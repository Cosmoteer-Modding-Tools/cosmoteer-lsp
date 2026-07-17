import { existsSync } from 'fs';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../core/ast/ast';
import { getStartOfAstNode, namedMembersOf, parseFilePath } from '../utils/ast.utils';
import { extractSubstrings } from '../features/navigation/navigation-strategy';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { FileTree, FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';
import { ActionSource } from './action';
import { parseModActions } from './action-parser';
import { normalizeTargetPath, resolveActionTarget } from './action-target-resolver';
import { findModRoot } from './mod-root';
import { safeReaddir } from '../utils/fs.utils';
import { isManifestBasename, isRulesPathSegment } from '../document/document-kind';
import { ParserResultRegistrar } from '../registrar/parser-result-registrar';
import { recordNavigationDep } from '../utils/navigation-deps';

const navigation = new FullNavigationStrategy();

/**
 * A game-root target path as a case-folded map key. The game resolves file paths through the
 * case-insensitive Windows FS, so a manifest target and a reference may spell the same file with
 * different casing (`<gui/x.rules>` vs `&<./Data/GUI/x.rules>`) and must land on the same key.
 * Navigation accepts the folded form as a path too, so it stays usable as a resolve prefix.
 */
const targetKeyOf = (rawTarget: string): string => normalizeTargetPath(rawTarget).toLowerCase();

/** The canonical game-root key for the root `cosmoteer.rules` (where super-paths `/X` resolve). */
const COSMOTEER_RULES_KEY = targetKeyOf('<cosmoteer.rules>');

/** Load a mod file, preferring the live in-editor (possibly unsaved) buffer over disk. The read
 *  is recorded for a running navigation's dependency set, like the fs parse cache does. */
const loadDocument = async (osPath: string): Promise<AbstractNodeDocument | null> => {
    recordNavigationDep(osPath);
    return ParserResultRegistrar.instance.getResultByPath(osPath) ?? (await parseFilePath(osPath).catch(() => null));
};

/** Split a target `<file...>/container...` path into its normalized file key and container segments. */
const fileKeyAndContainer = (rawTarget: string): { fileKey: string; container: string[] } | null => {
    if (!rawTarget.includes('<')) return null;
    const parts = extractSubstrings(rawTarget);
    const idx = parts.findIndex((p) => isRulesPathSegment(p));
    if (idx === -1) return null;
    return { fileKey: targetKeyOf(parts.slice(0, idx + 1).join('/')), container: parts.slice(idx + 1) };
};

/**
 * Resolve a reference path to the (fileKey, member segments) it targets in the effective
 * game tree: super-paths `/X` and `&/X` target the root cosmoteer.rules; file refs
 * `<file>/X` / `&<file>/X` target that file. Returns null for non-game-rooted paths.
 */
const splitEffectivePath = (path: string): { fileKey: string; segments: string[] } | null => {
    let p = path.trim();
    if (p.startsWith('&')) p = p.slice(1);
    if (p.startsWith('/')) return { fileKey: COSMOTEER_RULES_KEY, segments: extractSubstrings(p) };
    if (p.startsWith('<')) {
        const parts = extractSubstrings(p);
        const idx = parts.findIndex((s) => isRulesPathSegment(s));
        if (idx === -1) return null;
        return { fileKey: targetKeyOf(parts.slice(0, idx + 1).join('/')), segments: parts.slice(idx + 1) };
    }
    return null;
};

/**
 * The mod's additions to the effective game tree: which named members the mod injects
 * into each game file, captured from the mod's own root `cosmoteer.rules` globals and
 * the `Add (Name)` / root `Overrides` actions in its manifests.
 *
 * Scope (first cut): file-root additions, which covers the dominant pattern: globals
 * added to `<cosmoteer.rules>` and referenced via super-paths `&/SW_X/…` and targets
 * `<cosmoteer.rules>/SW_X`. Nested-container Overrides are not flattened yet.
 */
export class ModContext {
    private constructor(
        // A name maps to a list of sources: a Cosmoteer group-merge global (`SW_PARTICLES = &<a>, &<b>`)
        // contributes several files, and the looked-up member may live in any of them. Keyed by the
        // normalized target path (`<./Data/cosmoteer.rules>`), so super-paths `&/X` and direct file
        // refs `&<file>/X` find their additions.
        private readonly additions: Map<string, Map<string, ActionSource[]>>,
        // Members the mod merges into a concrete vanilla file via a whole-file `Overrides`
        // (`OverrideIn=<…file> Overrides=&<modfile>` or an inline `{}`). Keyed by the targeted file's
        // resolved normalized absolute path, so a reference reaching that file through a vanilla global
        // (e.g. `&/INDICATORS/SWX` → indicators.rules), not by naming the file directly, still finds
        // the added member. See {@link ModContext.resolveThroughFileOverride}.
        private readonly fileOverrides: Map<string, Map<string, ActionSource[]>>
    ) {}

    static async build(modRoot: string): Promise<ModContext> {
        const additions = new Map<string, Map<string, ActionSource[]>>();
        const fileOverrides = new Map<string, Map<string, ActionSource[]>>();
        const addTo = (
            map: Map<string, Map<string, ActionSource[]>>,
            fileKey: string,
            name: string,
            source: ActionSource
        ) => {
            let byName = map.get(fileKey);
            if (!byName) map.set(fileKey, (byName = new Map()));
            const sources = byName.get(name);
            if (sources) sources.push(source);
            else byName.set(name, [source]);
        };
        const add = (fileKey: string, name: string, source: ActionSource) => addTo(additions, fileKey, name, source);
        const addFileOverride = (fileKey: string, name: string, source: ActionSource) =>
            addTo(fileOverrides, fileKey, name, source);

        // 1. The mod's own cosmoteer.rules convenience globals overlay the game cosmoteer.rules.
        const modCosmoteer = join(modRoot, 'cosmoteer.rules');
        if (existsSync(modCosmoteer)) {
            const doc = await loadDocument(modCosmoteer);
            if (doc) for (const [name, source] of mergeAwareGlobals(doc)) add(COSMOTEER_RULES_KEY, name, source);
        }

        // 2. Add(Name) / root Overrides from every manifest in the mod root. Sorted so the
        //    "first declaration wins" tie-break is deterministic, not filesystem-order dependent.
        for (const name of safeReaddir(modRoot).filter(isManifestBasename).sort()) {
            const doc = await loadDocument(join(modRoot, name));
            if (!doc) continue;
            for (const action of parseModActions(doc)) {
                const target = action.targets[0];
                const source = action.sources[0];
                if (!target) continue;
                const fc = fileKeyAndContainer(String(target.valueType.value));
                if (!fc) continue;
                if (fc.container.length === 0 && action.type === 'Add' && action.nameNode && source) {
                    // A file-root `Add` injects a new named global into the targeted file.
                    add(fc.fileKey, String(action.nameNode.valueType.value), source);
                } else if (action.type === 'Overrides' && source) {
                    // An override merges the source's members into the target. We capture them keyed by
                    // the target's resolved file, so refs reaching that file through a vanilla global
                    // resolve. This covers a whole-file target (`OverrideIn=<…/indicators.rules>`) and a
                    // file-aliasing global (`OverrideIn=<cosmoteer.rules>/COMMON_EFFECTS`, where the
                    // global itself is `&<common_effects.rules>`, so the members land in that file).
                    // {@link resolveOverrideTargetKey} returns null when the target is not a whole file
                    // (a sub-group inside a file), so a true nested-container merge stays unhandled.
                    const members = await overrideMembers(source);
                    if (members.length) {
                        const targetKey = await resolveOverrideTargetKey(target);
                        if (targetKey) for (const [name2, src2] of members) addFileOverride(targetKey, name2, src2 as ActionSource);
                    }
                    // Also keep the legacy target-path-keyed entry for a whole-file inline group, so a
                    // direct `<file>/X` ref (which keys by the `<…>` path, not the resolved file) works.
                    if (fc.container.length === 0 && isGroupNode(source))
                        for (const [name2, src2] of namedMembersOf(source)) add(fc.fileKey, name2, src2 as ActionSource);
                }
            }
        }
        return new ModContext(additions, fileOverrides);
    }

    /** Member names the mod merged into the file stored under `fileKey` (for completion). */
    fileOverrideMemberNames(fileKey: string): string[] {
        return [...(this.fileOverrides.get(fileKey)?.keys() ?? [])];
    }

    /** Global names the mod adds to the root `cosmoteer.rules` (for `&/` completion). */
    cosmoteerRulesAdditionNames(): string[] {
        return [...(this.additions.get(COSMOTEER_RULES_KEY)?.keys() ?? [])];
    }

    /** Resolve a game-rooted path against the mod's additions (used only after vanilla fails). */
    async resolve(
        path: string,
        node: AbstractNode,
        cancellationToken: CancellationToken
    ): Promise<AbstractNode | null | FileWithPath> {
        const split = splitEffectivePath(path);
        if (!split || split.segments.length === 0) return null;
        const byName = this.additions.get(split.fileKey);
        if (byName) {
            const [first, ...rest] = split.segments;
            const sources = byName.get(first);
            // A group-merge global maps to several sources; the member may live in any of them, so
            // try each and return the first that yields the remaining path.
            if (sources)
                for (const source of sources) {
                    const resolved = await this.resolveSource(source, rest, cancellationToken);
                    if (resolved) return resolved;
                }
        }
        // Not a direct file-root addition. Try members the mod merged into a concrete vanilla file
        // via a whole-file Override, which a reference reaches through a vanilla global.
        return this.resolveThroughFileOverride(split, node, cancellationToken);
    }

    /**
     * Resolve a path against members the mod merged into a concrete vanilla file via a whole-file
     * `Overrides`. The reference reaches that file through a vanilla global (`&/INDICATORS/SWX` →
     * indicators.rules) or by naming the file directly (`&<…/indicators.rules>/SWX`). We walk the
     * leading segments through vanilla navigation to discover which concrete file the path lands in,
     * then look up the remaining segments among the members the mod added to that file (keyed by the
     * file's resolved absolute path, so the two sides match regardless of how the file was addressed).
     */
    private async resolveThroughFileOverride(
        split: { fileKey: string; segments: string[] },
        node: AbstractNode,
        cancellationToken: CancellationToken
    ): Promise<AbstractNode | null | FileWithPath> {
        if (this.fileOverrides.size === 0) return null;
        const uri = getStartOfAstNode(node).uri;
        // Candidate (prefix that names a file, remaining member segments) pairs. A super-path may
        // reach the file through any leading global, so try each split point; a direct file ref
        // names the file up front, so its whole segment list is the member path.
        const candidates: { prefix: string; rest: string[] }[] = [];
        if (split.fileKey === COSMOTEER_RULES_KEY) {
            for (let i = 1; i < split.segments.length; i++)
                candidates.push({ prefix: '/' + split.segments.slice(0, i).join('/'), rest: split.segments.slice(i) });
        } else {
            candidates.push({ prefix: split.fileKey, rest: split.segments });
        }
        for (const { prefix, rest } of candidates) {
            if (rest.length === 0) continue;
            const fileNode = await navigation.navigate(prefix, node, uri, cancellationToken).catch(() => null);
            const key = fileKeyOfResolved(fileNode);
            if (!key) continue;
            const byName = this.fileOverrides.get(key);
            const sources = byName?.get(rest[0]);
            if (!sources) continue;
            for (const source of sources) {
                const resolved = await this.resolveSource(source, rest.slice(1), cancellationToken);
                if (resolved) return resolved;
            }
        }
        return null;
    }

    /** Dereference one source and continue the remaining path through it. */
    private async resolveSource(
        source: ActionSource,
        rest: string[],
        cancellationToken: CancellationToken
    ): Promise<AbstractNode | null | FileWithPath> {
        // Dereference the source to a concrete node (a `&<file>` global -> its document).
        let resolved: AbstractNode | null | FileWithPath = source;
        if (isValueNode(source) && source.valueType.type === 'Reference') {
            resolved = await navigation
                .navigate(source.valueType.value, source, getStartOfAstNode(source).uri, cancellationToken)
                .catch(() => null);
            if (resolved && isFile(resolved as unknown as FileTree)) {
                resolved = await parseFilePath((resolved as FileWithPath).path).catch(() => null);
            }
        }
        if (rest.length === 0) return resolved ?? source; // the member exists even if its source is unresolved
        if (!resolved || isFile(resolved as unknown as FileTree)) return null;
        return navigation
            .navigate(
                rest.join('/'),
                resolved as AbstractNode,
                getStartOfAstNode(resolved as AbstractNode).uri,
                cancellationToken
            )
            .catch(() => null);
    }
}

/**
 * Top-level globals of the mod's cosmoteer.rules, expanding Cosmoteer's group-merge syntax. The game
 * lets a global concatenate several groups/files: `SW_PARTICLES = &<a.rules>, &<b.rules>`. Our parser
 * represents that as a named assignment (`&<a>`) followed by bare `Value` siblings (`&<b>`), so we
 * attribute each trailing bare value to the same global, yielding one `[name, source]` entry per
 * merged file, so a member in any of them resolves.
 */
const mergeAwareGlobals = (doc: { elements: AbstractNode[] }): [string, ActionSource][] => {
    const out: [string, ActionSource][] = [];
    const els = doc.elements;
    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        let name: string | undefined;
        const sources: ActionSource[] = [];
        if (isAssignmentNode(el)) {
            name = el.left?.name;
            if (el.right) sources.push(el.right as ActionSource);
        } else if ((isGroupNode(el) || isListNode(el)) && el.identifier) {
            name = el.identifier.name;
            sources.push(el as unknown as ActionSource);
        }
        if (!name || sources.length === 0) continue;
        // Pull in the bare-value continuations of a `Name = a, b, c` merge.
        while (i + 1 < els.length && isValueNode(els[i + 1])) sources.push(els[++i] as unknown as ActionSource);
        for (const source of sources) out.push([name, source]);
    }
    return out;
};

