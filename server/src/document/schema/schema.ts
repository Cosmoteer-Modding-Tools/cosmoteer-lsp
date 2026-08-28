/**
 * Loader + query helpers over {@link SchemaBundle}. This is the read side of the schema seam:
 * features ask "what fields does class X have?", "what does enum E contain?", "which concrete
 * class does discriminator `Type=Y` select?" without knowing how the bundle was produced.
 */
import bundle from './cosmoteer.schema.json';
import { SchemaBundle, SchemaEnum, SchemaField, SchemaRegistry, SchemaTypeDef, ValueType } from './schema.types';
import { applySchemaOverlay } from './schema-overlay';
import { applyFieldDocs } from './field-docs';
import { deprecatedDiscriminator, deprecatedField } from './deprecations';
import type { ModSchemaExtension } from '../../features/mod-schema/extract';

// Merge hand-authored corrections for custom-deserialized types schemagen can't reflect (e.g. the
// dual-form `Texture` group), then attach community-maintained prose descriptions. Both additive
// (see schema-overlay.ts and field-docs.ts).
const schema: SchemaBundle = applyFieldDocs(applySchemaOverlay(bundle));

/** discriminator value -> the registry/class candidates that declare it (15 values collide across registries). */
const discriminatorIndex = new Map<string, Array<{ registryKey: string; cls: string }>>();
/** Short registry `name` → registry, so a name lookup is not a scan over all registries. */
const registryByShortName = new Map<string, SchemaRegistry>();

/**
 * Rebuild the lookup indexes over the current bundle. Run once at load and again whenever a code
 * mod's extracted types are merged in (see {@link extendSchemaWithMods}).
 */
const buildIndexes = (): void => {
    discriminatorIndex.clear();
    registryByShortName.clear();
    for (const [registryKey, registry] of Object.entries(schema.registries)) {
        for (const [disc, cls] of Object.entries(registry.members)) {
            const list = discriminatorIndex.get(disc) ?? [];
            list.push({ registryKey, cls });
            discriminatorIndex.set(disc, list);
        }
        if (!registryByShortName.has(registry.name)) registryByShortName.set(registry.name, registry);
    }
};
buildIndexes();

/** The mod extension currently merged in, so re-applying a changed one starts from the game schema. */
let appliedModExtension: ModSchemaExtension | undefined;

let schemaGen = 0;

/**
 * How many times the bundle has been reshaped by a mod merge. A consumer that memoizes an answer
 * derived purely from the schema stores this alongside the memo and recomputes once the two differ,
 * which is what keeps such a memo honest across {@link extendSchemaWithMods}.
 *
 * @returns the current schema generation.
 */
export const schemaGeneration = (): number => schemaGen;

/**
 * What the merge actually inserted, which is not the same as what the extension offered: an entry
 * the game already declares is skipped, and unmerging must not then delete the game's own. Kept as
 * the exact undo of the last merge.
 */
interface AppliedModKeys {
    types: Set<string>;
    enums: string[];
    registries: string[];
    /** Discriminators added to a game registry, as `[registry, discriminator]`. */
    members: Array<[string, string]>;
}
let appliedModKeys: AppliedModKeys | undefined;

/**
 * Merge the schema surface of the workspace's code mods into the bundle, replacing whatever
 * extension was merged before.
 *
 * A code mod ships a `.dll` declaring new serializable types with their own `Type=` discriminators.
 * The game loads them like its own, so its `.rules` files legitimately name classes and fields the
 * shipped schema has never heard of. Merging the extracted surface makes those resolve everywhere
 * the schema is consulted: discriminator validation, field completion, hover, and the required and
 * ignored-field checks.
 *
 * Additive only, and the game's own definitions always win: a mod cannot redefine a game type or
 * re-point an existing discriminator, which keeps a broken or hostile assembly from turning valid
 * vanilla content into diagnostics.
 *
 * @param extension what the mods add, or undefined to drop back to the plain game schema.
 */
export const extendSchemaWithMods = (extension: ModSchemaExtension | undefined): void => {
    // Undo exactly what the last merge inserted. Deriving this from the extension instead would
    // delete a game definition the merge had refused to overwrite in the first place.
    if (appliedModKeys) {
        for (const fullName of appliedModKeys.types) delete schema.types[fullName];
        for (const fullName of appliedModKeys.enums) delete schema.enums[fullName];
        for (const fullName of appliedModKeys.registries) delete schema.registries[fullName];
        for (const [registryName, disc] of appliedModKeys.members) delete schema.registries[registryName]?.members[disc];
    }
    appliedModExtension = extension;
    appliedModKeys = undefined;
    if (extension) {
        const applied: AppliedModKeys = { types: new Set(), enums: [], registries: [], members: [] };
        for (const [fullName, type] of Object.entries(extension.types)) {
            if (schema.types[fullName]) continue;
            schema.types[fullName] = type;
            applied.types.add(fullName);
        }
        for (const [fullName, def] of Object.entries(extension.enums)) {
            if (schema.enums[fullName]) continue;
            schema.enums[fullName] = def;
            applied.enums.push(fullName);
        }
        for (const [fullName, registry] of Object.entries(extension.registries)) {
            if (schema.registries[fullName]) continue;
            schema.registries[fullName] = registry;
            applied.registries.push(fullName);
        }
        for (const [registryName, members] of Object.entries(extension.registryMembers)) {
            const registry = schema.registries[registryName];
            if (!registry) continue;
            for (const [disc, cls] of Object.entries(members)) {
                if (disc in registry.members) continue;
                registry.members[disc] = cls;
                applied.members.push([registryName, disc]);
            }
        }
        appliedModKeys = applied;
    }
    buildIndexes();
    schemaGen++;
    fieldsOfCache.clear();
    requiredFieldsCache.clear();
    typeChainCache.clear();
    fieldIndexCache.clear();
    acceptsShaderConstantsCache.clear();
    localizationKeyFieldNameSet = undefined;
    declaredFieldNameSet = undefined;
};

/**
 * A signature of what the merged mod extension contributes: its types with their field names and
 * which of them carry prose, and every discriminator it adds. Two builds with the same signature
 * answer every completion, hover and diagnostic identically, so a re-extraction triggered by a file
 * event that changed nothing relevant can be dropped instead of invalidating every cache.
 *
 * @returns the signature, empty when no mod extension is merged.
 */
