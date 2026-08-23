import { CancellationToken, CancellationTokenSource, Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { readFile, stat } from 'fs/promises';
import { collectRulesFiles, uriToFsPath } from '../features/navigation/workspace-files';
import { filePathToUri } from '../features/navigation/navigation-strategy';
import { normalizeUri } from '../features/navigation/reference-location';
import { reachabilityKey } from '../mod/mod-reachability';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { beginFsTrustWindow, endFsTrustWindow, foldPathCase } from '../workspace/fs-cache';
import {
    beginStatSweepWindow,
    endStatSweepWindow,
    saveScanCache,
    ScanCacheEntry,
    tryLoadScanCache,
} from '../workspace/index-cache';
import { recordScanBaseline } from '../features/post-update/post-update-baseline';
import { startScanCpuProfile, stopScanCpuProfile } from '../utils/cpu-profile';
import { perfCount, perfSampleMemory } from '../utils/perf-counters';
import { globalSettings } from '../settings';
import { traceFailure } from '../utils/cancellation';
import { connection } from './context';
import { ensureFragmentRooting } from './fragment-rooting';
import { isDocumentOpen, openDocumentNorms } from './open-documents';
import { scanRevisionSum, scanSettingsKeyOf, workspaceScanEpoch } from './scan-epoch';
import { validateTextDocument } from './validate-document';
import {
    isOutsideRulesPanel,
    validationScopeKeys,
    wholeWorkspaceEnabled,
    workspaceValidationScope,
} from './validation-scope';
import { workspaceFolderUris } from './workspace-folders';

// ── Whole-workspace diagnostics ─────────────────────────────────────────────────────────────
// On by default. Besides the file open in the editor (see `documents.onDidChangeContent`), the
// server walks every `.rules` file the configured scope covers in the open workspace folder(s) and
// publishes diagnostics for them, so problems surface in the Problems panel without opening each
// file. Results are cached on disk per file, so only the first open of a project pays for the walk.
// Turn `cosmoteerLSPRules.diagnostics.validateWholeWorkspace` off on a low-memory machine: the pass
// holds every scanned file's AST while it runs.

/** How many workspace files to validate concurrently, bounded so a big mod can't exhaust memory.
 *  Each in-flight validation holds an AST plus its cross-file resolution working set, so keep this
 *  low. The parsed ASTs are discarded after each file (validateTextDocument `persist: false`).
 *  Six measured best on the reference mod: four left the pass idle on read IO for ~6% of the cold
 *  wall time, eight bought nothing further while raising peak heap. */
export const WORKSPACE_DIAGNOSTIC_CONCURRENCY = 6;
/** URIs we have published whole-workspace diagnostics for, so we can clear them when disabled. */
const workspaceDiagnosticUris = new Set<string>();
/** Cancels an in-flight whole-workspace pass when settings or folders change again. */
let workspaceValidationSource: CancellationTokenSource | undefined;

/**
 * Retracts the whole-workspace diagnostics published for one file. A retraction has to be sent to
 * the same uri string the entry was published under, so entries are matched by normalized form: the
 * uri a watcher or an editor hands us may differ in encoding from our `filePathToUri` form.
 *
 * @param uri the file whose published problems should leave the panel, in any uri encoding.
 * @returns once every matching entry has been dropped and retracted.
 */
export async function retractWorkspaceDiagnostics(uri: string): Promise<void> {
    const norm = normalizeUri(uri);
    for (const stored of [...workspaceDiagnosticUris]) {
        if (normalizeUri(stored) !== norm) continue;
        workspaceDiagnosticUris.delete(stored);
        await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
    }
}


interface ScanResultEntry {
    size: number;
    mtimeMs: number;
    epoch: number;
    revisions: number;
    diagnostics: Diagnostic[];
}

/** Per-file scan results, keyed by case-folded fs path. */
const scanResultCache = new Map<string, ScanResultEntry>();
/** Upper bound of cached scan results, above one full pass over the largest known mods. */
const SCAN_RESULT_CAP = 16384;

/** Whether the persisted scan cache was already offered to this session (it seeds at most once). */
let persistedScanAttempted = false;
/** How many files any scan pass validated fresh (not served from a cache), for the save gate. */
let scanFreshValidations = 0;

/**
 * Seeds the in-memory scan cache from the persisted one, once per session. Only called after the
 * shared indexes converged, so the seeded entries carry the epoch and revision sum the per-file
 * check will compare against for the rest of the pass. The persisted cache is gated on nothing
 * having moved since it was saved (see `index-cache.ts`), which makes the seeded results exactly
 * what re-validating would produce.
 *
 * @param folderUris the workspace folder uris being scanned.
 * @returns once seeding finished (or was skipped).
 */
async function seedPersistedScanResults(folderUris: string[]): Promise<void> {
    if (persistedScanAttempted) return;
    persistedScanAttempted = true;
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return;
    const entries = await tryLoadScanCache(dataRoot, folderUris.map(uriToFsPath), scanSettingsKeyOf());
    if (!entries) return;
    const epoch = workspaceScanEpoch;
    const revisions = scanRevisionSum();
    for (const [path, size, mtimeMs, diagnostics] of entries) {
        scanResultCache.set(foldPathCase(path), { size, mtimeMs, epoch, revisions, diagnostics });
    }
    connection.console.info(`Workspace scan: ${entries.length} file results restored from cache`);
}

/**
 * The cached scan results that were computed under the state the session is in right now. An entry
 * from an earlier epoch or index revision describes a project that has since moved, so it is left
 * out rather than written into a cache or a report that claims to describe the current one.
 *
 * @returns the entries safe to persist or report.
 */
export const currentScanCacheEntries = (): ScanCacheEntry[] => {
    const epoch = workspaceScanEpoch;
    const revisions = scanRevisionSum();
    const entries: ScanCacheEntry[] = [];
    for (const [key, entry] of scanResultCache) {
        if (entry.epoch !== epoch || entry.revisions !== revisions) continue;
        entries.push([key, entry.size, entry.mtimeMs, entry.diagnostics]);
    }
    return entries;
};

/**
 * Validate a single `.rules` file from disk and publish its diagnostics. Skips files open in the
 * editor (the live-edit flow already covers them). Reuses {@link validateTextDocument} so on-disk
 * files go through the exact same lexer/parser/validator path as open ones.
 *
 * @param file the on-disk path of the `.rules` file to validate.
 * @param openNorms normalized uris of documents open in the editor, which are skipped. A snapshot
 *        the caller took, so it only pre-filters. {@link isDocumentOpen} re-asks at publish time
 *        for the file that was opened after the snapshot.
 * @param token cancellation token for the in-flight workspace pass.
 */
export async function validateWorkspaceFile(file: string, openNorms: Set<string>, token: CancellationToken): Promise<void> {
    const uri = filePathToUri(file);
    if (openNorms.has(normalizeUri(uri))) return;
    // A readme, a changelog, or a `.txt` nothing references is not rules content the game would ever
    // load, so it never enters the panel. Anything it published before the gate could answer (or
    // under an older reference set) is cleared instead of left to stick.
    if (await isOutsideRulesPanel(file, token)) {
        if (workspaceDiagnosticUris.has(uri)) {
            workspaceDiagnosticUris.delete(uri);
            await connection.sendDiagnostics({ uri, diagnostics: [] });
        }
        return;
    }
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
        stats = await stat(file);
    } catch {
        return;
    }
    const cacheKey = foldPathCase(file);
    const epochBefore = workspaceScanEpoch;
    const revisionsBefore = scanRevisionSum();
    const cached = scanResultCache.get(cacheKey);
    if (
        cached &&
        cached.size === stats.size &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.epoch === epochBefore &&
        cached.revisions === revisionsBefore
    ) {
        perfCount('scan.files');
        perfCount('scan.cacheHit');
        if (isDocumentOpen(uri)) return;
        workspaceDiagnosticUris.add(uri);
        await connection.sendDiagnostics({ uri, diagnostics: cached.diagnostics });
        return;
    }
    let text: string;
    try {
        text = await readFile(file, { encoding: 'utf-8' });
    } catch {
        return;
    }
    if (token.isCancellationRequested) return;
    const textDocument = TextDocument.create(uri, 'rules', 0, text);
    try {
        // persist=false: don't cache this unopened file's AST (memory). Produce diagnostics and discard.
        const diagnostics = await validateTextDocument(textDocument, token, false);
        if (token.isCancellationRequested) return;
        // Only a result whose shared inputs did not move while it computed may be cached: a file
        // validated while an index was still ingesting (the cold pass builds them mid-flight)
        // reflects a state the next pass will not see.
        if (workspaceScanEpoch === epochBefore && scanRevisionSum() === revisionsBefore) {
            scanResultCache.set(cacheKey, {
                size: stats.size,
                mtimeMs: stats.mtimeMs,
                epoch: epochBefore,
                revisions: revisionsBefore,
                diagnostics,
            });
            while (scanResultCache.size > SCAN_RESULT_CAP) {
                const oldest = scanResultCache.keys().next().value;
                if (oldest === undefined) break;
                scanResultCache.delete(oldest);
            }
        }
        perfCount('scan.files');
        perfSampleMemory();
        scanFreshValidations++;
        if (isDocumentOpen(uri)) return;
        workspaceDiagnosticUris.add(uri);
        await connection.sendDiagnostics({ uri, diagnostics });
    } catch (e) {
        traceFailure(e);
    }
}

