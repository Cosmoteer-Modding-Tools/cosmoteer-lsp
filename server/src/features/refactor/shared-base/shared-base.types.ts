/**
 * The facilities the shared-base extraction command is given, kept apart from the command so a test
 * can stand in for them without pulling the file writing in. The shapes the command speaks to a
 * client in are shared with the clients, in shared/shared-base.types.ts, and the plan's own working
 * form is in plan.types.ts.
 */

import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface SharedBaseHost {
    /** The workspace folders to sweep, as on-disk paths. */
    folderPaths(): Promise<string[]>;
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** Hands the client the multi-file edit. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Reports sweep progress, from 0 to 100. */
    report?(percent: number, message: string): void;
    /**
     * Whether a file is one the game actually loads. Without it the sweep would offer to rewrite a
     * backup folder or an unused template, and would drag the base file up to a directory the live
     * files do not share.
     */
    inScope?(fsPath: string): boolean;
    /** Announces the files the command wrote, so the indexes pick them up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}