export const modSchemaSignature = (): string => {
    const extension = appliedModExtension;
    if (!extension) return '';
    const parts: string[] = [];
    for (const [fullName, type] of Object.entries(extension.types)) {
        parts.push(`T ${fullName} ${type.fields.map((field) => `${field.name}${field.description ? '*' : ''}`).join(',')}`);
    }
    for (const [fullName, def] of Object.entries(extension.enums)) parts.push(`E ${fullName} ${def.members.join(',')}`);
    for (const [name, registry] of Object.entries(extension.registries)) {
        parts.push(`R ${name} ${Object.keys(registry.members).join(',')}`);
    }
    for (const [name, members] of Object.entries(extension.registryMembers)) {
        parts.push(`M ${name} ${Object.keys(members).join(',')}`);
    }
    return parts.sort().join('|');
};

/**
 * The assembly a class was extracted from, for the classes a code mod contributed.
 *
 * @param fullName the class FullName.
 * @returns the absolute path of the mod assembly declaring it, or undefined for a game class (which
 *          lives in the game's own assemblies) or when no mod schema is merged.
 */
export const modAssemblyOfClass = (fullName: string): string | undefined =>
    isModContributedClass(fullName) ? appliedModExtension?.assemblyOf[fullName] : undefined;

/**
 * Whether a class came from a code mod's assembly rather than the game's.
 *
 * @param fullName the class FullName.
 * @returns true when the currently merged mod schema declares it.
 */
export const isModContributedClass = (fullName: string): boolean => appliedModKeys?.types.has(fullName) === true;

/**
 * Where the code mod that declares a class is published.
 *
 * @param fullName the class FullName.
 * @returns the mod's Steam Workshop page and manifest name, or undefined for a game class or a mod
 *          that is not a subscribed workshop mod (one being developed locally has no page yet).
 */
export const modWorkshopLink = (fullName: string): { url: string; name?: string } | undefined => {
    const assembly = appliedModExtension?.assemblyOf[fullName];
    return assembly ? appliedModExtension?.modLinks[assembly] : undefined;
};

/** A type definition by C# FullName. */
export const typeDef = (fullName: string): SchemaTypeDef | undefined => schema.types[fullName];

/** An enum (its members) by C# FullName. */
export const enumDef = (fullName: string): SchemaEnum | undefined => schema.enums[fullName];

/**
 * The reference target class a plain scalar written for group class `cls` resolves to. A
 * scalar-form class reads a bare value into one member (the schema's `scalarField`, extracted from
 * the engine's deserializer, with the digit-`0` tuple field as fallback). When that member is
 * itself a scalar-form group (a multi-toggle entry's `Toggle`), the chain is followed to the
 * terminal reference.
 *
 * @param cls the group class FullName.
 * @returns the payload's reference target class, or undefined when `cls` reads no scalar or the
 *          payload is not a reference.
 */
export const scalarReferenceTargetOf = (cls: string): string | undefined => {
    for (let depth = 0; depth < 4; depth++) {
        const def = typeDef(cls);
        if (!def?.scalarForm) return undefined;
        const payload = def.scalarField ? fieldOf(cls, def.scalarField) : fieldOf(cls, '0');
        if (payload?.valueType.kind === 'reference') return payload.valueType.target;
        if (payload?.valueType.kind !== 'group') return undefined;
        cls = payload.valueType.ref;
    }
    return undefined;
};

/**
 * The field a plain scalar written for group class `cls` reads into, following a scalar-form chain
 * to the member that really holds the value. Its slot expectations are the ones that apply to the
 * bare value, since that is the member the engine ends up filling.
 *
 * @param cls the group class FullName.
 * @returns the payload field, or undefined when `cls` reads no scalar.
 */
export const scalarPayloadFieldOf = (cls: string): SchemaField | undefined => {
    let payload: SchemaField | undefined;
    for (let depth = 0; depth < 4; depth++) {
        const def = typeDef(cls);
        if (!def?.scalarForm) return payload;
        payload = def.scalarField ? fieldOf(cls, def.scalarField) : fieldOf(cls, '0');
        if (payload?.valueType.kind !== 'group') return payload;
        cls = payload.valueType.ref;
    }
    return payload;
};

/**
 * The name of a runtime component kind, for a message that has to say what the slot wanted.
 *
 * @param kind the kind index carried by a field's `expectedComponent`.
 * @returns the kind's class FullName, or undefined when the bundle knows no such kind.
 */
export const componentKindName = (kind: number): string | undefined => schema.componentKinds?.[kind];

/**
 * Whether the component a rules class builds satisfies a slot's required kind.
 *
 * Three answers, and the third is the important one: a class the bundle has no capability entry for
 * builds no physical component the engine can type, or is not a component class the extraction saw
 * at all (a code mod's own class), and neither can be judged. The check must say nothing there
 * rather than report a component the game accepts.
 *
 * @param rulesClass the FullName of the component's rules class.
 * @param kind the kind index the slot requires.
 * @returns true when it satisfies the kind, false when it does not, undefined when it cannot be judged.
 */
export const componentSatisfiesKind = (rulesClass: string, kind: number): boolean | undefined => {
    const satisfied = schema.componentCapabilities?.[rulesClass];
    return satisfied ? satisfied.includes(kind) : undefined;
};

/** A registry by FullName, or by its short `name`. */
export const registryOf = (fullNameOrName: string): SchemaRegistry | undefined =>
    schema.registries[fullNameOrName] ?? registryByShortName.get(fullNameOrName);

/**
 * The first registry (in schema order) whose members declare a discriminator. The sibling-based
 * registry inference resolves one discriminator against all registries per group, so this answers
 * from the prebuilt discriminator index instead of scanning every registry's member table.
 *
 * @param disc the `Type=` discriminator value.
 * @returns the first declaring registry, or undefined when none declares it.
 */
export const firstRegistryDeclaring = (disc: string): SchemaRegistry | undefined => {
    const candidates = discriminatorIndex.get(disc);
    if (candidates && candidates.length > 0) return schema.registries[candidates[0].registryKey];
    // A known renamed discriminator (a mod written against an older game) still pins its registry
    // through the current name, so sibling-based registry inference keeps working.
    const replacement = deprecatedDiscriminator(disc)?.replacement;
    return replacement ? firstRegistryDeclaring(replacement) : undefined;
};

