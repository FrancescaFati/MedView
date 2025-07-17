export interface DicomData {
    pixelData: Uint8Array;
    rows: number;
    columns: number;
    bitsAllocated: number;
    samplesPerPixel: number;
    photometricInterpretation: string;
    windowCenter?: number;
    windowWidth?: number;
    rescaleIntercept?: number;
    rescaleSlope?: number;
    pixelSpacing?: number[];
    sliceThickness?: number;
    imagePosition?: number[];
    imageOrientation?: number[];
    seriesDescription?: string;
    studyDescription?: string;
    patientName?: string;
    studyDate?: string;
    modality?: string;
}

export class DicomParser {
    private static readonly DICOM_TAGS = {
        ROWS: 0x00280010,
        COLUMNS: 0x00280011,
        BITS_ALLOCATED: 0x00280100,
        SAMPLES_PER_PIXEL: 0x00280002,
        PHOTOMETRIC_INTERPRETATION: 0x00280004,
        PIXEL_DATA: 0x7fe00010,
        WINDOW_CENTER: 0x00281050,
        WINDOW_WIDTH: 0x00281051,
        RESCALE_INTERCEPT: 0x00281052,
        RESCALE_SLOPE: 0x00281053,
        PIXEL_SPACING: 0x00280030,
        SLICE_THICKNESS: 0x00180050,
        IMAGE_POSITION: 0x00200032,
        IMAGE_ORIENTATION: 0x00200037,
        SERIES_DESCRIPTION: 0x0008103e,
        STUDY_DESCRIPTION: 0x00081030,
        PATIENT_NAME: 0x00100010,
        STUDY_DATE: 0x00080020,
        MODALITY: 0x00080060
    };

    private static readonly VR_TYPES = {
        US: 'US', // Unsigned Short
        SS: 'SS', // Signed Short
        FL: 'FL', // Float
        DS: 'DS', // Decimal String
        LO: 'LO', // Long String
        SH: 'SH', // Short String
        DA: 'DA', // Date
        CS: 'CS', // Code String
        SQ: 'SQ', // Sequence
        OB: 'OB', // Other Byte
        OW: 'OW'  // Other Word
    };

