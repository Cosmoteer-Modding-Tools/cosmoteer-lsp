/**
 * Whole-file document roots: files whose top-level fields are themselves a schema class, e.g. a
 * shot file is a `BulletRules`, an effect file is a `MediaEffectRules` (chosen by its top-level
 * `Type`). This is distinct from a part file, where a named `Part { … }` group is the root (see
 * `ROOT_GROUP_CLASSES`).
 *
 * Two resolution paths, tried in order:
 *  1. **Content dispatch** — a top-level `Type = <disc>` that names a member of a whole-file-root
 *     registry (media effects, music, doodads). Path-independent and self-describing, so the
 *     effect/music files scattered across many folders (crew, statuses, nebulas, …) root correctly
 *     wherever they live.
 *  2. **Path-scoped rule** — for files a fixed class with no `Type` discriminator (a resource, a
 *     status, a nebula), or a registry whose discriminators are too generic to dispatch globally
 *     (name generators). Fixed classes are guarded by a required top-level field so the effect and
 *     index files that share the same folder are not mis-rooted.
 *
 * Every candidate is finally self-validated by {@link classFitsDocument} (it must own a majority of
 * the document's top-level fields), which guards against loose path matches and generic
 * discriminators. Conservative on purpose: a wrong root mis-types fields, so only add a mapping
 * after confirming the whole-vanilla scan stays warning- and mis-root-free.
 */
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isGroupNode, isValueNode } from '../../core/ast/ast';
import { namedMembersOf } from '../../utils/ast.utils';
import { fieldOf, schema } from './schema';
import { SchemaRegistry } from './schema.types';

type RootRule = {
    readonly test: RegExp;
    /** Fixed whole-file class, for top-levels with no `Type=` discriminator. */
    readonly cls?: string;
    /** Path-scoped polymorphic root: dispatch the document's top-level `Type=` within this registry
     *  only. Used for registries whose discriminators are too generic for global dispatch (e.g.
     *  `NameGenerator` declares `None`, which collides with sysgen stage configs elsewhere). */
    readonly registry?: string;
    /** Apply `cls` only if the document has this top-level field — distinguishes `ID`-shaped data
     *  files from the `Type`-shaped effect files and the index files that share their folder. */
    readonly requireTopLevelField?: string;
};

