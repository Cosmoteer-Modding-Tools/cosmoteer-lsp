import { CancellationToken } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { readFile } from 'fs/promises';
import { lexer } from '../core/lexer/lexer';
import { parser } from '../core/parser/parser';
import {
    collectFileMigration,
    createMigrationPreview,
    migrationWriteScope,
} from '../features/migration/migrate-workspace';
import { applyMigrationChanges, narrowToSymbolScope } from '../features/migration/migrate-symbol';
import { MigrationSummary } from '../../../shared/migration.types';
import { MigrationChange } from '../features/migration/migration.types';
import { uriToFsPath } from '../workspace/workspace-files';
import { collectRulesFiles } from '../workspace/rules-file-walk';
import { filePathToUri } from '../document/reference-path';
import { normalizeUri } from '../document/reference-location';
import { beginFsTrustWindow, endFsTrustWindow } from '../workspace/fs-cache';
import { workspaceRelativePath } from '../utils/relative-path';
import { connection, documents } from './context';
import { ensureFragmentRooting } from './fragment-rooting';
import { sharedBaseHost } from './hosts';
import { isOutsideRulesPanel, reachableFileFilter } from './validation-scope';
import { workspaceFolderUris } from './workspace-folders';

/** What a migration run was asked to do. */
interface MigrationOptions {
    /** Also strips every ignored or dead-field finding, the fields the game never reads. */
    readonly removeDeadFields?: boolean;
    /** Works the whole migration out and answers with it as a diff, without changing anything. */
    readonly dryRun?: boolean;
    /** Narrows the run to one deprecation-registry entry. */
    readonly symbol?: string;
    /** The file the bulk fix was invoked from, whose mod the run then stays inside. */
    readonly scopeFsPath?: string;
}

/** What one migration pass gathers as it walks the files. */
interface MigrationRun {
    /** The counts the client displays, added to as each file is read. */
    readonly summary: MigrationSummary;
    /** The per-file edits a real run collects, left empty by a dry run. */
    readonly changes: MigrationChange[];
    /** The side-by-side text a dry run collects, absent during a real run. */
    readonly preview: ReturnType<typeof createMigrationPreview> | undefined;
    /** The workspace folders, which the preview writes its relative paths against. */
    readonly folderPaths: string[];
    /** Whether the run also strips the fields the game never reads. */
    readonly removeDeadFields: boolean;
    /** The one deprecation a bulk fix narrows the run to, absent for a whole-workspace run. */
    readonly symbol: string | undefined;
    /** The open editor buffers by normalized uri, which win over what is on disk. */
    readonly openByNorm: Map<string, TextDocument>;
    /** Cancels the per-file collection. */
    readonly token: CancellationToken;
}

/**
 * The files the migration visits: every rules file of the opened folders, cut to the ones the game
 * can load, cut again to the trees the write gate allows, and cut once more to the mod and the
 * mentions a bulk fix for one deprecation cares about.
 *
 * @param folderUris the workspace folders to walk.
 * @param folderPaths the same folders as paths, which the symbol narrowing reads.
 * @param options the run's options, whose `symbol` and `scopeFsPath` drive the narrowing.
 * @param token cancels the walk.
 * @returns the files to migrate in walk order, and the trees that were left alone.
 */
const filesToMigrate = async (
    folderUris: string[],
    folderPaths: string[],
    options: MigrationOptions,
    token: CancellationToken
): Promise<{ files: string[]; refusedTrees: string[] }> => {
    const files: string[] = [];
    for (const folder of folderUris) {
        for await (const file of collectRulesFiles(uriToFsPath(folder))) files.push(file);
    }
    // Same scope the diagnostics scan uses: only files the game can actually load.
    const scopeAllows = await reachableFileFilter(token);
    const loadable = scopeAllows ? files.filter((file) => scopeAllows(file)) : files;
    await ensureFragmentRooting(token).catch(() => undefined);
    // The migration writes straight to disk, so the one gate that says which trees may be written
    // decides here too. A folder the user opened that turns out to be the game's own install or
    // somebody else's installed mod is walked and reported, never edited.
    const { files: writable, refusedTrees } = migrationWriteScope(loadable);
    // A bulk fix for one deprecation stays inside the mod it was invoked from and only visits
    // the files that can mention the old name. Both gates belong to that command: the
    // whole-workspace migration deliberately covers every other folder the user opened.
    if (options.symbol === undefined || options.scopeFsPath === undefined) return { files: writable, refusedTrees };
    const narrowed = await narrowToSymbolScope(
        writable,
        { symbol: options.symbol, scopeFsPath: options.scopeFsPath, folderPaths },
        token
    );
    return { files: narrowed, refusedTrees };
};

/**
 * Reads one file, works out what the migration changes in it, and adds the result to the run: the
 * counts either way, the edits for a real run, the side-by-side text for a dry run.
 *
 * A file the parser could not fully read is never edited mechanically, since an edit computed
 * against a desynced AST could land in the wrong place. It is counted as unparsable instead.
 *
 * @param run what the pass has gathered so far, which this adds to.
 * @param file the file to read.
 * @param reportProgress tells the client how far the walk has come, called once the file is read.
 * @returns once the file has been accounted for.
 */
