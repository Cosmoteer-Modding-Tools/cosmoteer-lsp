import { CancellationToken, CompletionItemKind, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isValueNode } from '../../core/ast/ast';
import { classFitsDocument, documentRootClass } from '../../document/schema/document-root';
import { typeDef } from '../../document/schema/schema';
import { BUILTIN_IDS, entityDeclarationsOf, isIdDeclarationField } from '../../document/schema/entity-schema';
import { MARKER_CLASSES, markerUsagesOf } from '../../document/schema/category-usage';
import { normalizeUri } from '../navigation/reference-location';
import { ReverseIncludeIndex } from '../navigation/reverse-include.index';
import { WatchedDocumentIndex } from '../navigation/watched-document-index';
import { schemaReferenceFieldOf, isSameOrSubclass } from '../navigation/schema-id-reference.navigation';
import { aliasRootIndex } from '../../document/schema/alias-root';
import { ActionRootingIndex } from '../../mod/action-rooting.index';
import { Completion } from './autocompletion.service';

/**
 * The fields that borrow an id type in the C# without the engine ever resolving their value to an
 * object: `SelectionTypeID` only groups parts in the build UI, `FlipWhenLoadingIDs` names removed
 * legacy parts for save compatibility, and `UpgradedFrom` names the tech a tech replaces. Offering
 * the project's ids there suggests picking a live object for a slot that is a plain label.
 *
 * The reference validator derives the same set mechanically from the base game's own usage, but its
 * derivation is not exported (and costs a game-tree scan per field), so the names it settles on are
 * kept here as a list. Its vanilla test pins that set, so a divergence shows up there.
 */
const LABEL_FIELDS = new Set(['selectiontypeid', 'flipwhenloadingids', 'upgradedfrom']);

/**
 * Whether a field is a label field, which names an id without ever resolving it.
 *
 * @param fieldName the written field name, in any casing.
 * @returns true for a label field.
 */
export const isLabelField = (fieldName: string | undefined): boolean =>
    !!fieldName && LABEL_FIELDS.has(fieldName.toLowerCase());

/**
 * The class a whole file declares an instance of, path and content first and the wiring afterwards.
 *
 * A mod is free to keep a declaration where it likes and hand the file to the game from somewhere
 * else: a manifest action (`AddMany` into the game's `Resources` list), or simply the field that
 * names it, which is how a mod keeps a bullet file next to the weapon that fires it
 * (`Bullet = &<cannon_bolt/cannon_bolt.rules>`). The game reads such a file as whatever the slot
 * declares. Rooting it by its path alone leaves its `ID` unharvested, so the mod's own resources and
 * bullets are missing wherever the project's ids are offered or checked. The action, alias and
 * reference indexes each record the slot a fragment is wired into, so the type is asked of them when
 * the ordinary rooting has nothing, and the class still has to fit the document before an id is taken
 * from it.
 *
 * @param document the parsed document to root.
 * @returns the class the file declares, or undefined when it declares none.
 */
const declaredRootClass = (document: AbstractNodeDocument): string | undefined => {
    const rooted = documentRootClass(document);
    if (rooted) return rooted;
    const wired =
        ActionRootingIndex.instance.rootType(document.uri) ??
        aliasRootIndex.rootType(document.uri) ??
        ReverseIncludeIndex.instance.rootType(document.uri);
    if (wired?.kind !== 'group') return undefined;
    return classFitsDocument(wired.ref, document) ? wired.ref : undefined;
};

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

/** One name of a usage-defined vocabulary: the spelling a file wrote and how often it is written. */
export interface MarkerName {
    written: string;
    uses: number;
}

