import * as path from 'path';
import { commands, ExtensionContext, l10n, ProgressLocation, Uri, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { DiffPreviewFile, DiffPreviewProvider, showDiffPreview, showPatchPreview } from '../preview/diff-preview';
import { openDocumentPaths, saveAndTidy } from '../shared-base/apply-cleanup';

/**
 * Cloning a declaration under a new id, with everything inside the copy that names the old id
 * rewritten. The server reads what the copy would take and writes it, and this side asks for the id,
 * shows the copy as a diff and asks again before anything is written.
 */

/**
 * The command the server's "clone this under a new id" refactoring carries. The server does not claim
 * it, so the editor runs this instead: the new id is a name only the author can give, and the copy
 * writes files that have to be read before they are written.
 */
export const CLONE_DECLARATION_LOCAL_COMMAND = 'cosmoteer.cloneDeclarationFromAction';

/** What an id may be spelled with, the same set the server and the rename refactoring enforce. */
const VALID_CLONE_ID = /^[A-Za-z0-9_.]+$/;

/**
 * Mirror of the server's clone arguments (see server
 * features/refactor/clone-declaration/clone.command.ts).
 */
interface CloneDeclarationArgs {
    uri: string;
    offset: number;
    newId?: string;
    destinationDir?: string;
    preview?: boolean;
}

/** Mirror of the server's report round. */
interface CloneScanResult {
    kind: 'scan';
    id: string;
    identityKey: string;
    unit: 'directory' | 'file' | 'listElement';
    files: number;
    proposedId: string;
    destinationDir: string;
    modRoots: string[];
    failure?: CloneFailure;
}

/** Mirror of the server's preview round. */
interface ClonePreviewResult {
    kind: 'preview';
    diff: string;
    changed: DiffPreviewFile[];
    omitted: number;
    writes: string[];
    copied: string[];
    stringsFiles: string[];
    destinationDir: string;
    newId: string;
    unit: 'directory' | 'file' | 'listElement';
    droppedOtherIds: string[];
    keys: Array<{ from: string; to: string }>;
    failure?: CloneFailure;
    detail?: string[];
}

/** Mirror of the server's apply round. */
interface CloneApplyResult {
    kind: 'apply';
    created: string;
    createdPaths: string[];
    changedFiles: string[];
    stringsFiles: string[];
    droppedOtherIds: string[];
    keys: number;
    newId: string;
    unit: 'directory' | 'file' | 'listElement';
    failure?: CloneFailure;
    detail?: string[];
}

/** Why a clone did nothing, as the server words it. */
type CloneFailure =
    | 'stale'
    | 'noDeclaration'
    | 'inheritedIdentity'
    | 'unreadableBase'
    | 'severalIdentities'
    | 'invalidId'
    | 'idUnchanged'
    | 'idTaken'
    | 'notEditable'
    | 'ambiguousDestination'
    | 'destinationExists'
    | 'unresolvablePath'
    | 'escapingPath'
    | 'writeFailed'
    | 'editRejected';

/**
 * Say why a clone did not happen, one message per reason the server reports, each naming what the user
 * can do about it.
 *
 * @param failure the server's reason.
 * @param detail what the reason is about: a path, a file, or the mods to choose between.
 * @returns the message to show.
 */
function cloneFailureMessage(failure: CloneFailure, detail?: string[]): string {
    const first = detail?.[0] ?? '';
    switch (failure) {
        case 'stale':
            return l10n.t('Cosmoteer: the declaration has moved since the offer was made, so nothing was changed.');
        case 'noDeclaration':
            return l10n.t('Cosmoteer: nothing here declares an id, so there is nothing to clone.');
        case 'inheritedIdentity':
            return l10n.t(
                'Cosmoteer: this takes its id from a base file, so a copy would carry the same id. Give it an ID of its own first.'
            );
        case 'unreadableBase':
            return l10n.t(
                'Cosmoteer: a base file of this one could not be read, so there is no saying what the copy would carry.'
            );
        case 'severalIdentities':
            return l10n.t('Cosmoteer: this file declares more than one thing. Put the cursor in the one to clone.');
        case 'invalidId':
            return l10n.t('Cosmoteer: an id is made of letters, digits, dots and underscores.');
        case 'idUnchanged':
            return l10n.t('Cosmoteer: that is the id it already has. The game matches ids without regard to case.');
        case 'idTaken':
            return l10n.t(
                'Cosmoteer: something already declares that id, and the game keeps one of two such entries and drops the other.'
            );
        case 'notEditable':
            return l10n.t(
                "Cosmoteer: the copy would land outside a mod you can edit. The game's own files and installed workshop mods are left alone."
            );
        case 'ambiguousDestination':
            return l10n.t(
                'Cosmoteer: the workspace holds several mods, so which one gets the copy is yours to decide. Candidates: {0}.',
                (detail ?? []).join(', ')
            );
        case 'destinationExists':
            return l10n.t('Cosmoteer: {0} is already there, so nothing was changed.', first);
        case 'unresolvablePath':
            return l10n.t(
                'Cosmoteer: this reads {0}, which is not on disk, so the copy would read nothing either.',
                first
            );
        case 'escapingPath':
            return l10n.t(
                'Cosmoteer: this reads {0} from outside the destination mod, which a published mod cannot do. Copy that file into the mod first.',
                first
            );
        case 'writeFailed':
            return l10n.t('Cosmoteer: the copy could not be written, so it was removed again.');
        case 'editRejected':
            return l10n.t('Cosmoteer: the editor turned the edit down.');
    }
}

/**
 * Ask for the new id, show the whole copy as a diff, and write it once the author says so.
 *
 * The exchange is three rounds, the same shape the shared-base extraction uses: the server reports what
 * cloning would take, the author names the id, the server works the copy out and answers with it, and
 * only then is anything written.
 *
 * @param client the language client the command runs through.
 * @param args the declaration the lightbulb offered.
 * @param provider the content provider the copy's files are served from.
 * @returns once the copy happened or the author backed out.
 */
async function cloneDeclarationFlow(
    client: LanguageClient,
    args: CloneDeclarationArgs,
    provider: DiffPreviewProvider
): Promise<void> {
    const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.cloneDeclaration',
        arguments: [args],
    })) as CloneScanResult | null;
    if (!scan || scan.failure) {
        window.showWarningMessage(
            scan?.failure
                ? cloneFailureMessage(scan.failure)
                : l10n.t('Cosmoteer: this could not be read, so nothing was changed.')
        );
        return;
    }
    const newId = await window.showInputBox({
        title: l10n.t('Clone under a new id'),
        prompt: l10n.t(
            'The id the copy declares. Everything inside the copy that names the old id is rewritten to it.'
        ),
        value: scan.proposedId,
        validateInput: (value) =>
            VALID_CLONE_ID.test(value.trim())
                ? undefined
                : l10n.t('An id is made of letters, digits, dots and underscores.'),
    });
    if (!newId) return;

    // Captured before the preview, not after: the diff opens the real files on its left-hand side, so
    // by the time it is on screen those files count as open and the tidy-up would leave them behind.
    const openBefore = openDocumentPaths();
    const preview = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.cloneDeclaration',
        arguments: [{ ...args, newId: newId.trim(), preview: true }],
    })) as ClonePreviewResult | null;
    if (!preview || preview.failure) {
        window.showWarningMessage(
            preview?.failure
                ? cloneFailureMessage(preview.failure, preview.detail)
                : l10n.t('Cosmoteer: the copy could not be worked out, so nothing was changed.')
        );
        return;
    }
    const title = l10n.t('Clone: {0}', preview.newId);
    if (preview.changed.length > 0) await showDiffPreview(provider, `clone-${preview.newId}`, preview.changed, title);
    else await showPatchPreview(provider, `clone-${preview.newId}`, preview.diff);

    if (!(await confirmClone(preview))) return;
    const result = await window.withProgress(
        { location: ProgressLocation.Notification, title: l10n.t('Cloning {0}', preview.newId) },
        async () =>
            (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.cloneDeclaration',
                arguments: [{ ...args, newId: newId.trim() }],
            })) as CloneApplyResult | null
    );
    if (!result) {
        window.showWarningMessage(l10n.t('Cosmoteer: the copy could not be made, so nothing was changed.'));
        return;
    }
    if (result.failure) {
        window.showWarningMessage(cloneFailureMessage(result.failure, result.detail));
        return;
    }
    await saveAndTidy(result.changedFiles, openBefore);
    await showCloneSummary(result);
}

