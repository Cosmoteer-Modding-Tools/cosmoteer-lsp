import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isValueNode } from '../../core/ast/ast';
import { documentRootClass } from '../../document/schema/document-root';
import { typeDef } from '../../document/schema/schema';
import { BUILTIN_IDS, entityDeclarationsOf } from '../../document/schema/entity-schema';
import { markerUsagesOf } from '../../document/schema/category-usage';
import { normalizeUri } from '../navigation/reference-location';
import { WatchedDocumentIndex } from '../navigation/watched-document-index';
import { schemaReferenceFieldOf, isSameOrSubclass } from '../navigation/schema-id-reference.navigation';
import { ActionRootingIndex } from '../../mod/action-rooting.index';
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
 * Project-wide index of cross-file `ID<X>` declarations by class, the data behind cross-file `ID<X>`
 * value completion (e.g. `ResourceType = ` → every resource `ID` in the project). Two kinds of
 * declaration contribute: a whole-file root (a resource/nebula file with a top-level `ID`) gives one
 * `(rootClass, id)` entry, and an aggregate list element (a faction, a GUI toggle, a career tech, …)
 * gives one `(elementClass, id)` entry per element (see {@link entityDeclarationsOf}). Built once over
 * {@link projectDocuments} and kept current by the file watcher via {@link WatchedDocumentIndex}, so
 * completion never re-parses the project per keystroke. Go-to-definition uses a name-filtered scan
 * instead (one-off, no index needed). See `schema-id-reference.navigation.ts`.
 */
export class SchemaIdIndex extends WatchedDocumentIndex {
    private static _instance: SchemaIdIndex;

    /** class FullName → (id → source uri) of every file declaring that id. */
    private readonly byClass = new Map<string, Map<string, string>>();
    /** normalized source uri → the `(class, id)` entries it contributed (for incremental removal). */
    private readonly bySource = new Map<string, Array<{ cls: string; id: string; alias?: boolean }>>();

    private constructor() {
        super();
    }

    public static get instance(): SchemaIdIndex {
        if (!SchemaIdIndex._instance) SchemaIdIndex._instance = new SchemaIdIndex();
        return SchemaIdIndex._instance;
    }

    /** This index's slot in the persistent game-tree cache. */
    public readonly cacheId = 'schemaIds';

    protected clear(): void {
        this.byClass.clear();
        this.bySource.clear();
    }

    /**
     * Serializes the per-source id declarations for the persistent game-tree cache.
     *
     * @returns the JSON-safe state.
     */
    public saveState(): unknown {
        return [...this.bySource.entries()];
    }

    /**
     * Primes the index from a previously saved state, rebuilding the class lookup from the
     * per-source entries.
     *
     * @param state the value a prior {@link saveState} returned.
     * @returns true when the state had the expected shape and was loaded.
     */
    public loadState(state: unknown): boolean {
        if (!Array.isArray(state)) return false;
        this.clear();
        for (const entry of state as Array<[string, Array<{ cls: string; id: string; alias?: boolean }>]>) {
            if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) return false;
            const [source, entries] = entry;
            this.bySource.set(source, entries);
            for (const { cls, id } of entries) {
                (this.byClass.get(cls) ?? this.byClass.set(cls, new Map()).get(cls)!).set(id, source);
            }
        }
        return true;
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

    protected indexDocument(document: AbstractNodeDocument): boolean {
        const source = normalizeUri(document.uri);
        const prior = this.bySource.get(source);
        this.removeSource(source);
        const entries: Array<{ cls: string; id: string; alias?: boolean }> = [];
        // Whole-file root: the document's own top-level `ID` as an instance of its root class.
        const rootClass = documentRootClass(document);
        const id = rootClass ? topLevelId(document) : undefined;
        if (rootClass && id) entries.push({ cls: rootClass, id });
        // Aggregate list-element entities: each `Factions [ { ID } ]`, `PartToggles [ { ToggleID } ]`, …
        for (const decl of entityDeclarationsOf(document)) {
            entries.push(decl.alias ? { cls: decl.elementClass, id: decl.id, alias: true } : { cls: decl.elementClass, id: decl.id });
        }
        // Usage-defined marker targets (part categories, features, damage types, effect buckets, …)
        // have no declaration file, so each used name is itself an entry to complete and resolve.
        for (const usage of markerUsagesOf(document)) entries.push({ cls: usage.cls, id: usage.id });
        const changed = prior
            ? prior.length !== entries.length ||
              prior.some(
                  (entry, index) =>
                      entry.cls !== entries[index].cls ||
                      entry.id !== entries[index].id ||
                      (entry.alias ?? false) !== (entries[index].alias ?? false)
              )
            : entries.length > 0;
        if (!entries.length) return changed;
        this.bySource.set(source, entries);
        for (const { cls, id: entryId } of entries) {
            (this.byClass.get(cls) ?? this.byClass.set(cls, new Map()).get(cls)!).set(entryId, source);
        }
        return changed;
    }

