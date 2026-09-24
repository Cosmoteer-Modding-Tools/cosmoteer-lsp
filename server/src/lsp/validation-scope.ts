import { CancellationToken } from 'vscode-languageserver/node';
import { join } from 'path';
import { globalSettings } from '../settings';
import { uriToFsPath } from '../workspace/workspace-files';
import { foldPathCase } from '../workspace/fs-cache';
import { collectReferencedTxtKeys } from '../features/navigation/txt-reference-scan';
import { basenameOf, isDocumentationFileName } from '../document/document-kind';
import { computeModReachability, reachabilityKey } from '../mod/mod-reachability';
import { findModRoot } from '../mod/mod-root';
import { getWorkspaceFoldersCached, workspaceFolderPaths } from './workspace-folders';

/** Whether the whole-workspace diagnostics feature is currently enabled. */
export const wholeWorkspaceEnabled = (): boolean => globalSettings.diagnostics?.validateWholeWorkspace ?? true;

/** Which files the whole-workspace pass covers, defaulting to the files the game can load. */
export const workspaceValidationScope = (): 'allFiles' | 'modRulesReachable' =>
    globalSettings.diagnostics?.workspaceValidationScope ?? 'modRulesReachable';

/** Bumped whenever the on-disk `.rules` state or the folder set changes, staling the scope cache. */
let validationScopeEpoch = 0;
/** The cached result of {@link reachableFileFilter}, valid while its epoch is current. */
let validationScopeCache: { epoch: number; allows: ((fsPath: string) => boolean) | undefined } | undefined;
/** The cached result of {@link referencedTxtKeys}, valid while {@link validationScopeEpoch} holds. */
let referencedTxtCache: { epoch: number; keys: Set<string> | undefined } | undefined;

/** Stales the scope caches, after a disk or folder change moved what the manifest can reach. */
export function bumpValidationScopeEpoch(): void {
    validationScopeEpoch++;
}

/**
 * The `.txt` files something in the project references by path, or undefined when the project holds
 * no `.txt` and the gate is moot. Cached until a disk or folder change bumps the scope epoch, like
 * {@link reachableFileFilter}.
 *
 * @param token cancels the text scan. A cancelled (possibly partial) scan is not cached.
 * @returns the referenced keys, or undefined when no gate applies.
 */
async function referencedTxtKeys(token: CancellationToken): Promise<Set<string> | undefined> {
    if (referencedTxtCache?.epoch === validationScopeEpoch) return referencedTxtCache.keys;
    const epoch = validationScopeEpoch;
    const keys = await collectReferencedTxtKeys(await workspaceFolderPaths(), token).catch(() => undefined);
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

/** One workspace folder's closure, keyed the way {@link reachabilityKey} keys a file. */
interface FolderScope {
    /** The folder's path as a reachability key, without a trailing separator, for attribution. */
    readonly prefix: string;
    /** What the folder's manifest reaches, or undefined when the folder declares no manifest. */
    readonly keys: Set<string> | undefined;
}

/**
 * The scope predicate over the folders, which answers per folder rather than from one shared set.
 *
 * A file is judged by the closure of the folder it lies in, so a folder that declares no manifest
 * keeps every file it holds. One shared set silenced such a folder entirely as soon as any other
 * folder had a manifest, which is a whole folder reporting nothing with no way to tell that from a
 * clean one. Folders may nest, so the longest matching one owns the file, and a file under none of
 * them is judged by every closure together, which is what it was judged by before.
 *
 * @param scopes one entry per workspace folder, in the client's order.
 * @param union every folder closure's keys together, for a file outside all of them.
 * @returns the predicate.
 */
const scopePredicate =
    (scopes: FolderScope[], union: Set<string>) =>
    (fsPath: string): boolean => {
        const key = reachabilityKey(fsPath);
        let owner: FolderScope | undefined;
        for (const scope of scopes) {
            if (key !== scope.prefix && !key.startsWith(scope.prefix + '/')) continue;
            if (!owner || scope.prefix.length > owner.prefix.length) owner = scope;
        }
        if (!owner) return union.has(key);
        return owner.keys ? owner.keys.has(key) : true;
    };

/**
 * A predicate telling whether a file is one the game actually loads, for a feature that must not act
 * on backups, templates and other dead content. Undefined when no workspace folder has a manifest to
 * scope by, or when the user asked for every file, which both mean "no restriction".
 *
 * The closure walk parses every manifest and reached file, so the predicate is cached until a disk
 * or folder change bumps {@link validationScopeEpoch}.
 *
 * @param token cancels the closure walk. A cancelled (possibly partial) walk is not cached.
 * @returns the predicate, or undefined when nothing is out of scope.
 */
export async function reachableFileFilter(
    token: CancellationToken
): Promise<((fsPath: string) => boolean) | undefined> {
    if (workspaceValidationScope() !== 'modRulesReachable') return undefined;
    if (validationScopeCache?.epoch === validationScopeEpoch) return validationScopeCache.allows;
    const epoch = validationScopeEpoch;
    const folders = await getWorkspaceFoldersCached().catch(() => null);
    const scopes: FolderScope[] = [];
    const union = new Set<string>();
    let anyManifest = false;
    for (const folder of folders ?? []) {
        const folderPath = uriToFsPath(folder.uri);
        const modRoot = findModRoot(join(folderPath, 'probe.rules'));
        const reachability = modRoot ? await computeModReachability(modRoot, token).catch(() => undefined) : undefined;
        const keys = reachability?.reachable;
        if (keys) {
            anyManifest = true;
            for (const key of keys) union.add(key);
        }
        scopes.push({ prefix: reachabilityKey(folderPath).replace(/\/+$/, ''), keys });
    }
    const allows = anyManifest ? scopePredicate(scopes, union) : undefined;
    if (!token.isCancellationRequested) validationScopeCache = { epoch, allows };
    return allows;
}