/**
 * Have the author confirm the copy whose diff is now open beside the editor. Worth its click because
 * applying it writes a folder of files into the project.
 *
 * @param preview the server's account of what the copy would write.
 * @returns true when the author asked for it to happen.
 */
async function confirmClone(preview: ClonePreviewResult): Promise<boolean> {
    const clone = l10n.t('Clone');
    const parts: string[] = [];
    parts.push(
        preview.omitted > 0
            ? l10n.t('The open diff shows {0} of the files the copy writes.', preview.changed.length)
            : l10n.t('The open diff is the whole change.')
    );
    if (preview.keys.length > 0) {
        parts.push(
            l10n.t(
                '{0} new language keys are declared with the text the original already has.',
                preview.keys.length
            )
        );
    }
    if (preview.droppedOtherIds.length > 0) {
        parts.push(
            l10n.t(
                'The OtherIDs aliases {0} stay with the original, because the game answers to them there.',
                preview.droppedOtherIds.join(', ')
            )
        );
    }
    parts.push(l10n.t('References elsewhere in the project keep pointing at the original.'));
    const confirmed = await window.showInformationMessage(
        preview.unit === 'listElement'
            ? l10n.t('Add {0} to the same list?', preview.newId)
            : l10n.t('Write {0} files into {1}?', preview.writes.length, path.basename(preview.destinationDir)),
        { modal: true, detail: parts.join(' ') },
        clone
    );
    return confirmed === clone;
}

/**
 * Render the outcome: one information message, with the copy behind a button.
 *
 * @param result what the server wrote.
 * @returns once the message is dismissed or the copy is opened.
 */
async function showCloneSummary(result: CloneApplyResult): Promise<void> {
    if (result.unit === 'listElement') {
        window.showInformationMessage(l10n.t('Added {0} to the same list.', result.newId));
        return;
    }
    const open = l10n.t('Open the copy');
    const picked = await window.showInformationMessage(
        l10n.t('Cloned as {0} into {1} files.', result.newId, result.createdPaths.length),
        open
    );
    if (picked !== open || !result.created) return;
    const document = await workspace.openTextDocument(Uri.file(result.created));
    await window.showTextDocument(document);
}

/**
 * Registers the clone the lightbulb offers.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the command runs through.
 * @param provider the content provider the copy's files are served from.
 */
export function registerCloneDeclaration(
    context: ExtensionContext,
    client: LanguageClient,
    provider: DiffPreviewProvider
): void {
    context.subscriptions.push(
        // The command the server's clone refactoring carries. The server does not claim it, so the
        // editor runs this and the author names the id and reads the copy before anything is written.
        commands.registerCommand(CLONE_DECLARATION_LOCAL_COMMAND, async (args?: CloneDeclarationArgs) => {
            if (args) await cloneDeclarationFlow(client, args, provider);
        })
    );
}
