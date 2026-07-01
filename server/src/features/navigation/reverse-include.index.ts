import { CancellationToken } from 'vscode-languageserver';
import { dirname, resolve } from 'path';
import { AbstractNodeDocument, isAssignmentNode, isValueNode } from '../../core/ast/ast';
import { documentRootClass } from '../../document/schema/document-root';
import { fieldOf } from '../../document/schema/schema';
import { ValueType } from '../../document/schema/schema.types';
import { AliasMemberSource, parseAlias, registerAliasFallbackSource } from '../../document/schema/alias-root';
import { normalizeUri } from './reference-location';
import { uriToFsPath } from './workspace-files';
import { WatchedDocumentIndex } from './watched-document-index';

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
 * This index scans the project the other way round. For every rooted file it records each top-level
 * `Field = &<fragment>` include and the schema {@link ValueType} of the declaring `Field`, keyed by the
 * included fragment's canonical uri. {@link aliasedMemberType} then consults this index through the
 * registered {@link AliasMemberSource} when the forward walk misses, and roots the fragment the same way
 * a forward member-less alias would. A member-less `&<file>` include stores the field type as the file's
 * root type, so a `group<C>` field roots the fragment as `C` and its members resolve through `C`'s fields.
 *
 * It is built once over the project and kept current by the file watcher (see
 * {@link WatchedDocumentIndex}), so a request reads a synchronous, already-fresh snapshot. Only top-level
 * includes are covered, which is the common case for the fragment files that need this, and only includes
 * whose path resolves relative to the including file. Virtual and mod-overlay `<Data/…>` paths are a
 * known gap.
 */
export class ReverseIncludeIndex extends WatchedDocumentIndex implements AliasMemberSource {
    private static _instance: ReverseIncludeIndex;

    /** Included fragment uri (normalized) to its alias members. The member is '' for a member-less
     *  include, and each member maps to the declaring field's type per including source uri, so a
     *  source can be removed on its own. */
    private readonly byTarget = new Map<string, Map<string, Map<string, ValueType>>>();
    /** Normalized including-source uri to the `(target, member)` entries it contributed. */
    private readonly bySource = new Map<string, Array<{ target: string; member: string }>>();

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
     * Re-indexes one including document, recording every top-level `Field = &<fragment>` include and the
     * type of the declaring field, keyed by the included fragment's uri. A file that has no root class of
     * its own contributes nothing, since there would be no class to read the including field's type from.
     *
     * @param document the including document to index.
     */
    protected indexDocument(document: AbstractNodeDocument): void {
        const source = normalizeUri(document.uri);
        this.removeSource(source);
        const ownerClass = documentRootClass(document);
        if (!ownerClass) return;

        const contributed: Array<{ target: string; member: string }> = [];
        for (const element of document.elements) {
            if (!isAssignmentNode(element) || !element.right || !isValueNode(element.right)) continue;
            if (element.right.valueType.type !== 'Reference') continue;
            const alias = parseAlias(String(element.right.valueType.value));
            if (!alias) continue;
            const fieldType = fieldOf(ownerClass, element.left.name)?.valueType;
            if (!fieldType) continue;
            const target = this.resolveTarget(document.uri, alias.fileRef);
            if (!target) continue;
            const member = alias.member ?? '';
            const members = this.byTarget.get(target) ?? this.byTarget.set(target, new Map()).get(target)!;
            const sources = members.get(member) ?? members.set(member, new Map()).get(member)!;
            sources.set(source, fieldType);
            contributed.push({ target, member });
        }
        if (contributed.length) this.bySource.set(source, contributed);
    }

    /**
     * The canonical uri of the file a `<path>` include resolves to, relative to the including file's
     * directory. The `.rules` extension is appended when the ref omits one, matching how the game loads a
     * bare fragment path.
     *
     * @param sourceUri the including file's uri.
     * @param fileRef the include's file ref, for example `<../explode_sparks_def.rules>`.
     * @returns the normalized target uri, or undefined for a non-file ref or an empty path.
     */
    private resolveTarget(sourceUri: string, fileRef: string): string | undefined {
        const relative = fileRef.replace(/^</, '').replace(/>$/, '').trim();
        if (!relative) return undefined;
        const withExtension = /\.[^/\\.]+$/.test(relative) ? relative : `${relative}.rules`;
        return normalizeUri(resolve(dirname(uriToFsPath(sourceUri)), withExtension));
    }
}
