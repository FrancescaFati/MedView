import * as path from 'path';
import * as vscode from 'vscode';

export interface SegmentationCandidate {
    /** Text shown in the dropdown. */
    label: string;
    /** `Uri.toString()` of the candidate file. */
    uri: string;
    /** Tooltip: the path relative to the image being viewed. */
    detail: string;
}

/** Words that mark a file or folder as holding labels rather than intensities. */
const SEGMENTATION_WORDS = /(seg|mask|label|lbl|pred|roi|annot|contour|gt)/i;

/** Directories that are never worth walking into. */
const SKIPPED_DIRS = /^(\.|node_modules$|__pycache__$)/;

const MAX_CANDIDATES = 60;
const MAX_ENTRIES_SCANNED = 4000;

export function isNiftiFile(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith('.nii') || lower.endsWith('.nii.gz');
}

/**
 * Looks for label volumes that belong to the image being viewed.
 *
 * Real datasets put them in a few predictable places: beside the image with a
 * telling suffix, or in a subfolder named after the model that produced them
 * holding a file with the *same* name as the image -- for example
 * `case/CT.nii.gz` alongside `case/ovseg_predictions_pod_om/CT.nii.gz`.
 *
 * Everything is scored so the most likely match sorts first, and the scan is
 * bounded so a folder with thousands of files cannot stall the editor.
 */
export async function findSegmentations(volumeUri: vscode.Uri): Promise<SegmentationCandidate[]> {
    if (volumeUri.scheme === 'untitled') { return []; }

    const dir = volumeUri.with({ path: path.posix.dirname(volumeUri.path) });
    const volumeName = path.posix.basename(volumeUri.path);
    const found: Array<SegmentationCandidate & { score: number }> = [];
    let scanned = 0;

    const consider = (uri: vscode.Uri, name: string, relative: string, score: number) => {
        if (!isNiftiFile(name)) { return; }
        if (uri.toString() === volumeUri.toString()) { return; }
        found.push({ label: relative, uri: uri.toString(), detail: relative, score });
    };

    const scan = async (folder: vscode.Uri, relativePrefix: string, depth: number): Promise<void> => {
        if (depth > 2 || scanned > MAX_ENTRIES_SCANNED || found.length >= MAX_CANDIDATES) { return; }

        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(folder);
        } catch {
            return;
        }
        scanned += entries.length;

        const subdirectories: Array<{ uri: vscode.Uri; name: string; relative: string }> = [];

        for (const [name, type] of entries) {
            if (type === vscode.FileType.Directory) {
                if (SKIPPED_DIRS.test(name)) { continue; }
                // Only descend past the immediate children when the folder
                // name itself suggests it holds labels.
                if (depth >= 1 && !SEGMENTATION_WORDS.test(name)) { continue; }
                subdirectories.push({
                    uri: vscode.Uri.joinPath(folder, name),
                    name,
                    relative: relativePrefix + name + '/'
                });
                continue;
            }
            if (type !== vscode.FileType.File) { continue; }

            const relative = relativePrefix + name;
            let score = 0;
            if (SEGMENTATION_WORDS.test(name)) { score += 3; }
            if (SEGMENTATION_WORDS.test(relativePrefix)) { score += 3; }
            // A file in a subfolder sharing the image's name is the strongest
            // signal available: it is the same case, processed.
            if (depth > 0 && name === volumeName) { score += 4; }
            if (depth === 0 && score === 0) { score = 1; }
            if (score === 0) { continue; }

            consider(vscode.Uri.joinPath(folder, name), name, relative, score - depth * 0.5);
        }

        for (const sub of subdirectories) {
            await scan(sub.uri, sub.relative, depth + 1);
        }
    };

    await scan(dir, '', 0);

    return found
        .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
        .slice(0, MAX_CANDIDATES)
        .map(({ label, uri, detail }) => ({ label, uri, detail }));
}
