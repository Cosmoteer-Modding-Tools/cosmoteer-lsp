import { AbstractNode, isListNode, isGroupNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { cachedParseFilePath, cachedReaddir, foldPathCase, onFsInvalidation } from '../../workspace/fs-cache';
import { getParsedFileDocument } from '../../workspace/parsed-file-cache';
import {
    CosmoteerFile,
    CosmoteerWorkspaceService,
    FileTree,
    FileWithPath,
    isFile,
} from '../../workspace/cosmoteer-workspace.service';
import {
    createDirentPath,
    extractSubstrings,
    filePathToDirectoryPath,
    NavigationStrategy,
    stripReferenceWhitespace,
} from './navigation-strategy';
import * as path from 'path';
import { globalSettings } from '../../settings';
import { stepIntoNode } from '../../semantics/reference-resolver';
import { findMemberThroughInheritance, ResolveReferenceFn } from '../../semantics/inheritance-resolver';
import { CancellationToken } from 'vscode-languageserver';
import { CancellationError } from '../../utils/cancellation';
import { activeNavigationDeps, collectNavigationDeps, navigationDepKey } from '../../utils/navigation-deps';
import { perfCount } from '../../utils/perf-counters';

// Absolute references (`&<file>/…` file-relative, `&/…` super-path) resolve to the same target no
// matter which node bears them: the file form depends only on the bearer's directory, the super
// form on nothing but the game root. A whole-workspace scan resolves the same absolute paths tens
// of thousands of times (every part inheriting a shared base re-walks it), so those two forms are
// memoized here. Relative forms (`&Name`, `^`, `..`) depend on the bearer node and are not.
//
// Entries hold the resolved target through a WeakRef so the memo never extends an AST's lifetime:
// when the parse caches evict the target document, the entry empties and the next call re-resolves.
// Unresolved paths are memoized as misses, which is where most of the win is: a broken reference
// costs several extra full resolutions (mod-context fallback, did-you-mean, inheritance checks).
/** Upper bound of memoized resolutions, a plain insertion-ordered cap like the fs caches. */
const NAVIGATION_MEMO_CAP = 65_536;

type NavigationMemoEntry = { ref: WeakRef<object>; deps: readonly string[] } | { miss: true };

const navigationMemo: Map<string, NavigationMemoEntry> = new Map();

/** Memo keys of the miss entries, so an edit can drop every miss without scanning the map. A miss
 *  may flip to a hit through whatever the edit introduced, and its own read set is not stored, so
 *  all misses go on any buffer edit. */
const navigationMissKeys: Set<string> = new Set();

/** Dependency key (see {@link navigationDepKey}) → memo keys of the hit entries whose resolution
 *  read that file. An edit to one file invalidates exactly these entries. */
const navigationDepIndex: Map<string, Set<string>> = new Map();

/** The synthetic dependency of an entry whose resolution consumed a memoized miss. The miss's own
 *  read set is unknown, so such entries are dropped on any buffer edit, like the misses. */
const VOLATILE_NAVIGATION_DEP = '\0miss';

/**
 * Removes one memo entry and its dependency-index registrations.
 *
 * @param key the memo key to drop.
 */
const deleteNavigationMemoEntry = (key: string): void => {
    const entry = navigationMemo.get(key);
    if (!entry) return;
    navigationMemo.delete(key);
    if ('miss' in entry) {
        navigationMissKeys.delete(key);
        return;
    }
    for (const dep of entry.deps) {
        const keys = navigationDepIndex.get(dep);
        keys?.delete(key);
        if (keys && keys.size === 0) navigationDepIndex.delete(dep);
    }
};

/** Empties the resolution memo. Registered on fs-cache invalidation (disk changes arrive with no
 *  per-entry read information worth trusting) and on mod-context changes. */
export const clearNavigationMemo = (): void => {
    navigationMemo.clear();
    navigationMissKeys.clear();
    navigationDepIndex.clear();
};

/**
 * Drops the memo entries an open-buffer edit of one file can affect: every miss (the edit may
 * introduce what a miss was missing), every entry whose resolution consumed a memoized miss, and
 * every hit whose resolution read the edited file. Hits that never read it (the vanilla-tree bulk
 * of the memo) survive the keystroke. Buffer edits bypass the disk watcher, so the server calls
 * this from its change handler.
 *
 * @param uriOrPath the edited document's uri or OS path.
 */
export const invalidateNavigationMemoForFile = (uriOrPath: string): void => {
    for (const key of navigationMissKeys) navigationMemo.delete(key);
    navigationMissKeys.clear();
    for (const dep of [VOLATILE_NAVIGATION_DEP, navigationDepKey(uriOrPath)]) {
        const keys = navigationDepIndex.get(dep);
        if (!keys) continue;
        for (const key of [...keys]) deleteNavigationMemoEntry(key);
    }
};

onFsInvalidation(clearNavigationMemo);

/**
 * The memo key of an absolute reference path, or undefined when the path's resolution depends on
 * its bearer node and must not be memoized.
 *
 * @param path the whitespace-stripped reference path.
 * @param currentLocation the uri or fs path of the file bearing the reference.
 * @returns the memo key, or undefined for non-absolute forms.
 */
const navigationMemoKey = (path: string, currentLocation: string): string | undefined => {
    if (path.startsWith('&<') || path.startsWith('<')) {
        return `${foldPathCase(filePathToDirectoryPath(currentLocation))} ${path}`;
    }
    if (path.startsWith('&/') || path.startsWith('/')) return ` ${path}`;
    return undefined;
};

/** True if `node` is a reference value that points elsewhere (file, super, or in-file alias). */
const isReferenceValue = (node: AbstractNode | null | undefined): node is ValueNode =>
    !!node &&
    isValueNode(node) &&
    node.valueType.type === 'Reference' &&
    (node.valueType.value.startsWith('&') ||
        node.valueType.value.startsWith('<') ||
        node.valueType.value.startsWith('/'));

/**
 * A reference value whose target is the runtime root (`&~/…` / `~/…`). Such a value only resolves
 * once the part is instantiated, so when it is the final member a path lands on, the member itself
 * is a valid target even though its value can't be dereferenced statically (see the terminal-deref
 * handling in {@link FullNavigationStrategy.navigateReference}).
 */
const isRuntimeReferenceValue = (node: AbstractNode | null | undefined): node is ValueNode =>
    isReferenceValue(node) && String(node.valueType.value).replace(/^&/, '').startsWith('~');

/**
 * True if `node` is itself one of its parent group's inheritance references
 * (e.g. the `&BatteryStorageLeft` produced by `BatteryStorageRight : BatteryStorageLeft`).
 * Such a reference names a sibling of the inheriting group, so a relative `&`
 * lookup must resolve against the group's container, not the group's own members.
 */
const isInheritanceMember = (node: AbstractNode | null | undefined): boolean =>
    !!node &&
    !!node.parent &&
    (isGroupNode(node.parent) || isListNode(node.parent)) &&
    !!node.parent.inheritance &&
    node.parent.inheritance.some((inheritance) => inheritance === node);

export class FullNavigationStrategy extends NavigationStrategy<AbstractNode | null | FileWithPath> {
    async navigate(
        path: string,
        startNode: AbstractNode,
        currentLocation: string,
        cancellationToken: CancellationToken,
        // Reference value nodes already dereferenced on this resolution path. Threaded
        // through so an in-file alias cycle (e.g. `A = &B` / `B = &A`) terminates
        // instead of recursing forever. This replaces any depth-based guard.
        visited: Set<AbstractNode> = new Set(),
        // Inheritance nodes already seen on this resolution path. Distinct from `visited`
        // (which guards reference-value derefs) and threaded so a cyclic inheritance chain
        // reached through a reference's path terminates instead of overflowing the stack.
        inheritanceVisited?: Set<AbstractNode>
    ): Promise<AbstractNode | null | FileWithPath> {
        if (!path) {
            return null;
        }
        // Count only entry calls, not the recursive derefs they spawn, so the counter reads as
        // "reference resolutions requested" in the scan bench.
        if (visited.size === 0 && !inheritanceVisited) perfCount('navigate');
        // ObjectText allows insignificant whitespace in a reference path (after `&`, around `/` and
        // segments), e.g. `& <file>/X` or `^ / 0 / Part`. Strip it (outside any `<...>` file path)
        // so the prefix checks below and the segment walk see a canonical `&<file>/X` form.
        path = stripReferenceWhitespace(path);
        // Absolute forms resolve independently of the bearer node and the cycle guards (their
        // branches below never read `startNode`/`visited`), so the memo applies to nested
        // dereferences as much as to entry calls.
        const memoKey = navigationMemoKey(path, currentLocation);
        // The enclosing resolution's dependency collector, when one is running. A memoized result
        // (fresh or cached) contributes its recorded reads to it, so the outer entry is invalidated
        // whenever one of the files its nested resolutions read is edited.
        const outerDeps = activeNavigationDeps();
        if (memoKey) {
            const cached = navigationMemo.get(memoKey);
            if (cached) {
                if ('miss' in cached) {
                    perfCount('navigate.memoHit');
                    // The miss's own read set was not stored, so the enclosing entry cannot be
                    // invalidated precisely. Mark it volatile, it drops on any buffer edit.
                    outerDeps?.add(VOLATILE_NAVIGATION_DEP);
                    return null;
                }
                const target = cached.ref.deref();
                if (target) {
                    perfCount('navigate.memoHit');
                    if (outerDeps) for (const dep of cached.deps) outerDeps.add(dep);
                    return target as AbstractNode | FileWithPath;
                }
                deleteNavigationMemoEntry(memoKey);
            }
        }
        const resolve = (): Promise<AbstractNode | null | FileWithPath> => {
            if (path.startsWith('&<') || path.startsWith('<')) {
                return this.navigateRules(path.substring(path.startsWith('&') ? 2 : 1), currentLocation, cancellationToken);
            }
            if (path.startsWith('&/') || path.startsWith('/')) {
                return this.navigateSuperPath(path, cancellationToken);
            }
            if (path.startsWith('&') && startNode.parent) {
                // A relative `&Name` is resolved one scope up from the bearer node. When
                // the bearer is itself an inheritance reference (`Child : Parent`), the
                // name is a sibling of the inheriting group, so resolve against the
                // group's container (grandparent) instead of the group's own members.
                let scope: AbstractNode | undefined = isInheritanceMember(startNode)
                    ? startNode.parent.parent
                    : startNode.parent;
                // A bare relative `&Name` names a field in the nearest enclosing named scope. List
                // containers are positional (their elements have no names), so a name reference
                // sitting inside a list e.g., `Costs = [&BaseCost * 2]` must resolve against
                // the list's enclosing group, not the list itself. Climb out of any lists.
                // This does not apply to a positional `&N` (a numeric index, e.g. the `&1` of a
                // `: 1` numeric-inheritance) nor to the explicit traversal operators (`..`, `~`,
                // `^`). Those address the list as a real level, so leave their scope alone.
                const leadingSegment = path.substring(1).split('/')[0];
                const isNamedLookup = /^[A-Za-z_]/.test(leadingSegment);
                if (isNamedLookup) while (scope && isListNode(scope)) scope = scope.parent;
                if (!scope) return Promise.resolve(null);
                return this.navigateReference(path.substring(1), scope, cancellationToken, visited, inheritanceVisited);
            }
            return this.navigateReference(path, startNode, cancellationToken, visited, inheritanceVisited);
        };
        // A memoized form collects the files its resolution reads, so the stored entry can be
        // invalidated by exactly those files' buffer edits. Non-memoized (bearer-relative) forms
        // run under the enclosing collector as-is and record their reads straight into it.
        const deps = memoKey ? new Set<string>() : undefined;
        const promise = deps ? collectNavigationDeps(deps, resolve) : resolve();
        // The rejection handler must attach before any throw below: a bare `throw` here would leave
        // `promise` dangling, and its later CancellationError rejection would take the process down
        // as an unhandled rejection.
        const caught = promise.catch(() => null);
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        const result = await caught;
        if (deps && outerDeps) for (const dep of deps) outerDeps.add(dep);
        // A cancelled resolution yields null through the catch above, which must not be recorded
        // as a genuine miss, so a cancelled token skips the store entirely.
        if (memoKey && !cancellationToken.isCancellationRequested) {
            // A super-path (`&/…`, `/…`) resolves through the game's `cosmoteer.rules`, which
            // `navigateSuperPath` can only load once the workspace is initialized; until then it
            // returns null meaning "not ready yet", not "no such target". A validation of an
            // already-open file arrives before that init settles, so pinning that transient null as
            // a miss would outlive initialization (nothing re-validates the memo until an unrelated
            // fs change) and permanently flag a valid reference. Skip storing it, like the
            // cancelled case above. Genuine hits, and misses of bearer-independent file paths, stay.
            const superPathBeforeGameRoot =
                !result && (path.startsWith('&/') || path.startsWith('/')) && !CosmoteerWorkspaceService.instance.dataRootPath;
            if (!superPathBeforeGameRoot) {
                // Replace any concurrent store of the same key first, so its dep-index
                // registrations don't linger as orphans.
                deleteNavigationMemoEntry(memoKey);
                if (result) {
                    const entryDeps = [...deps!];
                    navigationMemo.set(memoKey, { ref: new WeakRef(result as object), deps: entryDeps });
                    for (const dep of entryDeps) {
                        (navigationDepIndex.get(dep) ?? navigationDepIndex.set(dep, new Set()).get(dep)!).add(memoKey);
                    }
                } else {
                    navigationMemo.set(memoKey, { miss: true });
                    navigationMissKeys.add(memoKey);
                }
                while (navigationMemo.size > NAVIGATION_MEMO_CAP) {
                    const oldest = navigationMemo.keys().next().value;
                    if (oldest === undefined) break;
                    deleteNavigationMemoEntry(oldest);
                }
            }
        }
        return result;
    }

    navigateReference = async (
        path: string,
        startNode: AbstractNode,
        cancellationToken: CancellationToken,
        visited: Set<AbstractNode> = new Set(),
        inheritanceVisited?: Set<AbstractNode>
    ): Promise<AbstractNode | null> => {
        // Resolve inheritance refs through `navigate` while forwarding both guard sets, so
        // an inheritance lookup that loops back here shares the same `visited` set.
        const resolveReference: ResolveReferenceFn = (p, n, location, token, inherited) =>
            this.navigate(p, n, location, token, visited, inherited);
        const substrings = extractSubstrings(path);
        let node: AbstractNode | null | undefined = startNode;
        let lastNode: AbstractNode | null | undefined = startNode;
        let index = 0;
        for (const substring of substrings) {
            if (!node) return null;
            node = this.navigateReferenceRecursive(
                substring,
                node,
                substrings.length > 1 && index > 0 && substrings[index - 1] === '^' && substrings[index] === substring
            );
            index++;
            if (!node) {
                // The segment was not found directly: look for it through the
                // inheritance chain.
                // Prefer the node's own inheritance (an inherited member of `lastNode`)
                // before the parent's inheritance. The parent branch only applies when
                // `lastNode` itself can't inherit (e.g. it is an unresolved `^/0/X`
                // reference value whose group parent carries the inheritance).
                if (
                    (isGroupNode(lastNode) || isListNode(lastNode)) &&
                    lastNode.inheritance &&
                    !lastNode.inheritance.some((v) => v.valueType.value === substring)
                ) {
                    node = await findMemberThroughInheritance(
                        lastNode,
                        substring,
                        resolveReference,
                        cancellationToken,
                        // Reuse the threaded guard when this resolution is itself nested inside
                        // an inheritance lookup. Otherwise start one fresh per member lookup.
                        inheritanceVisited ?? new Set()
                    ).catch(() => null);
                } else if (
                    lastNode.parent &&
                    (isGroupNode(lastNode.parent) || isListNode(lastNode.parent)) &&
                    lastNode.parent.inheritance
                ) {
                    node = await findMemberThroughInheritance(
                        lastNode.parent,
                        substring,
                        resolveReference,
                        cancellationToken,
                        inheritanceVisited ?? new Set()
                    ).catch(() => null);
                } else if (lastNode?.type === 'Value' && (lastNode as ValueNode).valueType.type === 'Reference') {
                    node = this.navigateReferenceRecursive(substring, lastNode.parent as AbstractNode);
                    continue;
                }
                if (!node) return null;
            }
            // If the segment resolved to a reference value, dereference it so the
            // remaining path can continue through it. This covers file/super refs
            // (`&<…>`, `&/…`, `<…>`, `/…`) and plain in-file aliases (`&Name`), e.g.
            // `Test1 = &TestBase` then `&Test1/TestValue`. `visited` breaks cycles.
            if (isReferenceValue(node)) {
                // Terminal segment whose member value is a runtime (`~`) reference: the member was
                // found, but its value only resolves at instantiation. Return the member itself
                // rather than failing the whole path. Otherwise a valid `&../DamagePerShot`, whose
                // value is `&~/Components/.../Damage`, is wrongly reported as an unknown reference.
                // (A non-`~` broken alias, `Foo = &Typo`, still fails below that is a real error.)
                if (index === substrings.length && isRuntimeReferenceValue(node)) return node;
                if (visited.has(node)) return null;
                visited.add(node);
                const nextNode = await this.navigate(
                    String(node.valueType.value),
                    node,
                    getStartOfAstNode(node).uri,
                    cancellationToken,
                    visited,
                    inheritanceVisited
                ).catch(() => null);
                if (!nextNode) return null;
                if (isFile(nextNode as unknown as FileTree)) {
                    // The reference points at a whole file (no member after `>`), e.g.
                    // `BASE_SOUNDS = &<…/base_sounds.rules>`. Continue the remaining path
                    // into that file's document so `…/AudioInterior` still resolves.
                    node = await getParsedFileDocument(nextNode as unknown as FileWithPath);
                } else {
                    node = nextNode as AbstractNode;
                }
            }
            lastNode = node;
        }
        return node ?? null;
    };;

    navigateRules = async (path: string, currentLocation: string, cancellationToken: CancellationToken) => {
        // ObjectText `<...>` file paths may use a backslash separator (`<hit_effects\foo.rules>`):
        // `\` is not in `Path.GetInvalidPathChars()`, so the game's PATH_RE accepts it and resolves
        // it on Windows via the .NET path APIs (which treat `\` and `/` interchangeably). Normalize
        // to `/` so the segment walk below (which splits on `/` only) finds the directory/file
        // instead of treating `hit_effects\foo.rules` as one bogus segment and flagging the ref.
        path = path.replace(/\\/g, '/');
        const pathes = extractSubstrings(path);
        const lastWorkspacePathIndex = pathes.findLastIndex((v) => v.includes('>'));
        if (lastWorkspacePathIndex === -1) return null;
        pathes[lastWorkspacePathIndex] = pathes[lastWorkspacePathIndex].replace('>', '');
        // `./Data/...` (case-insensitive, mods write `./data/...` too) addresses the merged game
        // `Data` tree: a mod referencing vanilla via `&<./data/.../foo.rules>` resolves against the
        // game install, not the mod folder. Match `data` case-insensitively so those don't fall
        // through to mod-relative resolution (which can't find them) and get wrongly flagged.
        const isDataRoot = pathes[0] === '.' && pathes[1]?.toLowerCase() === 'data';
        if (isDataRoot && pathes[2] !== '..') {
            const file = this.navigateCosmoteerRules(pathes.slice(2, lastWorkspacePathIndex + 1));
            if (file && lastWorkspacePathIndex < pathes.length - 1) {
                const document = await getParsedFileDocument(file);
                return await this.navigate(
                    pathes.slice(lastWorkspacePathIndex + 1).join('/'),
                    document,
                    document.uri,
                    cancellationToken
                ).catch(() => null);
            }
            return file;
        } else {
            if (isDataRoot && pathes[2] === '..') {
                return await this.navigateRulesByCurrentLocation(
                    pathes.slice(2),
                    CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
                    lastWorkspacePathIndex - 2,
                    cancellationToken
                );
            }
            return await this.navigateRulesByCurrentLocation(
                pathes,
                currentLocation,
                lastWorkspacePathIndex,
                cancellationToken
            );
        }
    };

    navigateRulesByCurrentLocation = async (
        pathes: string[],
        currentLocation: string,
        lastWorkspacePathIndex: number,
        cancellationToken: CancellationToken
    ) => {
        try {
            const cleanedPath = filePathToDirectoryPath(currentLocation);
            let dir = await cachedReaddir(cleanedPath);
            let currentPath = cleanedPath;
            let nextPath: string | null = null;
            for (let i = 0; i <= lastWorkspacePathIndex; i++) {
                if (pathes[i] === '..') {
                    dir = await cachedReaddir(filePathToDirectoryPath(path.join(currentPath, '..')));
                    currentPath = path.join(currentPath, '..');
                    continue;
                }
                for (const dirent of dir) {
                    if (dirent.name.toLowerCase() === pathes[i].toLowerCase()) {
                        if (i === lastWorkspacePathIndex && dirent.isFile()) {
                            const parsed = await cachedParseFilePath(createDirentPath(dirent), cancellationToken);
                            if (pathes.length - 1 > lastWorkspacePathIndex) {
                                return await this.navigate(
                                    pathes.slice(lastWorkspacePathIndex + 1).join('/'),
                                    parsed,
                                    dirent.parentPath,
                                    cancellationToken
                                ).catch(() => null);
                            }
                            return parsed;
                        } else if (dirent.isDirectory()) {
                            nextPath = createDirentPath(dirent);
                            currentPath = nextPath;
                            break;
                        } else {
                            return null;
                        }
                    }
                }
                if (nextPath) dir = await cachedReaddir(nextPath);
            }
        } catch (e) {
            // Per-reference resolution failures are routine when scanning the whole tree for
            // find-all-references. Only surface under 'verbose' to avoid flooding the channel.
            if (globalSettings.trace.server === 'verbose') {
                console.error(e);
            }
            throw e;
        }
        return null;
    };

    navigateReferenceRecursive = (substring: string, node: AbstractNode, isInheritance = false) =>
        stepIntoNode(node, substring, isInheritance);

    navigateCosmoteerRules = (pathes: string[]) => {
        const file = CosmoteerWorkspaceService.instance.findFile(pathes) ?? null;
        return file;
    };

    navigateSuperPath = async (path: string, cancellationToken: CancellationToken) => {
        const comsoteerRules = await CosmoteerWorkspaceService.instance.getCosmoteerRules();
        if (!comsoteerRules || !comsoteerRules.content.parsedDocument) return null;
        return await this.navigate(
            path.substring(path.at(0) === '&' ? 2 : 1),
            comsoteerRules.content.parsedDocument,
            comsoteerRules.path,
            cancellationToken
        ).catch(() => null);
    };
}