/**
 * Validate every `.rules` file in the open workspace folder(s) and publish their diagnostics. No-op
 * when the feature is disabled. Scoped to the workspace folders (the mod), not the Cosmoteer game
 * `Data` tree, which would be enormous. Any previous pass is cancelled first.
 */
export async function runWorkspaceValidation(): Promise<void> {
    if (!wholeWorkspaceEnabled()) return;
    workspaceValidationSource?.cancel();
    const source = new CancellationTokenSource();
    workspaceValidationSource = source;
    const token = source.token;

    const folderUris = await workspaceFolderUris();
    if (folderUris.length === 0) return;

    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('Validating workspace', 0, '', false);
    startScanCpuProfile();
    // Trust the fs caches for the duration of the pass: a scan re-checks the same directories and
    // base files tens of thousands of times, and the file watcher invalidates changed paths anyway.
    beginFsTrustWindow();
    // Share one walk+stat sweep across the pass for the same reason. A client that cannot watch
    // files leaves the mention index on its stateless sweep, which would otherwise re-stat the
    // whole project once per reference query the pass makes.
    beginStatSweepWindow();
    try {
        let files: string[] = [];
        for (const folder of folderUris) {
            for await (const file of collectRulesFiles(uriToFsPath(folder))) {
                if (token.isCancellationRequested) return;
                files.push(file);
            }
        }
        // In 'modRulesReachable' scope, restrict the pass to files the game can actually load (the
        // manifest's reachability closure), so dead backups and templates stay out of the Problems
        // panel. A folder without a manifest keeps every file (nothing to scope by).
        const scopeKeys = await validationScopeKeys(token);
        if (scopeKeys) files = files.filter((file) => scopeKeys.has(reachabilityKey(file)));
        const openNorms = openDocumentNorms();
        // Problems published for files that are no longer in scope (the closure shrank, or a tab
        // close or watcher event validated them before the scope gates existed) are not refreshed
        // by this pass, so they would stick in the panel forever. Clear them instead.
        if (scopeKeys) {
            for (const stored of [...workspaceDiagnosticUris]) {
                if (scopeKeys.has(reachabilityKey(uriToFsPath(stored)))) continue;
                if (openNorms.has(normalizeUri(stored))) continue;
                workspaceDiagnosticUris.delete(stored);
                await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
            }
        }
        // Converge the shared indexes before the pass, then seed the persisted scan results: the
        // seeded entries carry the converged epoch and revision sum, so the per-file check can
        // serve them for the whole pass instead of re-validating everything after a restart.
        await ensureFragmentRooting(token).catch(() => undefined);
        await seedPersistedScanResults(folderUris);
        const startedMs = Date.now();
        const freshBefore = scanFreshValidations;
        let next = 0;
        let done = 0;
        const worker = async (): Promise<void> => {
            while (next < files.length && !token.isCancellationRequested) {
                const file = files[next++];
                await validateWorkspaceFile(file, openNorms, token);
                done++;
                progress.report(Math.round((done / files.length) * 100), `${done}/${files.length}`);
            }
        };
        await Promise.all(Array.from({ length: WORKSPACE_DIAGNOSTIC_CONCURRENCY }, worker));
        const fresh = scanFreshValidations - freshBefore;
        if (!token.isCancellationRequested) {
            connection.console.info(
                `Workspace validation: ${files.length} files in ${Date.now() - startedMs}ms (${fresh} validated, rest cached or open)`
            );
            announceWorkspaceValidation(files.length, fresh, Date.now() - startedMs);
            // Persist the results computed under the pass's final shared state, so the next
            // session's scan can restore them instead of re-validating an unchanged project.
            // Only worth rewriting when this pass validated anything fresh.
            if (fresh > 0) {
                const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
                if (dataRoot) {
                    const entries = currentScanCacheEntries();
                    // Awaited, so a server shutdown right after the pass cannot tear the write.
                    await saveScanCache(dataRoot, folderUris.map(uriToFsPath), scanSettingsKeyOf(), entries);
                    // The same results, recorded as this game version's generation, so a later game
                    // update has a picture from before it to be compared against. Best effort, like
                    // the caches: a failure to record never disturbs the pass that produced it.
                    await recordScanBaseline({
                        dataRoot,
                        folderPaths: folderUris.map(uriToFsPath),
                        settingsKey: scanSettingsKeyOf(),
                        maxProblems: globalSettings.maxNumberOfProblems,
                        entries,
                    });
                }
            }
        }
    } finally {
        endStatSweepWindow();
        endFsTrustWindow();
        await stopScanCpuProfile();
        progress.done();
        if (workspaceValidationSource === source) workspaceValidationSource = undefined;
        releaseScanMemory();
    }
}

