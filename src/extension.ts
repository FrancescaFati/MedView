// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as dicomParser from 'dicom-parser';

export function activate(context: vscode.ExtensionContext) {
    console.log('MedView NIfTI/DICOM viewer extension activated');

    // Register the custom editor provider for individual files
    const provider = new MedicalImageViewerProvider(context);
    const registration = vscode.window.registerCustomEditorProvider(
        'medview.viewer', 
        provider, 
        {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        }
    );

    // Register the custom editor provider for DICOM series (folders)
    const seriesProvider = new DicomSeriesProvider(context);
    const seriesRegistration = vscode.window.registerCustomEditorProvider(
        'medview.series', 
        seriesProvider, 
        {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        }
    );

    // Register command for opening DICOM series
    const openDicomSeriesCommand = vscode.commands.registerCommand('medview.openDicomSeries', async (uri?: vscode.Uri) => {
        let targetUri = uri;
        
        // If no URI provided (called from Command Palette), prompt for folder selection
        if (!targetUri) {
            const selectedFolders = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select DICOM Series Folder'
            });
            
            if (!selectedFolders || selectedFolders.length === 0) {
                return; // User cancelled
            }
            
            targetUri = selectedFolders[0];
        }
        
        if (targetUri && targetUri.scheme === 'file') {
            vscode.commands.executeCommand('vscode.openWith', targetUri, 'medview.series');
        }
    });

    // Register command to create a DICOM series marker file and open it
    const createDicomSeriesMarkerCommand = vscode.commands.registerCommand('medview.createDicomSeriesMarker', async (uri?: vscode.Uri) => {
        let targetFolder = uri;
        if (!targetFolder) {
            const selectedFolders = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select DICOM Series Folder'
            });
            if (!selectedFolders || selectedFolders.length === 0) {
                return;
            }
            targetFolder = selectedFolders[0];
        }
        if (targetFolder && targetFolder.scheme === 'file') {
            const markerUri = vscode.Uri.joinPath(targetFolder, '.series.dicom');
            try {
                // Create the marker file if it doesn't exist
                try {
                    await vscode.workspace.fs.stat(markerUri);
                } catch {
                    await vscode.workspace.fs.writeFile(markerUri, new Uint8Array());
                }
                // Open the marker file with the custom editor
                await vscode.commands.executeCommand('vscode.openWith', markerUri, 'medview.series');
            } catch (err) {
                vscode.window.showErrorMessage('Failed to create or open DICOM series marker: ' + err);
            }
        }
    });
    context.subscriptions.push(registration, seriesRegistration, openDicomSeriesCommand, createDicomSeriesMarkerCommand);
}

export function deactivate() {}