/** Memo of {@link fieldsOf} per class. The schema is immutable after load, so it never goes stale. */
const fieldsOfCache = new Map<string, SchemaField[]>();

/**
 * The full field set of a class: own fields plus inherited ones, walking `extends`.
 * The most-derived definition of a duplicated field name wins. Memoized per class.
 *
 * @param fullName the class FullName.
 * @returns the class's own and inherited fields.
 */
export const fieldsOf = (fullName: string): SchemaField[] => {
    const cached = fieldsOfCache.get(fullName);
    if (cached) return cached;
    const out: SchemaField[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = fullName;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
        guard.add(cur);
        const t: SchemaTypeDef | undefined = schema.types[cur];
        if (!t) break;
        for (const f of t.fields) {
            if (!seen.has(f.name)) {
                seen.add(f.name);
                out.push(f);
            }
        }
        cur = t.extends;
    }
    fieldsOfCache.set(fullName, out);
    return out;
};

/** Memo of {@link requiredFieldsOf} per class. The schema is immutable after load, so it never goes stale. */
const requiredFieldsCache = new Map<string, SchemaField[]>();

/**
 * The fields of a class the game requires, own and inherited. Memoized per class.
 *
 * @param fullName the class FullName.
 * @returns the class's own and inherited fields that are not optional.
 */
export const requiredFieldsOf = (fullName: string): SchemaField[] => {
    const cached = requiredFieldsCache.get(fullName);
    if (cached) return cached;
    const out = fieldsOf(fullName).filter((field) => !field.optional);
    requiredFieldsCache.set(fullName, out);
    return out;
};

// Per-class lookup index over fieldsOf, keyed by lower-cased name/alias. The game resolves node
// names through a Dictionary with InvariantCultureIgnoreCase, so `maxhealth = 100` selects the
// `MaxHealth` field. The index gives every fieldOf call that same semantics without re-walking
// the inheritance chain per lookup. The schema is immutable after load, so the memo never goes stale.
const fieldIndexCache = new Map<string, Map<string, SchemaField>>();

const fieldIndexOf = (fullName: string): Map<string, SchemaField> => {
    let index = fieldIndexCache.get(fullName);
    if (!index) {
        index = new Map();
        for (const field of fieldsOf(fullName)) {
            const key = field.name.toLowerCase();
            if (!index.has(key)) index.set(key, field);
            for (const alias of field.aliases ?? []) {
                const aliasKey = alias.toLowerCase();
                if (!index.has(aliasKey)) index.set(aliasKey, field);
            }
        }
        fieldIndexCache.set(fullName, index);
    }
    return index;
};

/**
 * A single field on a class, searching the inheritance chain. Matches the field's primary OT name
 * or any of its alternate aliases: the engine accepts a field written under any of its
 * `[Serialize(AlternateAliases=…)]` spellings (e.g. `LeftEdgeEffect` for `LeftAdd`), so all are
 * recognized for validation and completion. The match ignores case, like the game's node lookup.
 */
export const fieldOf = (fullName: string, fieldName: string): SchemaField | undefined =>
    fieldIndexOf(fullName).get(fieldName.toLowerCase());

/**
 * Whether a value type is a Cosmoteer localization key (C# `KeyString`), a slash-path into a
 * language strings file (`NameKey = "Parts/LaserBlasterSmall"`). Drives strings-key completion.
 */
export const isLocalizationKeyType = (valueType: ValueType | undefined): boolean =>
    valueType?.kind === 'string' && valueType.semantic === 'localizationKey';

let localizationKeyFieldNameSet: Set<string> | undefined;

/**
 * The lower-cased names (and aliases) of every field typed as a localization key across the schema
 * (`NameKey`, `DescriptionKey`, `IconNameKey`, …). A cheap pre-filter for the existence validator:
 * only a value assigned to one of these names is worth the per-node schema resolution. Callers must
 * lower-case the written name before membership tests. Computed once and cached.
 */
export const localizationKeyFieldNames = (): ReadonlySet<string> => {
    if (!localizationKeyFieldNameSet) {
        localizationKeyFieldNameSet = new Set();
        for (const type of Object.values(schema.types)) {
            for (const field of type.fields) {
                if (!isLocalizationKeyType(field.valueType)) continue;
                localizationKeyFieldNameSet.add(field.name.toLowerCase());
                for (const alias of field.aliases ?? []) localizationKeyFieldNameSet.add(alias.toLowerCase());
            }
        }
    }
    return localizationKeyFieldNameSet;
};

let declaredFieldNameSet: Set<string> | undefined;

/**
 * The lower-cased names (and aliases) of every field any class in the schema declares. A key spelled
 * like one of these can be read by the game even when its container's class does not resolve, so the
 * unused-constant check treats such a name as a field rather than as a user constant. Callers must
 * lower-case the written name before membership tests. Computed once and cached.
 *
 * @returns the lower-cased set of every declared field name in the schema.
 */
export const declaredFieldNames = (): ReadonlySet<string> => {
    if (!declaredFieldNameSet) {
        declaredFieldNameSet = new Set();
        for (const type of Object.values(schema.types)) {
            for (const field of type.fields) {
                declaredFieldNameSet.add(field.name.toLowerCase());
                for (const alias of field.aliases ?? []) declaredFieldNameSet.add(alias.toLowerCase());
            }
        }
    }
    return declaredFieldNameSet;
};

/** Memo of {@link acceptsShaderConstants} per class, checked for every `_`-prefixed field. */
const acceptsShaderConstantsCache = new Map<string, boolean>();

/**
 * Whether a class deserializes inline shader constants, a material/sprite whose `Shader`'s
 * uniforms are written as sibling keys in the group (`_hotColor = …`, `_z = …`). True when the class
 * (or a base) carries a `ShaderConstantCollection` field. The exact constant names come from the
 * referenced `.shader`, so they cannot be enumerated from the schema. They follow the `_` convention.
 */