/** Path-scoped roots: a fixed class, or a registry whose discriminators are too generic to dispatch globally. */
const PATH_ROOTS: ReadonlyArray<RootRule> = [
    { test: /\/shots\//i, cls: 'Cosmoteer.Bullets.BulletRules' },
    // Codex page files (`codex/lore/**`, `codex/tutorials/**`) are whole-file `CodexPageRules`, pulled
    // into the codex through `CodexPages` lists that are assembled by multi-source `&<a>/CodexPages,
    // &<b>/CodexPages` concatenation the alias walk doesn't follow. Guarded by the top-level `Entries`
    // field, which every page declares but the list-container files (`codex.rules`, `lore.rules`,
    // `tutorials.rules`, `tips.rules`, whose top-level field is `CodexPages`) lack — so those stay
    // unrooted here instead of mis-typing as a page.
    { test: /[/\\]codex[/\\]/i, cls: 'Cosmoteer.Codex.CodexPageRules', requireTopLevelField: 'Entries' },
    // Builtin-ships database files (`builtin_ships/**`) are whole-file `BuiltinShipsDatabase`, whose
    // `Ships` list of ship blueprints is assembled by multi-source concatenation the alias walk can't
    // follow. The `Ships` / `Faction` / `Tags` / `IDPrefix` members are modeled in schema-overlay.ts.
    // Guarded by the top-level `Ships` field that every one of these files (concat and leaf) declares.
    { test: /[/\\]builtin_ships[/\\]/i, cls: 'Cosmoteer.Data.BuiltinShipsDatabase', requireTopLevelField: 'Ships' },
    { test: /\/resources\//i, cls: 'Cosmoteer.Resources.ResourceRules', requireTopLevelField: 'ID' },
    { test: /\/statuses\//i, cls: 'Cosmoteer.Ships.Statuses.StatusType', requireTopLevelField: 'ID' },
    // AI behaviour files (`ai/ai_normal.rules`, one per difficulty and station type) are whole-file
    // `ShipAIRules`. Guarded by `StrategyModules`, which every real AI file declares but the folder's
    // two fragments lack (`ai_common.rules` holds shared module defs, `ai.rules` is a name→ref index),
    // so those stay unrooted instead of mis-typed as an AI file.
    { test: /[/\\]ai[/\\]/i, cls: 'Cosmoteer.Ships.AI.ShipAIRules', requireTopLevelField: 'StrategyModules' },
    { test: /\/nebulas\//i, cls: 'Cosmoteer.Nebulas.NebulaTypeRules', requireTopLevelField: 'ID' },
    { test: /[/\\]crew[/\\]crew\.rules$/i, cls: 'Cosmoteer.Crew.CrewRules' },
    { test: /\/name_generators\//i, registry: 'Cosmoteer.Generators.Names.NameGenerator' },
    // Career sector-generation files are whole-file `SimObjectSpawner`s dispatched by their top-level
    // `Type=` (None/Doodads/Nebula/FtlGates/…). Path-scoped because those discriminators are generic
    // (`None`, `Ships`) and collide with other registries (e.g. doodad `Nebula`); rooting here lets a
    // `SubSpawners` element resolve within the spawner registry instead of the colliding doodad one.
    { test: /[/\\]sectors[/\\]/i, registry: 'Cosmoteer.Generators.Simulation.SimObjectSpawner' },
    // Spawner-generator fragment files included via `&<>` as a `SimulationGenerator`/`GalaxyGenerator`
    // (a `Spawners` list). Whole-file roots with no top-level `Type=`, so keyed by their canonical
    // folder and guarded by the distinctive top-level `Spawners` field. The two generator classes are
    // field-identical (both just `Spawners`), so the folder is what tells them apart.
    {
        test: /[/\\]galaxy_map[/\\]map_generators[/\\]/i,
        cls: 'Cosmoteer.Generators.Galaxies.GalaxyGenerator',
        requireTopLevelField: 'Spawners',
    },
    {
        test: /[/\\]modes[/\\](?:pvp|creative)[/\\]/i,
        cls: 'Cosmoteer.Generators.Simulation.SimulationGenerator',
        requireTopLevelField: 'Spawners',
    },
];

/**
 * Registries whose members are specific enough to be a whole-file root anywhere, selected by the
 * document's top-level `Type=` regardless of folder (effect/music/doodad files are scattered across
 * many folders). Generic-discriminator registries (e.g. NameGenerator's `None`) are excluded here
 * and handled path-scoped in {@link PATH_ROOTS} instead. Order only matters for cross-registry
 * discriminator collisions (currently none collide within this set).
 */
const ROOT_REGISTRIES: ReadonlyArray<string> = [
    'Cosmoteer.Simulation.MediaEffects.MediaEffectRules',
    'Cosmoteer.Music.MusicTrackRules',
    'Cosmoteer.Simulation.Doodads.DoodadRules',
];

/** A top-level named member of the document, if present. The name matches case-insensitively like the game's node lookup. */
const topLevelField = (document: AbstractNodeDocument, name: string): AbstractNode | undefined => {
    for (const [memberName, value] of namedMembersOf(document)) {
        if (memberName.toLowerCase() === name.toLowerCase()) return value;
    }
    return undefined;
};

/** The document's top-level `Type = <disc>` value, for polymorphic whole-file roots. */
const topLevelType = (document: AbstractNodeDocument): string | undefined => {
    const value = topLevelField(document, 'Type');
    if (value && isValueNode(value) && (value.valueType.type === 'String' || value.valueType.type === 'Reference')) {
        return String(value.valueType.value);
    }
    return undefined;
};

/** Minimum fraction of a document's top-level fields that a candidate root class must own. */
const MIN_ROOT_COVERAGE = 0.5;

/**
 * Self-validate a candidate root: reject a class that doesn't own a majority of the document's
 * top-level fields. This is what makes rooting robust against the two ways a candidate goes wrong,
 * a loose path substring match (`codex/tutorials/resources/…` matching `/resources/`) and a generic
 * `Type=` discriminator (`None`/`Random`/…) that belongs to a different registry. Documents with too
 * few nameable top-level members (< 3) carry too little signal to judge and are accepted unchecked;
 * pure-override/helper fragments fail naturally on their near-zero coverage.
 */
const classFitsDocument = (cls: string, document: AbstractNodeDocument): boolean => {
    const names = document.elements
        .filter((node): node is AbstractNode => isAssignmentNode(node) || isGroupNode(node))
        .map((node) => (isAssignmentNode(node) ? node.left.name : isGroupNode(node) ? node.identifier?.name : undefined))
        .filter((name): name is string => !!name)
        // The polymorphic `Type=` discriminator is structural, never a class field, so counting it
        // would understate coverage on `Type`-dispatched roots (a spawner file's only fields besides
        // `Type` may be a couple of base members). Drop it when it isn't a real field of the candidate.
        .filter((name) => name.toLowerCase() !== 'type' || !!fieldOf(cls, name));
    if (names.length < 3) return true;
    const known = names.filter((name) => fieldOf(cls, name)).length;
    return known / names.length >= MIN_ROOT_COVERAGE;
};

/** Normalize a document URI's path separators so the `/dir/` path rules match disk paths too
 *  (files scanned from disk on Windows carry backslashes, while open-buffer URIs use forward slashes). */
const normalizedUri = (document: AbstractNodeDocument): string => document.uri.replace(/\\/g, '/');

/** The schema class for a whole-file-root document, or undefined (part files, unknown kinds). */
export const documentRootClass = (document: AbstractNodeDocument): string | undefined => {
    // 1) Content dispatch: a top-level `Type=` naming a whole-file-root registry's member.
    const type = topLevelType(document);
    if (type) {
        for (const registry of ROOT_REGISTRIES) {
            const cls = schema.registries[registry]?.members[type];
            if (cls) return classFitsDocument(cls, document) ? cls : undefined;
        }
    }
    // 2) Path-scoped rule: a fixed class (guarded by a required top-level field), or a path-scoped
    //    polymorphic registry dispatched by the document's top-level `Type=`.
    const uri = normalizedUri(document);
    for (const rule of PATH_ROOTS) {
        if (!rule.test.test(uri)) continue;
        if (rule.cls) {
            if (rule.requireTopLevelField && !topLevelField(document, rule.requireTopLevelField)) continue;
            return classFitsDocument(rule.cls, document) ? rule.cls : undefined;
        }
        if (rule.registry && type) {
            const cls = schema.registries[rule.registry]?.members[type];
            if (cls) return classFitsDocument(cls, document) ? cls : undefined;
        }
    }
    return undefined;
};

/**
 * The registry a whole-file-root's top-level `Type=` dispatches within — known by the canonical
 * folder even when the written `Type` is a typo (so completion can offer it and validation can flag
 * it). Falls back to content when a valid `Type` already names a global root registry's member.
 * Returns undefined for non-`Type`-dispatched roots (parts, shots, resources, …), so callers stay
 * conservative. Only the canonical dirs are mapped — effect files scattered elsewhere simply aren't
 * covered (no false guidance), matching the low-FP bias of the rest of the seam.
 */
const ROOT_REGISTRY_BY_PATH: ReadonlyArray<{ readonly test: RegExp; readonly registry: string }> = [
    { test: /\/doodads\//i, registry: 'Cosmoteer.Simulation.Doodads.DoodadRules' },
    { test: /\/common_effects\//i, registry: 'Cosmoteer.Simulation.MediaEffects.MediaEffectRules' },
    { test: /\/music\//i, registry: 'Cosmoteer.Music.MusicTrackRules' },
    { test: /\/name_generators\//i, registry: 'Cosmoteer.Generators.Names.NameGenerator' },
];

export const documentRootRegistry = (document: AbstractNodeDocument): SchemaRegistry | undefined => {
    // Content first: a valid top-level `Type` pins the registry exactly (an effect file living under
    // /doodads/ is a MediaEffect, not a DoodadRules). Path is only the fallback for the typo case,
    // where the written `Type` matches nothing — so completion/validation still know what to offer.
    const type = topLevelType(document);
    if (type) {
        for (const registry of ROOT_REGISTRIES) {
            if (schema.registries[registry]?.members[type]) return schema.registries[registry];
        }
    }
    const uri = normalizedUri(document);
    const byPath = ROOT_REGISTRY_BY_PATH.find((rule) => rule.test.test(uri));
    return byPath ? schema.registries[byPath.registry] : undefined;
};
