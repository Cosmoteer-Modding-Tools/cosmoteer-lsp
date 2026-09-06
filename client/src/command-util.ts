import { l10n, Uri, window, workspace } from 'vscode';
import { ApplyCleanup } from './shared-base/apply-cleanup';

/**
 * The two ways a refactoring command ends once the server has written its files: a summary with the
 * changed file behind a button, and the warning for files the tidy-up could not save. Shared by the
 * commands that register a part and that override a value, and by whatever next writes a file and
 * wants to say so.
 */

/**
 * Show a summary with an "Open File" button, and open the file in a preview tab when it is pressed.
 *
 * @param message the summary.
 * @param fsPath the file the button opens.
 */
export async function offerToOpen(message: string, fsPath: string): Promise<void> {
    const open = l10n.t('Open File');
    const picked = await window.showInformationMessage(message, open);
    if (picked !== open) return;
    const doc = await workspace.openTextDocument(Uri.file(fsPath));
    await window.showTextDocument(doc, { preview: true });
}

/**
 * Warn when the tidy-up could not save some of the changed files. They stay open with their changes so
 * nothing is lost, and the warning says so.
 *
 * @param cleanup what the tidy-up did, absent when nothing was applied.
 */
export function warnOfUnsavedFiles(cleanup?: ApplyCleanup): void {
    if (cleanup?.unsaved.length) {
        window.showWarningMessage(
            l10n.t(
                'Cosmoteer: {0} files could not be saved and are still open with their changes. Save them yourself or undo.',
                cleanup.unsaved.length
            )
        );
    }
}
