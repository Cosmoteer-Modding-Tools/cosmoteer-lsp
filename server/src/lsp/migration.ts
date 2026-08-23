import { CancellationToken } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { readFile } from 'fs/promises';
import { lexer } from '../core/lexer/lexer';
import { parser } from '../core/parser/parser';
import { collectFileMigration, createMigrationPreview, MigrationSummary } from '../features/migration/migrate-workspace';
import { applyMigrationChanges, MigrationChange, narrowToSymbolScope } from '../features/migration/migrate-symbol';
import { buildPostUpdateReport, PostUpdateReportResult } from '../features/post-update/post-update-report';
import { collectRulesFiles, uriToFsPath } from '../features/navigation/workspace-files';
import { filePathToUri } from '../features/navigation/navigation-strategy';
import { normalizeUri } from '../features/navigation/reference-location';
import { reachabilityKey } from '../mod/mod-reachability';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { beginFsTrustWindow, endFsTrustWindow } from '../workspace/fs-cache';
import { workspaceRelativePath } from '../utils/relative-path';
import { globalSettings } from '../settings';
import { connection, documents } from './context';
import { ensureFragmentRooting } from './fragment-rooting';
import { sharedBaseHost } from './hosts';
import { scanSettingsKeyOf } from './scan-epoch';
import { isOutsideRulesPanel, validationScopeKeys, wholeWorkspaceEnabled } from './validation-scope';
import { workspaceFolderUris } from './workspace-folders';
import { currentScanCacheEntries } from './workspace-scan';

/**
 * Build the post-update report out of what this session already knows.
 *
 * The findings come from the scan cache rather than from a fresh pass, so the report describes
 * exactly what the Problems panel shows, and only the entries computed under the current epoch and
 * index revisions are taken, which is the same gate the persisted scan cache uses. The migration is
 * asked for a dry run, which brings its own progress and fs trust window.
 *
 * @returns the report for the invoking client, or null when no workspace folder is open.
 */
export async function postUpdateReport(): Promise<PostUpdateReportResult | null> {
    const folderUris = await workspaceFolderUris();
    if (folderUris.length === 0) return null;
    const entries = currentScanCacheEntries();
    const migration = await migrateWorkspace({ dryRun: true }).catch(() => null);
    return await buildPostUpdateReport({
        dataRoot: CosmoteerWorkspaceService.instance.dataRootPath,
        folderPaths: folderUris.map(uriToFsPath),
        wholeWorkspaceEnabled: wholeWorkspaceEnabled(),
        maxProblems: globalSettings.maxNumberOfProblems,
        settingsKey: scanSettingsKeyOf(),
        entries,
        migration: migration ?? undefined,
    });
}

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
export async function migrateWorkspace(options: {
    removeDeadFields?: boolean;
    dryRun?: boolean;
    symbol?: string;
    scopeFsPath?: string;
}): Promise<MigrationSummary | null> {
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
        const files: string[] = [];
        for (const folder of folderUris) {
            for await (const file of collectRulesFiles(uriToFsPath(folder))) files.push(file);
        }
        // Same scope the diagnostics scan uses: only files the game can actually load.
        const scopeKeys = await validationScopeKeys(token);
        const loadable = scopeKeys ? files.filter((file) => scopeKeys.has(reachabilityKey(file))) : files;
        await ensureFragmentRooting(token).catch(() => undefined);
        // A bulk fix for one deprecation stays inside the mod it was invoked from and only visits
        // the files that can mention the old name. Both gates belong to that command: the
        // whole-workspace migration deliberately covers every folder the user opened.
        const scoped =
            options.symbol !== undefined && options.scopeFsPath !== undefined
                ? await narrowToSymbolScope(
                      loadable,
                      { symbol: options.symbol, scopeFsPath: options.scopeFsPath, folderPaths },
                      token
                  )
                : loadable;
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
        let done = 0;
        for (const file of scoped) {
            done++;
            const canonicalUri = filePathToUri(file);
            let doc = openByNorm.get(normalizeUri(canonicalUri));
            if (!doc) {
                // Prose the game never loads (a readme, a `.txt` nothing references) is skipped like
                // the diagnostics scan skips it.
                if (await isOutsideRulesPanel(file, token)) continue;
                let text: string;
                try {
                    text = await readFile(file, { encoding: 'utf-8' });
                } catch {
                    continue;
                }
                doc = TextDocument.create(canonicalUri, 'rules', 0, text);
            }
            const parserResult = parser(lexer(doc.getText()), doc.uri);
            // A file the parser could not fully read is never edited mechanically: an edit computed
            // against a desynced AST could land in the wrong place.
            if (parserResult.parserErrors.length > 0) {
                summary.unparsable++;
                continue;
            }
            const fileResult = await collectFileMigration(
                parserResult.value,
                doc,
                options.removeDeadFields === true,
                token,
                options.symbol
            ).catch(() => undefined);
            progress.report(Math.round((done / scoped.length) * 100), `${done}/${scoped.length}`);
            if (!fileResult) continue;
            summary.manual.push(...fileResult.manual);
            for (const [version, count] of Object.entries(fileResult.byVersion)) {
                summary.byVersion[version] = (summary.byVersion[version] ?? 0) + count;
                summary.fixes += count;
            }
            summary.deadFieldsRemoved += fileResult.deadFieldsRemoved;
            if (fileResult.edits.length === 0) continue;
            summary.files++;
            if (!preview) {
                changes.push({ uri: doc.uri, fsPath: file, text: doc.getText(), edits: fileResult.edits });
                continue;
            }
            // A dry run answers with the text the edits produce rather than with the edits, so the
            // client can put it side by side against what is on disk. An edit set that does not
            // apply cleanly is counted as not shown instead of being rendered wrong.
            let after: string;
            try {
                after = TextDocument.applyEdits(doc, fileResult.edits);
            } catch {
                preview.omit();
                continue;
            }
            preview.add(file, workspaceRelativePath(file, folderPaths), doc.getText(), after);
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
