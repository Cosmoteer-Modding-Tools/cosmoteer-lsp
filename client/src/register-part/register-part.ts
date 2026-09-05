import * as path from 'path';
import { commands, ExtensionContext, l10n, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { offerToOpen, warnOfUnsavedFiles } from '../command-util';
import { ApplyCleanup, openDocumentPaths, saveAndTidy } from '../shared-base/apply-cleanup';

/**
 * Listing a part in a ship class so the game builds it. The server finds the ship classes and writes
 * the registration, and this side asks which ship the part belongs to.
 */

/**
 * The command the server's "register this part in a ship class" refactoring carries. The server does
 * not claim it, so the editor runs this instead and the author picks the ship class first.
 */
export const REGISTER_PART_IN_SHIP_LOCAL_COMMAND = 'cosmoteer.registerPartInShipFromAction';

/** Mirror of the server's registration arguments (see server features/refactor/register-part/register-part.command.ts). */
interface RegisterPartArgs {
    uri: string;
    offset: number;
    ship?: string;
}

/** Mirror of one ship class the part could be registered in (same module). */
interface ShipCandidate {
    /** The identity the pick is sent back by. */
    key: string;
    groupName: string;
    id?: string;
    fsPath: string;
    target: 'workspace' | 'vanilla';
    via: 'shipFile' | 'modAction';
    alreadyRegistered: boolean;
    blocked?: 'partsInherited' | 'noPartsList' | 'notEditable' | 'noModRoot' | 'unreadable';
}

/** Mirror of the server's candidate report (same module). */
interface RegisterPartScanResult {
    kind: 'scan';
    partId?: string;
    partGroupName: string;
    candidates: ShipCandidate[];
    failure?: RegisterPartFailure;
}

/** Mirror of the server's registration answer (same module). */
interface RegisterPartApplyResult {
    kind: 'apply';
    shipFsPath: string;
    via: 'shipFile' | 'modAction';
    /** Every file the edit changed, so they can be saved and tidied away. */
    changedFiles: string[];
    reference: string;
    warning?: 'noPartId';
    failure?: RegisterPartFailure;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
}

/** Why a registration did nothing, as the server words it. */
type RegisterPartFailure =
    | 'stale'
    | 'noShipClasses'
    | 'unknownShip'
    | 'alreadyRegistered'
    | 'partsInherited'
    | 'noPartsList'
    | 'noModRoot'
    | 'ambiguousManifest'
    | 'notEditable'
    | 'editRejected';

/**
 * What registering into a ship would do, shown under its entry in the picker.
 *
 * @param candidate the ship the server reported.
 * @returns the one-line detail.
 */
function shipCandidateDetail(candidate: ShipCandidate): string {
    if (candidate.alreadyRegistered) return l10n.t('Already listed in this ship');
    if (candidate.via === 'modAction') {
        return l10n.t("Patched in from this mod's manifest, so the game files stay untouched");
    }
    return l10n.t("Appended to this ship's own Parts list");
}

/**
 * Offer the ship classes the part can go into and let the user pick one.
 *
 * @param candidates the ship classes the server reported, in registry order.
 * @returns the picked ship, or undefined when none can take the part or the user backed out.
 */
async function pickShipCandidate(candidates: ShipCandidate[]): Promise<ShipCandidate | undefined> {
    const open = candidates.filter((candidate) => !candidate.blocked);
    if (open.length === 0) {
        window.showInformationMessage(
            l10n.t(
                'Cosmoteer: no ship class can take this part. Either none is loaded, or every one of them gets its Parts list from a base file, which this refactoring will not rewrite.'
            )
        );
        return undefined;
    }
    const picked = await window.showQuickPick(
        open.map((candidate) => ({
            label: candidate.id ?? candidate.groupName,
            description: workspace.asRelativePath(candidate.fsPath),
            detail: shipCandidateDetail(candidate),
            candidate,
        })),
        { placeHolder: l10n.t('Pick the ship class this part belongs to'), matchOnDescription: true }
    );
    return picked?.candidate;
}

/**
 * Say what the registration did, with the file it changed behind a button.
 *
 * @param result the server's registration summary.
 * @param cleanup what the tidy-up did.
 */
async function showRegisterPartSummary(result: RegisterPartApplyResult, cleanup?: ApplyCleanup): Promise<void> {
    warnOfUnsavedFiles(cleanup);
    const changed = result.changedFiles[0] ?? result.shipFsPath;
    const note =
        result.warning === 'noPartId'
            ? ` ${l10n.t('This part declares no ID yet, and the game will refuse to load it until it does.')}`
            : '';
    const message =
        result.via === 'modAction'
            ? l10n.t(
                  'Cosmoteer: added the part to {0} through an action in {1}.',
                  path.basename(result.shipFsPath),
                  workspace.asRelativePath(changed)
              )
            : l10n.t('Cosmoteer: added the part to {0}.', workspace.asRelativePath(changed));
    await offerToOpen(message + note, changed);
}

/**
 * Say why a registration did not happen, one message per reason the server reports, each naming what
 * the user can do about it.
 *
 * @param failure the server's reason.
 * @param manifests the manifest names to choose between, only for `ambiguousManifest`.
 * @returns the message to show.
 */
function registerPartFailureMessage(failure: RegisterPartFailure, manifests?: string[]): string {
    switch (failure) {
        case 'stale':
            return l10n.t('Cosmoteer: the part has moved since the offer was made, so nothing was changed.');
        case 'noShipClasses':
            return l10n.t(
                "Cosmoteer: no ship class was found. Set the Cosmoteer game path so the game's own ships are read."
            );
        case 'unknownShip':
            return l10n.t('Cosmoteer: that ship class is no longer registered, so nothing was changed.');
        case 'alreadyRegistered':
            return l10n.t('Cosmoteer: that ship already lists this part, so nothing was changed.');
        case 'partsInherited':
            return l10n.t(
                'Cosmoteer: that ship gets its Parts list from a base file, which this refactoring will not rewrite.'
            );
        case 'noPartsList':
            return l10n.t('Cosmoteer: that ship declares no Parts list to add to, so nothing was changed.');
        case 'noModRoot':
            return l10n.t(
                "Cosmoteer: this part is in no mod, so there is no manifest to patch the game's ship from. Put it in a mod, or turn on cosmoteerLSPRules.allowEditingVanillaFiles."
            );
        case 'ambiguousManifest':
            return l10n.t(
                'Cosmoteer: this mod has several manifests and none of them is mod.rules, so which one gets the part is yours to decide. Candidates: {0}.',
                (manifests ?? []).join(', ')
            );
        case 'notEditable':
            return l10n.t('Cosmoteer: the file could not be edited, so nothing was changed.');
        case 'editRejected':
            return l10n.t('Cosmoteer: the editor turned down the edit, so nothing was changed.');
    }
}

/**
 * Registers the registration the lightbulb offers.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the command runs through.
 */
export function registerPartRegistration(context: ExtensionContext, client: LanguageClient): void {
    context.subscriptions.push(
        // The command the server's part-registration refactoring carries. The server does not claim
        // it, so the editor runs this and the author picks the ship class before anything is written.
        commands.registerCommand(REGISTER_PART_IN_SHIP_LOCAL_COMMAND, async (args?: RegisterPartArgs) => {
            if (!args) return;
            const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.registerPartInShip',
                arguments: [args],
            })) as RegisterPartScanResult | null;
            if (!scan || scan.failure) {
                window.showWarningMessage(
                    scan?.failure
                        ? registerPartFailureMessage(scan.failure)
                        : l10n.t('Cosmoteer: the ship classes could not be read, so nothing was changed.')
                );
                return;
            }
            const ship = await pickShipCandidate(scan.candidates);
            if (!ship) return;
            // Captured before the edit, so the tidy-up can tell the tabs the user had from the one the
            // registration opened on its own.
            const openBefore = openDocumentPaths();
            const result = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.registerPartInShip',
                arguments: [{ ...args, ship: ship.key }],
            })) as RegisterPartApplyResult | null;
            if (!result) {
                window.showWarningMessage(
                    l10n.t('Cosmoteer: the part could not be registered, so nothing was changed.')
                );
                return;
            }
            if (result.failure) {
                window.showWarningMessage(registerPartFailureMessage(result.failure, result.manifests));
                return;
            }
            const cleanup = await saveAndTidy(result.changedFiles, openBefore);
            await showRegisterPartSummary(result, cleanup);
        })
    );
}
