// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('MedView NIfTI viewer extension activated');

    // Register the custom editor provider
    const provider = new NIfTIViewerProvider(context);
    const registration = vscode.window.registerCustomEditorProvider(
        'medview.viewer', 
        provider, 
        {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        }
    );

    context.subscriptions.push(registration);
}

export function deactivate() {}

class NIfTIViewerProvider implements vscode.CustomReadonlyEditorProvider {
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

        const fileName = path.basename(fileUri.fsPath);

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>NIfTI Viewer - ${fileName}</title>
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
                    position: relative;
                    overflow: hidden;
                }
                
                .canvas-container {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background-color: #000;
                    position: relative;
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
                    width: 200px;
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
                    <h3 style="margin: 0; font-size: 14px;">NIfTI Viewer - ${fileName}</h3>
                </div>
                
                <div class="viewer-container">
                    <div class="canvas-container">
                        <canvas id="imageCanvas"></canvas>
                        <div class="loading" id="loading">
                            <div>Loading NIfTI file...</div>
                        </div>
                        <div class="navigation-hint">
                            ↑↓←→ keys, mouse wheel, or slider to navigate slices
                        </div>
                        <div class="debug" id="debug">Initializing...</div>
                    </div>
                    
                    <div class="controls">
                        <div class="control-group">
                            <label>Slice</label>
                            <div class="slider-container">
                                <input type="range" id="sliceSlider" min="0" max="100" value="50">
                                <span id="sliceValue">50</span>
                            </div>
                        </div>
                        
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
                            <button id="resetButton" style="padding: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer;">Reset View</button>
                        </div>
                        
                        <div class="control-group">
                            <label>Axis</label>
                            <select id="axisSelect">
                                <option value="axial">Axial (Z)</option>
                                <option value="sagittal">Sagittal (X)</option>
                                <option value="coronal">Coronal (Y)</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>
            
            <script src="${niftiBundleUri}" onerror="console.error('Failed to load NIfTI bundle from: ${niftiBundleUri}')"></script>
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
                    
                    // Axis selection
                    const axisSelect = document.getElementById('axisSelect');
                    if (axisSelect) {
                        axisSelect.addEventListener('change', (e) => {
                            currentAxis = e.target.value;
                            updateAxisView();
                        });
                    }
                    
                    // Reset button
                    const resetButton = document.getElementById('resetButton');
                    if (resetButton) {
                        resetButton.addEventListener('click', () => {
                            resetView();
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
                            processFileData(message.data);
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
                
                function processFileData(data) {
                    debug('Processing file data, size: ' + data.length);
                    updateProgress(30);
                    
                    try {
                        // Convert to Uint8Array and then to ArrayBuffer
                        const uint8Array = new Uint8Array(data);
                        const arrayBuffer = uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength);
                        debug('Converted to ArrayBuffer, size: ' + arrayBuffer.byteLength);
                        updateProgress(40);
                        
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
                        
                    } catch (error) {
                        debug('Error processing file data: ' + error.message);
                        handleError('Error processing file data: ' + error.message);
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
                        handleError('Error parsing header: ' + error.message);
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
                        
                        // Optimized extraction with minimal function calls
                        if (currentAxis === 'axial') {
                            // Extract XY slice at Z = currentSlice - fastest case
                            const axialStart = currentSlice * nx * ny;
                            sliceData.set(imageData.subarray(axialStart, axialStart + nx * ny));
                        } else if (currentAxis === 'sagittal') {
                            // Extract YZ slice at X = currentSlice (flip Z to correct orientation)
                            const stride = nx * ny;
                            for (let z = 0; z < nz; z++) {
                                const zFlipped = nz - 1 - z;
                                const sourceStart = z * stride + currentSlice;
                                const targetStart = zFlipped * ny;
                                
                                for (let y = 0; y < ny; y++) {
                                    sliceData[targetStart + y] = imageData[sourceStart + y * nx];
                                }
                            }
                        } else if (currentAxis === 'coronal') {
                            // Extract XZ slice at Y = currentSlice (flip Z to correct orientation)
                            const stride = nx * ny;
                            const yOffset = currentSlice * nx;
                            
                            for (let z = 0; z < nz; z++) {
                                const zFlipped = nz - 1 - z;
                                const sourceStart = z * stride + yOffset;
                                const targetStart = zFlipped * nx;
                                
                                for (let x = 0; x < nx; x++) {
                                    sliceData[targetStart + x] = imageData[sourceStart + x];
                                }
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
                    
                    // Find min/max values for normalization (optimized)
                    let min = sliceData[0], max = sliceData[0];
                    for (let i = 1; i < sliceData.length; i++) {
                        const value = sliceData[i];
                        if (value < min) min = value;
                        if (value > max) max = value;
                    }
                    
                    // Pre-calculate normalization factor
                    const range = max - min;
                    const normFactor = range > 0 ? 255 / range : 0;
                    
                    // Convert to grayscale pixels (optimized loop)
                    for (let i = 0; i < sliceData.length; i++) {
                        let value = sliceData[i];
                        
                        // Normalize to 0-255
                        value = range > 0 ? (value - min) * normFactor : 0;
                        
                        // Apply contrast and brightness
                        value = (value - 128) * contrast + 128 + (brightness - 1) * 128;
                        value = Math.max(0, Math.min(255, value));
                        
                        const pixelIndex = i * 4;
                        pixelData[pixelIndex] = value;     // R
                        pixelData[pixelIndex + 1] = value; // G
                        pixelData[pixelIndex + 2] = value; // B
                        pixelData[pixelIndex + 3] = 255;   // A
                    }
                    
                    // Draw to canvas
                    ctx.putImageData(canvasImageData, 0, 0);
                    
                    // Scale canvas to fit container
                    scaleCanvas();
                    
                    debug('Slice rendered successfully');
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
                
                function resetView() {
                    debug('Resetting view to defaults...');
                    
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
                
                function calculateViewDimensions() {
                    if (!niftiData) return;
                    
                    const header = niftiData.header;
                    const dims = header.dims;
                    const nx = dims[1], ny = dims[2], nz = dims[3];
                    
                    // Get voxel spacing from header with validation
                    const pixDims = header.pixDims || [1, 1, 1, 1];
                    let voxelX = pixDims[1] || 1;
                    let voxelY = pixDims[2] || 1;
                    let voxelZ = pixDims[3] || 1;
                    
                    // Validate and fix invalid voxel spacing
                    if (voxelX <= 0 || isNaN(voxelX)) voxelX = 1;
                    if (voxelY <= 0 || isNaN(voxelY)) voxelY = 1;
                    if (voxelZ <= 0 || isNaN(voxelZ)) voxelZ = 1;
                    
                    debug('Raw pixDims: [' + (pixDims[0] || 'undefined') + ', ' + 
                          (pixDims[1] || 'undefined') + ', ' + (pixDims[2] || 'undefined') + ', ' + 
                          (pixDims[3] || 'undefined') + ']');
                    
                    let dataWidth, dataHeight, maxSlice;
                    let physicalWidth, physicalHeight;
                    
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
                
                function updateAxisView() {
                    if (!niftiData) return;
                    
                    debug('>>> SWITCHING TO AXIS: ' + currentAxis + ' <<<');
                    
                    // Clear slice cache when switching axes
                    sliceCache.clear();
                    
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
                
                function handleError(message) {
                    debug('ERROR: ' + message);
                    showLoading(false);
                    
                    const container = document.querySelector('.canvas-container');
                    if (container) {
                        container.innerHTML = '<div class="error"><h3>Error loading NIfTI file</h3><p>' + message + '</p></div>';
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
                    const fileData = await vscode.workspace.fs.readFile(document.uri);
                    console.log('File read successfully, size:', fileData.length);
                    
                    // Send file data to webview for processing
                    webviewPanel.webview.postMessage({
                        type: 'fileData',
                        data: Array.from(fileData)
                    });
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
}