/** The top-level members a whole-file Override merges in: an inline `{}` group's members, or (the
 *  dominant real-mod form) the top-level members of the file a `&<modfile>` source dereferences to. */
const overrideMembers = async (source: ActionSource): Promise<[string, AbstractNode][]> => {
    if (isGroupNode(source)) return namedMembersOf(source);
    if (isValueNode(source) && source.valueType.type === 'Reference') {
        const doc = await dereferenceSourceToDocument(source);
        if (doc) return namedMembersOf(doc);
    }
    return [];
};

/** Dereference a `&<file>` source value to that file's parsed document (or null). */
const dereferenceSourceToDocument = async (source: ActionSource): Promise<AbstractNodeDocument | null> => {
    const resolved = await navigation
        .navigate(String((source as { valueType: { value: unknown } }).valueType.value), source, getStartOfAstNode(source).uri, CancellationToken.None)
        .catch(() => null);
    if (!resolved) return null;
    // A workspace-tree file resolves to a FileWithPath (parse it). A mod-relative whole-file ref
    // resolves through `navigateRulesByCurrentLocation`, which returns the already-parsed document.
    if (isFile(resolved as unknown as FileTree)) return parseFilePath((resolved as FileWithPath).path).catch(() => null);
    if (isDocumentNode(resolved as AbstractNode)) return resolved as AbstractNodeDocument;
    return null;
};

