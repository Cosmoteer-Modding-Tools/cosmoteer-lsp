/**
 * The facilities the register-part command is given, kept apart from the command so the new-content
 * and ship commands, which reuse the host, do not pull its file writing in with them. The shapes the
 * command speaks to a client in are shared with the clients, in shared/register-part.types.ts.
 */

import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { FileWithPath } from '../../../workspace/cosmoteer-workspace.service';

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface RegisterPartHost {
    /** The workspace folders whose mods may declare ships, as on-disk paths. */
    folderPaths(): Promise<string[]>;
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** The game's own root `cosmoteer.rules`, which holds the ship registry. */
    gameRoot(): Promise<FileWithPath | undefined>;
    /** The game's `Data` directory, which decides whether a ship is the install's or the mod's. */
    dataRoot(): string | undefined;
    /** Hands the client the edit. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Announces the files the command wrote, so the indexes pick them up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}
