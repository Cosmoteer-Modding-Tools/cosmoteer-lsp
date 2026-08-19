import { Uri, window, workspace } from 'vscode';

/** What the tidy-up did, so the summary can say it out loud. */
export interface ApplyCleanup {
    saved: number;
    closed: number;
    /** Files that could not be written, which stay open and unsaved so nothing is lost. */
    unsaved: string[];
}

/** A path folded the way the editor compares them on this platform. */
const key = (fsPath: string): string => Uri.file(fsPath).fsPath.toLowerCase();

/**
 * The paths the editor currently holds a text document for, taken before an edit so the tidy-up can
 * tell the tabs the user had from the ones the edit itself opened.
 *
 * @returns the open paths, folded for comparison.
 */
export const openDocumentPaths = (): Set<string> =>
    new Set(workspace.textDocuments.filter((document) => document.uri.scheme === 'file').map((d) => key(d.uri.fsPath)));

/**
 * Write out the files a multi-file refactoring changed, and put away the ones it opened on its own.
 *
 * A `workspace/applyEdit` over hundreds of files leaves every one of them open and unsaved, which is
 * not a state anybody wants to be handed. Saving them is the obvious half. The other half is that
 * the files the user never opened should not stay behind as tabs, while the ones they did have open
 * are left exactly as they were, still dirty or not, because those are theirs.
 *
 * A file that fails to save keeps its tab: an unwritten buffer is the only copy of that change, so
 * closing it would throw the change away.
 *
 * @param changedFiles the paths the edit touched.
 * @param openBefore the paths that already had a document before the edit, from {@link openDocumentPaths}.
 * @returns what was saved and closed.
 */
export const saveAndTidy = async (
    changedFiles: readonly string[],
    openBefore: ReadonlySet<string>
): Promise<ApplyCleanup> => {
    const wanted = new Set(changedFiles.map(key));
    const cleanup: ApplyCleanup = { saved: 0, closed: 0, unsaved: [] };
    const closable = new Set<string>();

    for (const document of workspace.textDocuments) {
        if (document.uri.scheme !== 'file') continue;
        const path = key(document.uri.fsPath);
        if (!wanted.has(path)) continue;
        if (document.isDirty) {
            if (await document.save()) cleanup.saved++;
            else {
                cleanup.unsaved.push(document.uri.fsPath);
                continue;
            }
        }
        if (!openBefore.has(path)) closable.add(path);
    }

    // Tabs, not documents: a document the edit opened may or may not have been given a tab, and only
    // a tab can be closed. A tab's input is one of several shapes (a plain editor, a two-way diff, a
    // multi-file diff), each naming its uris under different properties, so they are read by shape
    // rather than by type: a tab qualifies when every file uri it shows is one we may close.
    const tabs = window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
        const uris = urisOf(tab.input);
        if (uris.length === 0) return false;
        return uris.every(
            (uri) => uri.scheme === previewScheme || (uri.scheme === 'file' && closable.has(key(uri.fsPath)))
        );
    });
    if (tabs.length > 0) {
        await window.tabGroups.close(tabs, false);
        cleanup.closed = tabs.length;
    }
    return cleanup;
};

/** The scheme the extraction's own preview documents are served under, which is ours to close. */
let previewScheme = '';

/**
 * Tell the tidy-up which scheme the preview it opened uses, so that tab is closed with the rest once
 * the rewrite it was describing has happened.
 *
 * @param scheme the virtual-document scheme of the preview.
 */
export const setPreviewScheme = (scheme: string): void => {
    previewScheme = scheme;
};

/** Every uri a tab input names, whatever shape that input is. */
const urisOf = (input: unknown): Uri[] => {
    if (!input || typeof input !== 'object') return [];
    const candidate = input as { uri?: unknown; original?: unknown; modified?: unknown };
    return [candidate.uri, candidate.original, candidate.modified].filter(
        (value): value is Uri => value instanceof Uri
    );
};
