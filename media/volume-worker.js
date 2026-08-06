/*
 * MedView volume decode worker.
 *
 * This file is never loaded on its own. viewer.js fetches `nifti-bundle.js`
 * and this file as text, concatenates them behind `var window = self;` and
 * builds a Blob worker out of the result. That indirection exists because a
 * webview document (`vscode-webview://`) and its resources
 * (`https://file+.vscode-resource.vscode-cdn.net`) are different origins, so
 * `new Worker(resourceUri)` is blocked. The bundle's trailing
 * `window.nifti = ...` therefore lands on `self.nifti`.
 *
 * Everything expensive about opening a volume happens here: the download, the
 * gunzip, the header parse and the full-volume statistics pass. The main
 * thread only ever receives progress messages and one transferred buffer.
 */

'use strict';

const NIFTI_TYPES = {
    2: Uint8Array,
    4: Int16Array,
    8: Int32Array,
    16: Float32Array,
    64: Float64Array,
    256: Int8Array,
    512: Uint16Array,
    768: Uint32Array
};

const TYPE_NAMES = {
    2: 'uint8', 4: 'int16', 8: 'int32', 16: 'float32',
    64: 'float64', 256: 'int8', 512: 'uint16', 768: 'uint32'
};

/** A label volume with more distinct values than this is almost certainly not a label map. */
const MAX_PLAUSIBLE_LABELS = 4096;

self.onmessage = async (event) => {
    const msg = event.data;
    try {
        if (msg.type === 'load') {
            await decode(msg, await acquire(msg));
        } else if (msg.type === 'loadBuffer') {
            // Fallback path: the extension host already handed us the bytes.
            const bytes = new Uint8Array(msg.buffer);
            await decode(msg, isGzip(bytes) ? await gunzip([bytes], bytes.length, msg) : bytes);
        }
    } catch (error) {
        self.postMessage({
            type: 'error',
            id: msg.id,
            role: msg.role,
            message: error && error.message ? error.message : String(error)
        });
    }
};

function progress(msg, phase, pct) {
    self.postMessage({ type: 'progress', id: msg.id, role: msg.role, phase, pct });
}

/* ------------------------------------------------------------------ */
/* Download + decompress                                              */
/* ------------------------------------------------------------------ */

/**
 * Fetches the volume and returns the decompressed bytes as a Uint8Array.
 * Replaces the old `Array.from(fileData)` + JSON postMessage round trip,
 * which turned an N byte file into an N element JS array before serialising
 * it as text -- the reason large volumes took minutes or failed outright.
 */
async function acquire(msg) {
    progress(msg, 'download', 0);

    const response = await fetch(msg.url);
    if (!response.ok) {
        throw new Error('Could not read the file (HTTP ' + response.status + ')');
    }

    const declared = Number(response.headers.get('content-length')) || 0;
    // Kept as a chunk list rather than one buffer: the gzip path can feed the
    // chunks straight into the decompressor, so the compressed bytes are never
    // copied a second time.
    const { chunks, total } = await readWithProgress(response, declared, msg);

    if (!chunks.length || !isGzip(chunks[0])) {
        progress(msg, 'decompress', 100);
        return concat(chunks, total);
    }

    progress(msg, 'decompress', 0);
    return await gunzip(chunks, total, msg);
}

async function readWithProgress(response, declared, msg) {
    // Without a readable stream we cannot report progress, but we can still
    // avoid any intermediate copies.
    if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = new Uint8Array(await response.arrayBuffer());
        progress(msg, 'download', 100);
        return { chunks: [bytes], total: bytes.length };
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let lastReported = -1;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        chunks.push(value);
        total += value.length;
        if (declared > 0) {
            const pct = Math.min(99, Math.floor((total / declared) * 100));
            if (pct !== lastReported) {
                lastReported = pct;
                progress(msg, 'download', pct);
            }
        }
    }

    progress(msg, 'download', 100);
    return { chunks, total };
}