/** How long after a pass the collection runs, long enough for the last publishes to be written and
 *  short enough that the process is not left holding the pass's garbage while the user reads the
 *  problems it produced. */
const SCAN_MEMORY_RELEASE_DELAY_MS = 2_000;

/** The pending collection, so a run of passes (a settings flip, a folder change) schedules one. */
let scanMemoryReleaseTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Hands the memory a finished pass allocated back to the operating system. The pass touches every
 * file of the project and drops each one again, which leaves a heap that is mostly garbage and a
 * resident set several times the size the session settles at. The collector would get there on its
 * own eventually, so this only decides when: at a moment the user is not waiting on anything, and
 * not while they are typing into the next keystroke's validation.
 *
 * Needs the client to have started the server with `--expose-gc`, which all of ours do. Without it
 * nothing happens and the heap shrinks whenever the collector decides.
 */
const releaseScanMemory = (): void => {
    const collect = (globalThis as { gc?: () => void }).gc;
    if (!collect || scanMemoryReleaseTimer) return;
    scanMemoryReleaseTimer = setTimeout(() => {
        scanMemoryReleaseTimer = undefined;
        try {
            // Twice: the first pass collects what the scan dropped, the second runs with the heap
            // already small, which is when the collector compacts and gives pages back.
            collect();
            collect();
        } catch {
            // A collector that refuses is no reason to disturb the session.
        }
    }, SCAN_MEMORY_RELEASE_DELAY_MS).unref();
};

