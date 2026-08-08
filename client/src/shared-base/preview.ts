import { EventEmitter, TextDocumentContentProvider, Uri, ViewColumn, commands, l10n, languages, window, workspace } from 'vscode';

/** The virtual-document scheme the rewritten file contents are served under. */
export const SHARED_BASE_DIFF_SCHEME = 'cosmoteer-shared-base';

/** One file an extraction would change, as the server describes it. */
export interface SharedBasePreviewFile {
    fsPath: string;
    after: string;
    created: boolean;
}

/**
 * Serves the rewritten contents of the files an extraction would change, so the editor can put them
 * side by side against what is on disk without anything being written first.
 */
export class SharedBaseDiffProvider implements TextDocumentContentProvider {
    private readonly contentByUri = new Map<string, string>();
    private readonly changeEmitter = new EventEmitter<Uri>();
    public readonly onDidChange = this.changeEmitter.event;

    /** Stores (or refreshes) the content behind a preview uri and notifies an already-open tab. */
    public set(uri: Uri, content: string): void {
        this.contentByUri.set(uri.toString(), content);
        this.changeEmitter.fire(uri);
    }

    public provideTextDocumentContent(uri: Uri): string {
        return (
            this.contentByUri.get(uri.toString()) ??
            l10n.t('This preview is no longer available. Run the command again.')
        );
    }
}

/**
 * The uri a rewritten file is served under. It keeps the original file's name and extension so the
 * diff is syntax-highlighted as rules, and carries the plan id so two previews never collide.
 */
const rewrittenUri = (planId: string, file: SharedBasePreviewFile): Uri =>
    Uri.from({
        scheme: SHARED_BASE_DIFF_SCHEME,
        path: `/${planId}/${file.fsPath.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')}`,
        query: 'after',
    });

/**
 * Show what an extraction would do, as the editor's own side-by-side diff over every file it
 * changes rather than as a patch to read.
 *
 * The multi-file diff editor is the right shape for this: one entry per file, each opening on the
 * real file against its rewritten contents. A `.rules` author should see their own syntax, not a
 * patch format. When that editor is unavailable the first file is opened in a plain two-way diff,
 * which every version has.
 *
 * @param provider the content provider the rewritten contents are served from.
 * @param planId the plan's id, which the uris are keyed by.
 * @param changed the files the extraction would change, base file first.
 * @param title the label the diff editor is given.
 * @returns once the diff is open.
 */
export async function showSharedBaseDiff(
    provider: SharedBaseDiffProvider,
    planId: string,
    changed: readonly SharedBasePreviewFile[],
    title: string
): Promise<void> {
    if (changed.length === 0) return;
    const empty = Uri.from({ scheme: SHARED_BASE_DIFF_SCHEME, path: `/${planId}/new-file`, query: 'empty' });
    provider.set(empty, '');

    const resources: Array<[Uri, Uri, Uri]> = [];
    for (const file of changed) {
        const modified = rewrittenUri(planId, file);
        provider.set(modified, file.after);
        // A file that does not exist yet is diffed against nothing, which renders as all-added.
        const original = file.created ? empty : Uri.file(file.fsPath);
        resources.push([Uri.file(file.fsPath), original, modified]);
    }

    try {
        await commands.executeCommand('vscode.changes', title, resources);
        return;
    } catch {
        // Older editors have no multi-file diff. One file at a time is still a real diff.
    }
    const [resource, original, modified] = resources[0];
    await commands.executeCommand('vscode.diff', original, modified, `${title} - ${resource.path.split('/').pop()}`);
}

/**
 * Fallback for a preview that carries no file contents: show the unified diff as a read-only tab.
 *
 * @param provider the content provider the diff is served from.
 * @param planId the plan's id, which the uri is keyed by.
 * @param diff the unified diff to show.
 * @returns once the tab is open.
 */
export async function showSharedBasePatch(
    provider: SharedBaseDiffProvider,
    planId: string,
    diff: string
): Promise<void> {
    const uri = Uri.from({ scheme: SHARED_BASE_DIFF_SCHEME, path: `/${planId}/preview.diff`, query: 'patch' });
    provider.set(uri, diff);
    const document = await workspace.openTextDocument(uri);
    await languages.setTextDocumentLanguage(document, 'diff');
    await window.showTextDocument(document, { preview: true, viewColumn: ViewColumn.Beside, preserveFocus: true });
}