function concat(chunks, total) {
    if (chunks.length === 1) { return chunks[0]; }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function isGzip(bytes) {
    return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** A ReadableStream over an existing chunk list, without copying it. */
function streamOf(chunks) {
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(chunks[i++]);
            } else {
                controller.close();
            }
        }
    });
}

/**
 * Decompresses using the browser's native gzip implementation, which is an
 * order of magnitude faster than the JS inflater bundled with the NIfTI
 * reader.
 *
 * The gzip trailer stores the uncompressed size (mod 2^32) in its last four
 * bytes. When that value is usable we allocate the output buffer exactly once
 * and stream straight into it, which keeps peak memory at
 * `compressed + decompressed` rather than roughly double the decompressed
 * size. That matters: a 332 MB CT expands to 761 MB.
 */
async function gunzip(chunks, total, msg) {
    if (typeof DecompressionStream === 'undefined' || typeof ReadableStream === 'undefined') {
        // Very old runtime: fall back to the bundled JS inflater.
        progress(msg, 'decompress', 50);
        const compressed = concat(chunks, total);
        const view = compressed.buffer.byteLength === compressed.byteLength
            ? compressed.buffer
            : compressed.slice().buffer;
        const out = new Uint8Array(self.nifti.decompress(view));
        progress(msg, 'decompress', 100);
        return out;
    }

    const expected = readIsize(chunks, total);
    if (expected > 0) {
        const out = await gunzipInto(chunks, expected, msg);
        if (out) { return out; }
        // ISIZE was wrong; fall through to the growable path.
    }
    return await gunzipGrowable(chunks, msg);
}

/**
 * Decompresses into a single preallocated buffer sized from the gzip trailer.
 * Returns null if the stream turned out to be larger than ISIZE claimed, in
 * which case the caller retries with the growable path rather than silently
 * truncating image data.
 */
async function gunzipInto(chunks, expected, msg) {
    const reader = streamOf(chunks).pipeThrough(new DecompressionStream('gzip')).getReader();
    const out = new Uint8Array(expected);
    let offset = 0;
    let lastReported = -1;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        if (offset + value.length > out.length) {
            await reader.cancel();
            return null;
        }
        out.set(value, offset);
        offset += value.length;
        const pct = Math.min(99, Math.floor((offset / expected) * 100));
        if (pct !== lastReported) {
            lastReported = pct;
            progress(msg, 'decompress', pct);
        }
    }

    progress(msg, 'decompress', 100);
    return offset === out.length ? out : out.subarray(0, offset);
}

async function gunzipGrowable(chunks, msg) {
    const reader = streamOf(chunks).pipeThrough(new DecompressionStream('gzip')).getReader();
    const out = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        out.push(value);
        total += value.length;
    }
    progress(msg, 'decompress', 100);
    return concat(out, total);
}

/**
 * The gzip trailer holds the uncompressed size (mod 2^32) in its final four
 * bytes. Those bytes may straddle a chunk boundary, so read from a stitched
 * tail rather than assuming they sit in the last chunk.
 */
function readIsize(chunks, total) {
    if (total < 18) { return 0; }
    const tail = new Uint8Array(4);
    let want = 4;
    for (let c = chunks.length - 1; c >= 0 && want > 0; c--) {
        const chunk = chunks[c];
        const take = Math.min(want, chunk.length);
        tail.set(chunk.subarray(chunk.length - take), want - take);
        want -= take;
    }
    if (want > 0) { return 0; }

    const isize = new DataView(tail.buffer).getUint32(0, true);
    // A NIfTI volume never compresses to something larger than itself, so an
    // ISIZE below the compressed size means the value wrapped past 4 GB.
    if (isize === 0 || isize < total) { return 0; }
    return isize;
}

/* ------------------------------------------------------------------ */
/* Parse                                                              */
/* ------------------------------------------------------------------ */

