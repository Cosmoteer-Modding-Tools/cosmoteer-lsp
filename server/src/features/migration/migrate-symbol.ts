import { readFile, writeFile } from 'fs/promises';
import { CancellationToken, CodeAction, CodeActionKind, Diagnostic, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as l10n from '@vscode/l10n';
import { deprecationBySymbol } from '../../document/schema/deprecations';
import { ValidationErrorData } from '../diagnostics/validator';
import { MentionIndex } from '../navigation/mention.index';
import { normalizeUri } from '../navigation/reference-location';
import { uriToFsPath } from '../navigation/workspace-files';
import { editableModRootOf } from '../refactor/shared-base/shared-base.analysis-entry';
import { foldPathCase } from '../../workspace/fs-cache';

/**
 * The `workspace/executeCommand` id of the bulk deprecation fix. The server claims it, runs the
 * whole-workspace migration narrowed to one deprecation and one mod, and answers with the same
 * {@link MigrationSummary} the whole-workspace command returns, so both clients render it with the
 * code they already have.
 */
export const MIGRATE_SYMBOL_COMMAND = 'cosmoteer.migrateSymbol';

/**
 * The command the lightbulb offer carries. The server deliberately leaves it out of its
 * `executeCommandProvider`, so VS Code and LSP4IJ both fall back to their own registration and the
 * client can show the rewrite as a diff and ask before anything is written. That matters more here
 * than for a single quick fix: a bulk fix can rewrite every part file of a mod at once, and undo in
 * both editors is per file.
 */
export const MIGRATE_SYMBOL_ACTION_COMMAND = 'cosmoteer.migrateSymbolFromAction';

/** What the bulk fix is invoked with: the deprecation to apply, and the file it was offered in. */
export interface MigrateSymbolArgs {
    /** The deprecation-registry identity, from the diagnostic's `data.migration.symbol`. */
    symbol: string;
    /** The uri of the file the offer came from, which decides the mod the sweep stays inside. */
    uri: string;
    /** Work the rewrite out and answer with it as a diff, without changing anything. */
    dryRun?: boolean;
}

/**
 * The "apply this deprecation fix to the whole mod" offer, built from a diagnostic that already
 * carries the fix. Offered beside the single-file quick fix, never instead of it and never as the
 * preferred action, since the author asked about one line and the bulk fix answers about a mod.
 *
 * The offer carries a command rather than an edit: which files change is only known after a sweep,
 * which is far too much work to do while the lightbulb menu is being built.
 *
 * @param diagnostic the diagnostic the offer hangs on.
 * @param uri the file the diagnostic is in.
 * @param data the diagnostic's validation data, whose `migration.symbol` names the deprecation.
 * @returns the code action, or undefined when this finding is not one a bulk fix can apply.
 */
export const migrateSymbolCodeAction = (
    diagnostic: Diagnostic,
    uri: string,
    data: ValidationErrorData | undefined
): CodeAction | undefined => {
    const migration = data?.migration;
    // Without a sanctioned fix the migration only reports the finding, so there is nothing to apply
    // in bulk either. Those need author judgment one by one.
    if (!migration?.symbol || !migration.apply) return undefined;
    const deprecation = deprecationBySymbol(migration.symbol);
    if (!deprecation) return undefined;
    // The same gate every refactoring reads: never rewrite the game's own files or somebody else's
    // installed workshop mod. Offering a fix that would then decline to touch anything is worse than
    // not offering it.
    if (!editableModRootOf(uriToFsPath(uri))) return undefined;
    const title = deprecation.replacement
        ? l10n.t("Change every '{0}' in this mod to '{1}'", deprecation.name, deprecation.replacement)
        : l10n.t("Migrate every '{0}' in this mod", deprecation.name);
    return {
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        command: {
            title,
            command: MIGRATE_SYMBOL_ACTION_COMMAND,
            arguments: [{ symbol: migration.symbol, uri } satisfies MigrateSymbolArgs],
        },
    };
};

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

/**
 * The real lookups: the project's mention index and the shared editable-mod gate.
 *
 * @returns the host the server uses.
 */
const defaultMigrateSymbolHost = (): MigrateSymbolHost => ({
    candidateFiles: (name, folderPaths, token) => MentionIndex.instance.candidateFiles(name, folderPaths, token),
    editableRootOf: (fsPath) => editableModRootOf(fsPath),
});

/** Which files a bulk fix may look at: one deprecation, one mod, and the folders in the project. */
interface SymbolScope {
    /** The deprecation-registry identity being applied. */
    symbol: string;
    /** The on-disk path of the file the offer came from, which names the mod the sweep stays in. */
    scopeFsPath: string;
    /** The workspace folders, as the mention index needs them. */
    folderPaths: string[];
}

/**
 * Narrow a whole-workspace file list to the files a bulk deprecation fix may rewrite.
 *
 * Two independent gates. The mod gate is the important one: the sweep stays inside the one editable
 * mod the offer came from, so a project holding several mods, or a workspace that also has the game's
 * `Data` tree open, never has files of another tree rewritten by a fix the author asked for in this
 * one. It is the same gate the shared-base extraction reads, so the game tree is refused unless
 * `allowEditingVanillaFiles` is on and an installed workshop mod is refused outright.
 *
 * The mention-index gate is only a cost saver: a file that does not write the old name anywhere
 * cannot produce a finding for it, and the index answers that without reading the file. Its own
 * contract is that the pre-filter can never change which documents are found, and it walks the same
 * file set the migration does, so nothing is lost. When it cannot answer, the full list stands.
 *
 * @param files the files the workspace migration would visit.
 * @param scope the deprecation, the invoking file, and the project folders.
 * @param token cancels the index sync the candidate query may start.
 * @param host the lookups, replaceable in tests.
 * @returns the files to visit, empty when the invoking file is not in a mod that may be rewritten.
 */
export const narrowToSymbolScope = async (
    files: readonly string[],
    scope: SymbolScope,
    token: CancellationToken,
    host: MigrateSymbolHost = defaultMigrateSymbolHost()
): Promise<string[]> => {
    const deprecation = deprecationBySymbol(scope.symbol);
    if (!deprecation) return [];
    const modRoot = host.editableRootOf(scope.scopeFsPath);
    if (!modRoot) return [];
    // The index question is answered from memory, the mod question walks the disk for a manifest, so
    // the cheap filter runs first and the walk only sees what is left.
    const candidates = await host.candidateFiles(deprecation.name, scope.folderPaths, token).catch(() => undefined);
    let mentioning = files;
    if (candidates) {
        const mentioned = new Set(candidates.map((file) => foldPathCase(file.replace(/\\/g, '/'))));
        // The file the offer came from is known to carry the finding, so it is kept whatever the
        // index says about it. Its text can be an unsaved buffer the index has not read yet.
        const selfKey = foldPathCase(scope.scopeFsPath.replace(/\\/g, '/'));
        mentioning = files.filter((file) => {
            const key = foldPathCase(file.replace(/\\/g, '/'));
            return key === selfKey || mentioned.has(key);
        });
    }

    const rootKey = foldPathCase(modRoot.replace(/\\/g, '/'));
    return mentioning.filter((file) => {
        const root = host.editableRootOf(file);
        return root !== undefined && foldPathCase(root.replace(/\\/g, '/')) === rootKey;
    });
};

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

/** The client-side facilities a migration needs to land its rewrite and refresh the indexes. */
interface MigrationApplyHost {
    /** The editor's open buffers, whose files have to be edited through the editor. */
    openDocuments(): readonly { uri: string }[];
    /** Hands the client the multi-file edit. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Announces the files that were written, so the indexes pick them up without a watcher event. */
    filesChanged(paths: readonly string[]): void;
}

/** What a migration managed to write. */
interface MigrationApplyResult {
    /** How many files actually changed. */
    files: number;
    /** The files nothing could be written to, which are unchanged. */
    failed: string[];
}

/**
 * Apply a migration's per-file edits, splitting them the way the shared-base extraction does.
 *
 * Only the files the author has open go through the editor. A workspace edit over a file that is not
 * open makes the editor load it, hold it dirty and give it a tab, so a migration covering a few
 * hundred part files would bury the workspace in unsaved buffers. Those are written straight to disk
 * instead, and the indexes are told about every touched file, or the freshly renamed field keeps
 * being reported until a watcher event lands.
 *
 * @param changes the files to rewrite, with the text their edits were computed against.
 * @param host the client-side facilities.
 * @returns how many files changed, and the ones that could not be written.
 */
export const applyMigrationChanges = async (
    changes: readonly MigrationChange[],
    host: MigrationApplyHost
): Promise<MigrationApplyResult> => {
    const open = new Set(host.openDocuments().map((document) => normalizeUri(document.uri)));
    const throughEditor = changes.filter((change) => open.has(normalizeUri(change.uri)));
    const ontoDisk = changes.filter((change) => !open.has(normalizeUri(change.uri)));

    const written: string[] = [];
    const failed: string[] = [];
    for (const change of ontoDisk) {
        try {
            const document = TextDocument.create(change.uri, 'rules', 0, change.text);
            const after = TextDocument.applyEdits(document, change.edits);
            // A file that moved on while the sweep was running is left alone: the edits were
            // computed against text that is no longer there, so applying them could land anywhere.
            // A file that has gone is not written back either, since bringing it back is not what
            // the fix offered to do.
            const current = await readFile(change.fsPath, { encoding: 'utf-8' }).catch(() => undefined);
            if (current !== change.text) {
                failed.push(change.fsPath);
                continue;
            }
            await writeFile(change.fsPath, after, { encoding: 'utf-8' });
            written.push(change.fsPath);
        } catch {
            failed.push(change.fsPath);
        }
    }
    if (written.length > 0) host.filesChanged(written);

    if (throughEditor.length === 0) return { files: written.length, failed };
    const edits: Record<string, TextEdit[]> = {};
    for (const change of throughEditor) edits[change.uri] = change.edits;
    const applied = await host.applyEdit(edits).catch(() => false);
    if (!applied) {
        return { files: written.length, failed: [...failed, ...throughEditor.map((change) => change.fsPath)] };
    }
    host.filesChanged(throughEditor.map((change) => change.fsPath));
    return { files: written.length + throughEditor.length, failed };
};
