import { l10n, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { openDocumentPaths, saveAndTidy } from '../shared-base/apply-cleanup';

/**
 * The two server round trips every creation wizard makes: a scan of the mod that decides what the
 * form offers, and the apply that writes the content, each with the messages shown when a round
 * answers nothing.
 */

/** The uri the mod is found from: the active document, else the first workspace folder. */
export const anchorUri = (): string | undefined =>
    window.activeTextEditor?.document.uri.toString() ?? workspace.workspaceFolders?.[0]?.uri.toString();

/**
 * The uri a wizard finds the mod from, telling the user to open a mod when there is none.
 *
 * @param anchor the uri the caller passed, absent to find it from the editor.
 * @returns the uri, or undefined after the message was shown.
 */
export const wizardAnchor = (anchor?: string): string | undefined => {
    const uri = anchor ?? anchorUri();
    if (!uri) window.showInformationMessage(l10n.t('Cosmoteer: open the folder of your mod first.'));
    return uri;
};

/**
 * The server's scan of the mod, or undefined after telling the user why there is none.
 *
 * @param client the language client the command runs through.
 * @param command the server command.
 * @param uri the uri the mod is found from.
 * @param failureMessage the message for a failure the server names.
 * @param unreadable the message for a server that answered nothing.
 * @returns the scan.
 */
export const scanForWizard = async <T extends { failure?: string }>(
    client: LanguageClient,
    command: string,
    uri: string,
    failureMessage: (failure: string) => string,
    unreadable = l10n.t('Cosmoteer: the mod could not be read, so nothing was created.')
): Promise<T | undefined> => {
    const scan = (await client.sendRequest(ExecuteCommandRequest.type, { command, arguments: [{ uri }] })) as T | null;
    if (scan && !scan.failure) return scan;
    window.showWarningMessage(scan?.failure ? failureMessage(scan.failure) : unreadable);
    return undefined;
};

/**
 * The apply round: runs the command, saves and tidies what it changed, or tells the user why
 * nothing was made.
 *
 * @param client the language client the command runs through.
 * @param command the server command.
 * @param args the command's arguments, the anchor uri included.
 * @param failureMessage the message for a failure the server names.
 * @param nothing the message for a server that answered nothing.
 * @returns the result, or undefined after the message was shown.
 */
export const applyForWizard = async <T extends { failure?: string; changedFiles: string[] }>(
    client: LanguageClient,
    command: string,
    args: Record<string, unknown>,
    failureMessage: (failure: string) => string,
    nothing = l10n.t('Cosmoteer: nothing was created.')
): Promise<T | undefined> => {
    const openBefore = openDocumentPaths();
    const result = (await client.sendRequest(ExecuteCommandRequest.type, { command, arguments: [args] })) as T | null;
    if (!result) {
        window.showWarningMessage(nothing);
        return undefined;
    }
    if (result.failure) {
        window.showWarningMessage(failureMessage(result.failure));
        return undefined;
    }
    await saveAndTidy(result.changedFiles, openBefore);
    return result;
};
