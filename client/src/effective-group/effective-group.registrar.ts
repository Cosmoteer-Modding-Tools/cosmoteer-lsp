import { commands, ExtensionContext, Position, Uri, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { EFFECTIVE_GROUP_SCHEME, EffectiveGroupContentProvider, showEffectiveGroup } from './effective-group';

/**
 * Registers the effective-group report: one command rendering the member set the game really
 * deserializes for the group under the cursor, with every row's origin in the inheritance chain.
 *
 * No CodeLens: it applies to any group, so a lens per group would bury the file.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the report is built by.
 */
export function registerEffectiveGroup(context: ExtensionContext, client: LanguageClient): void {
    const provider = new EffectiveGroupContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(EFFECTIVE_GROUP_SCHEME, provider),
        commands.registerCommand('cosmoteer.showEffectiveGroup', async (uri?: Uri, position?: Position) => {
            await showEffectiveGroup(client, provider, uri, position);
        })
    );
}