async function decode(msg, bytes) {
    progress(msg, 'parse', 0);

    // `readHeader` wants an ArrayBuffer. Hand it the underlying buffer when
    // the view already spans it so we do not copy hundreds of megabytes.
    const buffer = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
        ? bytes.buffer
        : bytes.slice().buffer;

    if (msg.format === 'dicom') {
        return decodeDicom(msg, buffer);
    }

    const header = self.nifti.readHeader(buffer);
    if (!header || !header.dims || header.dims.length < 4) {
        throw new Error('Not a valid NIfTI file: the header has no usable dimensions.');
    }

    const nx = header.dims[1] | 0;
    const ny = header.dims[2] | 0;
    const nz = Math.max(1, header.dims[3] | 0);
    const voxels = nx * ny * nz;
    if (!(voxels > 0)) {
        throw new Error('Not a valid NIfTI file: dimensions are ' + nx + 'x' + ny + 'x' + nz + '.');
    }

    const Ctor = NIFTI_TYPES[header.datatypeCode];
    if (!Ctor) {
        throw new Error('Unsupported NIfTI datatype code ' + header.datatypeCode + '.');
    }

    const data = viewImageData(buffer, header, Ctor, voxels);
    progress(msg, 'parse', 100);

    const meta = {
        dims: [nx, ny, nz],
        pixDims: [
            sanePixDim(header.pixDims && header.pixDims[1]),
            sanePixDim(header.pixDims && header.pixDims[2]),
            sanePixDim(header.pixDims && header.pixDims[3])
        ],
        datatypeCode: header.datatypeCode,
        datatypeName: TYPE_NAMES[header.datatypeCode] || 'unknown',
        voxels: voxels,
        name: msg.name
    };

    if (msg.role === 'segmentation') {
        finishSegmentation(msg, data, meta);
    } else {
        finishVolume(msg, data, meta);
    }
}

/**
 * Returns a typed-array *view* onto the decompressed buffer rather than a
 * copy. `nifti.readImage` slices, which would transiently double memory on a
 * 761 MB volume. Falls back to a copy only when the voxel offset is not
 * aligned for the element type.
 */
function viewImageData(buffer, header, Ctor, voxels) {
    const offset = header.vox_offset > 0 ? Math.floor(header.vox_offset) : 0;
    const bytesNeeded = voxels * Ctor.BYTES_PER_ELEMENT;

    if (offset + bytesNeeded > buffer.byteLength) {
        throw new Error(
            'The file is truncated: it declares ' + voxels + ' voxels but holds only ' +
            Math.max(0, buffer.byteLength - offset) + ' of ' + bytesNeeded + ' bytes of image data.'
        );
    }

    let data;
    if (offset % Ctor.BYTES_PER_ELEMENT === 0) {
        data = new Ctor(buffer, offset, voxels);
    } else {
        data = new Ctor(buffer.slice(offset, offset + bytesNeeded));
    }

    if (header.littleEndian === false && Ctor.BYTES_PER_ELEMENT > 1) {
        swapBytes(data, Ctor.BYTES_PER_ELEMENT);
    }
    return data;
}

function swapBytes(typed, width) {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.length * width);
    for (let i = 0; i < bytes.length; i += width) {
        for (let a = 0, b = width - 1; a < b; a++, b--) {
            const t = bytes[i + a];
            bytes[i + a] = bytes[i + b];
            bytes[i + b] = t;
        }
    }
}

function sanePixDim(value) {
    const n = Number(value);
    return (isFinite(n) && n > 0) ? n : 1;
}

/* ------------------------------------------------------------------ */
/* DICOM (single frame)                                               */
/* ------------------------------------------------------------------ */

const DICOM_TAGS = {
    ROWS: 'x00280010',
    COLUMNS: 'x00280011',
    BITS_ALLOCATED: 'x00280100',
    PIXEL_REPRESENTATION: 'x00280103',
    SAMPLES_PER_PIXEL: 'x00280002',
    PIXEL_SPACING: 'x00280030',
    PIXEL_DATA: 'x7fe00010'
};

