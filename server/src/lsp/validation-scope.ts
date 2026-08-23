import { CancellationToken } from 'vscode-languageserver/node';
import { join } from 'path';
import { globalSettings } from '../settings';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { foldPathCase } from '../workspace/fs-cache';
import { collectReferencedTxtKeys } from '../features/navigation/txt-reference-scan';
import { basenameOf, isDocumentationFileName } from '../document/document-kind';
import { computeModReachability, reachabilityKey } from '../mod/mod-reachability';
import { findModRoot } from '../mod/mod-root';
import { getWorkspaceFoldersCached } from './workspace-folders';

/** Whether the whole-workspace diagnostics feature is currently enabled. */
export const wholeWorkspaceEnabled = (): boolean => globalSettings.diagnostics?.validateWholeWorkspace ?? true;

/** Which files the whole-workspace pass covers, defaulting to the files the game can load. */
export const workspaceValidationScope = (): 'allFiles' | 'modRulesReachable' =>
    globalSettings.diagnostics?.workspaceValidationScope ?? 'modRulesReachable';

/** Bumped whenever the on-disk `.rules` state or the folder set changes, staling the scope cache. */
let validationScopeEpoch = 0;
/** The cached result of {@link validationScopeKeys}, valid while its epoch is current. */
let validationScopeCache: { epoch: number; keys: Set<string> | undefined } | undefined;
/** The cached result of {@link referencedTxtKeys}, valid while {@link validationScopeEpoch} holds. */
let referencedTxtCache: { epoch: number; keys: Set<string> | undefined } | undefined;

/** Stales the scope caches, after a disk or folder change moved what the manifest can reach. */
export function bumpValidationScopeEpoch(): void {
    validationScopeEpoch++;
}

/**
 * The `.txt` files something in the project references by path, or undefined when the project holds
 * no `.txt` and the gate is moot. Cached until a disk or folder change bumps the scope epoch, like
 * {@link validationScopeKeys}.
 *
 * @param token cancels the text scan. A cancelled (possibly partial) scan is not cached.
 * @returns the referenced keys, or undefined when no gate applies.
 */
async function referencedTxtKeys(token: CancellationToken): Promise<Set<string> | undefined> {
    if (referencedTxtCache?.epoch === validationScopeEpoch) return referencedTxtCache.keys;
    const epoch = validationScopeEpoch;
    const folders = await getWorkspaceFoldersCached();
    const keys = await collectReferencedTxtKeys((folders ?? []).map((folder) => uriToFsPath(folder.uri)), token).catch(
        () => undefined
    );
    if (!token.isCancellationRequested) referencedTxtCache = { epoch, keys };
    return keys;
}

/**
 * Whether a walked file is a `.txt` no rules text names, which the game would therefore never load
 * as rules. The walk claims every `.txt` because mods do keep real rules in them, but `.txt` is also
 * the extension of the game's own credits screen, of readmes, of decal whitelists and of stale
 * backups, and parsing those as rules fills the panel with noise. A `.rules` file is never gated:
 * nothing else uses that extension.
 *
 * Answers false while the reference set is unavailable, so an unscanned or cancelled state shows
 * diagnostics rather than hiding them.
 *
 * @param file the on-disk path of the walked file.
 * @param token cancels the reference scan the first call runs.
 * @returns true when the file is a `.txt` nothing references.
 */
async function isUnreferencedTxt(file: string, token: CancellationToken): Promise<boolean> {
    if (!file.toLowerCase().endsWith('.txt')) return false;
    const keys = await referencedTxtKeys(token);
    if (!keys) return false;
    return !keys.has(foldPathCase(file));
}

/**
 * Whether a walked file is none of the panel's business: a readme or changelog a modder gave a rules
 * extension, or a `.txt` nothing references. Both are prose the game never loads, and the walk drops
 * the former already, so this is what retracts anything published for one before the gate applied.
 *
 * @param file the on-disk path of the file.
 * @param token cancels the reference scan the `.txt` gate may run.
 * @returns true when the file's problems must not enter (or stay in) the panel.
 */
export async function isOutsideRulesPanel(file: string, token: CancellationToken): Promise<boolean> {
    if (isDocumentationFileName(basenameOf(file))) return true;
    return isUnreferencedTxt(file, token);
}

/**
 * The reachability keys the 'modRulesReachable' validation scope allows, or undefined when every
 * file is in scope (allFiles scope, or no workspace folder carries a mod manifest to scope by).
 * The closure walk parses every manifest and reached file, so the result is cached until a disk
 * or folder change bumps {@link validationScopeEpoch}.
 *
 * @param token cancels the closure walk. A cancelled (possibly partial) walk is not cached.
 * @returns the allowed reachability keys, or undefined when unrestricted.
 */
/**
 * A predicate telling whether a file is one the game actually loads, for a feature that must not act
 * on backups, templates and other dead content. Undefined when the workspace has no manifest to scope
 * by, or when the user asked for every file, which both mean "no restriction".
 *
 * @param token cancels the reachability computation.
 * @returns the predicate, or undefined when nothing is out of scope.
 */
export async function reachableFileFilter(token: CancellationToken): Promise<((fsPath: string) => boolean) | undefined> {
    const keys = await validationScopeKeys(token).catch(() => undefined);
    return keys ? (fsPath: string) => keys.has(reachabilityKey(fsPath)) : undefined;
}

export async function validationScopeKeys(token: CancellationToken): Promise<Set<string> | undefined> {
    if (workspaceValidationScope() !== 'modRulesReachable') return undefined;
    if (validationScopeCache?.epoch === validationScopeEpoch) return validationScopeCache.keys;
    const epoch = validationScopeEpoch;
    const folders = await getWorkspaceFoldersCached();
    const reachableKeys = new Set<string>();
    let anyManifest = false;
    for (const folder of folders ?? []) {
        const folderPath = uriToFsPath(folder.uri);
        const modRoot = findModRoot(join(folderPath, 'probe.rules'));
        if (!modRoot) continue;
        const reachability = await computeModReachability(modRoot, token);
        if (!reachability) continue;
        anyManifest = true;
        for (const key of reachability.reachable) reachableKeys.add(key);
    }
    const keys = anyManifest ? reachableKeys : undefined;
    if (!token.isCancellationRequested) validationScopeCache = { epoch, keys };
    return keys;
}
