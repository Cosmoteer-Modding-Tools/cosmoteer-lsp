import { CancellationToken, WorkDoneProgressReporter } from 'vscode-languageserver';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { getStartOfAstNode, parseFilePath } from '../../utils/ast.utils';
import { listElementType, memberTypeIn } from '../../document/schema/schema-context';
import { ValueType } from '../../document/schema/schema.types';
import { AliasMemberSource, parseAlias, registerAliasFallbackSource } from '../../document/schema/alias-root';
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
 */
export class ReverseIncludeIndex extends WatchedDocumentIndex implements AliasMemberSource {
    private static _instance: ReverseIncludeIndex;

    /** Included fragment uri (normalized) to its alias members. The member is '' for a member-less
     *  include, and each member maps to the declaring field's type per including source uri, so a
     *  source can be removed on its own. */
    private readonly byTarget = new Map<string, Map<string, Map<string, ValueType>>>();
    /** Normalized including-source uri to the `(target, member)` entries it contributed. */
    private readonly bySource = new Map<string, Array<{ target: string; member: string }>>();
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
        const sources = this.byTarget.get(normalizeUri(uri))?.get(member);
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

    /**
     * The schema type the whole fragment at `uri` was included as through a member-less `Field = &<uri>`.
     *
     * @param uri the fragment's document uri.
     * @returns the fragment's root type, or undefined when no member-less include declares it.
     */
    public rootType(uri: string): ValueType | undefined {
        return this.memberType(uri, '');
    }

    protected clear(): void {
        this.byTarget.clear();
        this.bySource.clear();
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
            bySource: [...this.bySource.entries()],
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
            bySource?: Array<[string, Array<{ target: string; member: string }>]>;
            signatures?: Array<[string, string]>;
            aliasFiles?: string[];
        };
        if (
            !parsed ||
            !Array.isArray(parsed.byTarget) ||
            !Array.isArray(parsed.bySource) ||
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
        for (const [source, entries] of parsed.bySource) this.bySource.set(source, entries);
        for (const [source, signature] of parsed.signatures) this.sourceSignatures.set(source, signature);
        this.pendingAliasFilePaths = parsed.aliasFiles;
        // Force at least one fixpoint pass over the restored alias files, so mod-era rooting of
        // game fragments is picked up (and a stale entry self-heals).
        this.changedSinceLastPass = true;
        return true;
    }

    protected removeSource(source: string): void {
        this.sourceSignatures.delete(source);
        const prior = this.bySource.get(source);
        if (!prior) return;
        for (const { target, member } of prior) {
            const members = this.byTarget.get(target);
            const sources = members?.get(member);
            sources?.delete(source);
            if (sources && sources.size === 0) members!.delete(member);
            if (members && members.size === 0) this.byTarget.delete(target);
        }
        this.bySource.delete(source);
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
    protected async indexDocument(document: AbstractNodeDocument, cancellationToken: CancellationToken): Promise<void> {
        const source = normalizeUri(document.uri);
        const previousSignature = this.sourceSignatures.get(source) ?? '';
        this.removeSource(source);
        const contributed: Array<{ target: string; member: string; slot: string }> = [];
        const state = { sawAlias: false };
        await this.collectIncludes(document, source, contributed, state, cancellationToken);
        if (contributed.length) this.bySource.set(source, contributed);
        if (!this.built && !this.inFixpointPass && state.sawAlias) this.fixpointDocuments?.push(document);
        const signature = contributed
            .map((entry) => `${entry.target} ${entry.member} ${entry.slot}`)
            .sort()
            .join('\n');
        if (signature !== previousSignature) this.changedSinceLastPass = true;
        if (signature) this.sourceSignatures.set(source, signature);
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
     * @param state gets `sawAlias` set when any alias include is seen, even one whose slot can't be typed yet.
     * @param cancellationToken cancels the slow-path navigation.
     */
    private async collectIncludes(
        container: AbstractNode,
        source: string,
        contributed: Array<{ target: string; member: string; slot: string }>,
        state: { sawAlias: boolean },
        cancellationToken: CancellationToken
    ): Promise<void> {
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
                    await this.collectIncludes(element.right, source, contributed, state, cancellationToken);
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
                await this.collectIncludes(element, source, contributed, state, cancellationToken);
            }
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
                const document = await parseFilePath(path).catch(() => null);
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
        const relative = fileRef.replace(/^</, '').replace(/>$/, '').trim();
        if (!relative) return undefined;
        const sourceUri = getStartOfAstNode(referenceNode).uri;
        const withExtension = /\.[^/\\.]+$/.test(relative) ? relative : `${relative}.rules`;
        const cheapPath = resolve(dirname(uriToFsPath(sourceUri)), withExtension);
        if (existsSync(cheapPath)) return normalizeUri(cheapPath);

        const resolved = await navigation.navigate(fileRef, referenceNode, sourceUri, cancellationToken).catch(() => null);
        if (!resolved) return undefined;
        if (isFile(resolved as unknown as FileTree)) return normalizeUri((resolved as FileWithPath).path);
        if (isDocumentNode(resolved as AbstractNode)) return normalizeUri((resolved as AbstractNodeDocument).uri);
        return undefined;
    }
}