    static parseDicomFile(buffer: ArrayBuffer): DicomData {
        try {
            const dataView = new DataView(buffer);
            const uint8Array = new Uint8Array(buffer);
            
            console.log('Parsing DICOM file, size:', buffer.byteLength);
            
            // Check for DICOM magic number
            let offset = 0;
            if (dataView.byteLength > 132) {
                const magic = String.fromCharCode(...uint8Array.slice(128, 132));
                console.log('DICOM magic number:', magic);
                if (magic === 'DICM') {
                    offset = 132; // Skip DICOM preamble
                    console.log('DICOM preamble found, starting at offset 132');
                } else {
                    console.log('No DICOM preamble found, starting at offset 0');
                }
            }

            // Parse DICOM elements
            const elements: any = {};
            let elementCount = 0;
            
            while (offset < dataView.byteLength - 8 && elementCount < 100) { // Limit to prevent infinite loops
                try {
                    const tag = dataView.getUint16(offset, false);
                    const nextTag = dataView.getUint16(offset + 2, false);
                    const fullTag = (tag << 16) | nextTag;
                    
                    offset += 4;
                    
                    // Get VR (Value Representation)
                    const vr = String.fromCharCode(...uint8Array.slice(offset, offset + 2));
                    offset += 2;
                    
                    let length: number;
                    if (this.isExplicitVR(vr)) {
                        length = dataView.getUint16(offset, false);
                        offset += 2;
                    } else {
                        // Implicit VR
                        offset -= 2; // Go back to before VR
                        length = dataView.getUint32(offset, false);
                        offset += 4;
                    }
                    
                    // Validate length to prevent buffer overruns
                    if (length < 0 || offset + length > dataView.byteLength) {
                        console.log('Invalid element length, stopping parsing');
                        break;
                    }
                    
                    // Store element
                    elements[fullTag.toString(16)] = {
                        offset: offset,
                        length: length,
                        vr: vr
                    };
                    
                    // Skip to next element
                    offset += length;
                    elementCount++;
                    
                    // Stop if we reach pixel data
                    if (fullTag === this.DICOM_TAGS.PIXEL_DATA) {
                        console.log('Found pixel data element');
                        break;
                    }
                } catch (error) {
                    console.log('Error parsing DICOM element at offset', offset, ':', error);
                    break;
                }
            }
            
            console.log('Parsed', elementCount, 'DICOM elements');

            // Extract basic image information
            const rows = this.getUint16Value(dataView, elements, this.DICOM_TAGS.ROWS) || 0;
            const columns = this.getUint16Value(dataView, elements, this.DICOM_TAGS.COLUMNS) || 0;
            const bitsAllocated = this.getUint16Value(dataView, elements, this.DICOM_TAGS.BITS_ALLOCATED) || 16;
            const samplesPerPixel = this.getUint16Value(dataView, elements, this.DICOM_TAGS.SAMPLES_PER_PIXEL) || 1;
            const photometricInterpretation = this.getStringValue(dataView, elements, this.DICOM_TAGS.PHOTOMETRIC_INTERPRETATION) || 'MONOCHROME2';
            
            // Extract pixel data
            const pixelDataElement = elements[this.DICOM_TAGS.PIXEL_DATA.toString(16)];
            if (!pixelDataElement) {
                throw new Error('No pixel data found in DICOM file');
            }
            
            console.log('Pixel data element found at offset:', pixelDataElement.offset, 'length:', pixelDataElement.length);
            
            // Validate pixel data bounds
            if (pixelDataElement.offset + pixelDataElement.length > buffer.byteLength) {
                throw new Error('Pixel data extends beyond file bounds');
            }
            
            const pixelData = new Uint8Array(buffer, pixelDataElement.offset, pixelDataElement.length);
            console.log('Pixel data extracted, size:', pixelData.length);
            
            // Extract window/level information
            const windowCenter = this.getFloatValue(dataView, elements, this.DICOM_TAGS.WINDOW_CENTER) || undefined;
            const windowWidth = this.getFloatValue(dataView, elements, this.DICOM_TAGS.WINDOW_WIDTH) || undefined;
            
            // Extract rescale information
            const rescaleIntercept = this.getFloatValue(dataView, elements, this.DICOM_TAGS.RESCALE_INTERCEPT) || undefined;
            const rescaleSlope = this.getFloatValue(dataView, elements, this.DICOM_TAGS.RESCALE_SLOPE) || undefined;
            
            // Extract spatial information
            const pixelSpacing = this.getFloatArray(dataView, elements, this.DICOM_TAGS.PIXEL_SPACING) || undefined;
            const sliceThickness = this.getFloatValue(dataView, elements, this.DICOM_TAGS.SLICE_THICKNESS) || undefined;
            const imagePosition = this.getFloatArray(dataView, elements, this.DICOM_TAGS.IMAGE_POSITION) || undefined;
            const imageOrientation = this.getFloatArray(dataView, elements, this.DICOM_TAGS.IMAGE_ORIENTATION) || undefined;
            
            // Extract metadata
            const seriesDescription = this.getStringValue(dataView, elements, this.DICOM_TAGS.SERIES_DESCRIPTION) || undefined;
            const studyDescription = this.getStringValue(dataView, elements, this.DICOM_TAGS.STUDY_DESCRIPTION) || undefined;
            const patientName = this.getStringValue(dataView, elements, this.DICOM_TAGS.PATIENT_NAME) || undefined;
            const studyDate = this.getStringValue(dataView, elements, this.DICOM_TAGS.STUDY_DATE) || undefined;
            const modality = this.getStringValue(dataView, elements, this.DICOM_TAGS.MODALITY) || undefined;
            
            return {
                pixelData,
                rows,
                columns,
                bitsAllocated,
                samplesPerPixel,
                photometricInterpretation,
                windowCenter,
                windowWidth,
                rescaleIntercept,
                rescaleSlope,
                pixelSpacing: pixelSpacing && pixelSpacing.length >= 2 ? [pixelSpacing[0], pixelSpacing[1]] : undefined,
                sliceThickness,
                imagePosition: imagePosition && imagePosition.length >= 3 ? [imagePosition[0], imagePosition[1], imagePosition[2]] : undefined,
                imageOrientation: imageOrientation && imageOrientation.length >= 6 ? [imageOrientation[0], imageOrientation[1], imageOrientation[2], 
                                                   imageOrientation[3], imageOrientation[4], imageOrientation[5]] : undefined,
                seriesDescription,
                studyDescription,
                patientName,
                studyDate,
                modality
            };
        } catch (error) {
            throw new Error(`Failed to parse DICOM file: ${error}`);
        }
    }
    
