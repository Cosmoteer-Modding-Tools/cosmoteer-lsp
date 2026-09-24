import * as path from 'path';
import { commands, ExtensionContext, l10n, ProgressLocation, Uri, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import { showDiffPreview, showPatchPreview } from '../preview/diff-preview';
import { VirtualContentProvider } from '../virtual-content-provider';
import { ApplyCleanup, openDocumentPaths, saveAndTidy } from './apply-cleanup';
import {
    SerializedPlan,
    SharedBaseApplyResult,
    SharedBaseFailure,
    SharedBasePreviewResult,
    SharedBaseScanResult,
} from '../../../shared/shared-base.types';

/**
 * Moving fields several files repeat word for word into one base file they all inherit, the way the
 * game's own data is written. The server finds the repeats, works the rewrite out and applies it, and
 * this side offers the plans, shows the rewrite as a diff and asks before anything is written.
 */

/**
 * The command the server's lightbulb refactoring carries. The server deliberately does not claim it,
 * so the editor resolves it here and the rewrite can be shown as a real diff before it happens.
 */
const EXTRACT_SHARED_BASE_LOCAL_COMMAND = 'cosmoteer.extractSharedBaseFromAction';

/**
 * Offer the sweep's extractions and let the user pick one to look at.
 *
 * @param plans the plans the sweep reported, already ranked by how much duplication each removes.
 * @returns the picked plan, or undefined when the user backed out.
 */
async function pickSharedBasePlan(plans: SerializedPlan[]): Promise<SerializedPlan | undefined> {
    const picked = await window.showQuickPick(
        plans.map((plan) => ({
            label: plan.label,
            description: plan.className,
            detail: l10n.t(
                '{0}, removes {1} bytes of duplicated source',
                workspace.asRelativePath(plan.baseFsPath),
                plan.savedBytes
            ),
            plan,
        })),
        {
            placeHolder: l10n.t('Move fields several files of this mod repeat word for word into one shared base file'),
            matchOnDetail: true,
        }
    );
    return picked?.plan;
}

/**
 * The whole extraction exchange: work out what the plan would do, show it as a real diff, and apply
 * it only once the user says so. Shared by the palette command and the lightbulb, which the
 * middleware reroutes here so both get the editor's own diff rather than a patch to read.
 *
 * @param client the language client the command runs through.
 * @param plan the plan to preview and apply.
 * @param provider the content provider the rewritten files are served from.
 * @returns once the extraction happened or the user backed out.
 */
async function previewAndApplySharedBase(
    client: LanguageClient,
    plan: SerializedPlan,
    provider: VirtualContentProvider
): Promise<void> {
    // Captured before the preview, not after: the diff opens the real file on its left-hand side, so
    // by the time it is on screen those files count as open and the tidy-up would leave them behind.
    const openBefore = openDocumentPaths();
    const preview = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.extractSharedBase',
        arguments: [{ plan, preview: true }],
    })) as SharedBasePreviewResult | null;
    if (!preview || preview.failure) {
        window.showWarningMessage(
            preview?.failure
                ? sharedBaseFailureMessage(preview.failure)
                : l10n.t('Cosmoteer shared base: the preview could not be built, nothing was changed.')
        );
        return;
    }
    const title = l10n.t('Shared base: {0}', path.basename(preview.baseFsPath));
    if (preview.changed.length > 0) await showDiffPreview(provider, plan.id, preview.changed, title);
    else await showPatchPreview(provider, plan.id, preview.diff);

    if (!(await confirmSharedBaseRewrite(preview))) return;
    const result = await window.withProgress(
        { location: ProgressLocation.Notification, title: l10n.t('Extracting {0}', path.basename(preview.baseFsPath)) },
        async () =>
            (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.extractSharedBase',
                arguments: [{ plan }],
            })) as SharedBaseApplyResult | null
    );
    if (!result) {
        window.showWarningMessage(l10n.t('Cosmoteer shared base: the extraction failed, nothing was changed.'));
        return;
    }
    // A workspace edit over hundreds of files leaves every one of them open and unsaved, which is
    // not a state to hand back to anybody.
    const cleanup = result.failure ? undefined : await saveAndTidy(result.changedFiles, openBefore);
    await showSharedBaseSummary(result, cleanup);
}

/**
 * Have the user confirm the rewrite whose diff is now open beside the editor. Worth its click
 * because applying a plan writes or extends a file and edits every file that inherits it.
 *
 * @param preview the server's account of what the rewrite would do.
 * @returns true when the user asked for it to happen.
 */
