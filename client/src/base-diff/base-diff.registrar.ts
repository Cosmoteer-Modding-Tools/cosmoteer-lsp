import { commands, ExtensionContext, Position, Uri, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { BASE_DIFF_SCHEME, BaseDiffContentProvider, showBaseDiff } from './base-diff';

/**
 * Registers the base diff: one command rendering what the group under the cursor loads differently
 * from the nearest base of it the game ships itself.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the diff is built by.
 */
export function registerBaseDiff(context: ExtensionContext, client: LanguageClient): void {
    const provider = new BaseDiffContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(BASE_DIFF_SCHEME, provider),
        commands.registerCommand('cosmoteer.diffAgainstBase', async (uri?: Uri, position?: Position) => {
            await showBaseDiff(client, provider, uri, position);
        })
    );
}