    private static isExplicitVR(vr: string): boolean {
        return Object.values(this.VR_TYPES).includes(vr);
    }
    
    private static getUint16Value(dataView: DataView, elements: any, tag: number): number | null {
        const element = elements[tag.toString(16)];
        if (!element || element.length !== 2) return null;
        return dataView.getUint16(element.offset, false);
    }
    
    private static getFloatValue(dataView: DataView, elements: any, tag: number): number | null {
        const element = elements[tag.toString(16)];
        if (!element || element.length !== 4) return null;
        return dataView.getFloat32(element.offset, false);
    }
    
    private static getStringValue(dataView: DataView, elements: any, tag: number): string | null {
        const element = elements[tag.toString(16)];
        if (!element || element.length === 0) return null;
        const bytes = new Uint8Array(dataView.buffer, element.offset, element.length);
        return new TextDecoder().decode(bytes).trim();
    }
    
    private static getFloatArray(dataView: DataView, elements: any, tag: number): number[] | null {
        const element = elements[tag.toString(16)];
        if (!element || element.length === 0) return null;
        const count = element.length / 4;
        const result: number[] = [];
        for (let i = 0; i < count; i++) {
            result.push(dataView.getFloat32(element.offset + i * 4, false));
        }
        return result;
    }
    
    static parseDicomSeries(buffers: ArrayBuffer[]): DicomData[] {
        return buffers.map(buffer => this.parseDicomFile(buffer));
    }
    
    static convertToNiftiFormat(dicomDataArray: DicomData[]): any {
        if (dicomDataArray.length === 0) {
            throw new Error('No DICOM data provided');
        }
        
        const firstDicom = dicomDataArray[0];
        const numSlices = dicomDataArray.length;
        
        // Create 3D volume data
        const volumeData = new Uint16Array(firstDicom.rows * firstDicom.columns * numSlices);
        
        for (let sliceIndex = 0; sliceIndex < numSlices; sliceIndex++) {
            const dicom = dicomDataArray[sliceIndex];
            const sliceOffset = sliceIndex * dicom.rows * dicom.columns;
            
            // Convert pixel data to 16-bit
            const pixelData = new Uint16Array(dicom.pixelData.buffer, dicom.pixelData.byteOffset, dicom.pixelData.length / 2);
            
            for (let i = 0; i < pixelData.length; i++) {
                volumeData[sliceOffset + i] = pixelData[i];
            }
        }
        
        // Create NIfTI-like structure
        return {
            data: volumeData,
            dims: [firstDicom.columns, firstDicom.rows, numSlices],
            pixdim: [
                1,
                firstDicom.pixelSpacing?.[0] || 1,
                firstDicom.pixelSpacing?.[1] || 1,
                firstDicom.sliceThickness || 1
            ],
            datatype: 4, // 16-bit signed integer
            bitpix: 16,
            scl_slope: firstDicom.rescaleSlope || 1,
            scl_inter: firstDicom.rescaleIntercept || 0,
            cal_min: Math.min(...volumeData),
            cal_max: Math.max(...volumeData)
        };
    }
} 