/** Marker class FullName to the folded names written for it, see {@link SchemaIdIndex.markerVocabulary}. */
export type MarkerVocabulary = ReadonlyMap<string, ReadonlyMap<string, MarkerName>>;

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
    private readonly byClass = new Map<string, Map<string, Set<string>>>();
    /** normalized source uri → the `(class, id)` entries it contributed (for incremental removal). */
    private readonly bySource = new Map<string, Array<{ cls: string; id: string; alias?: boolean }>>();
    /** The marker vocabulary aggregate, kept until an index change moves the revision past it. */
    private vocabularyCache: { revision: number; value: MarkerVocabulary } | undefined;

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
                this.declare(cls, id, source);
            }
        }
        return true;
    }

    /**
     * Records that `source` declares `id` for `cls`. An id several files declare is held with all of
     * them, since the game keeps one of the two while the project still writes both, and dropping one
     * file must not take the id away from the other.
     *
     * @param cls the declared class.
     * @param id the declared id.
     * @param source the declaring file's normalized uri.
     */
    private declare(cls: string, id: string, source: string): void {
        const ids = this.byClass.get(cls) ?? this.byClass.set(cls, new Map()).get(cls)!;
        (ids.get(id) ?? ids.set(id, new Set()).get(id)!).add(source);
    }

    protected removeSource(source: string): void {
        const prior = this.bySource.get(source);
        if (prior) {
            for (const { cls, id } of prior) {
                const sources = this.byClass.get(cls)?.get(id);
                if (!sources) continue;
                sources.delete(source);
                if (sources.size === 0) this.byClass.get(cls)?.delete(id);
            }
            this.bySource.delete(source);
        }
    }

    /**
     * Builds the index with the reference and action rooting in place, so a fragment another file
     * names, or a manifest wires into a game collection, is already typed when the walk reaches it.
     * Without the wait the walk would root such a file by its path alone, and a one-shot build has no
     * second pass to correct that.
     *
     * @param folderPaths the project folders to walk.
     * @param progress the reporter the walk posts its file count to.
     */
    private async buildWiredFirst(folderPaths: string[], progress?: WorkDoneProgressReporter): Promise<void> {
        await ReverseIncludeIndex.instance.ensureBuilt(folderPaths, CancellationToken.None).catch(() => undefined);
        await ActionRootingIndex.instance.ensureBuilt(folderPaths, CancellationToken.None).catch(() => undefined);
        await this.buildFromProject(folderPaths, progress);
    }

    protected indexDocument(document: AbstractNodeDocument): boolean {
        const source = normalizeUri(document.uri);
        const prior = this.bySource.get(source);
        this.removeSource(source);
        const entries: Array<{ cls: string; id: string; alias?: boolean }> = [];
        // Whole-file root: the document's own top-level `ID` as an instance of its root class.
        const rootClass = declaredRootClass(document);
        const id = rootClass ? topLevelId(document) : undefined;
        if (rootClass && id) entries.push({ cls: rootClass, id });
        // Aggregate list-element entities: each `Factions [ { ID } ]`, `PartToggles [ { ToggleID } ]`, …
        for (const decl of entityDeclarationsOf(document)) {
            entries.push(
                decl.alias
                    ? { cls: decl.elementClass, id: decl.id, alias: true }
                    : { cls: decl.elementClass, id: decl.id }
            );
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
            this.declare(cls, entryId, source);
        }
        return changed;
    }

    /**
     * How often the project writes each marker-class name, keyed by class and by the folded name.
     * A marker class has no declaration file, so every written usage is a declaration and the
     * count is what tells a name the project has agreed on apart from one a single file invented.
     * Memoized on the index revision, since the answer is an aggregate over every indexed file.
     *
     * @param folderPaths the project folders to index.
     * @param cancellationToken cancellation for the index build.
     * @returns class FullName to folded name to the written spelling and how often it is written.
     */
    public async markerVocabulary(
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<MarkerVocabulary> {
        await this.ensureFresh(
            (progress) => this.buildWiredFirst(folderPaths, progress),
            cancellationToken,
            'Indexing references'
        );
        if (this.vocabularyCache && this.vocabularyCache.revision === this.revision) return this.vocabularyCache.value;
        const vocabulary: Map<string, Map<string, MarkerName>> = new Map();
        for (const entries of this.bySource.values()) {
            for (const { cls, id } of entries) {
                if (!MARKER_CLASSES.has(cls)) continue;
                const names = vocabulary.get(cls) ?? vocabulary.set(cls, new Map()).get(cls)!;
                const folded = id.toLowerCase();
                const name = names.get(folded) ?? names.set(folded, { written: id, uses: 0 }).get(folded)!;
                name.uses++;
            }
        }
        this.vocabularyCache = { revision: this.revision, value: vocabulary };
        return vocabulary;
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
        // An `ID = ` slot (or an `OtherIDs` alias entry) declares an id instead of naming one, so
        // every id the project already has is exactly the set the user must not pick here.
        if (!ref || isIdDeclarationField(ref.ownerClass, ref.fieldName, ref.targetClass)) return [];
        if (isLabelField(ref.fieldName)) return [];
        return this.idCompletionsForClass(ref.targetClass, folderPaths, cancellationToken);
    }

    /** Completions for every project id whose declaring file's root class is `targetClass` (or a subclass). */
    public async idCompletionsForClass(
        targetClass: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<Completion[]> {
        await this.ensureFresh(
            (progress) => this.buildWiredFirst(folderPaths, progress),
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
        if (!this.fileDeclMemo || this.fileDeclMemo.revision !== this.revision) {
            this.fileDeclMemo = { revision: this.revision, byTarget: new Map() };
        }
        const memoized = this.fileDeclMemo.byTarget.get(targetClass);
        if (memoized !== undefined) return memoized;
        let declared = false;
        for (const [cls, ids] of this.byClass) {
            if (ids.size > 0 && isSameOrSubclass(cls, targetClass)) {
                declared = true;
                break;
            }
        }
        this.fileDeclMemo.byTarget.set(targetClass, declared);
        return declared;
    }

    /** The answer of {@link hasFileDeclarationsFor} per target class, dropped whenever the index
     *  moves. The question is asked once per reference of every file, while the answer only depends
     *  on what the index holds, and a class the index has nothing for reads the whole of it. */
    private fileDeclMemo?: { revision: number; byTarget: Map<string, boolean> };

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
            (progress) => this.buildWiredFirst(folderPaths, progress),
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
     * Every declaration of `targetClass` (or a subclass) the project carries, with the file each one
     * is written in. `primaryIdsForClass` answers the ids alone and drops aliases, which is what a
     * completion list wants. A report that has to say where a part is declared, or which files hold
     * the project's techs, needs the file as well.
     *
     * @param targetClass the class whose declarations are wanted.
     * @param folderPaths the project folders, for the index build.
     * @param cancellationToken cancels the build.
     * @param sourcePrefix a normalized uri prefix declarations must come from, or undefined for all.
     * @returns one entry per declaration, aliases included and marked.
     */
    public async declarationsForClass(
        targetClass: string,
        folderPaths: string[],
        cancellationToken: CancellationToken,
        sourcePrefix?: string
    ): Promise<Array<{ id: string; source: string; alias: boolean }>> {
        await this.ensureFresh(
            (progress) => this.buildWiredFirst(folderPaths, progress),
            cancellationToken,
            'Indexing references'
        );

        const declarations: Array<{ id: string; source: string; alias: boolean }> = [];
        for (const [source, entries] of this.bySource) {
            if (sourcePrefix && !source.startsWith(sourcePrefix)) continue;
            for (const entry of entries) {
                if (isSameOrSubclass(entry.cls, targetClass)) {
                    declarations.push({ id: entry.id, source, alias: entry.alias === true });
                }
            }
        }
        return declarations;
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
            (progress) => this.buildWiredFirst(folderPaths, progress),
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
