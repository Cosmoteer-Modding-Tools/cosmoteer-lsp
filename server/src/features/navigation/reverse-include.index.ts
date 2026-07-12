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
import { cachedDirLookup, cachedParseFilePath } from '../../workspace/fs-cache';
import { listElementType, memberTypeIn, resolveGroupClass } from '../../document/schema/schema-context';
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
        // schema resolution consults it.
        registerAliasFallbackSource(this);
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
        // Blank entries are class-less derivations, recorded only to mark the file as a base.
        const classes = [...derivers.values()].filter(Boolean);
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
        return [...(this.inheritanceByTarget.get(normalizeUri(uri))?.get(member)?.values() ?? [])].filter(Boolean);
    }

    protected clear(): void {
        this.byTarget.clear();
        this.inheritanceByTarget.clear();
        this.bySource.clear();
        this.inheritanceBySource.clear();
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
            signatures?: Array<[string, string]>;
            aliasFiles?: string[];
        };
        if (
            !parsed ||
            !Array.isArray(parsed.byTarget) ||
            !Array.isArray(parsed.inheritanceByTarget) ||
            !Array.isArray(parsed.bySource) ||
            !Array.isArray(parsed.inheritanceBySource) ||
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
        const contributed: Array<{ target: string; member: string; slot: string }> = [];
        const inherited: Array<{ target: string; member: string; deriverClass: string }> = [];
        const state = { sawAlias: false };
        await this.collectIncludes(document, source, contributed, inherited, state, cancellationToken);
        if (contributed.length) this.bySource.set(source, contributed);
        if (inherited.length) this.inheritanceBySource.set(source, inherited.map(({ target, member }) => ({ target, member })));
        if (!this.built && !this.inFixpointPass && state.sawAlias) this.fixpointDocuments?.push(document);
        const signature = [
            ...contributed.map((entry) => `${entry.target} ${entry.member} ${entry.slot}`),
            ...inherited.map((entry) => `: ${entry.target} ${entry.member} ${entry.deriverClass}`),
        ]
            .sort()
            .join('\n');
        if (signature !== previousSignature) this.changedSinceLastPass = true;
        if (signature) this.sourceSignatures.set(source, signature);
        return signature !== previousSignature;
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
        state: { sawAlias: boolean },
        cancellationToken: CancellationToken
    ): Promise<void> {
        // A group/list that inherits a cross-file base roots that base by the deriver's own class.
        if (isGroupNode(container) || isListNode(container)) {
            await this.recordInheritanceBases(container, source, inherited, state, cancellationToken);
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
                    const alias = parseAlias(String(element.right.valueType.value));
                    if (alias) state.sawAlias = true;
                    const slot = alias && memberTypeIn(container, element.left.name);
                    if (alias && slot) await this.recordInclude(element.right, alias, slot, source, contributed, cancellationToken);
                } else if (isGroupNode(element.right) || isListNode(element.right)) {
                    await this.collectIncludes(element.right, source, contributed, inherited, state, cancellationToken);
                }
                continue;
            }
            if (inList && isValueNode(element) && element.valueType.type === 'Reference') {
                const alias = parseAlias(String(element.valueType.value));
                if (alias) state.sawAlias = true;
                const slot = alias && listElementType(container);
                if (alias && slot) await this.recordInclude(element, alias, slot, source, contributed, cancellationToken);
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
        inherited: Array<{ target: string; member: string; deriverClass: string }>,
        state: { sawAlias: boolean },
        cancellationToken: CancellationToken
    ): Promise<void> {
        const bases = node.inheritance;
        if (!bases || bases.length === 0) return;
        // Resolve the deriver's class lazily, and only when a cross-file base is actually present, so the
        // common case (same-file inheritance, which is everywhere) pays nothing.
        let deriverClass: string | undefined | null = null;
        for (const base of bases) {
            if (!isValueNode(base) || base.valueType.type !== 'Reference') continue;
            const raw = String(base.valueType.value);
            const alias = parseAlias(raw);
            // A super-path base (`Derived : &/GLOBALS/Alias/Member`) reaches its file through the mod's
            // cosmoteer.rules convenience globals, so it carries no `<file>` for the cheap parse. Only
            // the full navigator can find where it lands.
            if (!alias && !/^&\s*\//.test(raw)) continue;
            if (deriverClass === null) deriverClass = isGroupNode(node) ? resolveGroupClass(node) : undefined;
            // A deriver whose class can't resolve (yet) still marks the target as an inheritance base,
            // recorded with a blank class. The rooting queries ignore blank entries, but the fact that
            // the file is derived from at all is what the component-reference validator's template
            // skip needs. The fixpoint retains the document, so a later pass can fill the class in.
            if (!deriverClass) state.sawAlias = true;
            const resolved = alias
                ? { target: await this.resolveTarget(base, alias.fileRef, cancellationToken), member: alias.member ?? '' }
                : await this.resolveSuperPathBase(raw, base, cancellationToken);
            if (!resolved?.target) continue;
            const { target, member } = resolved;
            const members =
                this.inheritanceByTarget.get(target) ?? this.inheritanceByTarget.set(target, new Map()).get(target)!;
            const derivers = members.get(member) ?? members.set(member, new Map()).get(member)!;
            derivers.set(source, deriverClass ?? '');
            inherited.push({ target, member, deriverClass: deriverClass ?? '' });
        }
    }

    /**
     * Resolves a super-path inheritance base (`&/GLOBALS/Alias/Member`) to the file and top-level
     * group it lands on. Resolution goes through the mod-aware resolver, since these globals are
     * typically the mod's own additions to the game root (`Add` actions targeting `cosmoteer.rules`)
     * that plain navigation cannot see. The landing group's own file and name key the base record,
     * exactly as a `<file>/Member` base would.
     *
     * @param raw the base reference as written, including the leading `&`.
     * @param base the base's reference value node, the navigation origin.
     * @param cancellationToken cancels the navigation.
     * @returns the normalized target uri and member name, or undefined when the path does not land
     *          on a named group or whole document.
     */
    private async resolveSuperPathBase(
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
        state: { sawAlias: boolean },
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
