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
import { getStartOfAstNode } from '../../utils/ast.utils';
import { listElementType, memberTypeIn } from '../../document/schema/schema-context';
import { ValueType } from '../../document/schema/schema.types';
import { AliasMemberSource, parseAlias, registerAliasFallbackSource } from '../../document/schema/alias-root';
import { FileTree, FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { FullNavigationStrategy } from './full.navigation-strategy';
import { normalizeUri } from './reference-location';
import { projectDocuments, uriToFsPath } from './workspace-files';
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
 * a reverse include still types its own includes. The build therefore runs to a fixpoint: it re-indexes
 * every document until the recorded set stops changing, so a chain of fragments (A includes B, B includes
 * C, and A is itself only reverse-rooted) roots all the way down regardless of scan order.
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
    }

    protected removeSource(source: string): void {
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
     * build re-runs once the container roots.
     *
     * @param document the including document to index.
     * @param cancellationToken cancels the slow-path navigation used for game-root and overlay includes.
     */
    protected async indexDocument(document: AbstractNodeDocument, cancellationToken: CancellationToken): Promise<void> {
        const source = normalizeUri(document.uri);
        this.removeSource(source);
        const contributed: Array<{ target: string; member: string }> = [];
        await this.collectIncludes(document, source, contributed, cancellationToken);
        if (contributed.length) this.bySource.set(source, contributed);
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
     * @param contributed collects this source's `(target, member)` entries for {@link bySource}.
     * @param cancellationToken cancels the slow-path navigation.
     */
    private async collectIncludes(
        container: AbstractNode,
        source: string,
        contributed: Array<{ target: string; member: string }>,
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
                    const slot = alias && memberTypeIn(container, element.left.name);
                    if (alias && slot) await this.recordInclude(element.right, alias, slot, source, contributed, cancellationToken);
                } else if (isGroupNode(element.right) || isListNode(element.right)) {
                    await this.collectIncludes(element.right, source, contributed, cancellationToken);
                }
                continue;
            }
            if (inList && isValueNode(element) && element.valueType.type === 'Reference') {
                const alias = parseAlias(String(element.valueType.value));
                const slot = alias && listElementType(container);
                if (alias && slot) await this.recordInclude(element, alias, slot, source, contributed, cancellationToken);
                continue;
            }
            if (isGroupNode(element) || isListNode(element)) {
                await this.collectIncludes(element, source, contributed, cancellationToken);
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
     * @param contributed collects this source's `(target, member)` entries.
     * @param cancellationToken cancels the slow-path navigation.
     */
    private async recordInclude(
        referenceNode: AbstractNode,
        alias: { fileRef: string; member?: string },
        slot: ValueType,
        source: string,
        contributed: Array<{ target: string; member: string }>,
        cancellationToken: CancellationToken
    ): Promise<void> {
        const target = await this.resolveTarget(referenceNode, alias.fileRef, cancellationToken);
        if (!target) return;
        const member = alias.member ?? '';
        const members = this.byTarget.get(target) ?? this.byTarget.set(target, new Map()).get(target)!;
        const sources = members.get(member) ?? members.set(member, new Map()).get(member)!;
        sources.set(source, slot);
        contributed.push({ target, member });
    }

    /**
     * Builds the index to a fixpoint: it collects every project document once, then re-indexes them all
     * repeatedly until the recorded set stops changing. A single pass can't root a chain whose middle
     * link is itself only reverse-rooted (that link's own includes can't be typed until it roots), and
     * scan order is arbitrary, so iterating to a fixpoint roots the whole chain either way. The pass count
     * is bounded so a pathological cycle can't loop forever.
     *
     * @param folderPaths the project folders (the mod plus the game `Data` tree) to index.
     * @param progress the reporter to post a running pass/file count to.
     */
    protected async buildFromProject(folderPaths: string[], progress?: WorkDoneProgressReporter): Promise<void> {
        const documents: AbstractNodeDocument[] = [];
        for await (const document of projectDocuments(folderPaths, CancellationToken.None)) documents.push(document);

        const MAX_PASSES = 8;
        let previous = '';
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            let count = 0;
            for (const document of documents) {
                await this.indexDocument(document, CancellationToken.None);
                progress?.report(`pass ${pass + 1}: ${++count} files`);
            }
            this.passesUsed = pass + 1;
            const signature = this.signature();
            if (signature === previous) break;
            previous = signature;
        }
    }

    /** A stable serialization of every recorded root, to detect when a fixpoint pass changed nothing. */
    private signature(): string {
        const parts: string[] = [];
        for (const [target, members] of this.byTarget) {
            for (const [member, sources] of members) {
                for (const [source, valueType] of sources) {
                    parts.push(`${target} ${member} ${source} ${JSON.stringify(valueType)}`);
                }
            }
        }
        return parts.sort().join('\n');
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
