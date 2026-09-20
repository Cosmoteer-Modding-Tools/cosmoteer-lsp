/**
 * The server-side shapes the migration sweeps work in: the lookups the bulk sweep narrows its file
 * set with, and the per-file change a migration computes. What the commands answer a client in is
 * shared with the clients, in shared/migration.types.ts.
 */

import { CancellationToken, TextEdit } from 'vscode-languageserver';

/** What the bulk fix is invoked with: the deprecation to apply, and the file it was offered in. */
export interface MigrateSymbolArgs {
    /** The deprecation-registry identity, from the diagnostic's `data.migration.symbol`. */
    symbol: string;
    /** The uri of the file the offer came from, which decides the mod the sweep stays inside. */
    uri: string;
    /** Work the rewrite out and answer with it as a diff, without changing anything. */
    dryRun?: boolean;
}

/** The lookups the bulk sweep narrows its file set with, so a test can stand in for both. */
export interface MigrateSymbolHost {
    /**
     * The indexed files under `folderPaths` whose text can contain `name`, from the mention index.
     * Undefined when the name has no word token, which means "no pre-filter available".
     */
    candidateFiles(name: string, folderPaths: string[], token: CancellationToken): Promise<string[] | undefined>;
    /** The tree a file may be rewritten within, or undefined when it must be left alone. */
    editableRootOf(fsPath: string): string | undefined;
}

/** One file a migration rewrites, with the text the edits were computed against. */
export interface MigrationChange {
    /** The uri to edit through the client, which for an open file is that buffer's own uri. */
    uri: string;
    /** The file's on-disk path, for the files written directly. */
    fsPath: string;
    /** The text the edits were computed against (the open buffer's, or what was read from disk). */
    text: string;
    /** The edits to apply to that text. */
    edits: TextEdit[];
}