async function confirmSharedBaseRewrite(preview: SharedBasePreviewResult): Promise<boolean> {
    const extract = l10n.t('Extract');
    const baseName = path.basename(preview.baseFsPath);
    const confirmed = await window.showInformationMessage(
        preview.tier === 'existingBase'
            ? l10n.t(
                  'Move {0} fields into {1}, the base those {2} files already inherit?',
                  preview.fields,
                  baseName,
                  preview.files
              )
            : l10n.t('Create {0} and rewrite {1} files to inherit it?', baseName, preview.files),
        {
            modal: true,
            detail:
                preview.omitted > 0
                    ? l10n.t(
                          'The open diff shows {0} of the changed files. In total {1} fields leave {2} files, removing {3} bytes of duplicated source.',
                          preview.changed.length,
                          preview.fields,
                          preview.files,
                          preview.removedBytes
                      )
                    : l10n.t(
                          'The open diff is the whole change: {0} fields leave {1} files, removing {2} bytes of duplicated source.',
                          preview.fields,
                          preview.files,
                          preview.removedBytes
                      ),
        },
        extract
    );
    return confirmed === extract;
}

/**
 * Render the extraction outcome: a one-line information message, with the new base file behind a
 * button, or the reason nothing was changed.
 *
 * @param result the server's extraction summary.
 */
async function showSharedBaseSummary(result: SharedBaseApplyResult, cleanup?: ApplyCleanup): Promise<void> {
    if (result.failure) {
        window.showWarningMessage(sharedBaseFailureMessage(result.failure));
        return;
    }
    if (cleanup?.unsaved.length) {
        window.showWarningMessage(
            l10n.t(
                'Cosmoteer shared base: {0} files could not be saved and are still open with their changes. Save them yourself or undo.',
                cleanup.unsaved.length
            )
        );
    }
    const open = l10n.t('Open Base File');
    const tidied = cleanup?.saved
        ? ` ${l10n.t('{0} files saved, {1} tabs closed.', cleanup.saved, cleanup.closed)}`
        : '';
    const picked = await window.showInformationMessage(
        (result.tier === 'existingBase'
            ? l10n.t(
                  'Cosmoteer shared base: moved {1} fields into {0}, out of {2} files, removed {3} bytes.',
                  workspace.asRelativePath(result.created),
                  result.fields,
                  result.files,
                  result.removedBytes
              )
            : l10n.t(
                  'Cosmoteer shared base: created {0}, moved {1} fields out of {2} files, removed {3} bytes.',
                  workspace.asRelativePath(result.created),
                  result.fields,
                  result.files,
                  result.removedBytes
              )) + tidied,
        open
    );
    if (picked !== open) return;
    const doc = await workspace.openTextDocument(Uri.file(result.created));
    await window.showTextDocument(doc, { preview: true });
}

/**
 * Say why an extraction did not happen, one message per reason the server reports, each naming what
 * the user can do about it.
 *
 * @param failure the server's reason.
 * @returns the message to show.
 */
function sharedBaseFailureMessage(failure: SharedBaseFailure): string {
    switch (failure) {
        case 'planStale':
            return l10n.t(
                'Cosmoteer shared base: those files no longer write the same fields, so nothing was changed. Run the command again to search the current text.'
            );
        case 'baseFileExists':
            return l10n.t(
                'Cosmoteer shared base: a file of that name already sits next to those files, so nothing was changed. Rename or remove it and run the command again.'
            );
        case 'notEditable':
            return l10n.t(
                'Cosmoteer shared base: the base file could not be written, so nothing was changed. Check that its folder is writable.'
            );
        case 'editRejected':
            return l10n.t(
                'Cosmoteer shared base: the editor turned down the rewrite, so the base file was removed again and nothing was changed.'
            );
    }
}

/**
 * Registers the palette sweep and the lightbulb's extraction, which share the preview.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the commands run through.
 * @param provider the content provider the rewritten files are served from.
 */
export function registerSharedBase(
    context: ExtensionContext,
    client: LanguageClient,
    provider: VirtualContentProvider
): void {
    // Shared base extraction: a command that sweeps the mod for fields several files write word for
    // word and turns the set the user picks into a base file all of them inherit, the way the game's
    // own data and the larger mods are written. The server ranks the extractions, writes the base file
    // and applies the multi-file edit, so this wrapper only offers the plans and renders the returned
    // summary. A distinct command id from the server's executeCommand id, for the same reason as the
    // migration above.
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.extractSharedBaseFiles', async () => {
            const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.extractSharedBase',
                arguments: [{}],
            })) as SharedBaseScanResult | null;
            if (!scan) {
                window.showInformationMessage(l10n.t('Cosmoteer shared base: the search could not be completed.'));
                return;
            }
            if (scan.plans.length === 0) {
                window.showInformationMessage(
                    l10n.t(
                        'Cosmoteer shared base: nothing worth extracting in {0} files, no group repeats another one word for word.',
                        scan.filesScanned
                    )
                );
                return;
            }
            const plan = await pickSharedBasePlan(scan.plans);
            if (plan) await previewAndApplySharedBase(client, plan, provider);
        }),
        // The command the server's lightbulb refactoring carries. The server does not declare it, so
        // the editor runs this rather than forwarding it, and the rewrite gets a real diff.
        commands.registerCommand(EXTRACT_SHARED_BASE_LOCAL_COMMAND, async (plan?: SerializedPlan) => {
            if (plan) await previewAndApplySharedBase(client, plan, provider);
        })
    );
}
