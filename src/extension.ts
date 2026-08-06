import * as path from 'path';
import * as vscode from 'vscode';
import { findSegmentations, isNiftiFile } from './segmentations';

export function activate(context: vscode.ExtensionContext) {
    const provider = new MedicalImageViewerProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('medview.viewer', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );
}

export function deactivate() { }

/** Bytes per postMessage when falling back to host-mediated file reads. */
const CHUNK_BYTES = 16 * 1024 * 1024;

class MedicalImageViewerProvider implements vscode.CustomReadonlyEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) { }

    async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => { } };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        const webview = webviewPanel.webview;
        const folder = document.uri.with({ path: path.posix.dirname(document.uri.path) });

        webview.options = {
            enableScripts: true,
            // The image is streamed to the webview over the resource protocol
            // instead of being serialised through postMessage, so its folder
            // has to be readable. Sibling segmentations live under it too.
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                folder
            ]
        };

        // Messages sent before the webview has attached its listener are
        // dropped, so wait for it to announce itself.
        let signalReady: () => void;
        const ready = new Promise<void>((resolve) => { signalReady = resolve; });

        webview.onDidReceiveMessage(
            (message) => {
                if (message.type === 'ready') { signalReady(); return; }
                return this.handleMessage(message, webviewPanel, document);
            },
            undefined,
            this.context.subscriptions
        );

        let disposed = false;
        webviewPanel.onDidDispose(() => { disposed = true; });

        // The viewer starts downloading the image the moment its HTML lands, so
        // the folder scan must not gate it -- it runs alongside and the results
        // are pushed into the dropdown when they arrive.
        webview.html = await this.buildHtml(webview, document.uri);

        Promise.all([ready, this.safeFindSegmentations(document.uri)]).then(([, items]) => {
            if (disposed || items.length === 0) { return; }
            webview.postMessage({
                type: 'segmentations',
                items: items.map((item) => ({
                    ...item,
                    resourceUri: webview.asWebviewUri(vscode.Uri.parse(item.uri)).toString()
                }))
            });
        });
    }

    private async safeFindSegmentations(uri: vscode.Uri) {
        try {
            return await findSegmentations(uri);
        } catch (error) {
            console.warn('MedView: segmentation scan failed', error);
            return [];
        }
    }

    private async buildHtml(webview: vscode.Webview, fileUri: vscode.Uri): Promise<string> {
        const media = (name: string) =>
            webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name)).toString();

        const templateUri = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.html');
        const template = new TextDecoder().decode(await vscode.workspace.fs.readFile(templateUri));

        const config = {
            volumeUri: fileUri.toString(),
            fileName: path.posix.basename(fileUri.path),
            format: isNiftiFile(fileUri.path) ? 'nifti' : 'dicom',
            // `asWebviewUri` is not callable inside the webview, so every file
            // it may stream needs its resource URI resolved out here.
            resourceUris: {
                [fileUri.toString()]: webview.asWebviewUri(fileUri).toString()
            },
            segmentations: [],
            niftiBundleUri: media('nifti-bundle.js'),
            workerUri: media('volume-worker.js'),
            settings: {
                brightness: this.context.workspaceState.get<number>('medview.brightness', 100),
                contrast: this.context.workspaceState.get<number>('medview.contrast', 100)
            }
        };

        const values: Record<string, string> = {
            cspSource: webview.cspSource,
            nonce: makeNonce(),
            styleUri: media('viewer.css'),
            viewerUri: media('viewer.js'),
            axialIconUri: media('axial_ico.png'),
            sagittalIconUri: media('sagittal_ico.png'),
            frontalIconUri: media('frontal_ico.png'),
            fileName: escapeHtml(config.fileName),
            // Inlined into a script tag, so `<` must not be able to close it.
            config: JSON.stringify(config).replace(/</g, '\\u003c')
        };

        return template.replace(/\$\{(\w+)\}/g, (match, key) =>
            Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
        );
    }

    private async handleMessage(
        message: any,
        webviewPanel: vscode.WebviewPanel,
        document: vscode.CustomDocument
    ): Promise<void> {
        switch (message.type) {
            case 'readFile':
                await this.streamFile(message.id, message.uri, webviewPanel);
                break;

            case 'saveSettings':
                await this.context.workspaceState.update('medview.brightness', message.brightness);
                await this.context.workspaceState.update('medview.contrast', message.contrast);
                break;

            case 'browseSegmentation':
                await this.browseSegmentation(webviewPanel, document.uri);
                break;

            case 'showError':
                vscode.window.showErrorMessage('MedView: ' + message.message);
                break;
        }
    }

    /**
     * Fallback transport for files the webview cannot fetch directly, such as
     * those on virtual or remote filesystems. Sent as binary chunks; the old
     * `Array.from(bytes)` JSON round trip turned a 150 MB volume into a
     * multi-hundred-megabyte string and could not represent large ones at all.
     */
    private async streamFile(id: number, uriString: string, webviewPanel: vscode.WebviewPanel) {
        const webview = webviewPanel.webview;
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(uriString));
            for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
                await webview.postMessage({
                    type: 'fileChunk',
                    id,
                    totalBytes: bytes.byteLength,
                    bytes: bytes.subarray(offset, Math.min(bytes.byteLength, offset + CHUNK_BYTES))
                });
            }
            await webview.postMessage({ type: 'fileEnd', id, totalBytes: bytes.byteLength });
        } catch (error) {
            await webview.postMessage({
                type: 'fileError',
                id,
                message: `Could not read the file: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    private async browseSegmentation(webviewPanel: vscode.WebviewPanel, volumeUri: vscode.Uri) {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Overlay',
            title: 'Select a segmentation volume',
            defaultUri: volumeUri.with({ path: path.posix.dirname(volumeUri.path) }),
            filters: { 'NIfTI volumes': ['nii', 'gz'] }
        });
        if (!picked || picked.length === 0) { return; }

        const uri = picked[0];
        await webviewPanel.webview.postMessage({
            type: 'openSegmentation',
            uri: uri.toString(),
            resourceUri: webviewPanel.webview.asWebviewUri(uri).toString(),
            label: path.posix.basename(uri.path)
        });
    }
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
