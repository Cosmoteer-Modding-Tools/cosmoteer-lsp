import { commands, ExtensionContext, l10n, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { offerToOpen, warnOfUnsavedFiles } from '../command-util';
import { ApplyCleanup, openDocumentPaths, saveAndTidy } from '../shared-base/apply-cleanup';

/**
 * Overriding a value of the game's own files from a mod, through an action in its manifest. The
 * server works the path out and writes the action, and this side asks which mod takes it and whether
 * a whole group goes into the manifest or into a file of its own.
 */

/**
 * The command the server's "override this in my mod" refactoring carries. The server does not
 * claim it, so the editor runs this instead and the author picks the mod first.
 */
export const OVERRIDE_IN_MOD_LOCAL_COMMAND = 'cosmoteer.overrideInModFromAction';

/**
 * Mirror of the server's override arguments (see server
 * features/refactor/override-in-mod/override-in-mod.command.ts).
 */
interface OverrideInModArgs {
    uri: string;
    offset: number;
    mod?: string;
    shape?: 'inline' | 'file';
}

/** Mirror of one mod the override could be written into (same module). */
interface OverrideModCandidate {
    /** The identity the pick is sent back by. */
    key: string;
    name: string;
    modRoot: string;
    manifests: string[];
    alreadyOverridden: boolean;
    blocked?: 'ambiguousManifest' | 'notEditable';
}

/** Mirror of the server's candidate report (same module). */
interface OverrideInModScanResult {
    kind: 'scan';
    memberName: string;
    target: string;
    body: string;
    replacesContainer: boolean;
    candidates: OverrideModCandidate[];
    failure?: OverrideInModFailure;
}

/** Mirror of the server's answer once the action is written (same module). */
interface OverrideInModApplyResult {
    kind: 'apply';
    modRoot: string;
    manifestFsPath: string;
    /** The fragment file that was created, empty for the inline shape. */
    createdFsPath: string;
    changedFiles: string[];
    target: string;
    memberName: string;
    replacesContainer: boolean;
    failure?: OverrideInModFailure;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
}

/** Why an override did nothing, as the server words it. */
type OverrideInModFailure =
    | 'stale'
    | 'insideList'
    | 'indexSegment'
    | 'unnamedMember'
    | 'shadowedName'
    | 'emptyMember'
    | 'inheritedMember'
    | 'multiLineText'
    | 'scopeRelativeValue'
    | 'unrebasablePath'
    | 'untypablePath'
    | 'notVanilla'
    | 'stringsFile'
    | 'noGamePath'
    | 'noModRoot'
    | 'unknownMod'
    | 'ambiguousManifest'
    | 'notEditable'
    | 'alreadyOverridden'
    | 'editRejected'
    | 'writeFailed';

/**
 * Offer the mods the override can go into and let the user pick one.
 *
 * @param candidates the mods the server reported.
 * @returns the picked mod, or undefined when none can take it or the user backed out.
 */
async function pickOverrideMod(candidates: OverrideModCandidate[]): Promise<OverrideModCandidate | undefined> {
    const open = candidates.filter((candidate) => !candidate.blocked);
    if (open.length === 0) {
        window.showInformationMessage(
            l10n.t(
                'Cosmoteer: no mod in this workspace can take the override. Either there is none, or every one of them ships several manifests and which gets the override is yours to decide.'
            )
        );
        return undefined;
    }
    const picked = await window.showQuickPick(
        open.map((candidate) => ({
            label: candidate.name,
            description: workspace.asRelativePath(candidate.modRoot),
            detail: candidate.alreadyOverridden
                ? l10n.t('This mod already overrides that value')
                : l10n.t('The action is written into {0}', candidate.manifests[0] ?? 'mod.rules'),
            candidate,
        })),
        { placeHolder: l10n.t('Pick the mod this override belongs in'), matchOnDescription: true }
    );
    return picked?.candidate;
}

/**
 * Ask where the overridden value is written, which is only worth asking for a body big enough to
 * crowd the manifest. A single value always goes in the manifest itself.
 *
 * @param scan the server's report, which says whether the body is a whole group or list.
 * @returns the shape to write, or undefined when the user backed out.
 */
async function pickOverrideShape(scan: OverrideInModScanResult): Promise<'inline' | 'file' | undefined> {
    if (!scan.replacesContainer) return 'inline';
    const inline = l10n.t('Write it into mod.rules');
    const file = l10n.t('Keep it in its own file');
    const picked = await window.showQuickPick(
        [
            {
                label: inline,
                detail: l10n.t('The whole value is written into the action itself'),
                shape: 'inline' as const,
            },
            {
                label: file,
                detail: l10n.t('A file is created under "overrides" and the action points at it'),
                shape: 'file' as const,
            },
        ],
        { placeHolder: l10n.t('Where should the overridden value be written?') }
    );
    return picked?.shape;
}

/**
 * Say what the override did, with the file it changed behind a button.
 *
 * @param result the server's summary.
 * @param cleanup what the tidy-up did.
 */
async function showOverrideSummary(result: OverrideInModApplyResult, cleanup?: ApplyCleanup): Promise<void> {
    warnOfUnsavedFiles(cleanup);
    const changed = result.manifestFsPath;
    const note = result.replacesContainer
        ? ` ${l10n.t(
              'This replaces the whole of that group, so everything the game reads under it now comes from your copy.'
          )}`
        : '';
    const message = result.createdFsPath
        ? l10n.t(
              'Cosmoteer: added the override of {0} to {1}, with the value in {2}.',
              result.memberName,
              workspace.asRelativePath(changed),
              workspace.asRelativePath(result.createdFsPath)
          )
        : l10n.t(
              'Cosmoteer: added the override of {0} to {1}.',
              result.memberName,
              workspace.asRelativePath(changed)
          );
    await offerToOpen(message + note, changed);
}

/**
 * Say why an override did not happen, one message per reason the server reports, each naming what
 * the user can do about it.
 *
 * @param failure the server's reason.
 * @param manifests the manifest names to choose between, only for `ambiguousManifest`.
 * @returns the message to show.
 */
function overrideInModFailureMessage(failure: OverrideInModFailure, manifests?: string[]): string {
    switch (failure) {
        case 'stale':
            return l10n.t('Cosmoteer: the value has moved since the offer was made, so nothing was changed.');
        case 'insideList':
            return l10n.t(
                'Cosmoteer: this value is inside a list, and the game addresses those by position, which another mod loading first renumbers. Override the whole list instead.'
            );
        case 'indexSegment':
        case 'untypablePath':
            return l10n.t(
                'Cosmoteer: the path to this value runs through a name the game reads as a position rather than as a name, so an override written for it could point somewhere else.'
            );
        case 'unnamedMember':
            return l10n.t('Cosmoteer: this value sits in a block with no name, so there is no path to write for it.');
        case 'shadowedName':
            return l10n.t(
                'Cosmoteer: another member of that group already answers to this name, so an override would change that one instead.'
            );
        case 'emptyMember':
            return l10n.t('Cosmoteer: this field has no value to copy, so nothing was changed.');
        case 'inheritedMember':
            return l10n.t(
                'Cosmoteer: this group has bases of its own, and an override replaces the whole of it, so copying only its body would drop what the bases supply.'
            );
        case 'multiLineText':
            return l10n.t(
                'Cosmoteer: this value carries text running across a line break, which cannot be copied safely.'
            );
        case 'scopeRelativeValue':
            return l10n.t(
                'Cosmoteer: this value reads something around it, with "~", "^", ":" or a bare name, so it would mean something else from your mod.'
            );
        case 'unrebasablePath':
            return l10n.t(
                'Cosmoteer: a path in this value could not be rewritten to read from the game folder, so an override would point at nothing.'
            );
        case 'notVanilla':
            return l10n.t(
                'Cosmoteer: this file is not one of the game install, so edit it directly rather than overriding it.'
            );
        case 'stringsFile':
            return l10n.t(
                'Cosmoteer: language files cannot be changed by an action. Ship your own file for that language instead.'
            );
        case 'noGamePath':
            return l10n.t('Cosmoteer: set the Cosmoteer game path so the override can name the file it changes.');
        case 'noModRoot':
            return l10n.t(
                'Cosmoteer: this workspace holds no mod, so there is no manifest to write the override into.'
            );
        case 'unknownMod':
            return l10n.t('Cosmoteer: that mod is no longer in the workspace, so nothing was changed.');
        case 'ambiguousManifest':
            return l10n.t(
                'Cosmoteer: this mod has several manifests and none of them is mod.rules, so which one gets the override is yours to decide. Candidates: {0}.',
                (manifests ?? []).join(', ')
            );
        case 'notEditable':
            return l10n.t('Cosmoteer: the manifest could not take another action, so nothing was changed.');
        case 'alreadyOverridden':
            return l10n.t('Cosmoteer: this mod already overrides that value, so nothing was changed.');
        case 'editRejected':
            return l10n.t('Cosmoteer: the editor turned down the edit, so nothing was changed.');
        case 'writeFailed':
            return l10n.t('Cosmoteer: the file holding the override could not be written, so nothing was changed.');
    }
}

/**
 * Registers the override the lightbulb offers.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the command runs through.
 */
export function registerOverrideInMod(context: ExtensionContext, client: LanguageClient): void {
    context.subscriptions.push(
        // The command the server's override refactoring carries. The server does not claim it, so
        // the editor runs this and the author picks the mod before anything is written.
        commands.registerCommand(OVERRIDE_IN_MOD_LOCAL_COMMAND, async (args?: OverrideInModArgs) => {
            if (!args) return;
            const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.overrideInMod',
                arguments: [args],
            })) as OverrideInModScanResult | null;
            if (!scan || scan.failure) {
                window.showWarningMessage(
                    scan?.failure
                        ? overrideInModFailureMessage(scan.failure)
                        : l10n.t('Cosmoteer: the override could not be worked out, so nothing was changed.')
                );
                return;
            }
            const mod = await pickOverrideMod(scan.candidates);
            if (!mod) return;
            const shape = await pickOverrideShape(scan);
            if (!shape) return;
            // Captured before the edit, so the tidy-up can tell the tabs the user had from the one
            // the override opened on its own.
            const openBefore = openDocumentPaths();
            const result = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.overrideInMod',
                arguments: [{ ...args, mod: mod.key, shape }],
            })) as OverrideInModApplyResult | null;
            if (!result) {
                window.showWarningMessage(
                    l10n.t('Cosmoteer: the override could not be written, so nothing was changed.')
                );
                return;
            }
            if (result.failure) {
                window.showWarningMessage(overrideInModFailureMessage(result.failure, result.manifests));
                return;
            }
            const cleanup = await saveAndTidy(result.changedFiles, openBefore);
            await showOverrideSummary(result, cleanup);
        })
    );
}