class MedicalImageViewerProvider implements vscode.CustomReadonlyEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        return {
            uri,
            dispose: () => {}
        };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media')
            ]
        };

        // Set up the webview HTML content
        webviewPanel.webview.html = this.getWebviewContent(webviewPanel.webview, document.uri);

                        // Handle messages from the webview
                webviewPanel.webview.onDidReceiveMessage(
                    message => this.handleWebviewMessage(message, webviewPanel, document),
                    undefined,
                    this.context.subscriptions
                );

                // Handle messages from extension to webview
                webviewPanel.webview.onDidReceiveMessage(
                    message => {
                        if (message.type === 'dicomSeries') {
                            // Handle DICOM series message
                            webviewPanel.webview.postMessage(message);
                        }
                    },
                    undefined,
                    this.context.subscriptions
                );

        // Send saved settings to webview
        this.sendSavedSettings(webviewPanel);

        // Load the NIfTI file when the webview is ready
        setTimeout(() => {
            webviewPanel.webview.postMessage({
                type: 'loadFile',
                uri: document.uri.toString()
            });
        }, 100);
    }

    private getWebviewContent(webview: vscode.Webview, fileUri: vscode.Uri): string {
        // Get URIs for resources
        const niftiBundleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'nifti-bundle.js')
        );

        // Get URIs for axis icons
        const axialIconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'axial_ico.png')
        );
        const sagittalIconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sagittal_ico.png')
        );
        const frontalIconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'frontal_ico.png')
        );

        const fileName = path.basename(fileUri.fsPath);

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Medical Image Viewer - ${fileName}</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    margin: 0;
                    padding: 0;
                    overflow: hidden;
                }
                
                .container {
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    width: 100vw;
                }
                
                .header {
                    padding: 10px;
                    background-color: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-widget-border);
                    flex-shrink: 0;
                }
                
                .viewer-container {
                    flex: 1;
                    display: flex;
                    flex-direction: row;
                    position: relative;
                    overflow: hidden;
                }
                .left-panel {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    min-width: 0;
                }
                .canvas-container {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background-color: #000;
                    position: relative;
                }
                .bottom-controls {
                    padding: 10px;
                    background-color: var(--vscode-sideBar-background);
                    border-top: 1px solid var(--vscode-widget-border);
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                
                .slice-controls {
                    display: flex;
                    align-items: center;
                    gap: 15px;
                }
                
                .slice-slider-container {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                
                .axis-toggle-group {
                    display: flex;
                    gap: 5px;
                }
                
                .axis-toggle {
                    padding: 8px 12px;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-button-border);
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: all 0.2s ease;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    min-width: 80px;
                    min-height: 85px;
                }
                
                .axis-toggle.active {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                
                .axis-toggle img {
                    width: 60px;
                    height: 60px;
                    opacity: 0.8;
                    transition: opacity 0.2s ease;
                    display: block;
                }
                
                .axis-toggle.active img {
                    opacity: 1;
                }
                
                .axis-toggle span {
                    text-align: center;
                    white-space: nowrap;
                }
                
                .control-section {
                    margin-bottom: 20px;
                    padding-bottom: 15px;
                    border-bottom: 1px solid var(--vscode-widget-border);
                }
                
                .control-section:last-child {
                    border-bottom: none;
                    margin-bottom: 0;
                }
                
                .transform-controls {
                    display: block;
                    gap: 8px;
                }
                
                .transform-row {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 8px;
                }
                
                .transform-row:last-child {
                    margin-bottom: 0;
                }
                
                .transform-btn {
                    padding: 8px 12px;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-button-border);
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: all 0.2s ease;
                    width: 50%;
                }
                
                .transform-btn:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                
                #imageCanvas {
                    max-width: 100%;
                    max-height: 100%;
                    image-rendering: pixelated;
                    cursor: crosshair;
                    border: 2px solid transparent;
                    transition: border-color 0.2s ease;
                }
                
                #imageCanvas:focus {
                    border-color: var(--vscode-focusBorder);
                }
                
                .navigation-hint {
                    position: absolute;
                    bottom: 10px;
                    left: 10px;
                    background-color: rgba(0, 0, 0, 0.7);
                    color: white;
                    padding: 5px 10px;
                    border-radius: 3px;
                    font-size: 11px;
                    font-family: var(--vscode-font-family);
                    opacity: 0.8;
                }
                
                .controls {
                    width: 220px;
                    padding: 15px;
                    background-color: var(--vscode-sideBar-background);
                    border-left: 1px solid var(--vscode-widget-border);
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                    overflow-y: auto;
                }
                
                .control-group {
                    display: flex;
                    flex-direction: column;
                    gap: 5px;
                }
                
                .control-group label {
                    font-size: 12px;
                    color: var(--vscode-foreground);
                    margin-bottom: 5px;
                }
                
                .slider-container {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                
                input[type="range"] {
                    flex: 1;
                    height: 20px;
                    background: var(--vscode-scrollbarSlider-background);
                    outline: none;
                    border-radius: 10px;
                }
                
                .loading {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                    border-radius: 4px;
                    border: 1px solid var(--vscode-widget-border);
                    z-index: 1000;
                    display: block;
                }
                
                .progress-bar {
                    width: 200px;
                    height: 4px;
                    background-color: var(--vscode-progressBar-background);
                    border-radius: 2px;
                    overflow: hidden;
                    margin-top: 10px;
                }
                
                .progress-fill {
                    height: 100%;
                    background-color: var(--vscode-progressBar-foreground);
                    width: 0%;
                    transition: width 0.3s ease;
                }
                
                .error {
                    color: var(--vscode-errorForeground);
                    background-color: var(--vscode-inputValidation-errorBackground);
                    padding: 10px;
                    border-radius: 4px;
                    border: 1px solid var(--vscode-inputValidation-errorBorder);
                }
                
                .debug {
                    position: absolute;
                    top: 10px;
                    right: 10px;
                    background-color: rgba(0, 0, 0, 0.8);
                    color: white;
                    padding: 10px;
                    border-radius: 4px;
                    font-family: monospace;
                    font-size: 12px;
                    max-width: 300px;
                    word-wrap: break-word;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h3 style="margin: 0; font-size: 14px;">Medical Image Viewer - ${fileName}</h3>
                </div>
                
                <div class="viewer-container">
                    <div class="left-panel">
                        <div class="canvas-container">
                            <canvas id="imageCanvas"></canvas>
                            <div class="loading" id="loading">
                                <div>Loading medical image file...</div>
                            </div>
                            <div class="navigation-hint">
                                ↑↓←→ keys, mouse wheel, or slider to navigate slices
                            </div>
                            <div class="debug" id="debug">Initializing...</div>
                        </div>
                        <div class="bottom-controls">
                            <div class="slice-controls">
                                <div class="slice-slider-container">
                                    <label style="font-size: 12px; color: var(--vscode-foreground);">Slice:</label>
                                    <input type="range" id="sliceSlider" min="0" max="100" value="50" style="flex: 1;">
                                    <span id="sliceValue" style="font-size: 12px; color: var(--vscode-foreground); min-width: 30px;">50</span>
                                </div>
                                <div class="axis-toggle-group">
                                    <button class="axis-toggle active" data-axis="axial">
                                        <img src="${axialIconUri}" alt="Axial">
                                        <span>Axial</span>
                                    </button>
                                    <button class="axis-toggle" data-axis="sagittal">
                                        <img src="${sagittalIconUri}" alt="Sagittal">
                                        <span>Sagittal</span>
                                    </button>
                                    <button class="axis-toggle" data-axis="coronal">
                                        <img src="${frontalIconUri}" alt="Coronal">
                                        <span>Coronal</span>
                                    </button>
                                </div>
                            </div>
                            
                        </div>
                    </div>
                    <div class="controls">
                        <div class="control-section">
                            <h4 style="margin: 0 0 10px 0; font-size: 13px; color: var(--vscode-foreground);">Intensity Controls</h4>
                            <div class="control-group">
                                <label>Brightness</label>
                                <div class="slider-container">
                                    <input type="range" id="brightnessSlider" min="0" max="200" value="100">
                                    <span id="brightnessValue">100%</span>
                                </div>
                            </div>
                            
                            <div class="control-group">
                                <label>Contrast</label>
                                <div class="slider-container">
                                    <input type="range" id="contrastSlider" min="0" max="200" value="100">
                                    <span id="contrastValue">100%</span>
                                </div>
                            </div>
                            
                            <div class="control-group">
                                <button id="resetIntensityButton" style="padding: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; width: 100%;">Reset Intensity</button>
                            </div>
                        </div>
                        
                        <div class="control-section">
                            <h4 style="margin: 0 0 10px 0; font-size: 13px; color: var(--vscode-foreground);">Image Transformations</h4>
                            <div class="transform-controls">
                                <div class="transform-row">
                                    <button class="transform-btn" id="rotateCW">Rotate CW</button>
                                    <button class="transform-btn" id="rotateCCW">Rotate CCW</button>
                                </div>
                                <div class="transform-row">
                                    <button class="transform-btn" id="flipH">Flip H</button>
                                    <button class="transform-btn" id="flipV">Flip V</button>
                                </div>
                            </div>
                            <div class="control-group" style="margin-top: 10px;">
                                <button id="resetTransformButton" style="padding: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; width: 100%;">Reset Transformations</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <script src="${niftiBundleUri}" onerror="console.error('Failed to load NIfTI bundle from: ${niftiBundleUri}')"></script>
            <script>
                // Simple DICOM parser for webview
                const DICOM = {
                    // DICOM tag constants
                    TAGS: {
                        TRANSFER_SYNTAX_UID: 'x00020010',
                        MODALITY: 'x00080060',
                        MANUFACTURER: 'x00080070',
                        INSTITUTION_NAME: 'x00080080',
                        PATIENT_NAME: 'x00100010',
                        PATIENT_ID: 'x00100020',
                        PATIENT_BIRTH_DATE: 'x00100030',
                        STUDY_DATE: 'x00080020',
                        STUDY_TIME: 'x00080030',
                        STUDY_DESCRIPTION: 'x00081030',
                        SERIES_DATE: 'x00080021',
                        SERIES_TIME: 'x00080031',
                        SERIES_DESCRIPTION: 'x0008103e',
                        IMAGE_TYPE: 'x00080008',
                        SAMPLES_PER_PIXEL: 'x00280002',
                        PHOTOMETRIC_INTERPRETATION: 'x00280004',
                        PLANAR_CONFIGURATION: 'x00280006',
                        ROWS: 'x00280010',
                        COLUMNS: 'x00280011',
                        BITS_ALLOCATED: 'x00280100',
                        BITS_STORED: 'x00280101',
                        HIGH_BIT: 'x00280102',
                        PIXEL_REPRESENTATION: 'x00280103',
                        WINDOW_CENTER: 'x00281050',
                        WINDOW_WIDTH: 'x00281051',
                        RESCALE_INTERCEPT: 'x00281052',
                        RESCALE_SLOPE: 'x00281053',
                        PIXEL_DATA: 'x7fe00010'
                    },
                    
                    // Parse DICOM file
                    parse: function(arrayBuffer) {
                        const dataView = new DataView(arrayBuffer);
                        const decoder = new TextDecoder('utf-8');
                        
                        // Check DICOM signature - be more flexible
                        let offset = 128;
                        const signature = decoder.decode(new Uint8Array(arrayBuffer, offset, 4));
                        if (signature !== 'DICM') {
                            // Try alternative DICOM format without signature
                            offset = 0;
                        } else {
                            offset = 132; // Skip DICOM signature
                        }
                        
                        const result = {
                            header: {},
                            imageData: null,
                            rows: 0,
                            columns: 0,
                            bitsAllocated: 8,
                            bitsStored: 8,
                            highBit: 7,
                            pixelRepresentation: 0,
                            samplesPerPixel: 1,
                            photometricInterpretation: 'MONOCHROME2',
                            windowCenter: 128,
                            windowWidth: 256,
                            rescaleIntercept: 0,
                            rescaleSlope: 1
                        };
                        
                        try {
                            while (offset < arrayBuffer.byteLength - 8) {
                                const group = dataView.getUint16(offset, true);
                                const element = dataView.getUint16(offset + 2, true);
                                const tag = 'x' + group.toString(16).padStart(4, '0') + element.toString(16).padStart(4, '0');
                                
                                // Try to read VR
                                let vr = '';
                                try {
                                    vr = decoder.decode(new Uint8Array(arrayBuffer, offset + 4, 2));
                                } catch (e) {
                                    vr = '';
                                }
                                
                                let length;
                                let valueOffset;
                                
                                if (this.isExplicitVR(vr)) {
                                    // Explicit VR format
                                    if (vr === 'OB' || vr === 'OW' || vr === 'SQ' || vr === 'UN') {
                                        // These VRs have 2 reserved bytes after VR
                                        length = dataView.getUint32(offset + 8, true);
                                        valueOffset = offset + 12;
                                    } else {
                                        // Standard explicit VR format
                                        length = dataView.getUint16(offset + 6, true);
                                        valueOffset = offset + 8;
                                    }
                                } else {
                                    // Implicit VR format
                                    length = dataView.getUint32(offset + 4, true);
                                    valueOffset = offset + 8;
                                }
                                
                                // Validate length
                                if (length < 0 || length > arrayBuffer.byteLength - valueOffset) {
                                    break;
                                }
                                
                                // Debug logging for important tags
                                if (tag === this.TAGS.ROWS || tag === this.TAGS.COLUMNS || tag === this.TAGS.BITS_ALLOCATED || tag === this.TAGS.PIXEL_DATA) {
                                    console.log('DICOM Tag:', tag, 'VR:', vr, 'Length:', length, 'Offset:', offset);
                                }
                                
                                // Handle specific tags
                                switch (tag) {
                                    case this.TAGS.ROWS:
                                        if (length === 2) {
                                            result.rows = dataView.getUint16(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.COLUMNS:
                                        if (length === 2) {
                                            result.columns = dataView.getUint16(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.BITS_ALLOCATED:
                                        if (length === 2) {
                                            result.bitsAllocated = dataView.getUint16(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.BITS_STORED:
                                        if (length === 2) {
                                            result.bitsStored = dataView.getUint16(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.HIGH_BIT:
                                        if (length === 2) {
                                            result.highBit = dataView.getUint16(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.PIXEL_REPRESENTATION:
                                        if (length === 2) {
                                            result.pixelRepresentation = dataView.getUint16(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.SAMPLES_PER_PIXEL:
                                        if (length === 2) {
                                            result.samplesPerPixel = dataView.getUint16(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.PHOTOMETRIC_INTERPRETATION:
                                        if (length > 0 && length <= 16) {
                                            result.photometricInterpretation = decoder.decode(new Uint8Array(arrayBuffer, valueOffset, length)).trim();
                                        }
                                        break;
                                    case this.TAGS.WINDOW_CENTER:
                                        if (length === 4) {
                                            result.windowCenter = dataView.getFloat32(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.WINDOW_WIDTH:
                                        if (length === 4) {
                                            result.windowWidth = dataView.getFloat32(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.RESCALE_INTERCEPT:
                                        if (length === 4) {
                                            result.rescaleIntercept = dataView.getFloat32(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.RESCALE_SLOPE:
                                        if (length === 4) {
                                            result.rescaleSlope = dataView.getFloat32(valueOffset, true);
                                        }
                                        break;
                                    case this.TAGS.PIXEL_DATA:
                                        // Extract image data
                                        if (length > 0) {
                                            result.imageData = new Uint8Array(arrayBuffer, valueOffset, length);
                                        }
                                        break;
                                    default:
                                        // Store other tags in header
                                        if (length > 0 && length < 1000) {
                                            try {
                                                const value = decoder.decode(new Uint8Array(arrayBuffer, valueOffset, length)).trim();
                                                result.header[tag] = value;
                                            } catch (e) {
                                                // Skip non-text values
                                            }
                                        }
                                        break;
                                }
                                
                                offset = valueOffset + length;
                            }
                        } catch (e) {
                            console.warn('DICOM parsing error:', e);
                        }
                        
                        // Validate required fields
                        console.log('DICOM parsing result:', {
                            rows: result.rows,
                            columns: result.columns,
                            bitsAllocated: result.bitsAllocated,
                            imageDataLength: result.imageData ? result.imageData.length : 0
                        });
                        
                        if (result.rows === 0 || result.columns === 0) {
                            throw new Error('Invalid DICOM file: missing image dimensions');
                        }
                        
                        if (!result.imageData) {
                            throw new Error('Invalid DICOM file: missing pixel data');
                        }
                        
                        return result;
                    },
                    
                    isExplicitVR: function(vr) {
                        return /^[A-Z]{2}$/.test(vr);
                    }
                };
            </script>
            <script>
                console.log('NIfTI Viewer script starting...');
                
                // Wait for the NIfTI library to load
                function waitForNifti() {
                    if (typeof window.nifti !== 'undefined') {
                        console.log('NIfTI library loaded successfully');
                        return true;
                    }
                    console.log('NIfTI library not yet loaded, waiting...');
                    return false;
                }
                
                // Check if library is loaded, wait if not
                if (!waitForNifti()) {
                    let attempts = 0;
                    const maxAttempts = 10;
                    const checkInterval = setInterval(() => {
                        attempts++;
                        if (waitForNifti()) {
                            clearInterval(checkInterval);
                            console.log('NIfTI library loaded after', attempts, 'attempts');
                        } else if (attempts >= maxAttempts) {
                            clearInterval(checkInterval);
                            console.error('Failed to load NIfTI library after', maxAttempts, 'attempts');
                        }
                    }, 100);
                }
                
                // Debug function
                function debug(message) {
                    console.log('NIfTI Viewer:', message);
                    const debugEl = document.getElementById('debug');
                    if (debugEl) {
                        debugEl.textContent = message;
                    }
                }
                
                // Test NIfTI library access
                debug('Testing NIfTI library access...');
                if (typeof window.nifti !== 'undefined') {
                    debug('NIfTI library available immediately');
                } else {
                    debug('NIfTI library not available, will retry...');
                }
                
                // Global variables
                let niftiData = null;
                let currentSlice = 0;
                let currentAxis = 'axial';
                let canvas = null;
                let ctx = null;
                let worker = null;
                
                // Image transformation state
                let imageTransform = {
                    flipHorizontal: false,
                    flipVertical: false,
                    rotation: 0 // 0, 90, 180, 270 degrees
                };
                
                // Global intensity normalization values for consistent scaling across all slices
                let globalIntensityRange = {
                    min: 0,
                    max: 0,
                    normFactor: 0
                };
                
                // Current view dimensions (calculated once per axis switch)
                let currentViewDimensions = {
                    dataWidth: 0,
                    dataHeight: 0,
                    displayWidth: 0,
                    displayHeight: 0,
                    maxSlice: 0,
                    physicalAspectRatio: 1
                };
                
                // WebView API
                const vscode = acquireVsCodeApi();
                
                debug('Initializing...');
                
                // Initialize when DOM is loaded
                document.addEventListener('DOMContentLoaded', () => {
                    debug('DOM loaded, setting up canvas...');
                    
                    canvas = document.getElementById('imageCanvas');
                    if (!canvas) {
                        debug('ERROR: Canvas not found');
                        return;
                    }
                    
                    ctx = canvas.getContext('2d');
                    if (!ctx) {
                        debug('ERROR: Canvas context not available');
                        return;
                    }
                    
                    debug('Canvas setup complete');
                    
                    // Set up event listeners
                    setupEventListeners();
                    
                    // Initialize processing without web worker for now
                    debug('Setup complete, waiting for file...');
                });
                
                function setupEventListeners() {
                    debug('Setting up event listeners...');
                    
                    // Slice slider
                    const sliceSlider = document.getElementById('sliceSlider');
                    if (sliceSlider) {
                        sliceSlider.addEventListener('input', (e) => {
                            currentSlice = parseInt(e.target.value);
                            document.getElementById('sliceValue').textContent = currentSlice;
                            renderSlice();
                        });
                    }
                    
                    // Brightness and contrast
                    const brightnessSlider = document.getElementById('brightnessSlider');
                    if (brightnessSlider) {
                        brightnessSlider.addEventListener('input', (e) => {
                            const value = parseInt(e.target.value);
                            document.getElementById('brightnessValue').textContent = value + '%';
                            renderSlice();
                            saveSettings();
                        });
                    }
                    
                    const contrastSlider = document.getElementById('contrastSlider');
                    if (contrastSlider) {
                        contrastSlider.addEventListener('input', (e) => {
                            const value = parseInt(e.target.value);
                            document.getElementById('contrastValue').textContent = value + '%';
                            renderSlice();
                            saveSettings();
                        });
                    }
                    
                    // Axis toggle buttons
                    const axisToggles = document.querySelectorAll('.axis-toggle');
                    axisToggles.forEach(toggle => {
                        toggle.addEventListener('click', (e) => {
                            // Remove active class from all toggles
                            axisToggles.forEach(t => t.classList.remove('active'));
                            // Add active class to clicked toggle
                            e.currentTarget.classList.add('active');
                            
                            currentAxis = e.currentTarget.dataset.axis;
                            updateAxisView();
                        });
                    });
                    
                    // Reset intensity button
                    const resetIntensityButton = document.getElementById('resetIntensityButton');
                    if (resetIntensityButton) {
                        resetIntensityButton.addEventListener('click', () => {
                            resetIntensity();
                        });
                    }
                    
                    // Reset transformations button
                    const resetTransformButton = document.getElementById('resetTransformButton');
                    if (resetTransformButton) {
                        resetTransformButton.addEventListener('click', () => {
                            resetTransformations();
                        });
                    }
                    
                    // Transformation buttons
                    const flipH = document.getElementById('flipH');
                    if (flipH) {
                        flipH.addEventListener('click', () => {
                            imageTransform.flipHorizontal = !imageTransform.flipHorizontal;
                            updateTransformButtonStates();
                            renderSlice();
                        });
                    }
                    
                    const flipV = document.getElementById('flipV');
                    if (flipV) {
                        flipV.addEventListener('click', () => {
                            imageTransform.flipVertical = !imageTransform.flipVertical;
                            updateTransformButtonStates();
                            renderSlice();
                        });
                    }
                    
                    const rotateCW = document.getElementById('rotateCW');
                    if (rotateCW) {
                        rotateCW.addEventListener('click', () => {
                            imageTransform.rotation = (imageTransform.rotation + 90) % 360;
                            updateTransformButtonStates();
                            renderSlice();
                        });
                    }
                    
                    const rotateCCW = document.getElementById('rotateCCW');
                    if (rotateCCW) {
                        rotateCCW.addEventListener('click', () => {
                            imageTransform.rotation = (imageTransform.rotation - 90 + 360) % 360;
                            updateTransformButtonStates();
                            renderSlice();
                        });
                    }
                    
                    // Keyboard navigation
                    document.addEventListener('keydown', (e) => {
                        if (!niftiData || !currentViewDimensions.maxSlice) return;
                        
                        let newSlice = currentSlice;
                        
                        switch (e.key) {
                            case 'ArrowLeft':
                            case 'ArrowDown':
                                e.preventDefault();
                                newSlice = Math.max(0, currentSlice - 1);
                                break;
                            case 'ArrowRight':
                            case 'ArrowUp':
                                e.preventDefault();
                                newSlice = Math.min(currentViewDimensions.maxSlice, currentSlice + 1);
                                break;
                            case 'Home':
                                e.preventDefault();
                                newSlice = 0;
                                break;
                            case 'End':
                                e.preventDefault();
                                newSlice = currentViewDimensions.maxSlice;
                                break;
                            case 'PageUp':
                                e.preventDefault();
                                newSlice = Math.max(0, currentSlice - 10);
                                break;
                            case 'PageDown':
                                e.preventDefault();
                                newSlice = Math.min(currentViewDimensions.maxSlice, currentSlice + 10);
                                break;
                        }
                        
                        if (newSlice !== currentSlice) {
                            currentSlice = newSlice;
                            updateSliceControls();
                            renderSlice();
                        }
                    });
                    
                    // Mouse wheel navigation on canvas
                    if (canvas) {
                        canvas.addEventListener('wheel', (e) => {
                            if (!niftiData || !currentViewDimensions.maxSlice) return;
                            
                            e.preventDefault();
                            
                            // Determine scroll direction
                            const delta = e.deltaY > 0 ? 1 : -1;
                            const newSlice = Math.max(0, Math.min(currentViewDimensions.maxSlice, currentSlice + delta));
                            
                            if (newSlice !== currentSlice) {
                                currentSlice = newSlice;
                                updateSliceControls();
                                renderSlice();
                            }
                        });
                        
                        // Make canvas focusable for keyboard events
                        canvas.tabIndex = 0;
                        canvas.style.outline = 'none'; // Remove focus outline
                    }
                    
                    debug('Event listeners set up (including keyboard and mouse wheel navigation)');
                }
                
                // Handle messages from extension
                window.addEventListener('message', (event) => {
                    const message = event.data;
                    debug('Received message: ' + message.type);
                    
                    switch (message.type) {
                        case 'loadFile':
                            debug('Loading file: ' + message.uri);
                            loadNiftiFile(message.uri);
                            break;
                        case 'fileData':
                            debug('Processing file data...');
                            processFileData(message.data, message.fileType);
                            break;
                        case 'dicomSeries':
                            debug('Processing DICOM series with ' + message.fileCount + ' files');
                            handleDicomSeries(message.fileCount, message.files);
                            break;
                        case 'error':
                            debug('Error: ' + message.message);
                            handleError(message.message);
                            break;
                        case 'loadSettings':
                            debug('Loading saved settings: brightness=' + message.brightness + ', contrast=' + message.contrast);
                            loadSavedSettings(message.brightness, message.contrast);
                            break;
                    }
                });
                
                function loadNiftiFile(uri) {
                    debug('Requesting file read from extension...');
                    showLoading(true);
                    updateProgress(10);
                    
                    // Request file data from extension
                    vscode.postMessage({
                        type: 'readFile',
                        uri: uri
                    });
                }
                
                function processFileData(data, fileType) {
                    debug('Processing file data, size: ' + data.length + ', type: ' + fileType);
                    updateProgress(30);
                    
                    try {
                        // Convert to Uint8Array and then to ArrayBuffer
                        const uint8Array = new Uint8Array(data);
                        const arrayBuffer = uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength);
                        debug('Converted to ArrayBuffer, size: ' + arrayBuffer.byteLength);
                        updateProgress(40);
                        
                        if (fileType === 'dicom') {
                            debug('Processing DICOM file...');
                            processDicomFile(arrayBuffer);
                        } else if (fileType === 'nifti') {
                            debug('Processing NIfTI file...');
                            // Check if NIfTI library is available
                            if (typeof window.nifti === 'undefined') {
                                debug('ERROR: NIfTI library not loaded');
                                handleError('NIfTI library not loaded');
                                return;
                            }
                            
                            debug('NIfTI library available');
                            updateProgress(50);
                            
                            // Fast header-only parsing first for immediate UI setup
                            parseHeaderFirst(arrayBuffer);
                        } else {
                            handleError('Unsupported file type: ' + fileType);
                        }
                        
                    } catch (error) {
                        debug('Error processing file data: ' + error.message);
                        handleError('Error processing file data: ' + error.message);
                    }
                }
                
                function processDicomFile(arrayBuffer) {
                    debug('Processing DICOM file...');
                    updateProgress(50);
                    
                    try {
                        // Parse DICOM file
                        const dicomData = DICOM.parse(arrayBuffer);
                        debug('DICOM parsed successfully');
                        debug('Dimensions: ' + dicomData.columns + 'x' + dicomData.rows);
                        debug('Bits allocated: ' + dicomData.bitsAllocated + ', stored: ' + dicomData.bitsStored);
                        
                        // Convert DICOM data to our standard format
                        niftiData = {
                            header: {
                                dims: [3, dicomData.columns, dicomData.rows, 1, 1, 1, 1, 1], // Single slice
                                datatypeCode: dicomData.bitsAllocated === 16 ? 4 : 2, // Int16 or Uint8
                                numBitsPerVoxel: dicomData.bitsAllocated,
                                pixDims: [1, 1, 1, 1, 1, 1, 1, 1], // Default spacing
                                scl_slope: dicomData.rescaleSlope,
                                scl_inter: dicomData.rescaleIntercept,
                                cal_max: dicomData.windowCenter + dicomData.windowWidth / 2,
                                cal_min: dicomData.windowCenter - dicomData.windowWidth / 2
                            },
                            image: null,
                            isHeaderOnly: true,
                            isDicom: true,
                            dicomData: dicomData
                        };
                        
                        updateProgress(75);
                        
                        // Initialize UI immediately with header info
                        initializeViewerWithHeader();
                        
                        // Load image data in background
                        setTimeout(() => loadDicomImageData(), 10);
                        
                    } catch (error) {
                        debug('Error parsing DICOM: ' + error.message);
                        handleError('Error parsing DICOM: ' + error.message);
                    }
                }
                
                function loadDicomImageData() {
                    debug('Loading DICOM image data...');
                    updateProgress(80);
                    
                    try {
                        const dicomData = niftiData.dicomData;
                        const imageData = dicomData.imageData;
                        
                        // Convert image data to appropriate typed array
                        let processedImageData;
                        if (dicomData.bitsAllocated === 16) {
                            processedImageData = new Int16Array(imageData.buffer, imageData.byteOffset, imageData.length / 2);
                        } else {
                            processedImageData = new Uint8Array(imageData);
                        }
                        
                        debug('DICOM image data loaded, length: ' + processedImageData.length);
                        
                        // Update stored data
                        niftiData.image = processedImageData;
                        niftiData.isHeaderOnly = false;
                        
                        // Calculate global intensity range for consistent normalization across all slices
                        calculateGlobalIntensityRange();
                        
                        updateProgress(100);
                        showLoading(false);
                        
                        // Render the current slice now that data is ready
                        renderSlice();
                        
                    } catch (error) {
                        debug('Error loading DICOM image data: ' + error.message);
                        handleError('Error loading DICOM image data: ' + error.message);
                    }
                }
                
                function parseHeaderFirst(arrayBuffer) {
                    debug('Fast header parsing...');
                    updateProgress(60);
                    
                    try {
                        // Check if compressed
                        const isCompressed = window.nifti.isCompressed(arrayBuffer);
                        debug('Is compressed: ' + isCompressed);
                        updateProgress(65);
                        
                        let niftiBuffer;
                        if (isCompressed) {
                            debug('Decompressing for header...');
                            niftiBuffer = window.nifti.decompress(arrayBuffer);
                        } else {
                            niftiBuffer = arrayBuffer;
                        }
                        
                        debug('Reading header only...');
                        updateProgress(70);
                        const header = window.nifti.readHeader(niftiBuffer);
                        
                        // Validate header
                        if (!header || !header.dims || header.dims.length < 4) {
                            throw new Error('Invalid NIfTI header: missing or invalid dimensions');
                        }
                        
                        debug('Header parsed successfully');
                        debug('Dimensions: ' + header.dims[1] + 'x' + header.dims[2] + 'x' + header.dims[3]);
                        debug('Image data type: ' + header.datatypeCode + ', bits per voxel: ' + header.numBitsPerVoxel);
                        
                        // Store header and buffer for later image loading
                        niftiData = {
                            header: header,
                            image: null, // Will be loaded lazily
                            niftiBuffer: niftiBuffer,
                            isHeaderOnly: true
                        };
                        
                        updateProgress(75);
                        
                        // Initialize UI immediately with header info
                        initializeViewerWithHeader();
                        
                        // Load image data in background
                        setTimeout(() => loadImageDataLazily(), 10);
                        
                    } catch (error) {
                        debug('Error parsing header: ' + error.message);
                        handleError('Error parsing NIfTI header: ' + error.message);
                    }
                }
                
                function loadImageDataLazily() {
                    debug('Loading image data in background...');
                    updateProgress(80);
                    
                    try {
                        const imageArrayBuffer = window.nifti.readImage(niftiData.header, niftiData.niftiBuffer);
                        updateProgress(90);
                        
                        // Convert image data to appropriate typed array
                        let imageData;
                        const dataType = niftiData.header.datatypeCode;
                        
                        switch (dataType) {
                            case 2: imageData = new Uint8Array(imageArrayBuffer); break;
                            case 4: imageData = new Int16Array(imageArrayBuffer); break;
                            case 8: imageData = new Int32Array(imageArrayBuffer); break;
                            case 16: imageData = new Float32Array(imageArrayBuffer); break;
                            case 64: imageData = new Float64Array(imageArrayBuffer); break;
                            case 512: imageData = new Uint16Array(imageArrayBuffer); break;
                            case 768: imageData = new Uint32Array(imageArrayBuffer); break;
                            default:
                                imageData = new Float32Array(imageArrayBuffer);
                                debug('Unknown data type, using Float32Array');
                        }
                        
                        debug('Image data loaded, length: ' + imageData.length);
                        
                        // Update stored data
                        niftiData.image = imageData;
                        niftiData.isHeaderOnly = false;
                        delete niftiData.niftiBuffer; // Free memory
                        
                        // Calculate global intensity range for consistent normalization across all slices
                        calculateGlobalIntensityRange();
                        
                        updateProgress(100);
                        showLoading(false);
                        
                        // Render the current slice now that data is ready
                        renderSlice();
                        
                    } catch (error) {
                        debug('Error loading image data: ' + error.message);
                        handleError('Error loading image data: ' + error.message);
                    }
                }
                
                function initializeViewerWithHeader() {
                    debug('Initializing viewer with header info...');
                    
                    // Calculate dimensions for initial axial view
                    calculateViewDimensions();
                    
                    // Set up slice slider
                    currentSlice = Math.floor(currentViewDimensions.maxSlice / 2);
                    
                    const sliceSlider = document.getElementById('sliceSlider');
                    if (sliceSlider) {
                        sliceSlider.max = currentViewDimensions.maxSlice;
                        sliceSlider.value = currentSlice;
                        document.getElementById('sliceValue').textContent = currentSlice;
                    }
                    
                    // Show a placeholder while image data loads
                    showPlaceholder();
                    
                    debug('Viewer UI initialized, loading image data...');
                }
                
                function initializeViewer() {
                    debug('Initializing viewer...');
                    
                    // Calculate dimensions for initial axial view
                    calculateViewDimensions();
                    
                    // Set up slice slider
                    currentSlice = Math.floor(currentViewDimensions.maxSlice / 2);
                    
                    const sliceSlider = document.getElementById('sliceSlider');
                    if (sliceSlider) {
                        sliceSlider.max = currentViewDimensions.maxSlice;
                        sliceSlider.value = currentSlice;
                        document.getElementById('sliceValue').textContent = currentSlice;
                    }
                    
                    // Render first slice
                    renderSlice();
                    
                    // Hide loading
                    showLoading(false);
                    
                    debug('Viewer initialized');
                }
                
                function showPlaceholder() {
                    if (!canvas || !currentViewDimensions.displayWidth) return;
                    
                    // Set canvas to calculated dimensions
                    canvas.width = currentViewDimensions.displayWidth;
                    canvas.height = currentViewDimensions.displayHeight;
                    
                    // Draw a simple loading pattern
                    ctx.fillStyle = '#333333';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    
                    ctx.fillStyle = '#666666';
                    ctx.font = '16px var(--vscode-font-family)';
                    ctx.textAlign = 'center';
                    ctx.fillText('Loading image data...', canvas.width / 2, canvas.height / 2);
                    
                    scaleCanvas();
                }
                
                // Simple cache for recently rendered slices
                const sliceCache = new Map();
                const MAX_CACHE_SIZE = 10;
                
                function renderSlice() {
                    if (!niftiData) {
                        debug('No NIfTI data available for rendering');
                        return;
                    }
                    
                    if (!currentViewDimensions.dataWidth) {
                        debug('View dimensions not calculated');
                        return;
                    }
                    
                    // If image data is not loaded yet, show placeholder
                    if (niftiData.isHeaderOnly) {
                        showPlaceholder();
                        return;
                    }
                    
                    // Ensure global intensity range is calculated
                    if (globalIntensityRange.normFactor === 0) {
                        debug('Global intensity range not calculated, calculating now...');
                        calculateGlobalIntensityRange();
                    }
                    
                    debug('Rendering slice ' + currentSlice);
                    
                    try {
                        const imageData = niftiData.image;
                        const dims = niftiData.header.dims;
                        const nx = dims[1], ny = dims[2], nz = dims[3];
                        
                        // Use pre-calculated dimensions
                        const dataWidth = currentViewDimensions.dataWidth;
                        const dataHeight = currentViewDimensions.dataHeight;
                        const displayWidth = currentViewDimensions.displayWidth;
                        const displayHeight = currentViewDimensions.displayHeight;
                        const maxSlice = currentViewDimensions.maxSlice;
                        
                        if (currentSlice > maxSlice) {
                            debug('Slice index out of bounds: ' + currentSlice + ' > ' + maxSlice);
                            return;
                        }
                        
                        // Set canvas size (consistent for all slices in this view)
                        canvas.width = displayWidth;
                        canvas.height = displayHeight;
                        
                        debug('Canvas set to: ' + canvas.width + 'x' + canvas.height + ' for slice ' + currentSlice);
                        
                        // Check cache first
                        const cacheKey = currentAxis + '_' + currentSlice;
                        if (sliceCache.has(cacheKey)) {
                            debug('Using cached slice');
                            const cachedData = sliceCache.get(cacheKey);
                            renderSliceFromData(cachedData);
                            return;
                        }
                        
                        // Extract slice data based on axis (using native resolution)
                        const sliceSize = dataWidth * dataHeight;
                        let sliceData = new Float32Array(sliceSize);
                        
                        // Handle DICOM files (single slice)
                        if (niftiData.isDicom) {
                            // For DICOM, just use the single slice data
                            sliceData.set(imageData);
                            debug('DICOM slice extracted: ' + dataWidth + 'x' + dataHeight);
                        } else {
                            // Optimized extraction with minimal function calls for NIfTI
                            if (currentAxis === 'axial') {
                                // Extract XY slice at Z = currentSlice - fastest case
                                const axialStart = currentSlice * nx * ny;
                                sliceData.set(imageData.subarray(axialStart, axialStart + nx * ny));
                                debug('Axial slice extracted: ' + nx + 'x' + ny + ' at Z=' + currentSlice);
                            } else if (currentAxis === 'sagittal') {
                                // Extract YZ slice at X = currentSlice (flip Z for correct anatomical orientation)
                                const stride = nx * ny;
                                for (let z = 0; z < nz; z++) {
                                    const zFlipped = nz - 1 - z; // Flip Z-axis for correct orientation
                                    const sourceStart = z * stride + currentSlice;
                                    const targetStart = zFlipped * ny;
                                    
                                    for (let y = 0; y < ny; y++) {
                                        sliceData[targetStart + y] = imageData[sourceStart + y * nx];
                                    }
                                }
                                debug('Sagittal slice extracted: ' + ny + 'x' + nz + ' at X=' + currentSlice + ' (Z-flipped)');
                            } else if (currentAxis === 'coronal') {
                                // Extract XZ slice at Y = currentSlice (flip Z for correct anatomical orientation)
                                const stride = nx * ny;
                                const yOffset = currentSlice * nx;
                                
                                for (let z = 0; z < nz; z++) {
                                    const zFlipped = nz - 1 - z; // Flip Z-axis for correct anatomical orientation
                                    const sourceStart = z * stride + yOffset;
                                    const targetStart = zFlipped * nx;
                                    
                                    for (let x = 0; x < nx; x++) {
                                        sliceData[targetStart + x] = imageData[sourceStart + x];
                                    }
                                }
                                debug('Coronal slice extracted: ' + nx + 'x' + nz + ' at Y=' + currentSlice + ' (Z-flipped)');
                            }
                        }
                        
                        // Cache the extracted slice
                        if (sliceCache.size >= MAX_CACHE_SIZE) {
                            const firstKey = sliceCache.keys().next().value;
                            sliceCache.delete(firstKey);
                        }
                        sliceCache.set(cacheKey, sliceData);
                        
                        // Render the extracted slice
                        renderSliceFromData(sliceData);
                        
                    } catch (error) {
                        debug('Error rendering slice: ' + error.message);
                        handleError('Error rendering slice: ' + error.message);
                    }
                }
                
                function renderSliceFromData(sliceData) {
                    const displayWidth = currentViewDimensions.displayWidth;
                    const displayHeight = currentViewDimensions.displayHeight;
                    
                    // Create canvas image data
                    const canvasImageData = ctx.createImageData(displayWidth, displayHeight);
                    const pixelData = canvasImageData.data;
                    
                    // Get brightness and contrast values
                    const brightness = document.getElementById('brightnessSlider').value / 100;
                    const contrast = document.getElementById('contrastSlider').value / 100;
                    
                    // Use global intensity range for consistent normalization across all slices
                    const { min, max, normFactor } = globalIntensityRange;
                    
                    debug('Rendering with global intensity range: ' + min.toFixed(2) + ' to ' + max.toFixed(2));
                    
                    // Convert to grayscale pixels (optimized loop)
                    for (let i = 0; i < sliceData.length; i++) {
                        let value = sliceData[i];
                        
                        // Normalize to 0-255 using global intensity range
                        value = (value - min) * normFactor;
                        
                        // Apply contrast and brightness
                        value = (value - 128) * contrast + 128 + (brightness - 1) * 128;
                        value = Math.max(0, Math.min(255, value));
                        
                        const pixelIndex = i * 4;
                        pixelData[pixelIndex] = value;     // R
                        pixelData[pixelIndex + 1] = value; // G
                        pixelData[pixelIndex + 2] = value; // B
                        pixelData[pixelIndex + 3] = 255;   // A
                    }
                    
                    // Draw to canvas first
                    ctx.putImageData(canvasImageData, 0, 0);
                    
                    // Apply transformations
                    applyImageTransformations();
                    
                    // Scale canvas to fit container
                    scaleCanvas();
                    
                    debug('Slice rendered successfully');
                }
                
                function applyImageTransformations() {
                    if (!canvas) return;
                    
                    // Get the current image data
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const data = imageData.data;
                    const width = canvas.width;
                    const height = canvas.height;
                    
                    // Create a new canvas for transformations
                    const tempCanvas = document.createElement('canvas');
                    const tempCtx = tempCanvas.getContext('2d');
                    
                    // Set up the temporary canvas
                    tempCanvas.width = width;
                    tempCanvas.height = height;
                    tempCtx.putImageData(imageData, 0, 0);
                    
                    // Clear the main canvas
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    
                    // Apply transformations
                    ctx.save();
                    
                    // Move to center for rotation
                    ctx.translate(canvas.width / 2, canvas.height / 2);
                    
                    // Apply rotation
                    if (imageTransform.rotation !== 0) {
                        ctx.rotate((imageTransform.rotation * Math.PI) / 180);
                    }
                    
                    // Apply flips
                    if (imageTransform.flipHorizontal) {
                        ctx.scale(-1, 1);
                    }
                    if (imageTransform.flipVertical) {
                        ctx.scale(1, -1);
                    }
                    
                    // Draw the transformed image
                    ctx.drawImage(tempCanvas, -width / 2, -height / 2);
                    
                    ctx.restore();
                }
                
                function scaleCanvas() {
                    if (!canvas || !currentViewDimensions.physicalAspectRatio) return;
                    
                    const container = document.querySelector('.canvas-container');
                    if (!container) return;
                    
                    const containerWidth = container.clientWidth - 40; // Some padding
                    const containerHeight = container.clientHeight - 40;
                    
                    // Get the physical aspect ratio for this view
                    const physicalAspectRatio = currentViewDimensions.physicalAspectRatio;
                    
                    // Calculate what the canvas should look like with correct physical proportions
                    const baseSize = 400; // Base size for scaling calculations
                    let physicalWidth, physicalHeight;
                    
                    if (physicalAspectRatio > 1) {
                        // Wider than tall (landscape)
                        physicalWidth = baseSize;
                        physicalHeight = baseSize / physicalAspectRatio;
                    } else {
                        // Taller than wide (portrait)
                        physicalWidth = baseSize * physicalAspectRatio;
                        physicalHeight = baseSize;
                    }
                    
                    // Calculate scale to fit the physically-correct dimensions in the container
                    const scaleX = containerWidth / physicalWidth;
                    const scaleY = containerHeight / physicalHeight;
                    const scale = Math.min(scaleX, scaleY);
                    
                    // Apply constraints
                    const finalScale = Math.max(0.1, Math.min(2, scale));
                    
                    // Calculate the final display size with correct aspect ratio
                    const displayWidth = physicalWidth * finalScale;
                    const displayHeight = physicalHeight * finalScale;
                    
                    // Calculate scaling factors relative to canvas native size
                    const scaleFactorX = displayWidth / canvas.width;
                    const scaleFactorY = displayHeight / canvas.height;
                    
                    // Apply the transform that achieves both sizing and aspect ratio correction
                    canvas.style.transform = 'scale(' + scaleFactorX + ', ' + scaleFactorY + ')';
                    
                    debug('Physical aspect: ' + physicalAspectRatio.toFixed(3) + 
                          ', Scale: ' + scaleFactorX.toFixed(3) + 'x' + scaleFactorY.toFixed(3));
                }
                
                function saveSettings() {
                    const brightnessSlider = document.getElementById('brightnessSlider');
                    const contrastSlider = document.getElementById('contrastSlider');
                    
                    if (brightnessSlider && contrastSlider) {
                        const brightness = parseInt(brightnessSlider.value);
                        const contrast = parseInt(contrastSlider.value);
                        
                        // Send settings to extension for persistence
                        vscode.postMessage({
                            type: 'saveSettings',
                            brightness: brightness,
                            contrast: contrast
                        });
                    }
                }
                
                function loadSavedSettings(brightness, contrast) {
                    debug('Applying saved settings...');
                    
                    const brightnessSlider = document.getElementById('brightnessSlider');
                    if (brightnessSlider) {
                        brightnessSlider.value = brightness;
                        document.getElementById('brightnessValue').textContent = brightness + '%';
                    }
                    
                    const contrastSlider = document.getElementById('contrastSlider');
                    if (contrastSlider) {
                        contrastSlider.value = contrast;
                        document.getElementById('contrastValue').textContent = contrast + '%';
                    }
                    
                    // Re-render with new settings if image is loaded
                    if (niftiData) {
                        renderSlice();
                    }
                }
                
                function resetIntensity() {
                    debug('Resetting intensity to defaults...');
                    
                    // Reset brightness
                    const brightnessSlider = document.getElementById('brightnessSlider');
                    if (brightnessSlider) {
                        brightnessSlider.value = 100;
                        document.getElementById('brightnessValue').textContent = '100%';
                    }
                    
                    // Reset contrast
                    const contrastSlider = document.getElementById('contrastSlider');
                    if (contrastSlider) {
                        contrastSlider.value = 100;
                        document.getElementById('contrastValue').textContent = '100%';
                    }
                    
                    // Save the reset values
                    saveSettings();
                    
                    // Re-render current slice
                    renderSlice();
                }
                
                function resetTransformations() {
                    debug('Resetting transformations to defaults...');
                    
                    // Reset transformations
                    imageTransform = {
                        flipHorizontal: false,
                        flipVertical: false,
                        rotation: 0
                    };
                    
                    // Update button states
                    updateTransformButtonStates();
                    
                    // Re-render current slice
                    renderSlice();
                }
                
                function resetView() {
                    debug('Resetting view to defaults...');
                    
                    // Reset intensity
                    resetIntensity();
                    
                    // Reset transformations
                    resetTransformations();
                }
                
                function calculateGlobalIntensityRange() {
                    if (!niftiData || !niftiData.image) return;
                    
                    debug('Calculating global intensity range for entire volume...');
                    
                    const imageData = niftiData.image;
                    const length = imageData.length;
                    
                    // Find global min/max values across entire volume (vectorized)
                    let min = imageData[0], max = imageData[0];
                    
                    // Optimized loop for finding min/max
                    for (let i = 1; i < length; i++) {
                        const value = imageData[i];
                        if (value < min) min = value;
                        if (value > max) max = value;
                    }
                    
                    // Calculate normalization factor
                    const range = max - min;
                    const normFactor = range > 0 ? 255 / range : 0;
                    
                    // Store global values
                    globalIntensityRange = {
                        min: min,
                        max: max,
                        normFactor: normFactor
                    };
                    
                    debug('Global intensity range: ' + min.toFixed(2) + ' to ' + max.toFixed(2) + 
                          ' (range: ' + range.toFixed(2) + ', norm factor: ' + normFactor.toFixed(4) + ')');
                }
                
                function calculateViewDimensions() {
                    if (!niftiData) return;

                    const header = niftiData.header;
                    const dims = header.dims;
                    const nx = dims[1], ny = dims[2], nz = dims[3];

                    let dataWidth, dataHeight, maxSlice;
                    let physicalWidth, physicalHeight;
                    let voxelX = 1, voxelY = 1, voxelZ = 1; // <-- Add this line

                    if (niftiData.isDicom) {
                        // For DICOM, force axial view and disable multi-planar reconstruction
                        currentAxis = 'axial';
                        dataWidth = nx;
                        dataHeight = ny;
                        physicalWidth = nx;
                        physicalHeight = ny;
                        maxSlice = 0; // Single slice
                        
                        
                        // Hide axis toggle buttons for DICOM
                        const axisToggles = document.querySelectorAll('.axis-toggle');
                        axisToggles.forEach(toggle => {
                            if (toggle.dataset.axis !== 'axial') {
                                toggle.style.display = 'none';
                            }
                        });
                        
                        // Hide slice slider for DICOM
                        const sliceSlider = document.getElementById('sliceSlider');
                        if (sliceSlider) {
                            sliceSlider.style.display = 'none';
                        }
                        const sliceValue = document.getElementById('sliceValue');
                        if (sliceValue) {
                            sliceValue.style.display = 'none';
                        }
                        
                        debug('DICOM view dimensions: ' + dataWidth + 'x' + dataHeight + ' (single slice)');
                    } else {
                        // Get voxel spacing from header with validation
                        const pixDims = header.pixDims || [1, 1, 1, 1];
                        voxelX = pixDims[1] || 1;
                        voxelY = pixDims[2] || 1;
                        voxelZ = pixDims[3] || 1;
                        
                        // Validate and fix invalid voxel spacing
                        if (voxelX <= 0 || isNaN(voxelX)) voxelX = 1;
                        if (voxelY <= 0 || isNaN(voxelY)) voxelY = 1;
                        if (voxelZ <= 0 || isNaN(voxelZ)) voxelZ = 1;
                        
                        debug('Raw pixDims: [' + (pixDims[0] || 'undefined') + ', ' + 
                              (pixDims[1] || 'undefined') + ', ' + (pixDims[2] || 'undefined') + ', ' + 
                              (pixDims[3] || 'undefined') + ']');
                        
                        // Show all axis toggle buttons for NIfTI
                        const axisToggles = document.querySelectorAll('.axis-toggle');
                        axisToggles.forEach(toggle => {
                            toggle.style.display = 'flex';
                        });
                        
                        // Show slice slider for NIfTI
                        const sliceSlider = document.getElementById('sliceSlider');
                        if (sliceSlider) {
                            sliceSlider.style.display = 'block';
                        }
                        const sliceValue = document.getElementById('sliceValue');
                        if (sliceValue) {
                            sliceValue.style.display = 'block';
                        }
                        
                        // Get dimensions based on current axis
                        switch (currentAxis) {
                            case 'axial':
                                dataWidth = nx;
                                dataHeight = ny;
                                physicalWidth = nx * voxelX;
                                physicalHeight = ny * voxelY;
                                maxSlice = nz - 1; // 0-based indexing
                                break;
                            case 'sagittal':
                                dataWidth = ny;
                                dataHeight = nz;
                                physicalWidth = ny * voxelY;
                                physicalHeight = nz * voxelZ;
                                maxSlice = nx - 1; // 0-based indexing
                                break;
                            case 'coronal':
                                dataWidth = nx;
                                dataHeight = nz;
                                physicalWidth = nx * voxelX;
                                physicalHeight = nz * voxelZ;
                                maxSlice = ny - 1; // 0-based indexing
                                break;
                            default:
                                dataWidth = nx;
                                dataHeight = ny;
                                physicalWidth = nx * voxelX;
                                physicalHeight = ny * voxelY;
                                maxSlice = nz - 1; // 0-based indexing
                        }
                    }
                    
                    // Calculate physical aspect ratio
                    const physicalAspectRatio = physicalWidth / physicalHeight;
                    
                    // Use native data resolution directly - no interpolation needed
                    // This preserves maximum image quality for medical viewing
                    let displayWidth = dataWidth;
                    let displayHeight = dataHeight;
                    
                    debug('Using native data resolution for maximum quality');
                    
                    // Store calculated dimensions
                    currentViewDimensions = {
                        dataWidth: dataWidth,
                        dataHeight: dataHeight,
                        displayWidth: displayWidth,
                        displayHeight: displayHeight,
                        maxSlice: maxSlice,
                        physicalAspectRatio: physicalAspectRatio
                    };
                    
                    debug('=== VIEW DIMENSIONS CALCULATED ===');
                    debug('Axis: ' + currentAxis);
                    debug('Voxel spacing: ' + voxelX.toFixed(2) + 'x' + voxelY.toFixed(2) + 'x' + voxelZ.toFixed(2) + ' mm');
                    debug('Data dimensions: ' + dataWidth + 'x' + dataHeight);
                    debug('Physical dimensions: ' + physicalWidth.toFixed(1) + 'mm x ' + physicalHeight.toFixed(1) + 'mm');
                    debug('Aspect ratio: ' + physicalAspectRatio.toFixed(3) + ' (width/height)');
                    debug('Display dimensions: ' + displayWidth + 'x' + displayHeight + ' (native resolution)');
                    debug('Max slice: ' + maxSlice);
                    debug('==================================');
                }
                
                function updateSliceControls() {
                    const sliceSlider = document.getElementById('sliceSlider');
                    if (sliceSlider) {
                        sliceSlider.value = currentSlice;
                        document.getElementById('sliceValue').textContent = currentSlice;
                    }
                }
                
                function updateTransformButtonStates() {
                    const flipH = document.getElementById('flipH');
                    const flipV = document.getElementById('flipV');
                    const rotateCW = document.getElementById('rotateCW');
                    const rotateCCW = document.getElementById('rotateCCW');
                    
                    if (flipH) {
                        flipH.style.background = imageTransform.flipHorizontal ? 
                            'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)';
                        flipH.style.color = imageTransform.flipHorizontal ? 
                            'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)';
                    }
                    
                    if (flipV) {
                        flipV.style.background = imageTransform.flipVertical ? 
                            'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)';
                        flipV.style.color = imageTransform.flipVertical ? 
                            'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)';
                    }
                    
                    if (rotateCW) {
                        rotateCW.style.background = imageTransform.rotation === 90 ? 
                            'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)';
                        rotateCW.style.color = imageTransform.rotation === 90 ? 
                            'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)';
                    }
                    
                    if (rotateCCW) {
                        rotateCCW.style.background = imageTransform.rotation === 270 ? 
                            'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)';
                        rotateCCW.style.color = imageTransform.rotation === 270 ? 
                            'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)';
                    }
                }
                
                function updateAxisView() {
                    if (!niftiData) return;
                    
                    debug('>>> SWITCHING TO AXIS: ' + currentAxis + ' <<<');
                    
                    // Clear slice cache when switching axes (intensity normalization may change)
                    sliceCache.clear();
                    
                    // Reset transformations when switching axes
                    imageTransform = {
                        flipHorizontal: false,
                        flipVertical: false,
                        rotation: 0
                    };
                    
                    // Calculate dimensions for this view
                    calculateViewDimensions();
                    
                    // Update slice controls
                    currentSlice = Math.floor(currentViewDimensions.maxSlice / 2);
                    
                    const sliceSlider = document.getElementById('sliceSlider');
                    if (sliceSlider) {
                        sliceSlider.max = currentViewDimensions.maxSlice;
                        sliceSlider.value = currentSlice;
                        document.getElementById('sliceValue').textContent = currentSlice;
                    }
                    
                    // Update button states
                    updateTransformButtonStates();
                    
                    debug('Axis view updated, rendering slice...');
                    renderSlice();
                }
                
                function showLoading(show) {
                    const loading = document.getElementById('loading');
                    if (loading) {
                        loading.style.display = show ? 'block' : 'none';
                    }
                }
                
                function updateProgress(percent) {
                    const progressFill = document.getElementById('progressFill');
                    if (progressFill) {
                        progressFill.style.width = percent + '%';
                    }
                }
                
                function handleDicomSeries(fileCount, files) {
                    debug('Handling DICOM series with ' + fileCount + ' files');
                    showLoading(false);
                    
                    const container = document.querySelector('.canvas-container');
                    if (container) {
                        const fileList = files.slice(0, 5).join(', ') + (files.length > 5 ? '...' : '');
                        container.innerHTML = 
                            '<div style="text-align: center; padding: 2em;">' +
                            '<h3>DICOM Series Detected!</h3>' +
                            '<p>Found ' + fileCount + ' DICOM files in this folder.</p>' +
                            '<p><strong>Full 3D volume viewing coming soon!</strong></p>' +
                            '<p style="font-size: 0.9em; color: #888;">' +
                            'Files: ' + fileList +
                            '</p>' +
                            '</div>';
                    }
                }
                
                function handleError(message) {
                    debug('ERROR: ' + message);
                    showLoading(false);
                    
                    const container = document.querySelector('.canvas-container');
                    if (container) {
                        container.innerHTML = '<div class="error"><h3>Error loading medical image file</h3><p>' + message + '</p></div>';
                    }
                }
                
                // Handle window resize
                window.addEventListener('resize', () => {
                    if (canvas) {
                        scaleCanvas();
                    }
                });
                
                debug('Script loaded successfully - Version: ' + new Date().toISOString());
            </script>
        </body>
        </html>`;
    }

    private sendSavedSettings(webviewPanel: vscode.WebviewPanel) {
        // Get saved brightness and contrast from workspace state
        const savedBrightness = this.context.workspaceState.get<number>('medview.brightness', 100);
        const savedContrast = this.context.workspaceState.get<number>('medview.contrast', 100);
        
        setTimeout(() => {
            webviewPanel.webview.postMessage({
                type: 'loadSettings',
                brightness: savedBrightness,
                contrast: savedContrast
            });
        }, 200); // Small delay to ensure webview is ready
    }

    private async handleWebviewMessage(
        message: any,
        webviewPanel: vscode.WebviewPanel,
        document: vscode.CustomDocument
    ) {
        console.log('Extension received message:', message.type);
        
        switch (message.type) {
            case 'readFile':
                try {
                    console.log('Reading file:', document.uri.toString());
                    
                    // Check if this is a directory (DICOM series)
                    const stat = await vscode.workspace.fs.stat(document.uri);
                    if (stat.type === vscode.FileType.Directory) {
                        // Handle DICOM series
                        await this.handleDicomSeries(document.uri, webviewPanel);
                    } else {
                        // Handle single file
                        const fileData = await vscode.workspace.fs.readFile(document.uri);
                        console.log('File read successfully, size:', fileData.length);
                        
                        // Detect file type based on extension
                        const fileExtension = path.extname(document.uri.fsPath).toLowerCase();
                        let fileType = 'unknown';
                        
                        if (fileExtension === '.nii' || fileExtension === '.gz') {
                            fileType = 'nifti';
                        } else if (fileExtension === '.dcm') {
                            fileType = 'dicom';
                        }
                        
                        // Send file data to webview for processing
                        webviewPanel.webview.postMessage({
                            type: 'fileData',
                            data: Array.from(fileData),
                            fileType: fileType
                        });
                    }
                } catch (error) {
                    console.error('Error reading file:', error);
                    webviewPanel.webview.postMessage({
                        type: 'error',
                        message: `Failed to read file: ${error}`
                    });
                }
                break;
            case 'saveSettings':
                try {
                    // Save brightness and contrast to workspace state
                    await this.context.workspaceState.update('medview.brightness', message.brightness);
                    await this.context.workspaceState.update('medview.contrast', message.contrast);
                    console.log('Settings saved:', message.brightness, message.contrast);
                } catch (error) {
                    console.error('Error saving settings:', error);
                }
                break;
        }
    }

    private async handleDicomSeries(folderUri: vscode.Uri, webviewPanel: vscode.WebviewPanel) {
        try {
            console.log('Handling DICOM series from folder:', folderUri.toString());
            
            // List all files in the directory
            const files = await vscode.workspace.fs.readDirectory(folderUri);
            console.log('All files in directory:', files.map(([name, type]) => `${name} (${type})`));
            
            const dicomFiles = files
                .filter(([filename, fileType]) => {
                    const isFile = fileType === vscode.FileType.File;
                    const isDicom = filename.toLowerCase().endsWith('.dcm');
                    console.log(`File: ${filename}, isFile: ${isFile}, isDicom: ${isDicom}`);
                    return isFile && isDicom;
                })
                .map(([filename]) => filename);
            
            console.log(`Found ${dicomFiles.length} DICOM files:`, dicomFiles);
            
            if (dicomFiles.length === 0) {
                webviewPanel.webview.postMessage({
                    type: 'error',
                    message: 'No DICOM files found in this folder'
                });
                return;
            }
            
            console.log(`Found ${dicomFiles.length} DICOM files`);
            
            // For now, just show a message that series support is coming
            webviewPanel.webview.postMessage({
                type: 'dicomSeries',
                fileCount: dicomFiles.length,
                files: dicomFiles
            });
            
        } catch (error) {
            console.error('Error handling DICOM series:', error);
            webviewPanel.webview.postMessage({
                type: 'error',
                message: `Failed to read DICOM series: ${error}`
            });
        }
    }
}

class DicomSeriesProvider implements vscode.CustomReadonlyEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        return {
            uri,
            dispose: () => {}
        };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media')
            ]
        };
        // Serve a real viewer UI (reuse the NIfTI viewer HTML, but adapt for DICOM series)
        webviewPanel.webview.html = this.getWebviewContent(webviewPanel.webview, document.uri);

        // Listen for messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                if (message.type === 'requestDicomSeries') {
                    // Find all .dcm files in the same folder as the .series.dicom file
                    const folderUri = vscode.Uri.joinPath(document.uri, '..');
                    try {
                        console.log('Looking for DICOM files in folder:', folderUri.toString());
                        const files = await vscode.workspace.fs.readDirectory(folderUri);
                        console.log('All files in directory:', files.map(([name, type]) => `${name} (${type})`));
                        
                        const dicomFiles = files
                            .filter(([filename, fileType]) => {
                                const isFile = fileType === vscode.FileType.File;
                                const isDicom = filename.toLowerCase().endsWith('.dcm');
                                console.log(`File: ${filename}, isFile: ${isFile}, isDicom: ${isDicom}`);
                                return isFile && isDicom;
                            })
                            .map(([filename]) => vscode.Uri.joinPath(folderUri, filename));
                        
                        console.log('Found DICOM files:', dicomFiles.length);
                        
                        if (dicomFiles.length === 0) {
                            webviewPanel.webview.postMessage({
                                type: 'error',
                                message: 'No DICOM files found in this folder.'
                            });
                            return;
                        }
                        // Read and parse all DICOM files for metadata only
                        const slices = [];
                        for (const fileUri of dicomFiles) {
                            try {
                                const fileData = await vscode.workspace.fs.readFile(fileUri);
                                const uint8Data = new Uint8Array(fileData);
                                const dataSet = dicomParser.parseDicom(uint8Data);
                                
                                // Extract metadata only (no pixel data)
                                const instanceNumber = dataSet.intString('x00200013') || 0;
                                const sliceLocation = dataSet.floatString('x00201041') || 0;
                                const rows = dataSet.uint16('x00280010');
                                const cols = dataSet.uint16('x00280011');
                                const bitsAllocated = dataSet.uint16('x00280100');
                                const windowCenter = dataSet.floatString('x00281050') || 128;
                                const windowWidth = dataSet.floatString('x00281051') || 256;
                                
                                slices.push({
                                    filePath: fileUri.fsPath,
                                    instanceNumber,
                                    sliceLocation,
                                    rows,
                                    cols,
                                    bitsAllocated,
                                    windowCenter,
                                    windowWidth,
                                    hasPixelData: dataSet.elements.x7fe00010 ? true : false
                                });
                            } catch (e) {
                                console.warn('Failed to parse DICOM file:', fileUri.fsPath, e);
                                // Skip unreadable files
                            }
                        }
                        
                        // Sort slices by instance number or slice location
                        slices.sort((a, b) => (a.instanceNumber || a.sliceLocation) - (b.instanceNumber || b.sliceLocation));
                        
                        console.log(`Sending ${slices.length} DICOM slice metadata to webview`);
                        
                        // Send metadata only to webview
                        webviewPanel.webview.postMessage({
                            type: 'dicomSeriesData',
                            slices: slices
                        });
                    } catch (err) {
                        webviewPanel.webview.postMessage({
                            type: 'error',
                            message: 'Failed to load DICOM series: ' + err
                        });
                    }
                } else if (message.type === 'requestSliceData') {
                    // Handle request for individual slice pixel data
                    try {
                        const filePath = message.filePath;
                        const sliceIndex = message.sliceIndex;
                        
                        console.log(`Loading pixel data for slice ${sliceIndex} from: ${filePath}`);
                        
                        const fileUri = vscode.Uri.file(filePath);
                        const fileData = await vscode.workspace.fs.readFile(fileUri);
                        const uint8Data = new Uint8Array(fileData);
                        const dataSet = dicomParser.parseDicom(uint8Data);
                        
                        // Extract pixel data
                        const pixelDataElement = dataSet.elements.x7fe00010;
                        if (!pixelDataElement) {
                            throw new Error('No pixel data found in DICOM file');
                        }
                        
                        const pixelData = new Uint8Array(dataSet.byteArray.buffer, pixelDataElement.dataOffset, pixelDataElement.length);
                        
                        console.log(`Sending pixel data for slice ${sliceIndex}, size: ${pixelData.length} bytes`);
                        
                        // Send pixel data to webview
                        webviewPanel.webview.postMessage({
                            type: 'sliceData',
                            sliceIndex: sliceIndex,
                            pixelData: Array.from(pixelData)
                        });
                        
                    } catch (err) {
                        console.error('Error loading slice pixel data:', err);
                        webviewPanel.webview.postMessage({
                            type: 'error',
                            message: 'Failed to load slice pixel data: ' + err
                        });
                    }
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    private getWebviewContent(webview: vscode.Webview, fileUri: vscode.Uri): string {
        const axialIconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'axial_ico.png')
        );
        const sagittalIconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sagittal_ico.png')
        );
        const frontalIconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'frontal_ico.png')
        );
        const fileName = path.basename(fileUri.fsPath);
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DICOM Series Viewer - ${fileName}</title>
    <style>
        body { 
            font-family: var(--vscode-font-family); 
            background-color: var(--vscode-editor-background); 
            color: var(--vscode-editor-foreground); 
            margin: 0; 
            padding: 0; 
            overflow: hidden; 
        }
        .container { 
            display: flex; 
            flex-direction: column; 
            height: 100vh; 
            width: 100vw; 
        }
        .header { 
            padding: 10px; 
            background-color: var(--vscode-sideBar-background); 
            border-bottom: 1px solid var(--vscode-widget-border); 
            flex-shrink: 0; 
        }
        .viewer-container { 
            flex: 1; 
            display: flex; 
            flex-direction: row; 
            position: relative; 
            overflow: hidden; 
        }
        .left-panel { 
            flex: 1; 
            display: flex; 
            flex-direction: column; 
            min-width: 0; 
        }
        .canvas-container { 
            flex: 1; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            background-color: #000; 
            position: relative; 
        }
        .bottom-controls { 
            padding: 10px; 
            background-color: var(--vscode-sideBar-background); 
            border-top: 1px solid var(--vscode-widget-border); 
            display: flex; 
            flex-direction: column; 
            gap: 10px; 
        }
        .slice-controls { 
            display: flex; 
            align-items: center; 
            gap: 15px; 
        }
        .slice-slider-container { 
            flex: 1; 
            display: flex; 
            align-items: center; 
            gap: 10px; 
        }
        .axis-toggle-group { 
            display: flex; 
            gap: 5px; 
        }
        .axis-toggle { 
            padding: 8px 12px; 
            background: var(--vscode-button-secondaryBackground); 
            color: var(--vscode-button-secondaryForeground); 
            border: 1px solid var(--vscode-button-border); 
            border-radius: 4px; 
            cursor: pointer; 
            font-size: 12px; 
            transition: all 0.2s ease; 
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            justify-content: center; 
            gap: 6px; 
            min-width: 80px; 
            min-height: 85px; 
        }
        .axis-toggle.active { 
            background: var(--vscode-button-background); 
            color: var(--vscode-button-foreground); 
        }
        .axis-toggle img { 
            width: 60px; 
            height: 60px; 
            opacity: 0.8; 
            transition: opacity 0.2s ease; 
            display: block; 
        }
        .axis-toggle.active img { 
            opacity: 1; 
        }
        .axis-toggle span { 
            text-align: center; 
            white-space: nowrap; 
        }
        .control-section { 
            margin-bottom: 20px; 
            padding-bottom: 15px; 
            border-bottom: 1px solid var(--vscode-widget-border); 
        }
        .control-section:last-child { 
            border-bottom: none; 
            margin-bottom: 0; 
        }
        .transform-controls { 
            display: block; 
            gap: 8px; 
        }
        .transform-row { 
            display: flex; 
            gap: 8px; 
            margin-bottom: 8px; 
        }
        .transform-row:last-child { 
            margin-bottom: 0; 
        }
        .transform-btn { 
            padding: 8px 12px; 
            background: var(--vscode-button-secondaryBackground); 
            color: var(--vscode-button-secondaryForeground); 
            border: 1px solid var(--vscode-button-border); 
            border-radius: 4px; 
            cursor: pointer; 
            font-size: 12px; 
            transition: all 0.2s ease; 
            width: 50%; 
        }
        .transform-btn:hover { 
            background: var(--vscode-button-hoverBackground); 
        }
        #imageCanvas { 
            max-width: 100%; 
            max-height: 100%; 
            image-rendering: pixelated; 
            cursor: crosshair; 
            border: 2px solid transparent; 
            transition: border-color 0.2s ease; 
        }
        #imageCanvas:focus { 
            border-color: var(--vscode-focusBorder); 
        }
        .navigation-hint { 
            position: absolute; 
            bottom: 10px; 
            left: 10px; 
            background-color: rgba(0, 0, 0, 0.7); 
            color: white; 
            padding: 5px 10px; 
            border-radius: 3px; 
            font-size: 11px; 
            font-family: var(--vscode-font-family); 
            opacity: 0.8; 
        }
        .controls { 
            width: 220px; 
            padding: 15px; 
            background-color: var(--vscode-sideBar-background); 
            border-left: 1px solid var(--vscode-widget-border); 
            display: flex; 
            flex-direction: column; 
            gap: 15px; 
            overflow-y: auto; 
        }
        .control-group { 
            display: flex; 
            flex-direction: column; 
            gap: 5px; 
        }
        .control-group label { 
            font-size: 12px; 
            color: var(--vscode-foreground); 
            margin-bottom: 5px; 
        }
        .slider-container { 
            display: flex; 
            align-items: center; 
            gap: 10px; 
        }
        input[type="range"] { 
            flex: 1; 
            height: 20px; 
            background: var(--vscode-scrollbarSlider-background); 
            outline: none; 
            border-radius: 10px; 
        }
        .loading { 
            position: absolute; 
            top: 50%; 
            left: 50%; 
            transform: translate(-50%, -50%); 
            background-color: var(--vscode-editor-background); 
            padding: 20px; 
            border-radius: 4px; 
            border: 1px solid var(--vscode-widget-border); 
            z-index: 1000; 
            display: block; 
        }
        .debug { 
            position: absolute; 
            top: 10px; 
            right: 10px; 
            background-color: rgba(0, 0, 0, 0.8); 
            color: white; 
            padding: 10px; 
            border-radius: 4px; 
            font-family: monospace; 
            font-size: 12px; 
            max-width: 300px; 
            word-wrap: break-word; 
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h3 style="margin: 0; font-size: 14px;">DICOM Series Viewer - ${fileName}</h3>
        </div>
        <div class="viewer-container">
            <div class="left-panel">
                <div class="canvas-container">
                    <canvas id="imageCanvas"></canvas>
                    <div class="loading" id="loading">
                        <div>Loading DICOM series...</div>
                    </div>
                    <div class="navigation-hint">
                        ↑↓←→ keys, mouse wheel, or slider to navigate slices
                    </div>
                    <div class="debug" id="debug">Initializing...</div>
                </div>
                <div class="bottom-controls">
                    <div class="slice-controls">
                        <div class="slice-slider-container">
                            <label style="font-size: 12px; color: var(--vscode-foreground);">Slice:</label>
                            <input type="range" id="sliceSlider" min="0" max="100" value="0" style="flex: 1;">
                            <span id="sliceValue" style="font-size: 12px; color: var(--vscode-foreground); min-width: 30px;">0</span>
                        </div>
                        <div class="axis-toggle-group">
                            <button class="axis-toggle active" data-axis="axial">
                                <img src="${axialIconUri}" alt="Axial">
                                <span>Axial</span>
                            </button>
                            <button class="axis-toggle" data-axis="sagittal">
                                <img src="${sagittalIconUri}" alt="Sagittal">
                                <span>Sagittal</span>
                            </button>
                            <button class="axis-toggle" data-axis="coronal">
                                <img src="${frontalIconUri}" alt="Coronal">
                                <span>Coronal</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="controls">
                <div class="control-section">
                    <h4 style="margin: 0 0 10px 0; font-size: 13px; color: var(--vscode-foreground);">Intensity Controls</h4>
                    <div class="control-group">
                        <label>Brightness</label>
                        <div class="slider-container">
                            <input type="range" id="brightnessSlider" min="0" max="200" value="100">
                            <span id="brightnessValue">100%</span>
                        </div>
                    </div>
                    <div class="control-group">
                        <label>Contrast</label>
                        <div class="slider-container">
                            <input type="range" id="contrastSlider" min="0" max="200" value="100">
                            <span id="contrastValue">100%</span>
                        </div>
                    </div>
                    <div class="control-group">
                        <button id="resetIntensityButton" style="padding: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; width: 100%;">Reset Intensity</button>
                    </div>
                </div>
                <div class="control-section">
                    <h4 style="margin: 0 0 10px 0; font-size: 13px; color: var(--vscode-foreground);">Image Transformations</h4>
                    <div class="transform-controls">
                        <div class="transform-row">
                            <button class="transform-btn" id="rotateCW">Rotate CW</button>
                            <button class="transform-btn" id="rotateCCW">Rotate CCW</button>
                        </div>
                        <div class="transform-row">
                            <button class="transform-btn" id="flipH">Flip H</button>
                            <button class="transform-btn" id="flipV">Flip V</button>
                        </div>
                    </div>
                    <div class="control-group" style="margin-top: 10px;">
                        <button id="resetTransformButton" style="padding: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; width: 100%;">Reset Transformations</button>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <script>
        // Request DICOM series data from the extension
        window.addEventListener('DOMContentLoaded', function() {
            const vscode = acquireVsCodeApi();
            vscode.postMessage({ type: 'requestDicomSeries' });
        });

        // DICOM Series Viewer Logic
        var slices = [];
        var currentSlice = 0;
        var brightness = 1.0;
        var contrast = 1.0;
        var loadedPixelData = {}; // Cache for loaded pixel data

        var loadingDiv = document.getElementById('loading');
        var debugDiv = document.getElementById('debug');
        var canvas = document.getElementById('imageCanvas');
        var ctx = canvas.getContext('2d');
        var sliceSlider = document.getElementById('sliceSlider');
        var sliceValue = document.getElementById('sliceValue');
        var brightnessSlider = document.getElementById('brightnessSlider');
        var brightnessValue = document.getElementById('brightnessValue');
        var contrastSlider = document.getElementById('contrastSlider');
        var contrastValue = document.getElementById('contrastValue');
        var resetIntensityButton = document.getElementById('resetIntensityButton');

        function showDebug(msg) {
            console.log('DICOM Series Viewer:', msg);
            if (debugDiv) debugDiv.textContent = msg;
        }

        function requestSliceData(sliceIndex) {
            if (!slices[sliceIndex]) {
                showDebug('Invalid slice index: ' + sliceIndex);
                return;
            }
            
            var slice = slices[sliceIndex];
            showDebug('Requesting pixel data for slice ' + (sliceIndex + 1) + ': ' + slice.filePath);
            
            vscode.postMessage({
                type: 'requestSliceData',
                sliceIndex: sliceIndex,
                filePath: slice.filePath
            });
        }

        function renderSlice(idx) {
            if (!slices.length || !slices[idx]) {
                showDebug('No valid slice metadata for index: ' + idx);
                return;
            }
            
            var slice = slices[idx];
            var rows = slice.rows;
            var cols = slice.cols;
            var bitsAllocated = slice.bitsAllocated;
            
            showDebug('Rendering slice ' + (idx + 1) + ' / ' + slices.length + ' (' + cols + 'x' + rows + ')');
            
            // Check if we have pixel data for this slice
            if (!loadedPixelData[idx]) {
                showDebug('Pixel data not loaded for slice ' + (idx + 1) + ', requesting...');
                requestSliceData(idx);
                return;
            }
            
            var pixelData = loadedPixelData[idx];
            
            var arr, min, max;
            if (bitsAllocated === 8) {
                arr = new Uint8ClampedArray(pixelData);
                min = 0;
                max = 255;
            } else if (bitsAllocated === 16) {
                var buf = new Uint16Array(pixelData.length / 2);
                for (var i = 0; i < buf.length; ++i) {
                    buf[i] = pixelData[2 * i] | (pixelData[2 * i + 1] << 8);
                }
                min = Math.min.apply(null, buf);
                max = Math.max.apply(null, buf);
                arr = new Uint8ClampedArray(buf.length);
                for (var i = 0; i < buf.length; ++i) {
                    arr[i] = 255 * (buf[i] - min) / (max - min || 1);
                }
            } else {
                showDebug('Unsupported bitsAllocated: ' + bitsAllocated);
                return;
            }
            
            for (var i = 0; i < arr.length; ++i) {
                var val = arr[i] * contrast + 128 * (1 - contrast) + 255 * (brightness - 1);
                arr[i] = Math.max(0, Math.min(255, val));
            }
            
            canvas.width = cols;
            canvas.height = rows;
            var imageData = ctx.createImageData(cols, rows);
            for (var i = 0; i < arr.length; ++i) {
                imageData.data[4 * i + 0] = arr[i];
                imageData.data[4 * i + 1] = arr[i];
                imageData.data[4 * i + 2] = arr[i];
                imageData.data[4 * i + 3] = 255;
            }
            ctx.putImageData(imageData, 0, 0);
            showDebug('Slice ' + (idx + 1) + ' / ' + slices.length + ' rendered successfully');
        }

        function updateSlice(idx) {
            currentSlice = idx;
            renderSlice(currentSlice);
            if (sliceSlider) sliceSlider.value = String(currentSlice);
            if (sliceValue) sliceValue.textContent = String(currentSlice + 1);
        }

        window.addEventListener('message', function(event) {
            var message = event.data;
            showDebug('Received message: ' + message.type);
            
            if (message.type === 'dicomSeriesData') {
                slices = message.slices || [];
                showDebug('Received ' + slices.length + ' slice metadata');
                
                if (!slices.length) {
                    showDebug('No slices found');
                    if (loadingDiv) loadingDiv.style.display = 'none';
                    return;
                }
                
                if (sliceSlider) {
                    sliceSlider.min = 0;
                    sliceSlider.max = slices.length - 1;
                    sliceSlider.value = 0;
                    sliceSlider.disabled = false;
                    sliceSlider.addEventListener('input', function(e) {
                        updateSlice(Number(sliceSlider.value));
                    });
                }
                if (sliceValue) sliceValue.textContent = '1';
                if (loadingDiv) loadingDiv.style.display = 'none';
                
                // Load the first slice
                updateSlice(0);
            } else if (message.type === 'sliceData') {
                var sliceIndex = message.sliceIndex;
                var pixelData = message.pixelData;
                
                showDebug('Received pixel data for slice ' + (sliceIndex + 1));
                loadedPixelData[sliceIndex] = pixelData;
                
                // If this is the current slice, render it
                if (sliceIndex === currentSlice) {
                    renderSlice(currentSlice);
                }
            } else if (message.type === 'error') {
                showDebug('Error: ' + message.message);
                if (loadingDiv) loadingDiv.style.display = 'none';
            }
        });

        if (brightnessSlider) {
            brightnessSlider.addEventListener('input', function() {
                brightness = Number(brightnessSlider.value) / 100;
                brightnessValue.textContent = Math.round(brightness * 100) + '%';
                renderSlice(currentSlice);
            });
        }
        if (contrastSlider) {
            contrastSlider.addEventListener('input', function() {
                contrast = Number(contrastSlider.value) / 100;
                contrastValue.textContent = Math.round(contrast * 100) + '%';
                renderSlice(currentSlice);
            });
        }
        if (resetIntensityButton) {
            resetIntensityButton.addEventListener('click', function() {
                brightness = 1.0;
                contrast = 1.0;
                brightnessSlider.value = '100';
                contrastSlider.value = '100';
                brightnessValue.textContent = '100%';
                contrastValue.textContent = '100%';
                renderSlice(currentSlice);
            });
        }
    </script>
</body>
</html>`;
    }
}
