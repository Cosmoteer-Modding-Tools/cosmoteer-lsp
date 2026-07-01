import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isValueNode } from '../../core/ast/ast';
import { documentRootClass } from '../../document/schema/document-root';
import { typeDef } from '../../document/schema/schema';
import { entityDeclarationsOf } from '../../document/schema/entity-schema';
import { categoryUsagesOf, PART_CATEGORY_CLASS } from '../../document/schema/category-usage';
import { normalizeUri } from '../navigation/reference-location';
import { WatchedDocumentIndex } from '../navigation/watched-document-index';
import { schemaReferenceFieldOf, isSameOrSubclass } from '../navigation/schema-id-reference.navigation';
import { Completion } from './autocompletion.service';

/** The top-level `ID = <value>` string of a whole-file-root document, if any. */
const topLevelId = (document: AbstractNodeDocument): string | undefined => {
    for (const element of document.elements) {
        if (isAssignmentNode(element) && element.left.name === 'ID' && isValueNode(element.right)) {
            const vt = element.right.valueType;
            if (vt.type === 'String' || vt.type === 'Reference') return String(vt.value);
        }
    }
    return undefined;
};

/**
 * Project-wide index of cross-file `ID<X>` declarations by class — the data behind cross-file `ID<X>`
 * value completion (e.g. `ResourceType = ` → every resource `ID` in the project). Two kinds of
 * declaration contribute: a whole-file root (a resource/nebula file with a top-level `ID`) gives one
 * `(rootClass, id)` entry, and an aggregate list element (a faction, a GUI toggle, a career tech, …)
 * gives one `(elementClass, id)` entry per element (see {@link entityDeclarationsOf}). Built once over
 * {@link projectDocuments} and kept current by the file watcher via {@link WatchedDocumentIndex}, so
 * completion never re-parses the project per keystroke. Go-to-definition uses a name-filtered scan
 * instead (one-off, no index needed) — see `schema-id-reference.navigation.ts`.
 */
export class SchemaIdIndex extends WatchedDocumentIndex {
    private static _instance: SchemaIdIndex;

    /** class FullName → (id → source uri) of every file declaring that id. */
    private readonly byClass = new Map<string, Map<string, string>>();
    /** normalized source uri → the `(class, id)` entries it contributed (for incremental removal). */
    private readonly bySource = new Map<string, Array<{ cls: string; id: string }>>();

    private constructor() {
        super();
    }

    public static get instance(): SchemaIdIndex {
        if (!SchemaIdIndex._instance) SchemaIdIndex._instance = new SchemaIdIndex();
        return SchemaIdIndex._instance;
    }

    protected clear(): void {
        this.byClass.clear();
        this.bySource.clear();
    }

    protected removeSource(source: string): void {
        const prior = this.bySource.get(source);
        if (prior) {
            for (const { cls, id } of prior) {
                const ids = this.byClass.get(cls);
                if (ids?.get(id) === source) ids.delete(id);
            }
            this.bySource.delete(source);
        }
    }

    protected indexDocument(document: AbstractNodeDocument): void {
        const source = normalizeUri(document.uri);
        this.removeSource(source);
        const entries: Array<{ cls: string; id: string }> = [];
        // Whole-file root: the document's own top-level `ID` as an instance of its root class.
        const rootClass = documentRootClass(document);
        const id = rootClass ? topLevelId(document) : undefined;
        if (rootClass && id) entries.push({ cls: rootClass, id });
        // Aggregate list-element entities: each `Factions [ { ID } ]`, `PartToggles [ { ToggleID } ]`, …
        for (const decl of entityDeclarationsOf(document)) entries.push({ cls: decl.elementClass, id: decl.id });
        // Usage-defined targets: part categories have no declaration, so each used category name
        // (`Category = armor`, `TypeCategories = [armor, …]`) is itself an entry to complete.
        for (const category of categoryUsagesOf(document)) entries.push({ cls: PART_CATEGORY_CLASS, id: category });
        if (!entries.length) return;
        this.bySource.set(source, entries);
        for (const { cls, id: entryId } of entries) {
            (this.byClass.get(cls) ?? this.byClass.set(cls, new Map()).get(cls)!).set(entryId, source);
        }
    }

    /**
     * Completions for a cross-file `ID<X>` value: every project id whose declaring file's root class
     * is the field's target (or a subclass). Returns `[]` immediately (no index build) when the
     * cursor isn't on such a reference field, so unrelated completions stay cheap.
     */
    public async idCompletions(
        node: AbstractNode,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<Completion[]> {
        const ref = schemaReferenceFieldOf(node);
        return ref ? this.idCompletionsForClass(ref.targetClass, folderPaths, cancellationToken) : [];
    }

    /** Completions for every project id whose declaring file's root class is `targetClass` (or a subclass). */
    public async idCompletionsForClass(
        targetClass: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<Completion[]> {
        await this.ensureFresh(
            (progress) => this.buildFromProject(folderPaths, progress),
            cancellationToken,
            'Indexing references'
        );

        const targetName = typeDef(targetClass)?.name ?? targetClass.split('.').pop()!;
        const out: Completion[] = [];
        const seen = new Set<string>();
        for (const [cls, ids] of this.byClass) {
            if (!isSameOrSubclass(cls, targetClass)) continue;
            for (const id of ids.keys()) {
                if (seen.has(id)) continue;
                seen.add(id);
                out.push({ label: id, kind: CompletionItemKind.Reference, detail: `→ ${targetName}` });
            }
        }
        return out;
    }

    /**
     * Collects every declared id whose class is `targetClass` or a subclass, after making sure the
     * project index is fresh. Used by reference validation to tell a real id from a typo.
     *
     * @param targetClass the reference target class FullName.
     * @param folderPaths the project folders to index.
     * @param cancellationToken cancellation for the index build.
     * @returns the set of ids declared for that class across the project.
     */
    public async idsForClass(
        targetClass: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<Set<string>> {
        await this.ensureFresh(
            (progress) => this.buildFromProject(folderPaths, progress),
            cancellationToken,
            'Indexing references'
        );

        const ids = new Set<string>();
        for (const [cls, classIds] of this.byClass) {
            if (!isSameOrSubclass(cls, targetClass)) continue;
            for (const id of classIds.keys()) ids.add(id);
        }
        return ids;
    }
}
