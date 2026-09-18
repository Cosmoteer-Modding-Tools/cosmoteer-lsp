import { commands, ExtensionContext, Uri, window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { PartTablePanel } from './table-panel';
import { COSMOTEER_METHOD } from '../../../shared/lsp-methods';

/**
 * Registers the part table: every part of the game and of the mod being edited side by side, with
 * the fields they carry resolved to the numbers the game computes, sortable, filterable and
 * comparable.
 *
 * Also wires the two notifications the table follows the files by: after a change that makes the
 * last table stale, the open table asks for its rows again.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the rows are built by.
 */
export function registerPartTable(context: ExtensionContext, client: LanguageClient): void {
    client.onNotification(COSMOTEER_METHOD.partTableChanged, () => PartTablePanel.notifyChanged());
    client.onNotification(COSMOTEER_METHOD.partTableProgress, (progress: { done: number; total: number }) =>
        PartTablePanel.notifyProgress(progress.done, progress.total)
    );
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.compareParts', async (uri?: Uri) => {
            await PartTablePanel.show(context, client, uri ?? window.activeTextEditor?.document.uri);
        })
    );
}
