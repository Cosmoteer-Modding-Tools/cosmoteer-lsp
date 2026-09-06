import { commands, ExtensionContext, l10n, window } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { openDocumentPaths, saveAndTidy } from '../shared-base/apply-cleanup';

/**
 * Turning a text literal into a localization key every language file declares. The server rewrites
 * the literal and writes the key, and this side asks for the key's name first.
 */

/**
 * The command the server's "extract text into a localization key" refactoring carries. The server
 * does not claim it, so the editor runs this instead and the author gets to name the key first.
 */
export const EXTRACT_LOCALIZATION_KEY_LOCAL_COMMAND = 'cosmoteer.extractLocalizationKeyFromAction';

/** Mirror of the server's extraction arguments (see server features/refactor/extract-localization-key.ts). */
interface ExtractLocalizationKeyArgs {
    uri: string;
    offset: number;
    literal: string;
    key: string;
}

/** Mirror of the server's extraction result. */
interface ExtractLocalizationKeyResult {
    key: string;
    changedFiles: string[];
    failure?: 'stale' | 'noStringsFiles' | 'editRejected';
}

/** A key path as a strings file declares one, which is what the input box accepts. */
const LOCALIZATION_KEY_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

/**
 * Why an extraction invoked from the lightbulb did nothing, in one sentence the user can act on.
 *
 * @param failure the reason the command reported.
 * @returns the message to show.
 */
function extractLocalizationKeyFailureMessage(failure: NonNullable<ExtractLocalizationKeyResult['failure']>): string {
    switch (failure) {
        case 'stale':
            return l10n.t('That text has changed since the offer was made, so nothing was changed.');
        case 'noStringsFiles':
            return l10n.t('This mod has no language strings file to put the text in, so nothing was changed.');
        case 'editRejected':
            return l10n.t('The editor turned down the edit, so nothing was changed.');
    }
}

/**
 * Registers the extraction the lightbulb offers.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the command runs through.
 */
export function registerLocalizationKey(context: ExtensionContext, client: LanguageClient): void {
    context.subscriptions.push(
        // The command the server's localization-key extraction carries. The server does not declare
        // it, so the editor runs this and the author names the key before anything is written.
        commands.registerCommand(EXTRACT_LOCALIZATION_KEY_LOCAL_COMMAND, async (args?: ExtractLocalizationKeyArgs) => {
            if (!args) return;
            const key = await window.showInputBox({
                title: l10n.t('Extract text into a localization key'),
                prompt: l10n.t('The key path every language file will declare, one name per group.'),
                value: args.key,
                valueSelection: [args.key.lastIndexOf('/') + 1, args.key.length],
                validateInput: (value) =>
                    LOCALIZATION_KEY_PATH.test(value.trim())
                        ? undefined
                        : l10n.t('A key path is one or more names joined by "/".'),
            });
            if (!key) return;
            const openBefore = openDocumentPaths();
            const result = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.extractLocalizationKey',
                arguments: [{ ...args, key: key.trim() }],
            })) as ExtractLocalizationKeyResult | null;
            if (!result) {
                window.showWarningMessage(l10n.t('The text could not be extracted.'));
                return;
            }
            if (result.failure) {
                window.showWarningMessage(extractLocalizationKeyFailureMessage(result.failure));
                return;
            }
            await saveAndTidy(result.changedFiles, openBefore);
            window.showInformationMessage(
                l10n.t('Added "{0}" to {1} language files.', result.key, result.changedFiles.length)
            );
        })
    );
}