/**
 * How many files a pass has to cover before the client is told about it. Below this a whole-mod
 * scan is over before the user notices and costs nothing worth a notification. The point of the
 * notice is the project where it is a real amount of work.
 */
const WORKSPACE_VALIDATION_NOTICE_MIN_FILES = 250;

/** Only the first qualifying pass of a session announces itself. */
let workspaceValidationAnnounced = false;

/**
 * Tell the client that a whole-mod validation ran, so it can inform the user once that this is
 * on by default and point at the switch. Whether the user has already been told is the client's
 * business (it owns the persistent state), so this is sent once per session and ignored after.
 *
 * A pass that validated nothing fresh (everything served from the on-disk scan cache) is not worth
 * announcing: nobody waited for it.
 *
 * @param files how many files the pass covered.
 * @param fresh how many of them were actually re-validated rather than served from the cache.
 * @param elapsedMs how long the pass took.
 */
function announceWorkspaceValidation(files: number, fresh: number, elapsedMs: number): void {
    if (workspaceValidationAnnounced) return;
    if (files < WORKSPACE_VALIDATION_NOTICE_MIN_FILES || fresh === 0) return;
    workspaceValidationAnnounced = true;
    void connection
        .sendNotification('cosmoteer/workspaceValidated', {
            files,
            fresh,
            elapsedMs,
            scope: workspaceValidationScope(),
        })
        .catch(() => undefined);
}

/** Clear all whole-workspace diagnostics we published (except files still open in the editor). */
export async function clearWorkspaceDiagnostics(): Promise<void> {
    workspaceValidationSource?.cancel();
    const openNorms = openDocumentNorms();
    for (const uri of workspaceDiagnosticUris) {
        if (openNorms.has(normalizeUri(uri))) continue;
        await connection.sendDiagnostics({ uri, diagnostics: [] });
    }
    workspaceDiagnosticUris.clear();
}