    /**
     * The ids mod actions declare for `targetClass` (or a subclass). A mod adds to the game's id
     * collections from its manifest (`Add` with a `Name` into an editor-groups map, an override that
     * creates a buff), a declaration site no `.rules` file of the mod names. See
     * {@link ActionRootingIndex.actionDeclaredIds}.
     *
     * @param targetClass the reference target class FullName.
     * @param folderPaths the project folders to index.
     * @param cancellationToken cancellation for the index build.
     * @returns the set of ids mod actions declare for that class.
     */
    private async actionIdsForClass(
        targetClass: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<Set<string>> {
        await ActionRootingIndex.instance.ensureBuilt(folderPaths, cancellationToken);
        const ids = new Set<string>();
        for (const [cls, declared] of ActionRootingIndex.instance.actionDeclaredIds) {
            if (!isSameOrSubclass(cls, targetClass)) continue;
            for (const id of declared.keys()) ids.add(id);
        }
        return ids;
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
        // Ids the engine hardcodes in C# (runtime tags, DamageType instances): declared in no file,
        // but referenceable everywhere.
        for (const [cls, ids] of BUILTIN_IDS) {
            if (!isSameOrSubclass(cls, targetClass)) continue;
            for (const id of ids) {
                if (seen.has(id)) continue;
                seen.add(id);
                out.push({ label: id, kind: CompletionItemKind.Reference, detail: `→ ${targetName} (built-in)` });
            }
        }
        // Ids a mod's manifest actions add to a game collection: declared in no `.rules` file of the mod.
        for (const id of await this.actionIdsForClass(targetClass, folderPaths, cancellationToken)) {
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ label: id, kind: CompletionItemKind.Reference, detail: `→ ${targetName}` });
        }
        return out;
    }

    /**
     * Whether any project file declares an id of `targetClass` (or a subclass). The engine-hardcoded
     * `builtinIds` do not count: they are swept from literal constructions only, so a class whose
     * whole coverage is builtins has unknown completeness and existence cannot be judged against it.
     * Callers must have built the index first (any idsForClass/idCompletionsForClass call does).
     *
     * @param targetClass the reference target class FullName.
     * @returns true when at least one file-harvested declaration of that class exists.
     */
    public hasFileDeclarationsFor(targetClass: string): boolean {
        for (const [cls, ids] of this.byClass) {
            if (ids.size > 0 && isSameOrSubclass(cls, targetClass)) return true;
        }
        return false;
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
        for (const [cls, builtin] of BUILTIN_IDS) {
            if (!isSameOrSubclass(cls, targetClass)) continue;
            for (const id of builtin) ids.add(id);
        }
        for (const id of await this.actionIdsForClass(targetClass, folderPaths, cancellationToken)) ids.add(id);
        return ids;
    }

    /**
     * Collects the primary ids of `targetClass` (or a subclass): every declared id except the
     * `OtherIDs` legacy aliases, plus the engine builtins. Optionally restricted to declarations
     * from sources under a uri prefix, which is how the label-field derivation reads the base
     * game's declarations without the workspace's own additions.
     *
     * @param targetClass the reference target class FullName.
     * @param folderPaths the project folders to index.
     * @param cancellationToken cancellation for the index build.
     * @param sourcePrefix a normalized uri prefix declarations must come from, or undefined for all.
     * @returns the set of primary ids declared for that class.
     */
    public async primaryIdsForClass(
        targetClass: string,
        folderPaths: string[],
        cancellationToken: CancellationToken,
        sourcePrefix?: string
    ): Promise<Set<string>> {
        await this.ensureFresh(
            (progress) => this.buildFromProject(folderPaths, progress),
            cancellationToken,
            'Indexing references'
        );

        const ids = new Set<string>();
        for (const [source, entries] of this.bySource) {
            if (sourcePrefix && !source.startsWith(sourcePrefix)) continue;
            for (const entry of entries) {
                if (!entry.alias && isSameOrSubclass(entry.cls, targetClass)) ids.add(entry.id);
            }
        }
        for (const [cls, builtin] of BUILTIN_IDS) {
            if (!isSameOrSubclass(cls, targetClass)) continue;
            for (const id of builtin) ids.add(id);
        }
        // Manifest-declared ids come from the workspace's mods, so a base-game-only read skips them.
        if (!sourcePrefix) {
            for (const id of await this.actionIdsForClass(targetClass, folderPaths, cancellationToken)) ids.add(id);
        }
        return ids;
    }
}
