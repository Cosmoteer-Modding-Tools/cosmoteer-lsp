import { commands, ExtensionContext, languages, Uri, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import {
    MOD_OVERVIEW_SCHEME,
    ModOverviewCodeLensProvider,
    ModOverviewContentProvider,
    showModOverview,
} from './mod-overview';

/**
 * Registers the mod overview: a CodeLens on a mod manifest and a command that render what the
 * manifest does (its actions with resolution status, and the mod's unreachable files) as a markdown
 * preview.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the overview is built by.
 */
export function registerModOverview(context: ExtensionContext, client: LanguageClient): void {
    const provider = new ModOverviewContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(MOD_OVERVIEW_SCHEME, provider),
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new ModOverviewCodeLensProvider()),
        commands.registerCommand('cosmoteer.showModOverview', async (uri?: Uri) => {
            await showModOverview(client, provider, uri);
        })
    );
}