export const acceptsShaderConstants = (fullName: string): boolean => {
    const cached = acceptsShaderConstantsCache.get(fullName);
    if (cached !== undefined) return cached;
    const accepts = fieldsOf(fullName).some(
        (f) => f.valueType.kind === 'opaque' && f.valueType.type === 'ShaderConstantCollection'
    );
    acceptsShaderConstantsCache.set(fullName, accepts);
    return accepts;
};

/**
 * Whether `fieldName` is a valid inline shader-constant key on `cls`: the class accepts shader
 * constants and the name follows the engine's `_`-prefixed uniform convention. Used so these
 * open-ended keys are treated as recognized (not unknown) by completion/hover/coverage.
 */
export const isShaderConstantField = (cls: string, fieldName: string): boolean =>
    fieldName.startsWith('_') && acceptsShaderConstants(cls);

/** True if a `Type=` discriminator is declared by more than one registry (resolution needs a hint). */
export const discriminatorIsAmbiguous = (disc: string): boolean => (discriminatorIndex.get(disc)?.length ?? 0) > 1;

/**
 * Whether registry `key`'s base class is, or derives from, the registry named by `hint` (a registry
 * FullName or short name). A slot can be typed as a base registry while the concrete `Type=` it
 * carries is declared only by a derived registry (e.g. `SubSpawners` is `List<SimSpawner>`, but
 * `Type = Nebula` lives in the derived `SimObjectSpawner` registry). Walking the `extends` chain lets
 * the base-typed slot still pin the right derived registry instead of a global collision.
 */
const registryDerivesFrom = (key: string, hint: string): boolean => {
    const hintKey = schema.registries[hint]
        ? hint
        : Object.keys(schema.registries).find((k) => schema.registries[k].name === hint);
    if (!hintKey) return false;
    let cur: string | undefined = key;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
        if (cur === hintKey) return true;
        guard.add(cur);
        cur = schema.types[cur]?.extends;
    }
    return false;
};

/**
 * Resolve the concrete class FullName a `Type=<disc>` discriminator selects.
 * @param disc The `Type=<disc>` discriminator value written in the group.
 * @param registryHint A registry FullName or short name that disambiguates the 15 colliding discriminators.
 * @returns The selected class FullName, or undefined when no registry declares the discriminator.
 */
export const classByDiscriminator = (disc: string, registryHint?: string): string | undefined => {
    const candidates = discriminatorIndex.get(disc);
    if (!candidates || candidates.length === 0) {
        // A known renamed discriminator (a mod written against an older game) resolves through its
        // current name, so hover, completion and validation inside the group keep working while
        // the deprecation hint on the `Type =` line nudges the rename.
        const replacement = deprecatedDiscriminator(disc)?.replacement;
        return replacement ? classByDiscriminator(replacement, registryHint) : undefined;
    }
    if (registryHint && candidates.length > 1) {
        const hinted = candidates.find(
            (c) => c.registryKey === registryHint || schema.registries[c.registryKey]?.name === registryHint
        );
        if (hinted) return hinted.cls;
        // The slot's registry may be a base of the one that actually declares this discriminator.
        const derived = candidates.find((c) => registryDerivesFrom(c.registryKey, registryHint));
        if (derived) return derived.cls;
    }
    return candidates[0].cls;
};

/** A vanilla-shaped sample path for an asset kind, matching the extensions the game ships. */
const assetExamplePath = (assetKind: string): string => {
    switch (assetKind) {
        case 'image':
            return '"sprite.png"';
        case 'sound':
            return '"sounds/sound.wav"';
        case 'shader':
            return '"effect.shader"';
        case 'font':
            return '"font.ttf"';
        default:
            return '"..."';
    }
};

/** The Color class, whose example is curated (byte channels + named colors), see {@link positionalInline}. */
const COLOR_CLASS = 'Halfling.Graphics.Color';

/**
 * The inline positional form of a group class whose digit fields make it list-writable, the form
 * the game's own files use for these types (`Offset = [1.5, 2]`, `VertexColor = [255, 255, 255, 217]`),
 * so it beats a `{ … }` block as an example. Color is curated: its channels are written as 0-255
 * values in the game's files, which its schema float fields cannot express.
 *
 * The digit fields are the list-form indexes of the class's own members (Vector2's `0`/`1` read
 * into `X`/`Y`), so the inline form carries the full value, required named fields included.
 *
 * @param cls the group class FullName.
 * @returns the inline `[ … ]` value, or undefined when the class has fewer than two digit fields.
 */
const positionalInline = (cls: string): string | undefined => {
    if (cls === COLOR_CLASS) return '[255, 255, 255, 255]';
    const digits = fieldsOf(cls)
        .filter((f) => /^\d+$/.test(f.name))
        .sort((a, b) => Number(a.name) - Number(b.name));
    if (digits.length < 2) return undefined;
    return `[${digits.map((f) => examplePlaceholder(f)).join(', ')}]`;
};

/**
 * A `.rules` example for a list of positional-form groups (`Vertices: Vector2[]`): two inline tuple
 * rows (the form the game's own files use, `[0.5, 0]`) followed by a comment naming the tuple's
 * fields and the equally-valid group-form alternative (`{ X = 0, Y = 0 }`).
 *
 * @param name the field name the example assigns.
 * @param cls the list element's group class FullName (a positional class).
 * @param inline the element's inline tuple form, from {@link positionalInline}.
 * @returns the fenced example markdown.
 */
const positionalListExample = (name: string, cls: string, inline: string): string => {
    const lines = [name, '[', `    ${inline}`, `    ${inline}`, ']'];
    if (cls === COLOR_CLASS) {
        lines.push('// each entry is R, G, B, A (0-255), or a group { Rf = 1, Gf = 1, Bf = 1, Af = 1 }');
    } else {
        const named = fieldsOf(cls)
            .filter((f) => !/^\d+$/.test(f.name))
            .sort((a, b) => Number(a.optional) - Number(b.optional))
            .slice(0, 4);
        if (named.length > 0) {
            const body = named.map((f) => `${f.name} = ${examplePlaceholder(f)}`).join(', ');
            lines.push(`// each entry is ${named.map((f) => f.name).join(', ')}, or a group { ${body} }`);
        }
    }
    return exampleFence(lines);
};

/**
 * A placeholder value for one line of a generated example, derived from the field's schema type.
 * A declared default beats every kind-based guess, since it is a value the game actually uses.
 */
