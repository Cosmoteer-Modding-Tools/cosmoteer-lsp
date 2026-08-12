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

/** The virtual-document scheme the rendered wiring markdown is served under. */
export const PART_WIRING_SCHEME = 'cosmoteer-part-wiring';

/**
 * Places a "Show part wiring" CodeLens above each root-level `Part` group, next to the grid editor
 * lens, so the report of what the part still needs before the game can build it is one click away.
 *
 * The provider is a light line scan rather than a parse: the server does the real work when the
 * command fires, and a lens on a non-part `Part` line is harmless (the request answers nothing and
 * the command warns).
 */
export class PartWiringCodeLensProvider implements CodeLensProvider {
    /** Matches an unindented `Part` declaration line (bare, inheriting, or with an inline brace). */
    private static readonly PART_LINE = /^Part\s*($|:|\{)/;

    /**
     * Provides a wiring lens for each root-level part declaration in the document.
     *
     * @param document the `.rules` document to scan.
     * @param _token cancellation token (unused, the scan is trivially fast).
     * @returns one CodeLens per root `Part` line.
     */
    public provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
        const lenses: CodeLens[] = [];
        for (let line = 0; line < document.lineCount; line++) {
            if (!PartWiringCodeLensProvider.PART_LINE.test(document.lineAt(line).text)) continue;
            const position = new Position(line, 0);
            lenses.push(
                new CodeLens(new Range(position, position), {
                    title: l10n.t('Show part wiring'),
                    command: 'cosmoteer.showPartWiring',
                    arguments: [document.uri, position],
                })
            );
        }
        return lenses;
    }
}

/**
 * Serves the generated wiring markdown as a read-only virtual document, so the built-in markdown
 * preview can render it without writing a file into the user's mod.
 */
export class PartWiringContentProvider implements TextDocumentContentProvider {
    private readonly contentByUri = new Map<string, string>();
    private readonly changeEmitter = new EventEmitter<Uri>();
    public readonly onDidChange = this.changeEmitter.event;

    /** Stores (or refreshes) the markdown behind a wiring uri and notifies open previews. */
    public set(uri: Uri, markdown: string): void {
        this.contentByUri.set(uri.toString(), markdown);
        this.changeEmitter.fire(uri);
    }

    public provideTextDocumentContent(uri: Uri): string {
        return (
            this.contentByUri.get(uri.toString()) ??
            l10n.t('The part wiring report is no longer available. Run the command again.')
        );
    }
}

/**
 * Requests the wiring report for the part at a position from the server and opens it in the
 * markdown preview. Bound to the `cosmoteer.showPartWiring` command, where the CodeLens passes the
 * part's line and the palette falls back to the active editor's cursor.
 *
 * @param client the running language client the request is sent through.
 * @param provider the content provider the rendered markdown is served from.
 * @param uri the part file's uri, or undefined to use the active editor.
 * @param position a position inside the part group, or undefined to use the cursor.
 */
export async function showPartWiring(
    client: LanguageClient,
    provider: PartWiringContentProvider,
    uri?: Uri,
    position?: Position
): Promise<void> {
    const editor = window.activeTextEditor;
    const targetUri = uri ?? editor?.document.uri;
    const targetPosition = position ?? editor?.selection.active;
    if (!targetUri || !targetPosition) return;
    const markdown = await client.sendRequest<string | null>('cosmoteer/partWiring', {
        textDocument: { uri: targetUri.toString() },
        position: { line: targetPosition.line, character: targetPosition.character },
    });
    if (!markdown) {
        void window.showWarningMessage(l10n.t('No part wiring available: the cursor is not inside a part.'));
        return;
    }
    // One stable wiring uri per (file, line), so re-running the command refreshes the open preview
    // instead of stacking new tabs. The part uri and line ride along in the query for reference.
    const wiringUri = Uri.from({
        scheme: PART_WIRING_SCHEME,
        path: '/Part Wiring.md',
        query: `${targetUri.toString()}#${targetPosition.line}`,
    });
    provider.set(wiringUri, markdown);
    await commands.executeCommand('markdown.showPreview', wiringUri);
}
