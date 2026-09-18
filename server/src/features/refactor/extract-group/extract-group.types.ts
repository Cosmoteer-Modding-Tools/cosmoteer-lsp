/**
 * The facilities the extract-group command is given, kept apart from the command so a test can stand
 * in for them without pulling the file writing in. The shapes the command speaks to a client in are
 * shared with the clients, in shared/extract-group.types.ts.
 */

import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

/** The facilities the command reads buffers through and hands its edit to. */
export interface ExtractGroupHost {
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** Hands the client the edit that replaces the group with a reference. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Announces the file the command wrote, so the indexes pick it up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}