const examplePlaceholder = (field: SchemaField): string => {
    const vt = field.valueType;
    if (field.default !== undefined) {
        const quote = typeof field.default === 'string' && (vt.kind === 'string' || vt.kind === 'asset');
        return quote ? `"${field.default}"` : String(field.default);
    }
    switch (vt.kind) {
        case 'bool':
            return 'true';
        case 'int':
        case 'float':
        case 'number':
            return '0';
        case 'string':
            return '""';
        case 'enum':
            return enumDef(vt.ref)?.members[0] ?? '...';
        case 'reference':
            return '&...';
        case 'asset':
            return assetExamplePath(vt.assetKind);
        case 'group':
            // A positional-form class (Vector2, Color) shows its inline list, the way the game's
            // own files write it, instead of an opaque `{ ... }`.
            return positionalInline(vt.ref) ?? '{ ... }';
        case 'polymorphicGroup':
        case 'map':
            return '{ ... }';
        case 'list':
        case 'interpolated':
            return '[ ... ]';
        case 'range':
        case 'tuple':
            return '[0, 1]';
        default:
            return '...';
    }
};

/** One example body line: an elided block attaches directly (`Sprite { ... }`), the idiomatic
 *  form in the game's own files, every concrete value assigns (`Range = 0`, `Size = [0, 0]`). */
const exampleFieldLine = (field: SchemaField): string => {
    const placeholder = examplePlaceholder(field);
    const attach = placeholder === '{ ... }' || placeholder === '[ ... ]';
    return attach && field.default === undefined
        ? `    ${field.name} ${placeholder}`
        : `    ${field.name} = ${placeholder}`;
};

/** Grammatical count for the example's fold-away comments (`3 optional fields`, `1 optional field`). */
const exampleFieldCount = (n: number, phrase: string): string => `${n} ${phrase}${n === 1 ? '' : 's'}`;

/** How many required fields an example body spells out before folding the rest into a comment. */
const EXAMPLE_MAX_REQUIRED = 6;
/** How many optional fields an example body shows when the class requires nothing. */
const EXAMPLE_MAX_OPTIONAL = 3;

/**
 * The indented body lines of a `{ … }` example for class `cls`: every required field with a
 * placeholder value (capped, remainder folded into a comment), and a closing comment counting the
 * optional fields so the block does not read as the complete vocabulary. A class that requires
 * nothing shows a few optional fields instead, so the example still has substance.
 *
 * @param cls the group class FullName.
 * @param typeLine a leading `Type = …` line for a polymorphic slot, already formatted.
 * @returns the body lines, or undefined when the class is unknown or the example would be empty.
 */
const exampleBodyLines = (cls: string, typeLine?: string): string[] | undefined => {
    if (!typeDef(cls)) return undefined;
    // Digit fields are the positional list-form names, not keys anyone writes inside `{ }`.
    const fields = fieldsOf(cls).filter((f) => !/^\d+$/.test(f.name));
    const required = fields.filter((f) => !f.optional);
    const lines: string[] = typeLine ? [typeLine] : [];
    for (const f of required.slice(0, EXAMPLE_MAX_REQUIRED)) lines.push(exampleFieldLine(f));
    if (required.length > EXAMPLE_MAX_REQUIRED) {
        lines.push(`    // + ${exampleFieldCount(required.length - EXAMPLE_MAX_REQUIRED, 'more required field')}`);
    }
    const optionalCount = fields.length - required.length;
    if (required.length === 0) {
        // Prefer optional fields with a declared default: their example line shows a real value.
        const shown = [...fields].sort((a, b) => Number(b.default !== undefined) - Number(a.default !== undefined));
        for (const f of shown.slice(0, EXAMPLE_MAX_OPTIONAL)) lines.push(exampleFieldLine(f));
        const rest = optionalCount - Math.min(optionalCount, EXAMPLE_MAX_OPTIONAL);
        if (rest > 0) lines.push(`    // ... ${exampleFieldCount(rest, 'more optional field')}`);
    } else if (optionalCount > 0) {
        lines.push(`    // ... ${exampleFieldCount(optionalCount, 'optional field')}`);
    }
    return lines.length > 0 ? lines : undefined;
};

/** Wraps example lines in a `rules`-highlighted fenced block. */
const exampleFence = (lines: string[]): string => '```rules\n' + lines.join('\n') + '\n```';

/**
 * A one-line example for a list of scalar values (`TypeCategories = [armor, non_flammable]`),
 * with entries the schema can vouch for: the engine's built-in ids for a reference target, the
 * first enum members, or a kind-derived placeholder, and a trailing comment naming the entries.
 *
 * @param name the field name the example assigns.
 * @param element the list's element value type.
 * @returns the example line, or undefined for element kinds an example would not clarify.
 */
const inlineListExample = (name: string, element: ValueType): string | undefined => {
    if (element.kind === 'reference') {
        // The engine's hardcoded ids are real values a mod can reference; failing those, an
        // honest placeholder plus the comment still says what an entry is.
        const builtin = schema.builtinIds?.[element.target] ?? [];
        const entries = builtin.length > 0 ? [...builtin.slice(0, 2), '...'] : ['...'];
        return `${name} = [${entries.join(', ')}]    // ${element.targetName} ids`;
    }
    if (element.kind === 'enum') {
        const members = enumDef(element.ref)?.members ?? [];
        if (members.length === 0) return undefined;
        return `${name} = [${members.slice(0, 2).join(', ')}]    // ${element.name} values`;
    }
    if (element.kind === 'asset') {
        const synthetic: SchemaField = { name, valueType: element, optional: true };
        return `${name} = [${examplePlaceholder(synthetic)}, ...]`;
    }
    // Numbers, strings, bools: the type label already says everything an example line would.
    return undefined;
};

/** Ids that name a fallback/wildcard rather than a real member; a map example seeded with one of
 *  these (`default = …`) reads as a keyword, so a more specific id is preferred when one exists. */
const GENERIC_KEY_IDS = new Set(['default', 'none', 'any', 'all', 'null', 'unknown']);

