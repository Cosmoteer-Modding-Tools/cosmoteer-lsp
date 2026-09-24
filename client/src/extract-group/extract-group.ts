import { commands, ExtensionContext, l10n, Uri, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { ExtractGroupArgs, ExtractGroupFailure, ExtractGroupResult } from '../../../shared/extract-group.types';

/**
 * Moving a block into a file of its own. The server writes the file and re-expresses every path the
 * block carries, and this side asks what the file is called.
 */

/**
 * The command the server's "move this block into its own file" refactoring carries. The server does
 * not claim it, so the editor runs this instead: what the new file is called is a name only the
 * author can give.
 */
const EXTRACT_GROUP_LOCAL_COMMAND = 'cosmoteer.extractGroupToFileFromAction';

/**
 * What to say when a block cannot be moved into a file of its own, one message per reason the server
 * reports, each naming what the author can do about it.
 *
 * @param failure the reason the server gave.
 * @returns the message to show.
 */
function extractGroupFailureMessage(failure: ExtractGroupFailure): string {
    switch (failure) {
        case 'stale':
            return l10n.t('The block has moved since the offer was made, so nothing was changed.');
        case 'rootGroup':
            return l10n.t(
                'This block is what gives its file a meaning, so moving it would leave the file with nothing the game reads.'
            );
        case 'notAGroup':
            return l10n.t('Only a named block can be moved into a file of its own.');
        case 'notEditable':
            return l10n.t('Files in the game folder are read-only.');
        case 'inheritedGroup':
            return l10n.t('This block derives from another one, whose members a copy would not carry.');
        case 'multiLineText':
            return l10n.t('A text in this block runs across lines, so it cannot be moved.');
        case 'scopeRelativeValue':
            return l10n.t(
                'This block reads something outside itself, so it would mean something else from another file.'
            );
        case 'badFileName':
            return l10n.t('The name has to be a .rules file inside this folder.');
        case 'fileExists':
            return l10n.t('A file of that name is already there.');
        case 'editRejected':
            return l10n.t('The editor refused the change, so nothing was moved.');
    }
}

/**
 * What to say about a round the server answered with nothing usable, which is either a named reason
 * or no answer at all.
 *
 * @param result what the server answered with, null when it answered with nothing.
 * @returns the message to show.
 */
function extractGroupProblemMessage(result: ExtractGroupResult | null): string {
    if (result && 'failure' in result) return extractGroupFailureMessage(result.failure);
    return l10n.t('The block could not be moved.');
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
            if (!offered || !('offer' in offered)) {
                window.showWarningMessage(extractGroupProblemMessage(offered));
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
            if (!written || !('written' in written)) {
                window.showWarningMessage(extractGroupProblemMessage(written));
                return;
            }
            const document = await workspace.openTextDocument(Uri.parse(written.written.uri));
            await window.showTextDocument(document);
        })
    );
}
