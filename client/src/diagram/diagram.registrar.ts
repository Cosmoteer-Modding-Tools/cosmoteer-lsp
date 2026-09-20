import { commands, ExtensionContext, l10n, Position, Uri, window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { DiagramPanel } from './diagram-panel';
import { COSMOTEER_METHOD } from '../../../shared/lsp-methods';

/**
 * Registers the two drawn views, which share one panel. A part's resource wiring and its firing
 * chain are each a graph, and a graph is the shape none of the reports could take.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the diagrams are built by.
 */
export function registerDiagrams(context: ExtensionContext, client: LanguageClient): void {
    /**
     * Opens one of the drawn views for the active editor's caret.
     *
     * @param request which diagram to draw.
     * @param uri the file's uri, or undefined to use the active editor.
     * @param position the caret, or undefined to use the active editor's.
     */
    const showDiagram = async (
        request: { method: string; title: string; missing: string },
        uri?: Uri,
        position?: Position
    ): Promise<void> => {
        const editor = window.activeTextEditor;
        const targetUri = uri ?? editor?.document.uri;
        const targetPosition = position ?? editor?.selection.active ?? new Position(0, 0);
        if (!targetUri) return;
        await DiagramPanel.show(context, client, request, targetUri, targetPosition);
    };

    context.subscriptions.push(
        commands.registerCommand('cosmoteer.showResourceFlow', async (uri?: Uri, position?: Position) => {
            await showDiagram(
                {
                    method: COSMOTEER_METHOD.resourceFlowDiagram,
                    title: l10n.t('Resource Flow'),
                    missing: l10n.t('No diagram available: the cursor is not inside a part that carries resources.'),
                },
                uri,
                position
            );
        }),
        commands.registerCommand('cosmoteer.showEffectChain', async (uri?: Uri, position?: Position) => {
            await showDiagram(
                {
                    method: COSMOTEER_METHOD.effectChainDiagram,
                    title: l10n.t('Firing Chain'),
                    missing: l10n.t('No diagram available: the cursor is not inside a part that fires anything.'),
                },
                uri,
                position
            );
        })
    );
}