/** The first non-sentinel entry of a list of candidate ids, else the first entry, else undefined. */
const firstSpecific = (ids: readonly string[]): string | undefined =>
    ids.find((id) => !GENERIC_KEY_IDS.has(id.toLowerCase())) ?? ids[0];

/** A sample key for a map example: a real member name where the schema knows one (a reference's
 *  built-in id, an enum's first member, preferring a specific id over a `default`-style sentinel),
 *  otherwise the key type's own name as a stand-in token. */
const mapKeySample = (key: ValueType): string => {
    if (key.kind === 'reference') return firstSpecific(schema.builtinIds?.[key.target] ?? []) ?? key.targetName;
    if (key.kind === 'enum') return firstSpecific(enumDef(key.ref)?.members ?? []) ?? key.name;
    return valueTypeLabel(key, true);
};

/** A compact one-line `{ Field = value, … }` form of a group class, for naming a value's group-form
 *  alternative inside a comment. Shows the first concrete field and elides the rest. */
const compactGroupExample = (cls: string): string | undefined => {
    const body = exampleBodyLines(cls);
    if (!body) return undefined;
    const concrete = body.map((l) => l.trim()).filter((l) => !l.startsWith('//'));
    if (concrete.length === 0) return '{ … }';
    return `{ ${concrete[0]}${concrete.length > 1 ? ', …' : ''} }`;
};

/**
 * The alternative written forms a map value accepts beyond its primary entry line, each a `// or …`
 * comment showing the same key. A range value adds the `[from, to]` list form; a dual-form scalar
 * (a `Modifiable<T>`, whether or not wrapped in a range) adds the `{ BaseValue = … }` modifier group.
 * Empty for a plain scalar or group value, which the primary line already shows in full.
 */
const mapValueAltComments = (key: string, value: ValueType): string[] => {
    const base = value.kind === 'range' ? value.element : value;
    const alts: string[] = [];
    if (value.kind === 'range') alts.push(`// or a range: ${key} = [0, 1]`);
    const groupForm =
        base.kind === 'number' || base.kind === 'int' || base.kind === 'float' ? base.groupForm : undefined;
    const group = groupForm ? compactGroupExample(groupForm) : undefined;
    if (group) alts.push(`// or with inline modifiers: ${key} ${group}`);
    return alts;
};

/**
 * A `{ Key = Value }` example for a map-typed field. The primary entry reuses the scalar/group
 * field-line rules (a group value attaches as `Key { … }`, a scalar assigns), sampling a range's
 * element so the entry shows the single scalar form modders write (`explosive = 0`). Every other
 * form the value accepts — the `[from, to]` range, a `{ BaseValue = … }` modifier group — follows as
 * a `// or …` comment, so the example shows all accepted spellings, not just one.
 *
 * @param name the map field's name.
 * @param map the map value type.
 * @returns the fenced example markdown.
 */
const mapExample = (name: string, map: Extract<ValueType, { kind: 'map' }>): string => {
    const key = mapKeySample(map.key);
    const base = map.value.kind === 'range' ? map.value.element : map.value;
    const primary = exampleFieldLine({ name: key, valueType: base, optional: true });
    const lines = [name, '{', `${primary}    // one entry per ${valueTypeLabel(map.key, true)}`];
    for (const alt of mapValueAltComments(key, map.value)) lines.push(`    ${alt}`);
    lines.push('}');
    return exampleFence(lines);
};

/**
 * A small `.rules`-syntax example of a field's structured value form, for hover and completion
 * documentation. A field typed `ISoundEffect` names the type but not the `{ … }` shape the game
 * expects. This renders that shape from the schema: the `Type =` discriminator for a polymorphic
 * slot, the required fields with placeholder values, and a count of what else is accepted. Only
 * fields whose value is a group (directly, as list elements, or as a scalar's group form) get an
 * example; scalar fields are already fully described by their signature line.
 *
 * @param field the schema field to illustrate.
 * @returns the fenced example markdown, or undefined when no structured example applies.
 */
export const fieldExampleMarkdown = (field: SchemaField): string | undefined => {
    const vt = field.valueType;
    // A scalar-primary dual-form field (`Modifiable<T>`): show both accepted shapes.
    if ((vt.kind === 'number' || vt.kind === 'int' || vt.kind === 'float') && vt.groupForm) {
        const body = exampleBodyLines(vt.groupForm);
        if (!body) return undefined;
        const scalar = `${field.name} = ${examplePlaceholder(field)}`;
        return exampleFence([scalar, '// or with inline modifiers:', field.name, '{', ...body, '}']);
    }
    // A single asset path: show the written form, which the type label (`asset (shader)`) alone
    // does not convey, plus the resolution rule the game applies.
    if (vt.kind === 'asset') {
        return exampleFence([`${field.name} = ${assetExamplePath(vt.assetKind)}    // path relative to this file`]);
    }
    // A map is written as a `{ … }` group whose members are `Key = Value`. The signature line names
    // the key/value types but not that shape, so show a single sample entry with a real key where the
    // schema knows one, and a comment saying entries repeat per key.
    if (vt.kind === 'map') return mapExample(field.name, vt);
    const structured = vt.kind === 'list' || vt.kind === 'interpolated' ? vt.element : vt;
    const asList = structured !== vt;
    // A list of scalars (ids, enum members, numbers, paths) is written inline: one example line
    // with real sample values where the schema knows any, and a comment naming what the entries are.
    if (asList && structured.kind !== 'group' && structured.kind !== 'polymorphicGroup') {
        const inline = inlineListExample(field.name, structured);
        return inline ? exampleFence([inline]) : undefined;
    }
    let cls: string | undefined;
    let typeLine: string | undefined;
    if (structured.kind === 'group') {
        // A scalar-form class with a reference payload is normally written as a bare id
        // (`FireTrigger = Turret`), and a valueForm class reads its member's shape, not its own
        // `{ … }`. A block example would mislead for both.
        if (scalarReferenceTargetOf(structured.ref) || typeDef(structured.ref)?.valueForm) return undefined;
        // A list of positional-form groups (`Vertices: Vector2[]`) is written as a list of inline
        // tuples (`[0.5, 0]`), the form the game's own files use, so the block example alone
        // (`[ { X = 0, Y = 0 } ]`) misses the shape a modder actually writes. Lead with the tuple
        // list and name the group-form alternative.
        if (asList) {
            const inline = positionalInline(structured.ref);
            if (inline) return positionalListExample(field.name, structured.ref, inline);
        }
        // A positional-form class leads with its inline form (`VertexColor = [255, 255, 255, 217]`),
        // then names the equally-valid alternatives: the named-field group, and for Color the
        // engine's named colors.
        if (!asList) {
            const inline = positionalInline(structured.ref);
            if (inline) {
                if (structured.ref === COLOR_CLASS) {
                    return exampleFence([
                        `${field.name} = ${inline}    // R, G, B, A`,
                        `// or a named color: ${field.name} = White`,
                        `// or a group: ${field.name} { Rf = 1, Gf = 1, Bf = 1, Af = 1 }`,
                    ]);
                }
                const lines = [`${field.name} = ${inline}`];
                // The named-field group alternative, required fields first (`{ X = 0, Y = 0 }`).
                const named = fieldsOf(structured.ref)
                    .filter((f) => !/^\d+$/.test(f.name))
                    .sort((a, b) => Number(a.optional) - Number(b.optional))
                    .slice(0, 4);
                if (named.length > 0) {
                    const body = named.map((f) => `${f.name} = ${examplePlaceholder(f)}`).join(', ');
                    lines.push(`// or: ${field.name} { ${body} }`);
                }
                return exampleFence(lines);
            }
        }
        cls = structured.ref;
    } else if (structured.kind === 'polymorphicGroup') {
        const registry = schema.registries[structured.ref];
        const [disc, memberCls] = Object.entries(registry?.members ?? {})[0] ?? [];
        if (!registry || !disc) return undefined;
        cls = memberCls;
        const total = Object.keys(registry.members).length;
        typeLine = `    ${registry.typeField} = ${disc}${total > 1 ? `    // one of ${total} types` : ''}`;
    } else {
        return undefined;
    }
    const body = exampleBodyLines(cls, typeLine);
    if (!body) return undefined;
    // A list-typed slot wraps the element block in `[ … ]`, one element shown.
    const lines = asList
        ? [field.name, '[', ...['{', ...body, '}'].map((l) => `    ${l}`), ']']
        : [field.name, '{', ...body, '}'];
    return exampleFence(lines);
};