/** Resolve a whole-file Override target (`<…/indicators.rules>`) to the key its file is stored under. */
const resolveOverrideTargetKey = async (target: ActionSource): Promise<string | null> => {
    const resolved = await resolveActionTarget(target as Parameters<typeof resolveActionTarget>[0], CancellationToken.None).catch(
        () => null
    );
    return fileKeyOfResolved(resolved);
};

/** Normalize an absolute OS path to a case/separator-insensitive key (Windows paths use `\`). */
const normFileKey = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/**
 * The {@link normFileKey} for a resolved node that is a whole file: a {@link FileWithPath} or a
 * document root. Returns null for anything else (a group/value inside a file), so we only key
 * `fileOverrides` by whole-file targets. Merges into a true sub-container stay unhandled (their
 * members would lose their container sub-path if attributed at the file level).
 */
const fileKeyOfResolved = (resolved: AbstractNode | null | FileWithPath | undefined): string | null => {
    if (!resolved) return null;
    if (isFile(resolved as unknown as FileTree)) return normFileKey((resolved as FileWithPath).path);
    if (isDocumentNode(resolved as AbstractNode)) return normFileKey((resolved as AbstractNodeDocument).uri);
    return null;
};

const contextCache = new Map<string, Promise<ModContext>>();

const getModContext = (modRoot: string): Promise<ModContext> => {
    let ctx = contextCache.get(modRoot);
    if (!ctx) contextCache.set(modRoot, (ctx = ModContext.build(modRoot)));
    return ctx;
};