/**
 * Minimal uncompressed-DICOM reader, carried over from the previous inline
 * implementation. It covers a single native-format frame; encapsulated
 * transfer syntaxes (JPEG, JPEG2000, RLE) are not decoded.
 */
function decodeDicom(msg, buffer) {
    const dv = new DataView(buffer);
    const decoder = new TextDecoder('utf-8');
    const bytes = new Uint8Array(buffer);

    let offset = 0;
    if (buffer.byteLength > 132 && decoder.decode(bytes.subarray(128, 132)) === 'DICM') {
        offset = 132;
    }

    let rows = 0, columns = 0, bitsAllocated = 16, pixelRepresentation = 0, samplesPerPixel = 1;
    let pixelStart = -1, pixelLength = 0;
    let spacing = null;

    while (offset < buffer.byteLength - 8) {
        const group = dv.getUint16(offset, true);
        const element = dv.getUint16(offset + 2, true);
        const tag = 'x' + group.toString(16).padStart(4, '0') + element.toString(16).padStart(4, '0');

        let vr = '';
        try { vr = decoder.decode(bytes.subarray(offset + 4, offset + 6)); } catch (e) { vr = ''; }

        let length, valueOffset;
        if (/^[A-Z]{2}$/.test(vr)) {
            if (vr === 'OB' || vr === 'OW' || vr === 'SQ' || vr === 'UN') {
                length = dv.getUint32(offset + 8, true);
                valueOffset = offset + 12;
            } else {
                length = dv.getUint16(offset + 6, true);
                valueOffset = offset + 8;
            }
        } else {
            length = dv.getUint32(offset + 4, true);
            valueOffset = offset + 8;
        }

        if (length < 0 || valueOffset + length > buffer.byteLength) { break; }

        switch (tag) {
            case DICOM_TAGS.ROWS: rows = dv.getUint16(valueOffset, true); break;
            case DICOM_TAGS.COLUMNS: columns = dv.getUint16(valueOffset, true); break;
            case DICOM_TAGS.BITS_ALLOCATED: bitsAllocated = dv.getUint16(valueOffset, true); break;
            case DICOM_TAGS.PIXEL_REPRESENTATION: pixelRepresentation = dv.getUint16(valueOffset, true); break;
            case DICOM_TAGS.SAMPLES_PER_PIXEL: samplesPerPixel = dv.getUint16(valueOffset, true); break;
            case DICOM_TAGS.PIXEL_SPACING:
                spacing = decoder.decode(bytes.subarray(valueOffset, valueOffset + length))
                    .split('\\').map(Number).filter((n) => isFinite(n) && n > 0);
                break;
            case DICOM_TAGS.PIXEL_DATA:
                pixelStart = valueOffset;
                pixelLength = length;
                break;
        }

        if (pixelStart >= 0) { break; }
        offset = valueOffset + length;
    }

    if (!rows || !columns) {
        throw new Error('This DICOM file does not declare image dimensions.');
    }
    if (pixelStart < 0) {
        throw new Error('This DICOM file has no readable pixel data. Compressed transfer syntaxes are not supported.');
    }
    if (samplesPerPixel !== 1) {
        throw new Error('Colour DICOM images (' + samplesPerPixel + ' samples per pixel) are not supported.');
    }

    const voxels = rows * columns;
    const Ctor = bitsAllocated === 16
        ? (pixelRepresentation === 1 ? Int16Array : Uint16Array)
        : Uint8Array;

    if (pixelLength < voxels * Ctor.BYTES_PER_ELEMENT) {
        throw new Error('This DICOM file is truncated: the pixel data is shorter than ' + columns + '×' + rows + '.');
    }

    // A typed array view needs an aligned offset; copy only when it is not.
    const data = (pixelStart % Ctor.BYTES_PER_ELEMENT === 0)
        ? new Ctor(buffer, pixelStart, voxels)
        : new Ctor(buffer.slice(pixelStart, pixelStart + voxels * Ctor.BYTES_PER_ELEMENT));

    progress(msg, 'parse', 100);

    finishVolume(msg, data, {
        dims: [columns, rows, 1],
        pixDims: [
            spacing && spacing.length > 1 ? spacing[1] : 1,
            spacing && spacing.length > 0 ? spacing[0] : 1,
            1
        ],
        datatypeCode: -1,
        datatypeName: (Ctor === Int16Array ? 'int16' : Ctor === Uint16Array ? 'uint16' : 'uint8') + ' (dicom)',
        voxels: voxels,
        name: msg.name
    });
}