/**
 * Turn authored `[[Type.FullName.Member]]` cross-references in doc prose into readable Markdown.
 * These crefs are written freely in `docs/fields/*.md` but have no target URL, so the whole `[[…]]`
 * would otherwise render literally in every client's hover. We show the last dotted segment (the
 * member name a modder actually types in the .rules file) as an inline code span.
 * @param prose The raw field description, possibly containing `[[…]]` crefs.
 * @returns The prose with every cref replaced by an inline code span of its final segment.
 */
const renderDocCrefs = (prose: string): string =>
    prose.replace(/\[\[([^\]]+)\]\]/g, (_, ref: string) => {
        const last = ref.split('.').pop()?.trim();
        return last ? `\`${last}\`` : ref;
    });

/**
 * Markdown documenting a single schema field: its value type, whether it's required, its default,
 * and (for enums / references) the legal values or target. Shared by field-name completion
 * documentation and the field hover so they read identically.
 */
export const fieldSignatureMarkdown = (field: SchemaField, owningType?: string): string => {
    const head = `**${field.name}**: \`${valueTypeLabel(field.valueType)}\`${field.optional ? '' : ' — required'}`;
    const extra: string[] = [];
    if (field.default !== undefined) extra.push(`default \`${field.default}\``);
    const vt = field.valueType;
    // Unwrap one collection layer so a `list<enum>` / `range<enum>` field still lists its members.
    const inner = vt.kind === 'list' || vt.kind === 'range' || vt.kind === 'interpolated' ? vt.element : vt;
    if (inner.kind === 'enum') {
        const members = enumDef(inner.ref)?.members ?? [];
        // Cap the inline listing: only ViKey (103 keyboard keys) exceeds it, and a hover-sized
        // sample plus the total serves better than a screen-filling dump.
        const shown = members.slice(0, 24).map((m) => `\`${m}\``).join(', ');
        if (members.length > 0) {
            extra.push(`one of: ${shown}${members.length > 24 ? `, … (${members.length} total)` : ''}`);
        }
    } else if (inner.kind === 'reference') {
        extra.push(`reference → \`${inner.targetName}\``);
    }
    let signature = extra.length > 0 ? `${head}\n\n${extra.join(' · ')}` : head;
    // A member the game deleted in an update (with its migration when known) or declares but never
    // reads: warn right under the signature, so hover and completion tell the truth about dead weight.
    const deprecation = owningType ? deprecatedField(owningType, field.name) : undefined;
    if (deprecation) {
        signature += `\n\n⚠ removed in a newer game version (${deprecation.note})`;
    } else if (field.dead) {
        signature += "\n\n⚠ declared but never read by the game's code";
    }
    // The prose description, when documented, goes below the type signature separated by a rule.
    const described = field.description ? `${signature}\n\n---\n\n${renderDocCrefs(field.description)}` : signature;
    // A structured (group-valued) field additionally shows a generated `{ … }` example, so the
    // type name alone (`ISoundEffect`) never leaves the reader guessing what to write.
    const example = fieldExampleMarkdown(field);
    const body = example ? `${described}\n\n${example}` : described;
    const footer = documentationLink(owningType);
    return footer ? `${body}\n\n${footer}` : body;
};

/**
 * The footer link under a field's signature, pointing at whatever actually documents the field's
 * owning class.
 *
 * For a game class that is the most relevant specialized modding-wiki page (a buff → /Buffs, a part
 * → /Data_fields, …), so a modder can read further from hover or completion. Only a specialized page
 * is linked. The generic /Modding landing page is not, since a link that always points at the same
 * top-level page on every field is noise rather than help.
 *
 * For a class a code mod declares, the wiki documents none of it, but the mod's own Steam Workshop
 * page does, so that is linked instead. A locally-developed mod has no published page and gets no
 * link, the same as any class with nothing worth pointing at.
 *
 * @param owningType the class the hovered field belongs to.
 * @returns the markdown link line, or undefined when nothing documents the class.
 */
