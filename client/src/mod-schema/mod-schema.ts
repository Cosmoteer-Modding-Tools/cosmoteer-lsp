import { commands, ExtensionContext, l10n, window } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';

/**
 * Reading the code mods' assemblies into the schema on demand, for a mod that was built or installed
 * after the server started.
 */

/** Mirror of the server's code mod schema summary (see server features/mod-schema/mod-schema.ts). */
interface ModSchemaSummary {
    assemblies: number;
    types: number;
    discriminators: number;
    fromCache: boolean;
    unreadable: string[];
    /** Set when `codeMods.enabled` is off, so the command says so instead of "nothing found". */
    disabled?: boolean;
}

/**
 * Registers the rebuild command.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the command runs through.
 */
export function registerModSchema(context: ExtensionContext, client: LanguageClient): void {
    // Code mod schema: a command that re-reads every mod assembly and merges the types it declares
    // into the schema, so a mod's own `Type=` discriminators and fields resolve. The server loads
    // the cached result at startup on its own, so this is for picking up a mod that was just built
    // or installed. A distinct command id from the server's executeCommand id, for the same reason
    // as the migration above.
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.buildModSchemaFromMods', async () => {
            const summary = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.buildModSchema',
                arguments: [],
            })) as ModSchemaSummary | null;
            if (!summary) {
                window.showInformationMessage(l10n.t('Cosmoteer code mod schema: no workspace folder is open.'));
                return;
            }
            if (summary.disabled) {
                window.showInformationMessage(
                    l10n.t(
                        'Cosmoteer code mod schema: code mod support is turned off (cosmoteerLSPRules.codeMods.enabled).'
                    )
                );
                return;
            }
            if (summary.types === 0) {
                window.showInformationMessage(
                    l10n.t('Cosmoteer code mod schema: no code mod assemblies found, nothing to add.')
                );
                return;
            }
            window.showInformationMessage(
                l10n.t(
                    'Cosmoteer code mod schema: added {0} types and {1} discriminators from {2} assemblies.',
                    summary.types,
                    summary.discriminators,
                    summary.assemblies
                )
            );
        })
    );
}
