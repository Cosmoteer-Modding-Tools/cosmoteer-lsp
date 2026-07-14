import { CancellationToken, WorkDoneProgressReporter } from 'vscode-languageserver';
import { basename, dirname, resolve } from 'path';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { isModRules } from '../../document/document-kind';
import { isActionFragmentDocument, parseModActions } from '../../mod/action-parser';
import { cachedDirLookup, cachedParseFilePath } from '../../workspace/fs-cache';
import {
    listElementType,
    memberTypeIn,
    registerNodeSlotSource,
    registryHintFromContainer,
    resolveGroupClass,
} from '../../document/schema/schema-context';
import { stepIntoNode } from '../../semantics/reference-resolver';
import { commonAncestorClass } from '../../document/schema/schema';
import { documentRootClass } from '../../document/schema/document-root';
import { ValueType } from '../../document/schema/schema.types';
import { aliasRootIndex, AliasMemberSource, parseAlias, registerAliasFallbackSource } from '../../document/schema/alias-root';
import { resolveWithModContext } from '../../mod/mod-context';
import { FileTree, FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { FullNavigationStrategy } from './full.navigation-strategy';
import { normalizeUri } from './reference-location';
import { uriToFsPath } from './workspace-files';
import { WatchedDocumentIndex } from './watched-document-index';

/** The shared reference resolver, used only for the slow path that a plain relative join can't reach. */
const navigation = new FullNavigationStrategy();

/** A parsed cross-file base: its file ref, first member segment, and whether the path went deeper. */
interface ParsedBase {
    readonly fileRef: string;
    readonly member?: string;
    /** True when the member path has more than one segment, so it names a nested group. */
    readonly deep: boolean;
}

/** Splits `&<file>/A/B` into the file ref, first member segment, and a deep flag for longer paths.
 *  Unlike {@link parseAlias}, the extra segments are not silently dropped, the caller must know. */
const parseAliasPath = (raw: string): ParsedBase | undefined => {
    const m = /^&?\s*(<[^>]*>)\s*(?:\/\s*(.+))?$/.exec(raw.trim());
    if (!m) return undefined;
    const segments = (m[2] ?? '').split('/').map((s) => s.trim()).filter(Boolean);
    return { fileRef: m[1], member: segments[0], deep: segments.length > 1 };
};

/**
 * The deriving group's own class, or, when its own `Type` comes through the inheritance itself, the
 * class of a plain-name sibling base: `Overclock_BeamEmitter : ~/OVERCLOCK/BEAM, BulletEmitter` has
 * no `Type=` of its own, but its second base names the sibling `BulletEmitter` component, whose
 * class is the deriver's class too (inheritance preserves type).
 *
 * @param node the deriving group.
 * @param bases the group's inheritance references.
 * @returns the deriver's concrete class FullName, or undefined when none resolves synchronously.
 */
const deriverClassOf = (node: GroupNode, bases: readonly AbstractNode[]): string | undefined => {
    const own = resolveGroupClass(node);
    if (own) return own;
    const container = node.parent;
    if (!container || !isGroupNode(container)) return undefined;
    for (const base of bases) {
        if (!isValueNode(base) || base.valueType.type !== 'Reference') continue;
        const m = /^&?\s*([A-Za-z_]\w*)\s*$/.exec(String(base.valueType.value).trim());
        if (!m) continue;
        for (const sibling of container.elements) {
            if (isGroupNode(sibling) && sibling.identifier?.name === m[1]) {
                const cls = resolveGroupClass(sibling);
                if (cls) return cls;
            }
        }
    }
    return undefined;
};

/**
 * Parses a cross-file inheritance base to its file and member path: the direct `<file>/Member` form,
 * or the macro idiom `&ALIAS[/Member]` whose top-level sibling `ALIAS = &<file>[/Member]` supplies the
 * file (one hop, the dominant shape in shot-fragment mods). Same-file `&Group` and `^/N` bases return
 * undefined, they resolve in ordinary scope.
 *
 * @param raw the base reference as written.
 * @param node the deriving group or list, whose document holds the sibling alias.
 * @returns the parsed base, or undefined when the base names no cross-file target.
 */
const parseAliasBase = (raw: string, node: GroupNode | ListNode): ParsedBase | undefined => {
    const direct = parseAliasPath(raw);
    if (direct) return direct;
    const m = /^&\s*([A-Za-z_]\w*)((?:\s*\/\s*[^/\s]+)*)\s*$/.exec(raw.trim());
    if (!m) return undefined;
    const document = getStartOfAstNode(node);
    if (!isDocumentNode(document)) return undefined;
    for (const element of document.elements) {
        if (!isAssignmentNode(element) || element.left.name !== m[1]) continue;
        const value = element.right;
        if (!value || !isValueNode(value) || value.valueType.type !== 'Reference') return undefined;
        const aliased = parseAliasPath(String(value.valueType.value));
        if (!aliased) return undefined;
        const tail = m[2].split('/').map((s) => s.trim()).filter(Boolean);
        const segments = [...(aliased.member ? [aliased.member] : []), ...tail];
        return { fileRef: aliased.fileRef, member: segments[0], deep: aliased.deep || segments.length > 1 };
    }
    return undefined;
};

/**
 * Reverse-include rooting, which roots an otherwise-unrooted fragment file from the field that
 * `&<includes>` it.
 *
 * The forward {@link aliasRootIndex} walks `cosmoteer.rules`'s own aliases, but many fragments are
 * pulled in deep inside another file the forward walk never descends into. A particle definition, for
 * one, is included as `Def = &<../explode_sparks_def.rules>` from an effect file that is itself only a
 * list or map element of the game data. Opened on its own such a fragment has no root class, so no
 * schema feature (completion, validation, hover, the shader preview) works inside it.
 *
 * This index scans the project the other way round. For every including file it walks the whole document
 * and records each `&<fragment>` include — a `Field = &<fragment>` assignment at any depth, or a bare
 * `&<fragment>` written as a list element (a codex `CodexPages [ &<page> ]`) — together with the schema
 * {@link ValueType} the include's slot expects (the declaring field's type, or the list's element type).
 * {@link aliasedMemberType} then consults this index through the registered {@link AliasMemberSource} when
 * the forward walk misses, and roots the fragment the same way a forward member-less alias would. A
 * member-less `&<file>` include stores the slot type as the file's root type, so a `group<C>` slot roots
 * the fragment as `C` and its members resolve through `C`'s fields.
 *
 * The include's slot type is resolved through the full schema stack ({@link memberTypeIn} /
 * {@link listElementType}), which itself consults this index, so an includer that is only rooted *by*
 * a reverse include still types its own includes. The build therefore runs to a fixpoint: after one pass
 * over the project it re-indexes the alias-containing documents until the recorded set stops changing, so
 * a chain of fragments (A includes B, B includes C, and A is itself only reverse-rooted) roots all the
 * way down regardless of scan order.
 *
 * It is built once over the project and kept current by the file watcher (see
 * {@link WatchedDocumentIndex}), so a request reads a synchronous, already-fresh snapshot. An include is
 * resolved by a cheap join against the including file's own directory first, then, when that misses, by
 * the shared {@link FullNavigationStrategy}, so a game-root `<Data/…>` include and a mod-overlay path
 * whose target lives in the vanilla tree both root the fragment as well.
 *
 * **Inheritance-base rooting.** A second class of fragment is unrooted for a different reason: it is a
 * pure inheritance base, pulled in only through `Derived : <base_file.rules>/BaseNode` and never as a
 * field value. The `commands/` folder is the canonical case — `base_command.rules`'s `BaseCommand`
 * group is inherited by `MoveCommand`, `DirectControlCommand`, `BaseFollowCommand` and (transitively)
 * every command, but nothing aliases it in as a field, so neither the forward walk nor the include
 * scan above roots it. This index also records, per base file and base member, the concrete schema
 * class of every deriving group that inherits it (via {@link resolveGroupClass}). The base then roots
 * to the *most-derived common ancestor* of all its derivers ({@link commonAncestorClass}) — the one
 * class they all agree on — computed at query time so it converges as more derivers root, and so a base
 * inherited by unrelated classes roots to nothing rather than to a guessed type. This too runs to the
 * same fixpoint: a base file that is itself only reachable through another base (a
 * `BaseFollowCommand : <base_command.rules>/BaseCommand` that is in turn inherited by the concrete
 * commands) roots on a later pass, once its own derivers have rooted it. Inheritance bases (`: <base>`)
 * are the one reference form the include scan deliberately skips, so this is the seam that covers them.
 */
export class ReverseIncludeIndex extends WatchedDocumentIndex implements AliasMemberSource {
    private static _instance: ReverseIncludeIndex;

    /** Included fragment uri (normalized) to its alias members. The member is '' for a member-less
     *  include, and each member maps to the declaring field's type per including source uri, so a
     *  source can be removed on its own. */
    private readonly byTarget = new Map<string, Map<string, Map<string, ValueType>>>();
    /** Base fragment uri (normalized) → base member → deriving source uri → the deriver's concrete
     *  schema class. The base roots to the common ancestor of these classes (see {@link memberType}).
     *  The member is '' for a member-less `: <base_file.rules>` whole-file inheritance base. */
    private readonly inheritanceByTarget = new Map<string, Map<string, Map<string, string>>>();
    /** Normalized including-source uri to the `(target, member)` entries it contributed. */
    private readonly bySource = new Map<string, Array<{ target: string; member: string }>>();
    /** Mod-declared game-root macros: lower-cased macro name → container file uri → declaring
     *  manifest uris. Fed from `mod.rules` actions that `Add` a named member to `cosmoteer.rules` or
     *  `Overrides` one of its members (`OverrideIn = <cosmoteer.rules>/SW_SHOTS`), the mod-side
     *  counterpart of {@link aliasRootIndex}'s vanilla macro map. One macro can have several
     *  container files (an Add placeholder plus per-folder Overrides merges). */
    private readonly modMacroTargets = new Map<string, Map<string, Set<string>>>();
    /** Normalized manifest uri to the macro `(name, target)` entries it declared. */
    private readonly macroBySource = new Map<string, Array<{ name: string; target: string }>>();
    /** Macro-container key → its real filesystem path, for parsing the container during deep-usage
     *  leaf resolution (the key is lower-cased by normalizeUri, not a valid path off Windows). */
    private readonly macroTargetPaths = new Map<string, string>();
    /** Deep macro-usage leaf records: node key (`uri|start,end` inside the container file) → reading
     *  source uri → the slot type the usage gives the leaf. Answered through the node-slot fallback
     *  of the schema layer, since the leaf is a nested group no `(file, member)` record can name. */
    private readonly leafByNode = new Map<string, Map<string, ValueType>>();
    /** Normalized reading-source uri to the leaf node keys it contributed. */
    private readonly leafBySource = new Map<string, string[]>();
    /** Normalized container uri → the leaf node keys recorded inside it, so an edit to the container
     *  (which shifts positions) drops them and dirty-marks the readers to re-record. */
    private readonly leafByTargetUri = new Map<string, Set<string>>();
    /** Normalized deriving-source uri to the inheritance `(target, member)` entries it contributed. */
    private readonly inheritanceBySource = new Map<string, Array<{ target: string; member: string }>>();
    /** Fixpoint passes the last build ran (a test/telemetry hook; > 1 means a chain rooted across passes). */
    public passesUsed = 0;
    /** Documents seen during the one-time build that contain at least one `&<…>` alias include.
     *  Only they can ever contribute entries, so the fixpoint passes re-run just these instead of
     *  the whole project. Released once the whole build completes so their ASTs can be collected. */
    private fixpointDocuments: AbstractNodeDocument[] | undefined = [];
    /** Per-source signature of the entries the last indexing of that source recorded, so a fixpoint
     *  pass can tell whether re-indexing a document changed anything. */
    private readonly sourceSignatures = new Map<string, string>();
    /** Whether any source's recorded entries changed since the flag was last cleared. */
    private changedSinceLastPass = false;
    /** Alias-containing game files restored from the persistent cache, parsed into
     *  {@link fixpointDocuments} at the next {@link finishBuild} so a mod-era fixpoint can re-run
     *  them (a mod include can root a game fragment, which can type that fragment's own includes). */
    private pendingAliasFilePaths: string[] = [];

    /** True while a fixpoint pass re-runs the retained documents, so re-indexing them does not
     *  append them to {@link fixpointDocuments} again. */
    private inFixpointPass = false;

    /** This index's slot in the persistent game-tree cache. */
    public readonly cacheId = 'reverseInclude';

    private constructor() {
        super();
        // Register as the schema layer's secondary fragment-root source in the constructor. The
        // singleton is created before the first ensureBuilt, so it is in place before any synchronous
        // schema resolution consults it. The node-slot source answers for deep macro-usage leaves.
        registerAliasFallbackSource(this);
        registerNodeSlotSource((node) => this.leafSlotType(node));
    }

    /**
     * The slot type deep macro usages gave a nested container-file leaf (`&/SW_PARTICLES/Shot/…/Blue`
     * read from a media-effects slot), when every reading source agrees on it. Consulted by the
     * schema layer only after ordinary anchoring fails, so a rooted context always wins.
     *
     * @param node the group or list node ordinary slot resolution could not anchor.
     * @returns the agreed slot type, or undefined.
     */
    public leafSlotType(node: GroupNode | ListNode): ValueType | undefined {
        if (this.leafByNode.size === 0) return undefined;
        const document = getStartOfAstNode(node);
        const key = `${normalizeUri(document.uri)}|${node.position?.start ?? -1},${node.position?.end ?? -1}`;
        const sources = this.leafByNode.get(key);
        if (!sources || sources.size === 0) return undefined;
        let chosen: ValueType | undefined;
        let signature: string | undefined;
        for (const valueType of sources.values()) {
            const current = JSON.stringify(valueType);
            if (signature === undefined) {
                signature = current;
                chosen = valueType;
            } else if (current !== signature) {
                return undefined;
            }
        }
        return chosen;
    }

    public static get instance(): ReverseIncludeIndex {
        if (!ReverseIncludeIndex._instance) ReverseIncludeIndex._instance = new ReverseIncludeIndex();
        return ReverseIncludeIndex._instance;
    }

    /**
     * Builds the index once, then reconciles any changed files, so a later synchronous query reads a
     * fresh snapshot.
     *
     * @param folderPaths the project folders (the mod plus the game `Data` tree) to scan.
     * @param cancellationToken cancels the post-build reconcile of changed documents.
     * @returns once the index has been built and reconciled.
     */
    public async ensureBuilt(folderPaths: string[], cancellationToken: CancellationToken): Promise<void> {
        await this.ensureFresh(
            (progress) => this.buildFromProject(folderPaths, progress),
            cancellationToken,
            'Indexing includes'
        );
    }

    /**
     * The schema type an include aliases onto `member` of the fragment at `uri`, when every including
     * source agrees on it. An ambiguous conflict roots to nothing so an unrooted fragment is never
     * given a guessed type.
     *
     * @param uri the fragment's document uri.
     * @param member the aliased member name, or '' for a member-less include.
     * @returns the aliased schema type, or undefined when no include declares it or sources disagree.
     */
    public memberType(uri: string, member: string): ValueType | undefined {
        const normalized = normalizeUri(uri);
        const sources = this.byTarget.get(normalized)?.get(member);
        if (sources && sources.size > 0) {
            let chosen: ValueType | undefined;
            let signature: string | undefined;
            let conflict = false;
            for (const valueType of sources.values()) {
                const current = JSON.stringify(valueType);
                if (signature === undefined) {
                    signature = current;
                    chosen = valueType;
                } else if (current !== signature) {
                    conflict = true;
                    break;
                }
            }
            // An explicit field include is the authoritative slot; only when the field includes
            // disagree (or there are none) does inheritance-base rooting get a say.
            if (!conflict) return chosen;
        }
        return this.inheritedMemberType(normalized, member);
    }

    /**
     * The schema type a pure inheritance base at `member` of the file at `uri` roots to: the most-derived
     * common ancestor of every group that inherits it. Computed live from the recorded deriver classes so
     * it converges as more derivers root, and roots to nothing when they share no ancestor.
     *
     * @param normalizedUri the base fragment's normalized document uri.
     * @param member the inherited base member name, or '' for a whole-file inheritance base.
     * @returns the base's group schema type, or undefined when no deriver roots it (or they disagree).
     */
    private inheritedMemberType(normalizedUri: string, member: string): ValueType | undefined {
        const derivers = this.inheritanceByTarget.get(normalizedUri)?.get(member);
        if (!derivers || derivers.size === 0) return undefined;
        // Blank entries are class-less derivations, recorded only to mark the file as a base, and
        // `#`-prefixed entries carry a slot registry instead of a class (see inheritanceRegistry).
        const classes = [...derivers.values()].filter((cls) => cls && !cls.startsWith('#'));
        if (classes.length === 0) return undefined;
        const cls = commonAncestorClass(classes);
        if (!cls) return undefined;
        return { kind: 'group', ref: cls, name: cls.split('.').pop() ?? cls };
    }

    /**
     * The schema type the whole fragment at `uri` was included as through a member-less `Field = &<uri>`.
     *
     * @param uri the fragment's document uri.
     * @returns the fragment's root type, or undefined when no member-less include declares it.
     */
    public rootType(uri: string): ValueType | undefined {
        return this.memberType(uri, '');
    }

    /**
     * Every recorded field include of the fragment at `uri`: the normalized including-source uri,
     * the included member, and the schema type of the slot the include fills. This is the fragment's
     * way back to its including context, so a mode-variant components fragment finds the part file
     * whose `ToggledComponents` pulls it in. The slot type lets a caller follow only the includes it
     * cares about (a components-map slot, not a scalar read of one nested value).
     *
     * @param uri the fragment's document uri.
     * @returns the recorded includes, or an empty array when nothing includes the fragment.
     */
    public includesOf(uri: string): Array<{ source: string; member: string; slot: ValueType }> {
        const members = this.byTarget.get(normalizeUri(uri));
        if (!members) return [];
        const out: Array<{ source: string; member: string; slot: ValueType }> = [];
        for (const [member, sources] of members) {
            for (const [source, slot] of sources) out.push({ source, member, slot });
        }
        return out;
    }

    /**
     * The base-member names the file at `uri` is rooted by through inheritance-base rooting (a
     * `Derived : <uri>/Member` somewhere in the project), or an empty array. These are the members no
     * forward walk or field include reaches, so this identifies exactly the fragments this seam newly
     * roots — used by the mod/vanilla no-regression scans.
     *
     * @param uri the base fragment's document uri.
     * @returns the recorded inherited base members, or an empty array when none.
     */
    public inheritanceBaseMembers(uri: string): string[] {
        return [...(this.inheritanceByTarget.get(normalizeUri(uri))?.keys() ?? [])];
    }

    /**
     * The concrete classes of every group that inherits the base at `member` of the file at `uri`. The
     * schema layer picks the best-fitting one for the base node's own fields (a base whose fields include
     * a derived-only member roots to that derived class, not the shallow common ancestor). Returns an
     * empty array when the file is not a recorded inheritance base.
     *
     * @param uri the base fragment's document uri.
     * @param member the inherited base member name, or '' for a whole-file inheritance base.
     * @returns the deriver class FullNames, or an empty array.
     */
    public inheritanceDeriverClasses(uri: string, member: string): string[] {
        return [...(this.inheritanceByTarget.get(normalizeUri(uri))?.get(member)?.values() ?? [])].filter(
            (cls) => cls && !cls.startsWith('#')
        );
    }

    /**
     * The polymorphic registry every class-less deriver of `member` agrees the base dispatches in: a
     * deriver whose own class can't resolve (its `Type` comes through the inheritance itself) still
     * knows its slot's registry, recorded as a `#`-prefixed entry. The schema layer then dispatches
     * the base FILE's own top-level `Type=` within this registry (see {@link aliasedMemberType}),
     * which is how a `BlueprintWalls : <blueprint_walls.rules>` part component roots the walls file.
     * Concrete deriver classes take precedence through the ordinary rooting path, so this only
     * answers when no deriver has a class, and stays silent when the recorded registries disagree.
     *
     * @param uri the base fragment's document uri.
     * @param member the inherited base member name, or '' for a whole-file inheritance base.
     * @returns the agreed registry FullName, or undefined.
     */
    public inheritanceRegistry(uri: string, member: string): string | undefined {
        const derivers = this.inheritanceByTarget.get(normalizeUri(uri))?.get(member);
        if (!derivers || derivers.size === 0) return undefined;
        const entries = [...derivers.values()].filter(Boolean);
        if (entries.length === 0 || entries.some((entry) => !entry.startsWith('#'))) return undefined;
        const registries = new Set(entries.map((entry) => entry.slice(1)));
        return registries.size === 1 ? [...registries][0] : undefined;
    }

    protected clear(): void {
        this.byTarget.clear();
        this.inheritanceByTarget.clear();
        this.bySource.clear();
        this.inheritanceBySource.clear();
        this.modMacroTargets.clear();
        this.macroBySource.clear();
        this.macroTargetPaths.clear();
        this.leafByNode.clear();
        this.leafBySource.clear();
        this.leafByTargetUri.clear();
        this.sourceSignatures.clear();
        this.changedSinceLastPass = false;
        this.fixpointDocuments = [];
        this.pendingAliasFilePaths = [];
        this.passesUsed = 0;
    }

    /**
     * Serializes the pure game-tree state for the persistent cache: the recorded roots, each
     * source's contributions and signature, and which game files contain alias includes (so a
     * later mod-era fixpoint can re-run exactly those).
     *
     * @returns the JSON-safe state.
     */
    public saveState(): unknown {
        return {
            byTarget: [...this.byTarget.entries()].map(([target, members]) => [
                target,
                [...members.entries()].map(([member, sources]) => [member, [...sources.entries()]]),
            ]),
            inheritanceByTarget: [...this.inheritanceByTarget.entries()].map(([target, members]) => [
                target,
                [...members.entries()].map(([member, derivers]) => [member, [...derivers.entries()]]),
            ]),
            bySource: [...this.bySource.entries()],
            inheritanceBySource: [...this.inheritanceBySource.entries()],
            macroTargets: [...this.modMacroTargets.entries()].map(([name, targets]) => [
                name,
                [...targets.entries()].map(([target, sources]) => [target, [...sources]]),
            ]),
            macroBySource: [...this.macroBySource.entries()],
            macroTargetPaths: [...this.macroTargetPaths.entries()],
            leafByNode: [...this.leafByNode.entries()].map(([key, sources]) => [key, [...sources.entries()]]),
            leafBySource: [...this.leafBySource.entries()],
            signatures: [...this.sourceSignatures.entries()],
            aliasFiles: (this.fixpointDocuments ?? []).map((document) => uriToFsPath(document.uri)),
        };
    }

    /**
     * Primes the index from a previously saved game-tree state. The alias-containing file list is
     * kept aside and parsed at the next {@link finishBuild}, so the fixpoint over the live folders
     * still covers game fragments that a mod include can root.
     *
     * @param state the value a prior {@link saveState} returned.
     * @returns true when the state had the expected shape and was loaded.
     */
    public loadState(state: unknown): boolean {
        const parsed = state as {
            byTarget?: Array<[string, Array<[string, Array<[string, ValueType]>]>]>;
            inheritanceByTarget?: Array<[string, Array<[string, Array<[string, string]>]>]>;
            bySource?: Array<[string, Array<{ target: string; member: string }>]>;
            inheritanceBySource?: Array<[string, Array<{ target: string; member: string }>]>;
            macroTargets?: Array<[string, Array<[string, string[]]>]>;
            macroBySource?: Array<[string, Array<{ name: string; target: string }>]>;
            macroTargetPaths?: Array<[string, string]>;
            leafByNode?: Array<[string, Array<[string, ValueType]>]>;
            leafBySource?: Array<[string, string[]]>;
            signatures?: Array<[string, string]>;
            aliasFiles?: string[];
        };
        if (
            !parsed ||
            !Array.isArray(parsed.byTarget) ||
            !Array.isArray(parsed.inheritanceByTarget) ||
            !Array.isArray(parsed.bySource) ||
            !Array.isArray(parsed.inheritanceBySource) ||
            !Array.isArray(parsed.macroTargets) ||
            !Array.isArray(parsed.macroBySource) ||
            !Array.isArray(parsed.macroTargetPaths) ||
            !Array.isArray(parsed.leafByNode) ||
            !Array.isArray(parsed.leafBySource) ||
            !Array.isArray(parsed.signatures) ||
            !Array.isArray(parsed.aliasFiles)
        ) {
            return false;
        }
        this.clear();
        for (const [target, members] of parsed.byTarget) {
            const memberMap = new Map<string, Map<string, ValueType>>();
            for (const [member, sources] of members) memberMap.set(member, new Map(sources));
            this.byTarget.set(target, memberMap);
        }
        for (const [target, members] of parsed.inheritanceByTarget) {
            const memberMap = new Map<string, Map<string, string>>();
            for (const [member, derivers] of members) memberMap.set(member, new Map(derivers));
            this.inheritanceByTarget.set(target, memberMap);
        }
        for (const [source, entries] of parsed.bySource) this.bySource.set(source, entries);
        for (const [source, entries] of parsed.inheritanceBySource) this.inheritanceBySource.set(source, entries);
        for (const [name, targets] of parsed.macroTargets) {
            const targetMap = new Map<string, Set<string>>();
            for (const [target, sources] of targets) targetMap.set(target, new Set(sources));
            this.modMacroTargets.set(name, targetMap);
        }
        for (const [source, entries] of parsed.macroBySource) this.macroBySource.set(source, entries);
        for (const [key, path] of parsed.macroTargetPaths) this.macroTargetPaths.set(key, path);
        for (const [key, sources] of parsed.leafByNode) {
            this.leafByNode.set(key, new Map(sources));
            const target = key.split('|')[0];
            (this.leafByTargetUri.get(target) ?? this.leafByTargetUri.set(target, new Set()).get(target)!).add(key);
        }
        for (const [source, keys] of parsed.leafBySource) this.leafBySource.set(source, keys);
        for (const [source, signature] of parsed.signatures) this.sourceSignatures.set(source, signature);
        this.pendingAliasFilePaths = parsed.aliasFiles;
        // Force at least one fixpoint pass over the restored alias files, so mod-era rooting of
        // game fragments is picked up (and a stale entry self-heals).
        this.changedSinceLastPass = true;
        return true;
    }

    /**
     * Drops the fixpoint reparse {@link loadState} scheduled. The combined project cache saved a
     * state that already converged over game and workspace files together, so re-deriving it from
     * the alias files would only reproduce what was just loaded. Changed files re-enter through
     * the normal dirty reconcile instead.
     */
    public override stateLoadedConverged(): void {
        this.pendingAliasFilePaths = [];
        this.changedSinceLastPass = false;
    }

    protected removeSource(source: string): void {
        this.sourceSignatures.delete(source);
        const prior = this.bySource.get(source);
        if (prior) {
            for (const { target, member } of prior) {
                const members = this.byTarget.get(target);
                const sources = members?.get(member);
                sources?.delete(source);
                if (sources && sources.size === 0) members!.delete(member);
                if (members && members.size === 0) this.byTarget.delete(target);
            }
            this.bySource.delete(source);
        }
        const priorInheritance = this.inheritanceBySource.get(source);
        if (priorInheritance) {
            for (const { target, member } of priorInheritance) {
                const members = this.inheritanceByTarget.get(target);
                const derivers = members?.get(member);
                derivers?.delete(source);
                if (derivers && derivers.size === 0) members!.delete(member);
                if (members && members.size === 0) this.inheritanceByTarget.delete(target);
            }
            this.inheritanceBySource.delete(source);
        }
        const priorMacros = this.macroBySource.get(source);
        if (priorMacros) {
            for (const { name, target } of priorMacros) {
                const targets = this.modMacroTargets.get(name);
                const sources = targets?.get(target);
                sources?.delete(source);
                if (sources && sources.size === 0) targets!.delete(target);
                if (targets && targets.size === 0) this.modMacroTargets.delete(name);
            }
            this.macroBySource.delete(source);
        }
        const priorLeaves = this.leafBySource.get(source);
        if (priorLeaves) {
            for (const key of priorLeaves) {
                const sources = this.leafByNode.get(key);
                sources?.delete(source);
                if (sources && sources.size === 0) {
                    this.leafByNode.delete(key);
                    this.leafByTargetUri.get(key.split('|')[0])?.delete(key);
                }
            }
            this.leafBySource.delete(source);
        }
    }

    /**
     * Re-indexes one including document, recording every `&<fragment>` include it makes — at any depth,
     * whether written as a `Field = &<fragment>` assignment or as a bare list element — keyed by the
     * included fragment's uri, together with the schema type of the slot that holds it. An include whose
     * slot can't yet be typed (its container isn't rooted) contributes nothing this pass; the fixpoint
     * build re-runs once the container roots. During the one-time build a document that contains any
     * alias include is remembered for those fixpoint passes, and a change to what the document
     * contributes (against its last recorded signature) marks the pass as still converging.
     *
     * @param document the including document to index.
     * @param cancellationToken cancels the slow-path navigation used for game-root and overlay includes.
     */
    protected async indexDocument(document: AbstractNodeDocument, cancellationToken: CancellationToken): Promise<boolean> {
        const source = normalizeUri(document.uri);
        const previousSignature = this.sourceSignatures.get(source) ?? '';
        this.removeSource(source);
        // A post-build re-index of this file means its content changed, which shifts the positions
        // every deep-macro leaf record inside it is keyed by. Drop them and dirty-mark their readers
        // so they re-resolve against the new positions. The initial build and its fixpoint passes
        // stream unchanged content, where the records stay valid.
        if (this.built && !this.inFixpointPass) {
            const staleLeaves = this.leafByTargetUri.get(source);
            if (staleLeaves && staleLeaves.size > 0) {
                for (const key of [...staleLeaves]) {
                    for (const reader of this.leafByNode.get(key)?.keys() ?? []) {
                        if (reader !== source) this.markDirty(reader);
                    }
                    this.leafByNode.delete(key);
                }
                this.leafByTargetUri.delete(source);
            }
        }
        const contributed: Array<{ target: string; member: string; slot: string }> = [];
        const inherited: Array<{ target: string; member: string; deriverClass: string }> = [];
        const macros: Array<{ name: string; target: string }> = [];
        const state = { sawAlias: false, rerooted: [] as string[] };
        // A manifest's (or action fragment's) root-macro declarations must be harvested before the
        // include walk of any usage document can resolve them; scan order is arbitrary, so usage
        // documents seen earlier are retained for the fixpoint (see recordMacroUsage) and re-run
        // once the manifest's pass has filled the map.
        if (isModRules(document.uri) || isActionFragmentDocument(document)) {
            await this.harvestRootMacros(document, source, macros, cancellationToken);
        }
        await this.collectIncludes(document, source, contributed, inherited, state, cancellationToken);
        if (contributed.length) this.bySource.set(source, contributed);
        if (inherited.length) this.inheritanceBySource.set(source, inherited.map(({ target, member }) => ({ target, member })));
        if (macros.length) this.macroBySource.set(source, macros);
        if (!this.built && !this.inFixpointPass && state.sawAlias) this.fixpointDocuments?.push(document);
        const signature = [
            ...contributed.map((entry) => `${entry.target} ${entry.member} ${entry.slot}`),
            ...inherited.map((entry) => `: ${entry.target} ${entry.member} ${entry.deriverClass}`),
            ...macros.map((entry) => `M ${entry.name} ${entry.target}`),
        ]
            .sort()
            .join('\n');
        if (signature !== previousSignature) this.changedSinceLastPass = true;
        if (signature) this.sourceSignatures.set(source, signature);
        const changed = signature !== previousSignature;
        // A base this pass newly rooted must re-index as a source, so its own bases root in turn.
        if (changed) {
            for (const target of state.rerooted) {
                if (target !== source) this.markDirty(target);
            }
        }
        return changed;
    }

    /**
     * Walks a container (the document root, a group, or a list) and records every `&<fragment>` include
     * it directly holds, then recurses into nested groups and lists. A `Field = &<fragment>` assignment is
     * typed by its declaring field ({@link memberTypeIn}); a bare `&<fragment>` list element is typed by
     * the list's element type ({@link listElementType}). Inheritance bases (`: <base>`) live outside
     * `elements` and are deliberately not treated as includes.
     *
     * @param container the node whose elements are scanned.
     * @param source the including document's canonical uri, recorded per contribution so it can be removed.
     * @param contributed collects this source's `(target, member, slot)` entries for {@link bySource}.
     * @param inherited collects this source's inheritance-base `(target, member, deriverClass)` entries.
     * @param state gets `sawAlias` set when any alias include is seen, even one whose slot can't be typed yet.
     * @param cancellationToken cancels the slow-path navigation.
     */
    private async collectIncludes(
        container: AbstractNode,
        source: string,
        contributed: Array<{ target: string; member: string; slot: string }>,
        inherited: Array<{ target: string; member: string; deriverClass: string }>,
        state: { sawAlias: boolean; rerooted: string[] },
        cancellationToken: CancellationToken
    ): Promise<void> {
        // A group/list that inherits a cross-file base roots that base by the deriver's own class.
        if (isGroupNode(container) || isListNode(container)) {
            await this.recordInheritanceBases(container, source, contributed, inherited, state, cancellationToken);
        }
        // The inverse. A top-level group inheriting a whole-file base roots itself to that base's class.
        // Roots the overclock shot fragments, whose macro-anchor top level blocks every other rule.
        if (isDocumentNode(container)) {
            for (const element of container.elements) {
                if (isGroupNode(element) && element.identifier) {
                    await this.recordOwnInheritanceRoot(element, source, contributed, state, cancellationToken);
                }
            }
        }
        const inList = isListNode(container);
        const elements =
            isDocumentNode(container) || isGroupNode(container) || isListNode(container) ? container.elements : [];
        for (const element of elements) {
            if (isAssignmentNode(element) && element.right) {
                if (
                    isValueNode(element.right) &&
                    element.right.valueType.type === 'Reference' &&
                    (isGroupNode(container) || isDocumentNode(container))
                ) {
                    // A deep include (`Delay = &<base_ship.rules>/FtlEffects/TotalDuration`) reads one
                    // leaf value, and its slot says nothing about the first member. Recording it there
                    // mis-typed base_ship's whole FtlEffects group as a Time, so deep paths are skipped.
                    const raw = String(element.right.valueType.value);
                    const alias = parseAliasPath(raw);
                    if (alias) state.sawAlias = true;
                    const slot = alias && !alias.deep && memberTypeIn(container, element.left.name);
                    if (alias && slot) await this.recordInclude(element.right, alias, slot, source, contributed, cancellationToken);
                    if (!alias) {
                        await this.recordMacroUsage(
                            raw,
                            () => memberTypeIn(container, element.left.name),
                            source,
                            contributed,
                            state,
                            cancellationToken
                        );
                    }
                } else if (isGroupNode(element.right) || isListNode(element.right)) {
                    await this.collectIncludes(element.right, source, contributed, inherited, state, cancellationToken);
                }
                continue;
            }
            if (inList && isValueNode(element) && element.valueType.type === 'Reference') {
                // Deep list-element includes are skipped for the same reason as the assignment form.
                const raw = String(element.valueType.value);
                const alias = parseAliasPath(raw);
                if (alias) state.sawAlias = true;
                const slot = alias && !alias.deep && listElementType(container);
                if (alias && slot) await this.recordInclude(element, alias, slot, source, contributed, cancellationToken);
                if (!alias) {
                    await this.recordMacroUsage(raw, () => listElementType(container), source, contributed, state, cancellationToken);
                }
                continue;
            }
            if (isGroupNode(element) || isListNode(element)) {
                await this.collectIncludes(element, source, contributed, inherited, state, cancellationToken);
            }
        }
    }

    /**
     * Records every cross-file inheritance base a group/list node declares (`Derived : <base.rules>/Base`),
     * keyed by the base fragment's uri and base member, together with the deriving group's own concrete
     * schema class. The base later roots to the common ancestor of all its derivers (see
     * {@link inheritedMemberType}). Only a group deriver contributes a class; a same-file base (`&Base`,
     * `^/0`, a numeric index) carries no `<file>` and is left to ordinary scope resolution. When the
     * deriver isn't yet rooted its class can't be read, so nothing is recorded and the document is retained
     * for a later fixpoint pass (via `sawAlias`), which is what roots a base that is itself reached only
     * through another base.
     *
     * @param node the deriving group or list node whose inheritance bases are scanned.
     * @param source the deriving document's canonical uri, recorded per contribution so it can be removed.
     * @param inherited collects this source's `(target, member, deriverClass)` entries.
     * @param state gets `sawAlias` set when a cross-file base can't be typed yet, to retain the document.
     * @param cancellationToken cancels the slow-path navigation used to resolve the base file.
     */
    private async recordInheritanceBases(
        node: GroupNode | ListNode,
        source: string,
        contributed: Array<{ target: string; member: string; slot: string }>,
        inherited: Array<{ target: string; member: string; deriverClass: string }>,
        state: { sawAlias: boolean; rerooted: string[] },
        cancellationToken: CancellationToken
    ): Promise<void> {
        const bases = node.inheritance;
        if (!bases || bases.length === 0) return;
        // Resolve the deriver's class lazily, and only when a cross-file base is actually present, so the
        // common case (same-file inheritance, which is everywhere) pays nothing.
        let deriverClass: string | undefined | null = null;
        // A list deriver has no class to speak for it, only an element type. Resolved lazily too.
        let listElement: ValueType | undefined | null = null;
        for (const base of bases) {
            if (!isValueNode(base) || base.valueType.type !== 'Reference') continue;
            const raw = String(base.valueType.value);
            const alias = parseAliasBase(raw, node);
            // A super-path base (`Derived : &/GLOBALS/Alias/Member`) reaches its file through the mod's
            // cosmoteer.rules convenience globals, and a tilde base (`Overclock : ~/OVERCLOCK/BEAM`)
            // through a file-root macro alias. Neither carries a `<file>` for the cheap parse, so only
            // the full navigator can find where they land.
            if (!alias && !/^&?\s*[/~]/.test(raw)) continue;
            // A deep member path (`: <file>/TopGroup/Nested`) derives the NESTED group, whose class
            // says nothing about the top-level member the record would be keyed under. Recording it
            // mis-roots the top group (a `…/AttackCommand/Circle` deriver is a circle renderer, not a
            // command), so deep bases are skipped entirely.
            if (alias && alias.deep) continue;
            if (deriverClass === null) deriverClass = isGroupNode(node) ? deriverClassOf(node, bases) : undefined;
            // A deriver whose class can't resolve (yet) still marks the target as an inheritance base.
            // When its slot at least pins a polymorphic registry (a part component whose `Type` comes
            // through the inheritance itself), that registry is recorded as a `#`-prefixed entry so the
            // base file can dispatch its own top-level `Type=` within it (see inheritanceRegistry).
            // Otherwise the record is blank: rooting queries ignore it, but the fact that the file is
            // derived from at all is what the component-reference validator's template skip needs. The
            // fixpoint retains the document, so a later pass can fill the class in.
            if (!deriverClass) state.sawAlias = true;
            const registryHint = !deriverClass && isGroupNode(node) ? registryHintFromContainer(node) : undefined;
            const recorded = deriverClass ?? (registryHint ? `#${registryHint}` : '');
            const resolved = alias
                ? { target: await this.resolveTarget(base, alias.fileRef, cancellationToken), member: alias.member ?? '' }
                : await this.resolveNavigatedBase(raw, base, cancellationToken);
            if (!resolved?.target) continue;
            const { target, member } = resolved;
            const members =
                this.inheritanceByTarget.get(target) ?? this.inheritanceByTarget.set(target, new Map()).get(target)!;
            const derivers = members.get(member) ?? members.set(member, new Map()).get(member)!;
            derivers.set(source, recorded);
            inherited.push({ target, member, deriverClass: recorded });
            // A list inheriting a cross-file list (`Ships : <faction_ships.rules>/Ships`) roots that
            // base by its own element type: inheritance preserves type, so the base holds the same
            // elements. The class-keyed rooting above cannot carry this — a list has no class — and a
            // mod that fans its content out over per-category files (each a base of the next) would
            // otherwise leave every one of them unrooted. Recorded as an ordinary alias entry, so it
            // resolves through the same agreement check as a field include.
            if (isListNode(node)) {
                if (listElement === null) listElement = listElementType(node);
                if (!listElement) {
                    state.sawAlias = true; // not typed yet: a later fixpoint pass records it
                    continue;
                }
                const slot: ValueType = { kind: 'list', element: listElement };
                const aliasMembers = this.byTarget.get(target) ?? this.byTarget.set(target, new Map()).get(target)!;
                const sources = aliasMembers.get(member) ?? aliasMembers.set(member, new Map()).get(member)!;
                sources.set(source, slot);
                contributed.push({ target, member, slot: JSON.stringify(slot) });
                // The base file is now rooted, so its OWN list bases can type in turn. It is not in
                // the dirty set (nothing edited it), so mark it: a mod that fans its ships out over
                // a chain of per-category files roots one link per reconcile round.
                state.rerooted.push(target);
            }
        }
    }

    /**
     * Resolves a navigated inheritance base to the file and top-level group it lands on: a
     * super-path (`&/GLOBALS/Alias/Member`) through the mod's cosmoteer.rules convenience globals,
     * or a tilde path (`~/OVERCLOCK/BEAM`) through a file-root macro group. Resolution goes through
     * the mod-aware resolver, since super-path globals are typically the mod's own additions to the
     * game root that plain navigation cannot see. A landing on an alias value (`BEAM = &<file>`)
     * dereferences one hop to the aliased file, the overclock macro idiom.
     *
     * @param raw the base reference as written.
     * @param base the base's reference value node, the navigation origin.
     * @param cancellationToken cancels the navigation.
     * @returns the normalized target uri and member name, or undefined when the path does not land
     *          on a named group, a whole document, or a file alias.
     */
    private async resolveNavigatedBase(
        raw: string,
        base: AbstractNode,
        cancellationToken: CancellationToken
    ): Promise<{ target: string | undefined; member: string } | undefined> {
        const resolved = await resolveWithModContext(raw, base, cancellationToken).catch(() => null);
        if (!resolved) return undefined;
        if (isFile(resolved as unknown as FileTree)) {
            return { target: normalizeUri((resolved as FileWithPath).path), member: '' };
        }
        const node = resolved as AbstractNode;
        if (isDocumentNode(node)) return { target: normalizeUri(node.uri), member: '' };
        if (isGroupNode(node) && node.identifier && node.parent && isDocumentNode(node.parent)) {
            return { target: normalizeUri(node.parent.uri), member: node.identifier.name };
        }
        // The path landed on a macro alias member (`BEAM = &<overclock.rules>` or
        // `BEAM = &<overclock.rules>/Beam`): follow the one `&<file>` hop, so the aliased file records
        // the deriver as a whole-file base, or the named top-level group as a member base. A deep
        // member path is skipped like everywhere else, its class says nothing about the first member.
        if (isValueNode(node) && node.valueType.type === 'Reference') {
            const aliased = parseAliasPath(String(node.valueType.value));
            if (aliased && !aliased.deep) {
                const target = await this.resolveTarget(node, aliased.fileRef, cancellationToken);
                if (target) return { target, member: aliased.member ?? '' };
            }
        }
        return undefined;
    }

    /**
     * Roots a top-level group to the class of the whole-file base it inherits (`Group : <base.rules>`, or
     * `Group : &ALIAS` naming a sibling `ALIAS = &<base.rules>`), since inheritance preserves type. Records
     * it under this document so {@link aliasedMemberType} then resolves the group. Skips a group that
     * already resolves natively, and handles only member-less bases. Roots the `*_overclock*` shot
     * fragments, whose macro-anchor top level defeats every folder or `Type=` rule.
     *
     * @param group the top-level group whose inheritance base is followed.
     * @param source the containing document's uri, the record's target and owner.
     * @param contributed collects the entry so it can be removed and signature-tracked.
     * @param state gets `sawAlias` set when the base is not rooted yet, so the fixpoint re-runs.
     * @param cancellationToken cancels the slow-path navigation.
     */
    private async recordOwnInheritanceRoot(
        group: GroupNode,
        source: string,
        contributed: Array<{ target: string; member: string; slot: string }>,
        state: { sawAlias: boolean; rerooted: string[] },
        cancellationToken: CancellationToken
    ): Promise<void> {
        const bases = group.inheritance;
        const member = group.identifier?.name;
        if (!bases || bases.length === 0 || !member) return;
        // Leave a group that already resolves on its own untouched.
        if (resolveGroupClass(group)) return;
        for (const base of bases) {
            if (!isValueNode(base) || base.valueType.type !== 'Reference') continue;
            const resolved = this.wholeFileBaseRef(String(base.valueType.value), group);
            if (!resolved) continue;
            state.sawAlias = true;
            const target = await this.resolveTargetFile(resolved.referenceNode, resolved.fileRef, cancellationToken);
            if (!target) continue;
            const baseClass = await this.wholeFileBaseClass(target.key, target.fsPath);
            if (!baseClass) continue;
            const slot: ValueType = { kind: 'group', ref: baseClass, name: baseClass.split('.').pop() ?? baseClass };
            const members = this.byTarget.get(source) ?? this.byTarget.set(source, new Map()).get(source)!;
            const sources = members.get(member) ?? members.set(member, new Map()).get(member)!;
            sources.set(source, slot);
            contributed.push({ target: source, member, slot: JSON.stringify(slot) });
            return;
        }
    }

    /**
     * Resolves an inheritance base to the whole-file `<path>` it names, following one level of same-file
     * `&ALIAS` indirection (`ALIAS = &<file>`). Returns undefined for a member-qualified or same-file-group
     * base, which is not plain whole-file inheritance.
     *
     * @param raw the raw inheritance reference text, for example `<ion_beam.rules>` or `&BASE`.
     * @param group the deriving group, used to look up a sibling alias and as the origin node.
     * @returns the file ref and the reference node it is written on, or undefined.
     */
    private wholeFileBaseRef(raw: string, group: GroupNode): { fileRef: string; referenceNode: AbstractNode } | undefined {
        const direct = parseAlias(raw);
        if (direct) return direct.member ? undefined : { fileRef: direct.fileRef, referenceNode: group };
        // A same-file `&NAME` with no path or member. Follow it to a sibling `NAME = &<file>`.
        const match = /^&\s*([A-Za-z_][\w]*)\s*$/.exec(raw.trim());
        const document = group.parent;
        if (!match || !document || !isDocumentNode(document)) return undefined;
        for (const element of document.elements) {
            if (!isAssignmentNode(element) || element.left.name !== match[1]) continue;
            const value = element.right;
            if (!value || !isValueNode(value) || value.valueType.type !== 'Reference') return undefined;
            const alias = parseAlias(String(value.valueType.value));
            return alias && !alias.member ? { fileRef: alias.fileRef, referenceNode: value } : undefined;
        }
        return undefined;
    }

    /**
     * The schema class the whole file roots to, from its own `documentRootClass` or the group type a
     * forward alias or earlier reverse-include pass recorded. Undefined when the base is not rooted yet, so
     * a later fixpoint pass re-runs the deriver.
     *
     * The base is parsed from its real filesystem path, not from the normalized index key: the key is
     * lower-cased and stripped of its leading slash for identity comparison, which is not a valid path on
     * a case-sensitive filesystem. The key is still used for the recorded-root-type lookups below.
     *
     * @param key the resolved base file's normalized index key (for the recorded-type fallbacks).
     * @param fsPath the resolved base file's real filesystem path (for parsing).
     * @returns the base file's root class, or undefined.
     */
    private async wholeFileBaseClass(key: string, fsPath: string): Promise<string | undefined> {
        const base = await cachedParseFilePath(fsPath).catch(() => null);
        const native = base ? documentRootClass(base) : undefined;
        if (native) return native;
        const rootType = this.rootType(key) ?? aliasRootIndex.rootType(key);
        return rootType?.kind === 'group' ? rootType.ref : undefined;
    }

    /**
     * Records a game-root macro usage (`Field = &/COMMON_EFFECTS/PowerOn`) as an alias record on the
     * macro's target file(s): the referenced member types as the slot that reads it. The macro name →
     * file mapping comes from the forward alias walk (a member-less `NAME = &<file>` the root class
     * declares no field for) plus the mod-declared macros harvested from manifests (see
     * {@link harvestRootMacros}); a mod macro can have several container files, and the member is
     * recorded on each (it exists in one, and a record for an absent member is never queried).
     *
     * A two-segment usage types the container's top-level member. A deeper usage
     * (`&/SW_PARTICLES/Shot/Laser/…/Blue`) says nothing about the first member (the intermediate
     * groups are folder-like nesting with no class of their own), so instead the LEAF node the path
     * resolves to is recorded position-keyed and answered through the schema layer's node-slot
     * fallback (see {@link leafSlotType}). Conflicting slot types across usages cancel out in the
     * respective agreement checks, so nothing roots to a guess.
     *
     * @param raw the reference text as written.
     * @param slotOf lazily resolves the reading slot's type, only paid when the ref is a macro usage.
     * @param source the reading document's canonical uri.
     * @param contributed collects this source's `(target, member, slot)` entries.
     * @param state gets `sawAlias` set so the fixpoint re-runs the document: for a resolved macro whose
     *              slot can't be typed yet, and for an unresolved ALL_CAPS name, whose declaring
     *              manifest may simply not have been scanned yet.
     */
    private async recordMacroUsage(
        raw: string,
        slotOf: () => ValueType | undefined | false,
        source: string,
        contributed: Array<{ target: string; member: string; slot: string }>,
        state: { sawAlias: boolean; rerooted: string[] },
        cancellationToken: CancellationToken
    ): Promise<void> {
        const m = /^&\s*\/\s*([A-Za-z_]\w*)((?:\s*\/\s*[\w.]+)+)\s*$/.exec(raw.trim());
        if (!m) return;
        const segments = m[2].split('/').map((s) => s.trim()).filter(Boolean);
        const targets = new Map<string, string | undefined>();
        const vanilla = aliasRootIndex.macroAliasTarget(m[1]);
        if (vanilla) targets.set(vanilla, aliasRootIndex.macroAliasFsPath(m[1]));
        for (const target of this.modMacroTargets.get(m[1].toLowerCase())?.keys() ?? []) {
            targets.set(target, this.macroTargetPaths.get(target));
        }
        if (targets.size === 0) {
            if (/^[A-Z][A-Z0-9_]*$/.test(m[1])) state.sawAlias = true;
            return;
        }
        state.sawAlias = true;
        const slot = slotOf();
        if (!slot) return;
        if (segments.length === 1) {
            for (const target of targets.keys()) {
                const members = this.byTarget.get(target) ?? this.byTarget.set(target, new Map()).get(target)!;
                const sources = members.get(segments[0]) ?? members.set(segments[0], new Map()).get(segments[0])!;
                sources.set(source, slot);
                contributed.push({ target, member: segments[0], slot: JSON.stringify(slot) });
            }
            return;
        }
        for (const [target, fsPath] of targets) {
            if (fsPath) await this.recordMacroLeaf(target, fsPath, segments, slot, source, contributed, cancellationToken);
        }
    }

    /**
     * Resolves a deep macro usage's member path inside the container file and records the slot type
     * against the leaf it lands on. An inline group or list leaf is recorded position-keyed for the
     * node-slot fallback. A reference-valued leaf (`Blue = &<blue_glow.rules>` at the end of the
     * path, the dominant shape in the SW containers) dereferences one member-less `&<file>` hop and
     * records the slot as that file's root type instead, an ordinary whole-file alias record. A
     * scalar leaf carries no members to type and records nothing. The walk uses the shared
     * per-segment resolver, so list indexes and case-insensitive member lookup behave exactly like
     * navigation. Position-keyed records are dropped when the container file changes and their
     * readers re-record (see the invalidation in {@link indexDocument}).
     *
     * @param target the container file's normalized key, the record's uri part.
     * @param fsPath the container file's real filesystem path, for parsing.
     * @param segments the member path inside the container, macro name excluded.
     * @param slot the schema type the reading slot gives the leaf.
     * @param source the reading document's canonical uri.
     * @param contributed collects the entry so it is removable and moves the source's signature.
     * @param cancellationToken cancels the referenced-file resolution.
     */
    private async recordMacroLeaf(
        target: string,
        fsPath: string,
        segments: string[],
        slot: ValueType,
        source: string,
        contributed: Array<{ target: string; member: string; slot: string }>,
        cancellationToken: CancellationToken
    ): Promise<void> {
        const container = await cachedParseFilePath(fsPath).catch(() => null);
        if (!container) return;
        let node: AbstractNode | null | undefined = container;
        for (const segment of segments) {
            node = stepIntoNode(node, segment);
            if (!node) return;
        }
        if (isValueNode(node) && node.valueType.type === 'Reference') {
            const alias = parseAliasPath(String(node.valueType.value));
            if (!alias || alias.member) return;
            const resolved = await this.resolveTargetFile(node, alias.fileRef, cancellationToken);
            if (!resolved) return;
            const members = this.byTarget.get(resolved.key) ?? this.byTarget.set(resolved.key, new Map()).get(resolved.key)!;
            const sources = members.get('') ?? members.set('', new Map()).get('')!;
            sources.set(source, slot);
            contributed.push({ target: resolved.key, member: '', slot: JSON.stringify(slot) });
            return;
        }
        if (!isGroupNode(node) && !isListNode(node)) return;
        const key = `${target}|${node.position?.start ?? -1},${node.position?.end ?? -1}`;
        const sources = this.leafByNode.get(key) ?? this.leafByNode.set(key, new Map()).get(key)!;
        sources.set(source, slot);
        (this.leafBySource.get(source) ?? this.leafBySource.set(source, []).get(source)!).push(key);
        (this.leafByTargetUri.get(target) ?? this.leafByTargetUri.set(target, new Set()).get(target)!).add(key);
        contributed.push({ target: key, member: '@leaf', slot: JSON.stringify(slot) });
    }

    /**
     * Harvests a manifest's (or included action fragment's) game-root macro declarations into
     * {@link modMacroTargets}: an `Add` of a named member to `cosmoteer.rules` (`Name = SW_SHOTS`,
     * `ToAdd = &<file>`) and an `Overrides` of one of its members
     * (`OverrideIn = <cosmoteer.rules>/SW_SHOTS`, `Overrides = &<file>`), the two halves of the
     * add-placeholder-then-merge idiom mods use for their convenience containers. Only member-less
     * `&<file>` sources count (an inline source has no container file to root), and the target file
     * is matched by its `cosmoteer.rules` basename, since the action's path resolves against the
     * game root wherever the manifest lives.
     *
     * @param document the manifest or action-fragment document.
     * @param source the document's normalized uri, the owner of the harvested entries.
     * @param macros collects the `(name, target)` entries for {@link macroBySource} and the signature.
     * @param cancellationToken cancels the source-file resolution.
     */
    private async harvestRootMacros(
        document: AbstractNodeDocument,
        source: string,
        macros: Array<{ name: string; target: string }>,
        cancellationToken: CancellationToken
    ): Promise<void> {
        for (const action of parseModActions(document)) {
            if (action.type !== 'Add' && action.type !== 'Overrides') continue;
            const targetRef = action.targets[0];
            if (!targetRef) continue;
            const targetPath = parseAliasPath(String(targetRef.valueType.value));
            if (!targetPath || targetPath.deep || !/cosmoteer\.rules\s*>$/i.test(targetPath.fileRef)) continue;
            const name =
                action.type === 'Add'
                    ? !targetPath.member && action.nameNode
                        ? String(action.nameNode.valueType.value)
                        : undefined
                    : targetPath.member;
            if (!name) continue;
            const value = action.sources[0];
            if (!value || !isValueNode(value) || value.valueType.type !== 'Reference') continue;
            const alias = parseAliasPath(String(value.valueType.value));
            if (!alias || alias.member) continue;
            const resolved = await this.resolveTargetFile(value, alias.fileRef, cancellationToken);
            if (!resolved) continue;
            const key = name.toLowerCase();
            const targetMap = this.modMacroTargets.get(key) ?? this.modMacroTargets.set(key, new Map()).get(key)!;
            const sources = targetMap.get(resolved.key) ?? targetMap.set(resolved.key, new Set()).get(resolved.key)!;
            sources.add(source);
            this.macroTargetPaths.set(resolved.key, resolved.fsPath);
            macros.push({ name: key, target: resolved.key });
        }
    }

    /**
     * Resolves an include's target file and records the slot type against it, so the fragment roots (or,
     * for a `&<file>/Member` include, so that member of the fragment roots).
     *
     * @param referenceNode the include's `&<…>` value node, the navigation origin.
     * @param alias the parsed file ref and optional member of the include.
     * @param slot the schema type the include's slot expects.
     * @param source the including document's canonical uri.
     * @param contributed collects this source's `(target, member, slot)` entries.
     * @param cancellationToken cancels the slow-path navigation.
     */
    private async recordInclude(
        referenceNode: AbstractNode,
        alias: { fileRef: string; member?: string },
        slot: ValueType,
        source: string,
        contributed: Array<{ target: string; member: string; slot: string }>,
        cancellationToken: CancellationToken
    ): Promise<void> {
        const target = await this.resolveTarget(referenceNode, alias.fileRef, cancellationToken);
        if (!target) return;
        const member = alias.member ?? '';
        const members = this.byTarget.get(target) ?? this.byTarget.set(target, new Map()).get(target)!;
        const sources = members.get(member) ?? members.set(member, new Map()).get(member)!;
        sources.set(source, slot);
        contributed.push({ target, member, slot: JSON.stringify(slot) });
    }

    /**
     * Runs the build's fixpoint passes after every project document has been streamed through
     * {@link indexDocument} once. A single pass can't root a chain whose middle link is itself only
     * reverse-rooted (that link's own includes can't be typed until it roots), and scan order is
     * arbitrary, so the passes repeat until the recorded set stops changing. Only the documents that
     * contain an alias include are re-run, since a document without one can never contribute an
     * entry, and they are the small minority of a project. The pass count is bounded so a
     * pathological cycle can't loop forever, and the retained documents are released at the end so
     * their ASTs can be collected.
     *
     * @param progress the reporter of the running build, to post a pass/file count to.
     * @returns once the recorded roots have converged or the pass bound is reached.
     */
    protected async finishBuild(progress?: WorkDoneProgressReporter): Promise<void> {
        // Cache-restored alias files join the retained documents first, so a fixpoint after the
        // live folders covers the game fragments too. A file that no longer parses is skipped.
        if (this.pendingAliasFilePaths.length > 0) {
            const paths = this.pendingAliasFilePaths;
            this.pendingAliasFilePaths = [];
            for (const path of paths) {
                const document = await cachedParseFilePath(path).catch(() => null);
                if (document) this.fixpointDocuments?.push(document);
            }
        }
        const documents = this.fixpointDocuments ?? [];
        const MAX_PASSES = 8;
        if (this.passesUsed < 1) this.passesUsed = 1;
        this.inFixpointPass = true;
        try {
            while (this.changedSinceLastPass && this.passesUsed < MAX_PASSES) {
                this.changedSinceLastPass = false;
                let count = 0;
                for (const document of documents) {
                    await this.indexDocument(document, CancellationToken.None);
                    progress?.report(`pass ${this.passesUsed + 1}: ${++count} files`);
                }
                this.passesUsed++;
            }
        } finally {
            this.inFixpointPass = false;
        }
    }

    /** Releases the documents retained for the fixpoint passes once the whole build is done. */
    protected buildCompleted(): void {
        this.fixpointDocuments = [];
        this.pendingAliasFilePaths = [];
    }

    /**
     * The canonical key of the file a `<path>` include resolves to. A plain path relative to the
     * including file's own directory is tried first, since that is how the game resolves a non `./Data`
     * include and it covers the dominant fragment case with a single synchronous filesystem check. When
     * no such file exists, the ref is a game-root `<Data/…>` path or a mod-overlay path whose target
     * lives in the vanilla tree, so it is resolved through the shared {@link FullNavigationStrategy},
     * which knows the merged `Data` tree and the mod overlay.
     *
     * @param referenceNode the include's reference value node, the navigation start and origin location.
     * @param fileRef the include's file ref, for example `<../explode_sparks_def.rules>`.
     * @param cancellationToken cancels the slow-path navigation.
     * @returns the normalized target key, or undefined for an empty path or an unresolvable ref.
     */
    private async resolveTarget(
        referenceNode: AbstractNode,
        fileRef: string,
        cancellationToken: CancellationToken
    ): Promise<string | undefined> {
        return (await this.resolveTargetFile(referenceNode, fileRef, cancellationToken))?.key;
    }

    /**
     * Resolves an include's target to both its normalized index `key` (for map storage and identity) and
     * its real filesystem `fsPath` (for reading the file). The two must not be conflated: the key is
     * lower-cased and slash-stripped by {@link normalizeUri}, so it is not a valid path off Windows.
     *
     * @param referenceNode the include's reference value node, the navigation start and origin location.
     * @param fileRef the include's file ref, for example `<../explode_sparks_def.rules>`.
     * @param cancellationToken cancels the slow-path navigation.
     * @returns the target key and filesystem path, or undefined for an empty path or an unresolvable ref.
     */
    private async resolveTargetFile(
        referenceNode: AbstractNode,
        fileRef: string,
        cancellationToken: CancellationToken
    ): Promise<{ key: string; fsPath: string } | undefined> {
        const relative = fileRef.replace(/^</, '').replace(/>$/, '').trim();
        if (!relative) return undefined;
        const sourceUri = getStartOfAstNode(referenceNode).uri;
        const withExtension = /\.[^/\\.]+$/.test(relative) ? relative : `${relative}.rules`;
        const cheapPath = resolve(dirname(uriToFsPath(sourceUri)), withExtension);
        // Membership through the cached parent listing instead of a per-include existsSync: the
        // same directories are probed for every include in every file of a scan.
        const cheapDir = await cachedDirLookup(dirname(cheapPath)).catch(() => undefined);
        if (cheapDir?.has(basename(cheapPath).toLowerCase())) {
            return { key: normalizeUri(cheapPath), fsPath: cheapPath };
        }

        const resolved = await navigation.navigate(fileRef, referenceNode, sourceUri, cancellationToken).catch(() => null);
        if (!resolved) return undefined;
        if (isFile(resolved as unknown as FileTree)) {
            const path = (resolved as FileWithPath).path;
            return { key: normalizeUri(path), fsPath: path };
        }
        if (isDocumentNode(resolved as AbstractNode)) {
            const uri = (resolved as AbstractNodeDocument).uri;
            return { key: normalizeUri(uri), fsPath: uriToFsPath(uri) };
        }
        return undefined;
    }
}