/** Drop cached contexts (call when a manifest or the mod's cosmoteer.rules changes). */
export const invalidateModContext = (): void => contextCache.clear();

/**
 * Resolve a path against only the mod's additions (no vanilla navigation). For callers
 * that already proved vanilla resolution fails. Avoids re-walking the filesystem.
 * Returns null when the file is not inside a mod.
 */
export const resolveFromModContextOnly = async (
    path: string,
    node: AbstractNode,
    cancellationToken: CancellationToken
): Promise<AbstractNode | null | FileWithPath> => {
    const modRoot = findModRoot(getStartOfAstNode(node).uri);
    if (!modRoot) return null;
    return (await getModContext(modRoot)).resolve(path, node, cancellationToken);
};

/**
 * Resolve a reference against the effective game tree = vanilla + the mod's own
 * additions. Tries the normal navigation first; on failure, falls back to the mod
 * context so mod-added globals (`<cosmoteer.rules>/SW_SHADERS`, `&/SW_SOUNDS/…`)
 * resolve everywhere in the mod. Returns null if the file is not inside a mod.
 */
export const resolveWithModContext = async (
    path: string,
    node: AbstractNode,
    cancellationToken: CancellationToken
): Promise<AbstractNode | null | FileWithPath> => {
    const vanilla = await navigation
        .navigate(path, node, getStartOfAstNode(node).uri, cancellationToken)
        .catch(() => null);
    if (vanilla) return vanilla;
    return resolveFromModContextOnly(path, node, cancellationToken);
};

/**
 * The member names the mod merged into `resolved` (a resolved whole file / document) via a whole-file
 * or file-aliasing-global `Overrides` action, so completion of `&/INDICATORS/` etc. offers the
 * mod-added members alongside the file's own. `node` locates the owning mod; returns [] outside a mod.
 */
/**
 * The global names the mod adds to the root `cosmoteer.rules` (its own cosmoteer.rules globals plus
 * manifest `Add` actions targeting `<cosmoteer.rules>`), so `&/` completion can offer them alongside
 * the vanilla root members. `originUri` locates the owning mod; returns [] outside a mod.
 */
export const modAddedGlobalNames = async (originUri: string): Promise<string[]> => {
    const modRoot = findModRoot(originUri);
    if (!modRoot) return [];
    return (await getModContext(modRoot)).cosmoteerRulesAdditionNames();
};

export const modOverrideMemberNamesForFile = async (
    resolved: AbstractNode | FileWithPath,
    originUri: string
): Promise<string[]> => {
    const modRoot = findModRoot(originUri);
    if (!modRoot) return [];
    const key = fileKeyOfResolved(resolved);
    if (!key) return [];
    return (await getModContext(modRoot)).fileOverrideMemberNames(key);
};
