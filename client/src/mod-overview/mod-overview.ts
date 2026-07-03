import {
    CancellationToken,
    CodeLens,
    CodeLensProvider,
    EventEmitter,
    Position,
    Range,
    TextDocument,
    TextDocumentContentProvider,
    Uri,
    commands,
    l10n,
    window,
} from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

/** The virtual-document scheme the rendered overview markdown is served under. */
export const MOD_OVERVIEW_SCHEME = 'cosmoteer-mod-overview';

/** Whether a document is a mod manifest (`mod.rules` or a version-specific `mod_*.rules`). */
const isManifestDocument = (document: TextDocument): boolean =>
    /^mod(_[^/\\]*)?\.rules$/i.test(document.fileName.replace(/\\/g, '/').split('/').pop() ?? '');

/**
 * Places a "Show mod overview" CodeLens at the top of a mod manifest, so the report of what the
 * manifest does (its actions, their resolution status, and the mod's unreachable files) is one
 * click away while editing it.
 */
export class ModOverviewCodeLensProvider implements CodeLensProvider {
    /**
     * Provides the single overview lens for a manifest document.
     *
     * @param document the `.rules` document to check.
     * @param _token cancellation token (unused, the check is trivially fast).
     * @returns the lens on the first line, or nothing for a non-manifest file.
     */
    public provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
        if (!isManifestDocument(document)) return [];
        const start = new Position(0, 0);
        return [
            new CodeLens(new Range(start, start), {
                title: l10n.t('Show mod overview'),
                command: 'cosmoteer.showModOverview',
                arguments: [document.uri],
            }),
        ];
    }
}

/**
 * Serves the generated overview markdown as a read-only virtual document, so the built-in markdown
 * preview can render it without writing a file into the user's mod.
 */
export class ModOverviewContentProvider implements TextDocumentContentProvider {
    private readonly contentByUri = new Map<string, string>();
    private readonly changeEmitter = new EventEmitter<Uri>();
    public readonly onDidChange = this.changeEmitter.event;

    /** Stores (or refreshes) the markdown behind an overview uri and notifies open previews. */
    public set(uri: Uri, markdown: string): void {
        this.contentByUri.set(uri.toString(), markdown);
        this.changeEmitter.fire(uri);
    }

    public provideTextDocumentContent(uri: Uri): string {
        return this.contentByUri.get(uri.toString()) ?? l10n.t('The mod overview is no longer available. Run the command again.');
    }
}

/**
 * Requests the overview markdown for a manifest from the server and opens it in the markdown
 * preview. Bound to the `cosmoteer.showModOverview` command (the CodeLens passes the manifest uri;
 * from the palette the active editor's document is used).
 *
 * @param client the running language client the request is sent through.
 * @param provider the content provider the rendered markdown is served from.
 * @param uri the manifest uri, or undefined to use the active editor.
 */
export async function showModOverview(
    client: LanguageClient,
    provider: ModOverviewContentProvider,
    uri?: Uri
): Promise<void> {
    const targetUri = uri ?? window.activeTextEditor?.document.uri;
    if (!targetUri) return;
    const markdown = await client.sendRequest<string | null>('cosmoteer/modOverview', {
        textDocument: { uri: targetUri.toString() },
    });
    if (!markdown) {
        void window.showWarningMessage(l10n.t('No mod overview available: the file is not inside a mod with a mod.rules.'));
        return;
    }
    // One stable overview uri per manifest, so re-running the command refreshes the open preview
    // instead of stacking new tabs. The manifest uri rides along in the query for reference.
    const overviewUri = Uri.from({
        scheme: MOD_OVERVIEW_SCHEME,
        path: '/Mod Overview.md',
        query: targetUri.toString(),
    });
    provider.set(overviewUri, markdown);
    await commands.executeCommand('markdown.showPreview', overviewUri);
}
