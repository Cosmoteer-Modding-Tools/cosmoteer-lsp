/**
 * The server-side facilities the override-in-mod command is given, kept apart from the command so a
 * test can stand in for them without pulling the file writing in. The shapes the command speaks to a
 * client in are shared with the clients, in shared/override-in-mod.types.ts.
 */

import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface OverrideInModHost {
    /** The workspace folders whose mods could take the override, as on-disk paths. */
    folderPaths(): Promise<string[]>;
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** The game's `Data` directory, which the target path is expressed against. */
    dataRoot(): string | undefined;
    /** Hands the client the edit. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Announces the files the command wrote, so the indexes pick them up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}