/* ------------------------------------------------------------------ */
/* Statistics                                                         */
/* ------------------------------------------------------------------ */

function finishVolume(msg, data, meta) {
    progress(msg, 'stats', 0);

    let min = Infinity;
    let max = -Infinity;
    const n = data.length;
    // Chunked so we can report progress on a 380 M voxel volume without
    // leaving the UI with a frozen progress bar.
    const step = 1 << 24;
    for (let start = 0; start < n; start += step) {
        const end = Math.min(n, start + step);
        for (let i = start; i < end; i++) {
            const v = data[i];
            if (v < min) { min = v; }
            if (v > max) { max = v; }
        }
        progress(msg, 'stats', Math.floor((end / n) * 100));
    }

    if (!isFinite(min) || !isFinite(max)) {
        // All-NaN float volume.
        min = 0;
        max = 1;
    }
    if (max === min) { max = min + 1; }

    meta.min = min;
    meta.max = max;

    self.postMessage(
        { type: 'volume', id: msg.id, role: msg.role, meta, buffer: data.buffer, byteOffset: data.byteOffset, length: data.length, arrayType: data.constructor.name },
        [data.buffer]
    );
}

/**
 * Label maps are frequently stored as float32 -- one of the segmentations in
 * this dataset is 1.4 MB gzipped but 307 MB expanded. Repacking to the
 * narrowest integer type that fits cuts that to 77 MB (or 38 MB for uint8)
 * and makes the overlay lookup a plain array index.
 */
function finishSegmentation(msg, data, meta) {
    progress(msg, 'stats', 0);

    const n = data.length;
    const counts = new Map();
    let maxLabel = 0;
    const step = 1 << 24;

    for (let start = 0; start < n; start += step) {
        const end = Math.min(n, start + step);
        for (let i = start; i < end; i++) {
            const v = data[i];
            const label = v > 0 ? Math.round(v) : 0;
            if (label > 0) {
                if (label > maxLabel) { maxLabel = label; }
                counts.set(label, (counts.get(label) || 0) + 1);
                if (counts.size > MAX_PLAUSIBLE_LABELS) {
                    throw new Error(
                        'This file has more than ' + MAX_PLAUSIBLE_LABELS +
                        ' distinct values, so it looks like an intensity image rather than a label map.'
                    );
                }
            }
        }
        progress(msg, 'stats', Math.floor((end / n) * 100));
    }

    const Packed = maxLabel < 256 ? Uint8Array : Uint16Array;
    let packed;
    if (data.constructor === Packed) {
        packed = data;
    } else {
        packed = new Packed(n);
        for (let i = 0; i < n; i++) {
            const v = data[i];
            packed[i] = v > 0 ? Math.round(v) : 0;
        }
    }

    const labels = Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value - b.value);

    meta.labels = labels;
    meta.maxLabel = maxLabel;

    self.postMessage(
        { type: 'segmentation', id: msg.id, role: msg.role, meta, buffer: packed.buffer, byteOffset: packed.byteOffset, length: packed.length, arrayType: packed.constructor.name },
        [packed.buffer]
    );
}
