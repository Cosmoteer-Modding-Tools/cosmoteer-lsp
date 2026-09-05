import { commands, ExtensionContext, l10n, Uri, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';

/**
 * Moving a block into a file of its own. The server writes the file and re-expresses every path the
 * block carries, and this side asks what the file is called.
 */

/**
 * The command the server's "move this block into its own file" refactoring carries. The server does
 * not claim it, so the editor runs this instead: what the new file is called is a name only the
 * author can give.
 */
export const EXTRACT_GROUP_LOCAL_COMMAND = 'cosmoteer.extractGroupToFileFromAction';

/** Mirror of the server's extract-group arguments (see server features/refactor/extract-group). */
interface ExtractGroupArgs {
    uri: string;
    offset: number;
    fileName?: string;
}

/** Mirror of what the server answers with on either round. */
interface ExtractGroupResult {
    offer?: { name: string; fileName: string; members: number };
    written?: { uri: string; reference: string };
    failure?: string;
}

/**
 * What to say when a block cannot be moved into a file of its own.
 *
 * @param failure the reason the server gave, absent when it answered with nothing at all.
 * @returns the message to show.
 */
function extractGroupFailureMessage(failure: string | undefined): string {
    switch (failure) {
        case 'notAGroup':
            return l10n.t('Only a named block can be moved into a file of its own.');
        case 'notEditable':
            return l10n.t('Files in the game folder are read-only.');
        case 'inheritedGroup':
            return l10n.t('This block derives from another one, whose members a copy would not carry.');
        case 'multiLineText':
            return l10n.t('A text in this block runs across lines, so it cannot be moved.');
        case 'scopeRelativeValue':
            return l10n.t('This block reads something outside itself, so it would mean something else from another file.');
        case 'badFileName':
            return l10n.t('The name has to be a .rules file inside this folder.');
        case 'fileExists':
            return l10n.t('A file of that name is already there.');
        case 'editRejected':
            return l10n.t('The editor refused the change, so nothing was moved.');
        default:
            return l10n.t('The block could not be moved.');
    }
}

/**
 * Registers the move the lightbulb offers.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the command runs through.
 */
export function registerExtractGroup(context: ExtensionContext, client: LanguageClient): void {
    context.subscriptions.push(
        // The command the server's "move this block into its own file" refactoring carries. The name is
        // asked for here, and the server writes the file and re-expresses every path the block carries.
        commands.registerCommand(EXTRACT_GROUP_LOCAL_COMMAND, async (args?: ExtractGroupArgs) => {
            if (!args?.uri) return;
            const run = async (fileName?: string) =>
                (await client.sendRequest(ExecuteCommandRequest.type, {
                    command: 'cosmoteer.extractGroupToFile',
                    arguments: [{ ...args, fileName }],
                })) as ExtractGroupResult | null;
            const offered = await run();
            if (!offered?.offer) {
                window.showWarningMessage(extractGroupFailureMessage(offered?.failure));
                return;
            }
            const fileName = await window.showInputBox({
                title: l10n.t("Move '{0}' into its own file", offered.offer.name),
                prompt: l10n.t('The file to write it to, relative to the folder this file is in.'),
                value: offered.offer.fileName,
                valueSelection: [0, offered.offer.fileName.lastIndexOf('.')],
            });
            if (!fileName) return;
            const written = await run(fileName.trim());
            if (!written?.written) {
                window.showWarningMessage(extractGroupFailureMessage(written?.failure));
                return;
            }
            const document = await workspace.openTextDocument(Uri.parse(written.written.uri));
            await window.showTextDocument(document);
        })
    );
}
