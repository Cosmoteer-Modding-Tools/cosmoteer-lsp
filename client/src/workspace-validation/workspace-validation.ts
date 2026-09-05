import { commands, ConfigurationTarget, ExtensionContext, l10n, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

/**
 * The one-time notice that the Problems panel covers the whole mod. The server says when a pass did
 * real work, and this side tells the user once and offers the switch that turns the pass off.
 */

/** What the server reports after a whole-mod validation pass (see server.ts `announceWorkspaceValidation`). */
interface WorkspaceValidatedParams {
    files: number;
    fresh: number;
    elapsedMs: number;
    scope: 'allFiles' | 'modRulesReachable';
}

/** Remembers that the whole-mod validation notice has been shown, so it is shown exactly once. */
const WORKSPACE_VALIDATION_NOTICE_KEY = 'cosmoteer.workspaceValidationNoticeShown';

/**
 * Tell the user once that the whole mod is validated, not just their open tabs, and let them switch
 * it off without going looking for the setting.
 *
 * The server only reports a pass that actually did work, so a project where this is instant never
 * produces the notice at all, and the flag stays unset, so the first genuinely large project the
 * user opens is still the one that tells them.
 *
 * @param context the extension context, whose global state remembers that the notice was shown.
 * @param params what the pass covered.
 * @returns once the user answered or dismissed the notice.
 */
async function showWorkspaceValidationNotice(
    context: ExtensionContext,
    params: WorkspaceValidatedParams
): Promise<void> {
    if (context.globalState.get<boolean>(WORKSPACE_VALIDATION_NOTICE_KEY)) return;
    await context.globalState.update(WORKSPACE_VALIDATION_NOTICE_KEY, true);

    const openFilesOnly = l10n.t('Only open files');
    const settingsAction = l10n.t('Settings');
    const message =
        params.scope === 'modRulesReachable'
            ? l10n.t(
                  'Cosmoteer: the Problems panel now covers your whole mod, not just open files. {0} files the mod.rules actions load were validated, and the results are cached, so later starts are fast.',
                  params.files
              )
            : l10n.t(
                  'Cosmoteer: the Problems panel now covers your whole workspace, not just open files. {0} files were validated, and the results are cached, so later starts are fast.',
                  params.files
              );
    const choice = await window.showInformationMessage(message, openFilesOnly, settingsAction);
    if (choice === openFilesOnly) {
        await workspace
            .getConfiguration('cosmoteerLSPRules')
            .update('diagnostics.validateWholeWorkspace', false, ConfigurationTarget.Global);
    } else if (choice === settingsAction) {
        await commands.executeCommand('workbench.action.openSettings2', {
            query: 'cosmoteerLSPRules.diagnostics.validateWholeWorkspace',
        });
    }
}

/**
 * Listens for the server's whole-mod validation report and shows the notice the first time it arrives.
 *
 * @param context the extension context, whose global state remembers that the notice was shown.
 * @param client the language client the report arrives through.
 */
export function registerWorkspaceValidation(context: ExtensionContext, client: LanguageClient): void {
    // Whole-mod validation is on by default, which is work the user never asked for. Tell them once,
    // the first time it actually costs something, and offer the switch right there.
    client.onNotification('cosmoteer/workspaceValidated', async (params: WorkspaceValidatedParams) => {
        await showWorkspaceValidationNotice(context, params);
    });
}