const documentationLink = (owningType?: string): string | undefined => {
    if (!owningType) return undefined;
    if (isModContributedClass(owningType)) {
        const mod = modWorkshopLink(owningType);
        if (!mod) return undefined;
        const label = mod.name ? `${mod.name} on the Steam Workshop` : 'This mod on the Steam Workshop';
        return `_[${label} ↗](${mod.url})_`;
    }
    const wiki = wikiUrlForType(owningType);
    return wiki ? `_[Cosmoteer modding wiki ↗](${wiki})_` : undefined;
};

const WIKI = 'https://cosmoteer.wiki.gg/wiki';

/** Memo of {@link typeChain} per class, mirroring {@link fieldsOf}'s. */
const typeChainCache = new Map<string, string[]>();

/** The inheritance chain of FullNames for a class (itself first, then each `extends`). */
const typeChain = (fullName: string): string[] => {
    const cached = typeChainCache.get(fullName);
    if (cached) return cached;
    const out: string[] = [];
    let cur: string | undefined = fullName;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
        guard.add(cur);
        out.push(cur);
        cur = schema.types[cur]?.extends;
    }
    typeChainCache.set(fullName, out);
    return out;
};

/** The inheritance chain of a class, most-derived first (the class itself, then each `extends`). */
export const classAncestry = (fullName: string): string[] => typeChain(fullName);

/**
 * The most-derived class that is an ancestor of (or equal to) every class in `classes`, their nearest
 * common base in the single-inheritance `extends` chain. Used to root a shared inheritance-base node
 * (`BaseCommand`, inherited by commands of several concrete classes) to the one class all its derivers
 * agree on, so the base's fields resolve without over-specializing to any single deriver.
 *
 * @param classes the deriver class FullNames (concrete classes that inherit the base).
 * @returns the nearest common ancestor FullName, or undefined for an empty input or disjoint chains.
 */
export const commonAncestorClass = (classes: readonly string[]): string | undefined => {
    if (classes.length === 0) return undefined;
    let common = classAncestry(classes[0]);
    for (let i = 1; i < classes.length && common.length > 0; i++) {
        const chain = new Set(classAncestry(classes[i]));
        common = common.filter((c) => chain.has(c));
    }
    return common[0];
};

/**
 * The most relevant specialized modding-wiki page for a class, matched against its inheritance chain so
 * a derived part/component/buff still resolves to its family's page. Ordered most-specific first.
 * Returns undefined when no specific page applies: the caller then links nothing rather than the
 * generic /Modding landing page, so a wiki link only appears where it points somewhere useful. Only
 * pages verified to exist on cosmoteer.wiki.gg are linked.
 *
 * A class a code mod contributed links nothing either. Its game ancestry would match a page (a modded
 * component still descends from `PartComponentRules`), but that page documents the game's own content
 * and says nothing about the mod's class or its fields, so the link would promise help it cannot give.
 * A field inside the mod's group that belongs to a plain game class still resolves to that class and
 * keeps its link.
 */
export const wikiUrlForType = (owningType?: string): string | undefined => {
    if (!owningType || isModContributedClass(owningType)) return undefined;
    const chain = typeChain(owningType);
    const has = (needle: string): boolean => chain.some((c) => c.includes(needle));
    // A proxy is also a component, so match it before the component rule.
    if (has('Proxy')) return `${WIKI}/Modding/Proxies`;
    if (has('.Ships.Parts.PartComponentRules')) return `${WIKI}/Modding/Components`;
    if (has('.Ships.Parts.PartRules')) return `${WIKI}/Modding/Data_fields`;
    if (has('.Ships.Buffs.') || has('.Ships.Statuses.')) return `${WIKI}/Modding/Buffs`;
    if (has('.Bullets.')) return `${WIKI}/Modding/Projectile`;
    if (has('Cosmoteer.Resources')) return `${WIKI}/Modding/Resources`;
    if (has('Cosmoteer.Factions')) return `${WIKI}/Modding/Factions`;
    if (has('.Ships.AI')) return `${WIKI}/Modding/AI`;
    return undefined;
};

/**
 * A short human label for a field's value type, for completion `detail` / hover.
 * @param vt The value type to label.
 * @param nested True when the type sits inside a collection label (a `map`/`list`/`range`/`tuple`
 *   element). A standalone reference field reads as `→ TargetName`, but the same arrow nested inside
 *   `map<…>` reads as an artifact, so a nested reference renders as its bare target name instead.
 */
export const valueTypeLabel = (vt: ValueType, nested = false): string => {
    switch (vt.kind) {
        case 'enum':
            return `enum ${vt.name}`;
        case 'reference':
            return nested ? vt.targetName : `→ ${vt.targetName}`;
        case 'group':
        case 'polymorphicGroup':
            return vt.name;
        case 'list':
            return `${valueTypeLabel(vt.element, true)}[]`;
        case 'range':
            return `range<${valueTypeLabel(vt.element, true)}>`;
        case 'map':
            return `map<${valueTypeLabel(vt.key, true)}, ${valueTypeLabel(vt.value, true)}>`;
        case 'tuple':
            return `[${vt.elements.map((e) => valueTypeLabel(e, true)).join(', ')}]`;
        case 'asset':
            return `asset (${vt.assetKind})`;
        case 'bool':
        case 'int':
        case 'float':
        case 'string':
        case 'number': {
            const base = vt.kind === 'number' && vt.unit ? `number (${vt.unit})` : vt.kind;
            // A dual-form scalar (a Modifiable<T>, DirectionalCrewSpeeds) also accepts a group whose
            // fields come from the groupForm class; surface that in the label so `Arc: number` does
            // not read as scalar-only when `Arc { BaseValue = … }` is equally valid.
            const groupForm = vt.groupForm ? (schema.types[vt.groupForm]?.name ?? vt.groupForm) : undefined;
            return groupForm ? `${base} | ${groupForm} group` : base;
        }
        case 'opaque':
            // A custom-deserialized engine type (e.g. a particle channel `ParticleDataID`). It has no
            // modelled fields, but its C# type name is meaningful to show, far more useful than the
            // bare word `opaque`. A generic type parameter (`reason === 'typeParam'`) has no real name.
            return vt.reason === 'typeParam' ? 'any' : vt.type;
        default:
            return vt.kind;
    }
};

export { schema };
