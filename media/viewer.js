/*
 * MedView webview controller.
 *
 * Responsibilities are deliberately narrow: own the UI, own the canvas, and
 * hand every expensive operation to media/volume-worker.js. Nothing on this
 * thread ever iterates the whole volume.
 */

(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const config = window.MEDVIEW_CONFIG || {};

    /** Size of the intensity lookup table. One entry per quantised input value. */
    const LUT_SIZE = 65536;

    /** Distinct overlay colours, cycled for label values beyond the list. */
    const LABEL_PALETTE = [
        [230, 25, 75], [60, 180, 75], [67, 99, 216], [245, 130, 49],
        [145, 30, 180], [66, 212, 244], [240, 50, 230], [191, 239, 69],
        [250, 190, 190], [0, 128, 128], [230, 190, 255], [154, 99, 36],
        [255, 250, 200], [128, 0, 0], [170, 255, 195], [128, 128, 0],
        [255, 216, 177], [0, 0, 117], [169, 169, 169], [255, 225, 25]
    ];

    const state = {
        volume: null,       // { dims, pixDims, data, min, max, datatypeName }
        seg: null,          // { data, labels, colors, name }
        axis: 'axial',
        slice: 0,
        brightness: 100,
        contrast: 100,
        segOpacity: 45,
        segMode: 'fill',
        hiddenLabels: new Set(),
        rotation: 0,
        flipH: false,
        flipV: false
    };

    const el = {};
    let canvas = null;
    let ctx = null;
    let worker = null;
    let workerReady = null;
    let imageData = null;       // reused across renders
    let lut = new Uint8Array(LUT_SIZE);
    let lutScale = 1;
    let renderQueued = false;
    let nextRequestId = 1;
    const pending = new Map();  // request id -> { resolve, reject, role }

    /* ------------------------------------------------------------------ */
    /* Bootstrap                                                          */
    /* ------------------------------------------------------------------ */

    document.addEventListener('DOMContentLoaded', () => {
        cacheElements();
        canvas = el.imageCanvas;
        ctx = canvas.getContext('2d', { alpha: false });
        wireEvents();
        applySettings(config.settings || {});
        populateSegmentationOptions(config.segmentations || []);
        vscode.postMessage({ type: 'ready' });

        if (config.volumeUri) {
            openVolume(config.volumeUri, config.fileName).catch(showError);
        }
    });

    function cacheElements() {
        const ids = [
            'imageCanvas', 'canvasContainer', 'loading', 'loadingPhase', 'loadingDetail',
            'progressFill', 'statusReadout', 'headerMeta', 'sliceSlider', 'sliceValue',
            'sliceSliderContainer', 'axisToggleGroup', 'brightnessSlider', 'brightnessValue',
            'contrastSlider', 'contrastValue', 'resetIntensityButton', 'segmentationSelect',
            'segmentationControls', 'segOpacitySlider', 'segOpacityValue', 'segModeFill',
            'segModeOutline', 'labelList', 'rotateCW', 'rotateCCW', 'flipH', 'flipV',
            'resetTransformButton'
        ];
        for (const id of ids) { el[id] = document.getElementById(id); }
    }

    /* ------------------------------------------------------------------ */
    /* Worker                                                             */
    /* ------------------------------------------------------------------ */

    /*
     * The webview document and its resources live on different origins, so
     * `new Worker(resourceUri)` is blocked. Fetch both scripts as text and
     * build a same-origin blob worker instead. `var window = self` lets the
     * NIfTI bundle's trailing `window.nifti = ...` land on the worker global.
     */
    function ensureWorker() {
        if (workerReady) { return workerReady; }
        workerReady = (async () => {
            const [niftiSource, workerSource] = await Promise.all([
                fetch(config.niftiBundleUri).then((r) => r.text()),
                fetch(config.workerUri).then((r) => r.text())
            ]);
            const blob = new Blob(
                ['var window = self;\n', niftiSource, '\n', workerSource],
                { type: 'text/javascript' }
            );
            const url = URL.createObjectURL(blob);
            worker = new Worker(url);
            URL.revokeObjectURL(url);
            worker.onmessage = onWorkerMessage;
            worker.onerror = (event) => {
                const message = event.message || 'The decoding worker stopped unexpectedly.';
                for (const [, entry] of pending) { entry.reject(new Error(message)); }
                pending.clear();
            };
            return worker;
        })();
        return workerReady;
    }

    function onWorkerMessage(event) {
        const msg = event.data;
        const entry = pending.get(msg.id);

        if (msg.type === 'progress') {
            if (entry) { reportProgress(entry.role, msg.phase, msg.pct); }
            return;
        }
        if (!entry) { return; }
        pending.delete(msg.id);

        if (msg.type === 'error') {
            entry.reject(new Error(msg.message));
            return;
        }
        const Ctor = self[msg.arrayType];
        entry.resolve({
            meta: msg.meta,
            data: new Ctor(msg.buffer, msg.byteOffset, msg.length)
        });
    }

    /**
     * Loads a volume or segmentation and hands the raw bytes to the worker.
     *
     * The bytes are fetched on the *main* webview thread from the resource
     * URI. That is the same mechanism that already loads viewer.js, the CSS
     * and the NIfTI bundle, so it is known to work here. An earlier design
     * fetched from inside the Worker instead, but webview hosts serve their
     * resources through a service worker that only answers the main thread,
     * so the worker's fetch failed or, worse, hung forever -- leaving the
     * viewer stuck on a blank loading screen. If the main-thread fetch fails
     * (virtual or unusual filesystems), the extension host streams the bytes.
     *
     * On a slow or network-mounted filesystem the resource fetch can sit
     * completely idle -- no headers, no bytes -- for the ~30s VS Code takes
     * to give up and answer with an HTTP 408. Both transports end up reading
     * the same underlying disk, so that wait buys nothing: if nothing at all
     * has arrived after a short grace period, it is switched to the host
     * path early rather than sitting out the rest of VS Code's timeout.
     * Fetches that are genuinely progressing, just slowly, are left alone.
     */
    const FETCH_STALL_GRACE_MS = 4000;

    async function loadThroughWorker(uri, role, name, format) {
        await ensureWorker();

        const controller = new AbortController();
        const progress = { bytes: 0 };
        const fetchPromise = fetchResource(uri, role, controller.signal, progress);

        if (await isStalled(fetchPromise, progress, FETCH_STALL_GRACE_MS)) {
            controller.abort();
            reportProgress(role, 'download', 0);
            return await loadThroughHost(uri, role, name, format);
        }

        try {
            const buffer = await fetchPromise;
            return await decodeBuffer(buffer, role, name, format);
        } catch (error) {
            reportProgress(role, 'download', 0);
            return await loadThroughHost(uri, role, name, format);
        }
    }

    /** True if `promise` neither settles nor reports any progress within `ms`. */
    function isStalled(promise, progress, ms) {
        return new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) { resolve(progress.bytes === 0); }
            }, ms);
            promise.then(
                () => { settled = true; clearTimeout(timer); resolve(false); },
                () => { settled = true; clearTimeout(timer); resolve(false); }
            );
        });
    }

    /** Fetches a resource URI on the main thread, reporting download progress. */
    async function fetchResource(uri, role, signal, progress) {
        const url = toResourceUri(uri);
        const response = await fetch(url, signal ? { signal } : undefined);
        if (!response.ok) { throw new Error('HTTP ' + response.status); }

        const declared = Number(response.headers.get('content-length')) || 0;
        if (!response.body || typeof response.body.getReader !== 'function') {
            const buffer = await response.arrayBuffer();
            if (progress) { progress.bytes = buffer.byteLength; }
            reportProgress(role, 'download', 100);
            return buffer;
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
            if (progress) { progress.bytes = total; }
            if (declared > 0) {
                const pct = Math.min(99, Math.floor((total / declared) * 100));
                if (pct !== lastReported) { lastReported = pct; reportProgress(role, 'download', pct); }
            }
        }
        reportProgress(role, 'download', 100);

        if (chunks.length === 1) { return chunks[0].buffer.slice(chunks[0].byteOffset, chunks[0].byteOffset + chunks[0].length); }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
        return out.buffer;
    }

    /** Transfers a raw file buffer to the worker for decode. */
    function decodeBuffer(buffer, role, name, format) {
        const id = nextRequestId++;
        const promise = new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject, role });
        });
        worker.postMessage({ type: 'loadBuffer', id, role, name, format, buffer }, [buffer]);
        return promise;
    }

    async function loadThroughHost(uri, role, name, format) {
        const buffer = await requestHostBytes(uri, role);
        return await decodeBuffer(buffer, role, name, format);
    }

    /** Reassembles the file from the extension host's chunked byte stream. */
    function requestHostBytes(uri, role) {
        return new Promise((resolve, reject) => {
            const id = nextRequestId++;
            let out = null;
            let offset = 0;

            hostReaders.set(id, {
                onChunk(chunk, totalBytes) {
                    if (!out) { out = new Uint8Array(totalBytes); }
                    out.set(chunk, offset);
                    offset += chunk.length;
                    reportProgress(role, 'download', Math.floor((offset / totalBytes) * 100));
                },
                onDone() {
                    hostReaders.delete(id);
                    resolve(out ? out.buffer : new ArrayBuffer(0));
                },
                onError(message) {
                    hostReaders.delete(id);
                    reject(new Error(message));
                }
            });

            vscode.postMessage({ type: 'readFile', id, uri });
        });
    }

    const hostReaders = new Map();

    function toResourceUri(uri) {
        const map = config.resourceUris || {};
        return map[uri] || uri;
    }

    /* ------------------------------------------------------------------ */
    /* Loading                                                            */
    /* ------------------------------------------------------------------ */

    async function openVolume(uri, name) {
        showLoading(true, 'Opening image…');
        try {
            const { meta, data } = await loadThroughWorker(uri, 'volume', name, config.format);
            state.volume = {
                dims: meta.dims,
                pixDims: meta.pixDims,
                data,
                min: meta.min,
                max: meta.max,
                datatypeName: meta.datatypeName
            };
            state.seg = null;
            configureForVolume();
            rebuildLut();
            showLoading(false);
            render();
        } catch (error) {
            showError(error);
        }
    }

    async function openSegmentation(uri, name) {
        if (!state.volume) { return; }
        showLoading(true, 'Loading segmentation…');
        try {
            const { meta, data } = await loadThroughWorker(uri, 'segmentation', name, 'nifti');
            const vd = state.volume.dims;
            if (meta.dims[0] !== vd[0] || meta.dims[1] !== vd[1] || meta.dims[2] !== vd[2]) {
                throw new Error(
                    'The segmentation grid is ' + meta.dims.join('×') + ' but the image is ' +
                    vd.join('×') + '. They must be sampled on the same grid to be overlaid.'
                );
            }
            state.seg = {
                name: name,
                data,
                labels: meta.labels,
                colors: buildLabelColors(meta.labels, meta.maxLabel)
            };
            state.hiddenLabels.clear();
            renderLabelList();
            el.segmentationControls.classList.remove('hidden-el');
            showLoading(false);
            render();
        } catch (error) {
            state.seg = null;
            el.segmentationSelect.value = '';
            el.segmentationControls.classList.add('hidden-el');
            showLoading(false);
            showTransientError(error);
        }
    }

    function clearSegmentation() {
        state.seg = null;
        el.segmentationControls.classList.add('hidden-el');
        el.labelList.innerHTML = '';
        render();
    }

    function buildLabelColors(labels, maxLabel) {
        const colors = new Uint8Array((maxLabel + 1) * 3);
        labels.forEach((label, index) => {
            const rgb = LABEL_PALETTE[index % LABEL_PALETTE.length];
            colors[label.value * 3] = rgb[0];
            colors[label.value * 3 + 1] = rgb[1];
            colors[label.value * 3 + 2] = rgb[2];
        });
        return colors;
    }

    /* ------------------------------------------------------------------ */
    /* Geometry                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Describes how to walk the volume for the current axis. `srcBase` is the
     * index of the slice's first voxel; `inner`/`outer` are the index strides
     * along the displayed columns and rows.
     */
    function geometry() {
        const [nx, ny, nz] = state.volume.dims;
        const [vx, vy, vz] = state.volume.pixDims;
        const plane = nx * ny;

        switch (state.axis) {
            case 'sagittal':
                return {
                    width: ny, height: nz, maxSlice: nx - 1,
                    srcBase: state.slice, inner: nx, outer: plane, flipOuter: true,
                    aspect: (ny * vy) / (nz * vz)
                };
            case 'coronal':
                return {
                    width: nx, height: nz, maxSlice: ny - 1,
                    srcBase: state.slice * nx, inner: 1, outer: plane, flipOuter: true,
                    aspect: (nx * vx) / (nz * vz)
                };
            default:
                return {
                    width: nx, height: ny, maxSlice: nz - 1,
                    srcBase: state.slice * plane, inner: 1, outer: nx, flipOuter: false,
                    aspect: (nx * vx) / (ny * vy)
                };
        }
    }

    function configureForVolume() {
        const [nx, ny, nz] = state.volume.dims;
        const singleSlice = nz <= 1;

        // A single-slice image (a lone DICOM frame, or a 2D NIfTI) has no
        // meaningful sagittal or coronal reconstruction.
        el.axisToggleGroup.classList.toggle('hidden-el', singleSlice);
        el.sliceSliderContainer.classList.toggle('hidden-el', singleSlice);
        if (singleSlice) { state.axis = 'axial'; }

        const geo = geometry();
        state.slice = Math.floor(geo.maxSlice / 2);
        updateSliceControl();

        el.headerMeta.textContent =
            nx + '×' + ny + '×' + nz + '  ·  ' +
            state.volume.pixDims.map((v) => v.toFixed(2)).join('×') + ' mm  ·  ' +
            state.volume.datatypeName;
    }

    function updateSliceControl() {
        const geo = geometry();
        state.slice = Math.max(0, Math.min(geo.maxSlice, state.slice));
        el.sliceSlider.max = String(geo.maxSlice);
        el.sliceSlider.value = String(state.slice);
        el.sliceValue.textContent = state.slice + ' / ' + geo.maxSlice;
    }

    /* ------------------------------------------------------------------ */
    /* Rendering                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Maps quantised intensity to 8-bit grey once per settings change, so the
     * per-pixel path is a single multiply and an array lookup instead of the
     * normalise/contrast/brightness/clamp arithmetic it used to run 260k times
     * per slice.
     */
    function rebuildLut() {
        if (!state.volume) { return; }
        const { min, max } = state.volume;
        lutScale = (LUT_SIZE - 1) / (max - min);

        const brightness = state.brightness / 100;
        const contrast = state.contrast / 100;
        const toByte = 255 / (LUT_SIZE - 1);
        const offset = 128 + (brightness - 1) * 128;

        for (let i = 0; i < LUT_SIZE; i++) {
            const v = (i * toByte - 128) * contrast + offset;
            // Rounded, not truncated: writing a float into a Uint8Array
            // truncates, which would darken every pixel by up to one level
            // relative to the ImageData path this replaces.
            lut[i] = v < 0 ? 0 : (v > 255 ? 255 : Math.round(v));
        }
    }

    function scheduleRender() {
        if (renderQueued) { return; }
        renderQueued = true;
        requestAnimationFrame(() => {
            renderQueued = false;
            render();
        });
    }

    function render() {
        if (!state.volume || !ctx) { return; }

        const geo = geometry();
        const { width, height } = geo;

        if (canvas.width !== width || canvas.height !== height || !imageData) {
            canvas.width = width;
            canvas.height = height;
            imageData = ctx.createImageData(width, height);
        }

        paint(imageData.data, geo);
        ctx.putImageData(imageData, 0, 0);
        layout(geo);
        updateReadout(geo);
    }

    function paint(px, geo) {
        const src = state.volume.data;
        const min = state.volume.min;
        const { width, height, srcBase, inner, outer, flipOuter } = geo;

        const seg = state.seg;
        const segData = seg ? seg.data : null;
        const colors = seg ? seg.colors : null;
        const alpha = seg ? state.segOpacity / 100 : 0;
        const outline = state.segMode === 'outline';
        const hidden = state.hiddenLabels;
        const maxColorIndex = colors ? (colors.length / 3) - 1 : -1;

        for (let row = 0; row < height; row++) {
            const o = flipOuter ? (height - 1 - row) : row;
            const rowSrc = srcBase + o * outer;
            let dst = row * width * 4;

            for (let col = 0; col < width; col++, dst += 4) {
                const i = rowSrc + col * inner;
                let index = (src[i] - min) * lutScale;
                index = index < 0 ? 0 : (index > LUT_SIZE - 1 ? LUT_SIZE - 1 : index);
                const grey = lut[index | 0];

                let r = grey, g = grey, b = grey;

                if (segData !== null) {
                    const label = segData[i];
                    if (label > 0 && label <= maxColorIndex && !hidden.has(label)) {
                        let draw = true;
                        if (outline) {
                            draw = (col === 0 || segData[i - inner] !== label)
                                || (col === width - 1 || segData[i + inner] !== label)
                                || (o === 0 || segData[i - outer] !== label)
                                || (o === height - 1 || segData[i + outer] !== label);
                        }
                        if (draw) {
                            const c = label * 3;
                            r = grey + (colors[c] - grey) * alpha;
                            g = grey + (colors[c + 1] - grey) * alpha;
                            b = grey + (colors[c + 2] - grey) * alpha;
                        }
                    }
                }

                px[dst] = r;
                px[dst + 1] = g;
                px[dst + 2] = b;
                px[dst + 3] = 255;
            }
        }
    }

    /**
     * Sizes and orients the canvas with CSS only. The previous implementation
     * re-read the framebuffer and redrew through a scratch canvas on every
     * slice change just to apply a rotation; a compositor transform costs
     * nothing and keeps the pixel data untouched.
     */
    function layout(geo) {
        const container = el.canvasContainer;
        const available = {
            w: Math.max(1, container.clientWidth - 24),
            h: Math.max(1, container.clientHeight - 24)
        };

        const quarterTurn = (state.rotation % 180) !== 0;
        const shownAspect = quarterTurn ? 1 / geo.aspect : geo.aspect;

        let w = available.w;
        let h = w / shownAspect;
        if (h > available.h) {
            h = available.h;
            w = h * shownAspect;
        }

        // The element is laid out unrotated, so swap back for a quarter turn.
        canvas.style.width = (quarterTurn ? h : w) + 'px';
        canvas.style.height = (quarterTurn ? w : h) + 'px';
        canvas.style.transform =
            'rotate(' + state.rotation + 'deg) scale(' +
            (state.flipH ? -1 : 1) + ',' + (state.flipV ? -1 : 1) + ')';
    }

    function updateReadout(geo) {
        el.statusReadout.classList.remove('hidden-el');
        const lines = [
            state.axis + '  ' + geo.width + '×' + geo.height,
            'range ' + formatNumber(state.volume.min) + ' … ' + formatNumber(state.volume.max)
        ];
        if (state.seg) { lines.push('overlay ' + state.seg.name); }
        el.statusReadout.textContent = lines.join('\n');
    }

    function formatNumber(v) {
        return Number.isInteger(v) ? String(v) : v.toFixed(2);
    }

    /* ------------------------------------------------------------------ */
    /* Label list                                                         */
    /* ------------------------------------------------------------------ */

    function renderLabelList() {
        el.labelList.innerHTML = '';
        if (!state.seg) { return; }

        for (const label of state.seg.labels) {
            const c = label.value * 3;
            const row = document.createElement('div');
            row.className = 'label-row';
            row.title = 'Click to show or hide this label';

            const swatch = document.createElement('span');
            swatch.className = 'label-swatch';
            swatch.style.backgroundColor = 'rgb(' +
                state.seg.colors[c] + ',' + state.seg.colors[c + 1] + ',' + state.seg.colors[c + 2] + ')';

            const name = document.createElement('span');
            name.className = 'label-name';
            name.textContent = 'Label ' + label.value;

            const count = document.createElement('span');
            count.className = 'label-count';
            count.textContent = label.count.toLocaleString();

            row.append(swatch, name, count);
            row.addEventListener('click', () => {
                if (state.hiddenLabels.has(label.value)) {
                    state.hiddenLabels.delete(label.value);
                } else {
                    state.hiddenLabels.add(label.value);
                }
                row.classList.toggle('hidden', state.hiddenLabels.has(label.value));
                scheduleRender();
            });

            el.labelList.appendChild(row);
        }
    }

    function populateSegmentationOptions(items) {
        const select = el.segmentationSelect;
        while (select.options.length > 1) { select.remove(1); }

        for (const item of items) {
            const option = document.createElement('option');
            option.value = item.uri;
            option.textContent = item.label;
            option.title = item.detail || item.label;
            select.appendChild(option);
        }

        const browse = document.createElement('option');
        browse.value = '__browse__';
        browse.textContent = 'Browse…';
        select.appendChild(browse);
    }

    /* ------------------------------------------------------------------ */
    /* UI wiring                                                          */
    /* ------------------------------------------------------------------ */

    function wireEvents() {
        el.sliceSlider.addEventListener('input', (e) => {
            state.slice = parseInt(e.target.value, 10);
            el.sliceValue.textContent = state.slice + ' / ' + el.sliceSlider.max;
            scheduleRender();
        });

        el.brightnessSlider.addEventListener('input', (e) => {
            state.brightness = parseInt(e.target.value, 10);
            el.brightnessValue.textContent = state.brightness + '%';
            rebuildLut();
            scheduleRender();
            saveSettings();
        });

        el.contrastSlider.addEventListener('input', (e) => {
            state.contrast = parseInt(e.target.value, 10);
            el.contrastValue.textContent = state.contrast + '%';
            rebuildLut();
            scheduleRender();
            saveSettings();
        });

        el.resetIntensityButton.addEventListener('click', () => {
            applySettings({ brightness: 100, contrast: 100 });
            rebuildLut();
            scheduleRender();
            saveSettings();
        });

        for (const toggle of el.axisToggleGroup.querySelectorAll('.axis-toggle')) {
            toggle.addEventListener('click', () => {
                for (const other of el.axisToggleGroup.querySelectorAll('.axis-toggle')) {
                    other.classList.remove('active');
                }
                toggle.classList.add('active');
                state.axis = toggle.dataset.axis;
                resetTransform(false);
                state.slice = Math.floor(geometry().maxSlice / 2);
                updateSliceControl();
                scheduleRender();
            });
        }

        el.segmentationSelect.addEventListener('change', (e) => {
            const value = e.target.value;
            if (value === '__browse__') {
                e.target.value = state.seg ? e.target.value : '';
                vscode.postMessage({ type: 'browseSegmentation' });
                return;
            }
            if (!value) {
                clearSegmentation();
                return;
            }
            const option = e.target.selectedOptions[0];
            openSegmentation(value, option ? option.textContent : 'segmentation');
        });

        el.segOpacitySlider.addEventListener('input', (e) => {
            state.segOpacity = parseInt(e.target.value, 10);
            el.segOpacityValue.textContent = state.segOpacity + '%';
            scheduleRender();
        });

        for (const button of [el.segModeFill, el.segModeOutline]) {
            button.addEventListener('click', () => {
                state.segMode = button.dataset.mode;
                el.segModeFill.classList.toggle('active', state.segMode === 'fill');
                el.segModeOutline.classList.toggle('active', state.segMode === 'outline');
                scheduleRender();
            });
        }

        el.rotateCW.addEventListener('click', () => {
            state.rotation = (state.rotation + 90) % 360;
            updateTransformButtons();
            scheduleRender();
        });
        el.rotateCCW.addEventListener('click', () => {
            state.rotation = (state.rotation + 270) % 360;
            updateTransformButtons();
            scheduleRender();
        });
        el.flipH.addEventListener('click', () => {
            state.flipH = !state.flipH;
            updateTransformButtons();
            scheduleRender();
        });
        el.flipV.addEventListener('click', () => {
            state.flipV = !state.flipV;
            updateTransformButtons();
            scheduleRender();
        });
        el.resetTransformButton.addEventListener('click', () => resetTransform(true));

        canvas.addEventListener('wheel', (e) => {
            if (!state.volume) { return; }
            e.preventDefault();
            step(e.deltaY > 0 ? 1 : -1);
        }, { passive: false });

        document.addEventListener('keydown', (e) => {
            if (!state.volume) { return; }
            const geo = geometry();
            switch (e.key) {
                case 'ArrowLeft': case 'ArrowDown': step(-1); break;
                case 'ArrowRight': case 'ArrowUp': step(1); break;
                case 'PageUp': step(-10); break;
                case 'PageDown': step(10); break;
                case 'Home': jump(0); break;
                case 'End': jump(geo.maxSlice); break;
                default: return;
            }
            e.preventDefault();
        });

        window.addEventListener('resize', () => scheduleRender());
        window.addEventListener('message', onHostMessage);
    }

    function step(delta) { jump(state.slice + delta); }

    function jump(target) {
        const geo = geometry();
        const next = Math.max(0, Math.min(geo.maxSlice, target));
        if (next === state.slice) { return; }
        state.slice = next;
        updateSliceControl();
        scheduleRender();
    }

    function resetTransform(shouldRender) {
        state.rotation = 0;
        state.flipH = false;
        state.flipV = false;
        updateTransformButtons();
        if (shouldRender) { scheduleRender(); }
    }

    function updateTransformButtons() {
        el.flipH.classList.toggle('active', state.flipH);
        el.flipV.classList.toggle('active', state.flipV);
        el.rotateCW.classList.toggle('active', state.rotation === 90);
        el.rotateCCW.classList.toggle('active', state.rotation === 270);
    }

    function applySettings(settings) {
        if (typeof settings.brightness === 'number') {
            state.brightness = settings.brightness;
            el.brightnessSlider.value = String(settings.brightness);
            el.brightnessValue.textContent = settings.brightness + '%';
        }
        if (typeof settings.contrast === 'number') {
            state.contrast = settings.contrast;
            el.contrastSlider.value = String(settings.contrast);
            el.contrastValue.textContent = settings.contrast + '%';
        }
    }

    let saveTimer = null;
    function saveSettings() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            vscode.postMessage({
                type: 'saveSettings',
                brightness: state.brightness,
                contrast: state.contrast
            });
        }, 250);
    }

    /* ------------------------------------------------------------------ */
    /* Host messages                                                      */
    /* ------------------------------------------------------------------ */

    function onHostMessage(event) {
        const msg = event.data;
        const reader = msg.id != null ? hostReaders.get(msg.id) : null;

        switch (msg.type) {
            case 'fileChunk':
                if (reader) { reader.onChunk(msg.bytes, msg.totalBytes); }
                break;
            case 'fileEnd':
                if (reader) { reader.onDone(); }
                break;
            case 'fileError':
                if (reader) { reader.onError(msg.message); }
                break;
            case 'segmentations':
                config.resourceUris = config.resourceUris || {};
                for (const item of msg.items || []) {
                    if (item.resourceUri) { config.resourceUris[item.uri] = item.resourceUri; }
                }
                populateSegmentationOptions(msg.items || []);
                break;
            case 'openSegmentation':
                if (msg.resourceUri) {
                    config.resourceUris = config.resourceUris || {};
                    config.resourceUris[msg.uri] = msg.resourceUri;
                }
                addSegmentationOption(msg.uri, msg.label);
                el.segmentationSelect.value = msg.uri;
                openSegmentation(msg.uri, msg.label);
                break;
        }
    }

    function addSegmentationOption(uri, label) {
        const select = el.segmentationSelect;
        for (const option of select.options) {
            if (option.value === uri) { return; }
        }
        const option = document.createElement('option');
        option.value = uri;
        option.textContent = label;
        select.insertBefore(option, select.options[select.options.length - 1]);
    }

    /* ------------------------------------------------------------------ */
    /* Status                                                             */
    /* ------------------------------------------------------------------ */

    const PHASE_TEXT = {
        download: 'Reading file',
        decompress: 'Decompressing',
        parse: 'Reading header',
        stats: 'Analysing intensities'
    };

    function reportProgress(role, phase, pct) {
        const what = role === 'segmentation' ? 'segmentation' : 'image';
        el.loadingPhase.textContent = (PHASE_TEXT[phase] || phase) + ' …';
        el.loadingDetail.textContent = what + '  ·  ' + pct + '%';
        el.progressFill.style.width = pct + '%';
    }

    function showLoading(show, message) {
        el.loading.classList.toggle('hidden-el', !show);
        if (message) { el.loadingPhase.textContent = message; }
        if (show) {
            el.progressFill.style.width = '0%';
            el.loadingDetail.textContent = '';
        }
    }

    function showError(error) {
        showLoading(false);
        const box = document.createElement('div');
        box.className = 'error';
        const title = document.createElement('h3');
        title.textContent = 'Could not open this image';
        const body = document.createElement('p');
        body.textContent = error && error.message ? error.message : String(error);
        box.append(title, body);
        el.canvasContainer.innerHTML = '';
        el.canvasContainer.appendChild(box);
    }

    function showTransientError(error) {
        vscode.postMessage({
            type: 'showError',
            message: error && error.message ? error.message : String(error)
        });
    }
})();