const migrateOneFile = async (run: MigrationRun, file: string, reportProgress: () => void): Promise<void> => {
    const { summary, preview } = run;
    const canonicalUri = filePathToUri(file);
    let doc = run.openByNorm.get(normalizeUri(canonicalUri));
    if (!doc) {
        // Prose the game never loads (a readme, a `.txt` nothing references) is skipped like
        // the diagnostics scan skips it.
        if (await isOutsideRulesPanel(file, run.token)) return;
        let text: string;
        try {
            text = await readFile(file, { encoding: 'utf-8' });
        } catch {
            return;
        }
        doc = TextDocument.create(canonicalUri, 'rules', 0, text);
    }
    const parserResult = parser(lexer(doc.getText()), doc.uri);
    if (parserResult.parserErrors.length > 0) {
        summary.unparsable++;
        return;
    }
    const fileResult = await collectFileMigration(
        parserResult.value,
        doc,
        run.removeDeadFields,
        run.token,
        run.symbol
    ).catch(() => undefined);
    reportProgress();
    if (!fileResult) return;
    summary.manual.push(...fileResult.manual);
    for (const [version, count] of Object.entries(fileResult.byVersion)) {
        summary.byVersion[version] = (summary.byVersion[version] ?? 0) + count;
        summary.fixes += count;
    }
    summary.deadFieldsRemoved += fileResult.deadFieldsRemoved;
    if (fileResult.edits.length === 0) return;
    summary.files++;
    if (!preview) {
        run.changes.push({ uri: doc.uri, fsPath: file, text: doc.getText(), edits: fileResult.edits });
        return;
    }
    // A dry run answers with the text the edits produce rather than with the edits, so the
    // client can put it side by side against what is on disk. An edit set that does not
    // apply cleanly is counted as not shown instead of being rendered wrong.
    let after: string;
    try {
        after = TextDocument.applyEdits(doc, fileResult.edits);
    } catch {
        preview.omit();
        return;
    }
    preview.add(file, workspaceRelativePath(file, run.folderPaths), doc.getText(), after);
};

/**
 * The one-command workspace migration: walk every rules file the workspace scan would validate, run
 * the deprecation-aware validators on each, and apply every migration-sanctioned fix (old-version
 * renames, deletions, and rewrites like `Flammable = false` → a `non_flammable` TypeCategories
 * entry) as one WorkspaceEdit, so the whole migration lands as an atomic, undoable edit in the
 * client. Findings that need author judgment are returned in the summary instead of edited, grouped
 * report-side by the game version that made each change.
 *
 * @param options `removeDeadFields` also strips every ignored/dead-field finding (fields the game
 * never reads) on top of the migrations. Off unless the user opted in. `dryRun` works the whole
 * migration out and answers with it as a diff, without changing anything. `symbol` narrows the run
 * to one deprecation-registry entry, and `scopeFsPath` names the file the bulk fix was invoked
 * from, whose mod the run then stays inside. Both are given together, by the bulk fix only.
 * @returns the summary for the invoking client to display, or null without workspace folders.
 */
export async function migrateWorkspace(options: MigrationOptions): Promise<MigrationSummary | null> {
    const folderUris = await workspaceFolderUris();
    if (folderUris.length === 0) return null;
    const token = CancellationToken.None;
    const folderPaths = folderUris.map(uriToFsPath);
    const preview = options.dryRun === true ? createMigrationPreview() : undefined;
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin(preview ? 'Previewing migration' : 'Migrating workspace', 0, '', false);
    // Trust the fs caches for the duration of the pass, like the diagnostic scan does: the walk
    // re-checks the same directories and base files constantly, and nothing edits files mid-pass
    // (the WorkspaceEdit applies only at the end).
    beginFsTrustWindow();
    try {
        const { files: scoped, refusedTrees } = await filesToMigrate(folderUris, folderPaths, options, token);
        // Said out loud rather than left as a quietly smaller fix count, since a run that reports
        // nothing in a folder the user opened otherwise reads as the migration having nothing to do.
        for (const refusal of refusedTrees) connection.window.showWarningMessage(refusal);
        // An open editor buffer wins over the disk content, and its (possibly differently-encoded)
        // uri is the one the WorkspaceEdit must target, or the client would open a second buffer.
        const openByNorm = new Map<string, TextDocument>();
        for (const open of documents.all()) openByNorm.set(normalizeUri(open.uri), open);
        const summary: MigrationSummary = {
            files: 0,
            fixes: 0,
            byVersion: {},
            manual: [],
            deadFieldsRemoved: 0,
            unparsable: 0,
        };
        const changes: MigrationChange[] = [];
        const run: MigrationRun = {
            summary,
            changes,
            preview,
            folderPaths,
            removeDeadFields: options.removeDeadFields === true,
            symbol: options.symbol,
            openByNorm,
            token,
        };
        let done = 0;
        for (const file of scoped) {
            done++;
            await migrateOneFile(run, file, () =>
                progress.report(Math.round((done / scoped.length) * 100), `${done}/${scoped.length}`)
            );
        }
        if (preview) {
            summary.preview = preview.result();
            return summary;
        }
        if (changes.length > 0) {
            // Only a file the author already has open goes through the editor. A workspace edit over
            // a file nobody opened gives it a dirty tab, and a mod-wide rename would leave hundreds
            // of them behind, which is the same trade the shared-base extraction makes.
            const applied = await applyMigrationChanges(changes, sharedBaseHost(undefined, undefined));
            summary.files = applied.files;
            if (applied.failed.length > 0) {
                connection.console.warn(
                    `Migration could not write ${applied.failed.length} files, which are unchanged: ` +
                        applied.failed.slice(0, 10).join(', ')
                );
            }
        }
        return summary;
    } finally {
        endFsTrustWindow();
        progress.done();
    }
}
