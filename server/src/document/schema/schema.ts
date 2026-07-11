/**
 * Loader + query helpers over {@link SchemaBundle}. This is the read side of the schema seam:
 * features ask "what fields does class X have?", "what does enum E contain?", "which concrete
 * class does discriminator `Type=Y` select?" without knowing how the bundle was produced.
 */
import bundle from './cosmoteer.schema.json';
import { SchemaBundle, SchemaEnum, SchemaField, SchemaRegistry, SchemaTypeDef, ValueType } from './schema.types';
import { applySchemaOverlay } from './schema-overlay';
import { applyFieldDocs } from './field-docs';

// Merge hand-authored corrections for custom-deserialized types schemagen can't reflect (e.g. the
// dual-form `Texture` group), then attach community-maintained prose descriptions. Both additive —
// see schema-overlay.ts and field-docs.ts.
const schema: SchemaBundle = applyFieldDocs(applySchemaOverlay(bundle));

/** discriminator value -> the registry/class candidates that declare it (15 values collide across registries). */
const discriminatorIndex = new Map<string, Array<{ registryKey: string; cls: string }>>();
for (const [registryKey, registry] of Object.entries(schema.registries)) {
    for (const [disc, cls] of Object.entries(registry.members)) {
        const list = discriminatorIndex.get(disc) ?? [];
        list.push({ registryKey, cls });
        discriminatorIndex.set(disc, list);
    }
}

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

/** Short registry `name` → registry, so a name lookup is not a scan over all registries. */
const registryByShortName = new Map<string, SchemaRegistry>();
for (const registry of Object.values(schema.registries)) {
    if (!registryByShortName.has(registry.name)) registryByShortName.set(registry.name, registry);
}

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
    return candidates && candidates.length > 0 ? schema.registries[candidates[0].registryKey] : undefined;
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
 * or any of its alternate aliases — the engine accepts a field written under any of its
 * `[Serialize(AlternateAliases=…)]` spellings (e.g. `LeftEdgeEffect` for `LeftAdd`), so all are
 * recognized for validation and completion. The match ignores case, like the game's node lookup.
 */
export const fieldOf = (fullName: string, fieldName: string): SchemaField | undefined =>
    fieldIndexOf(fullName).get(fieldName.toLowerCase());

/**
 * Whether a value type is a Cosmoteer localization key (C# `KeyString`) — a slash-path into a
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
    if (!candidates || candidates.length === 0) return undefined;
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

/**
 * Markdown documenting a single schema field — its value type, whether it's required, its default,
 * and (for enums / references) the legal values or target. Shared by field-name completion
 * documentation and the field hover so they read identically.
 */
export const fieldSignatureMarkdown = (field: SchemaField, owningType?: string): string => {
    const head = `**${field.name}**: \`${valueTypeLabel(field.valueType)}\`${field.optional ? '' : ' — required'}`;
    const extra: string[] = [];
    if (field.default !== undefined) extra.push(`default \`${field.default}\``);
    const vt = field.valueType;
    if (vt.kind === 'enum') {
        const members = enumDef(vt.ref)?.members ?? [];
        if (members.length > 0) extra.push(`one of: ${members.map((m) => `\`${m}\``).join(', ')}`);
    } else if (vt.kind === 'reference') {
        extra.push(`reference → \`${vt.targetName}\``);
    }
    const signature = extra.length > 0 ? `${head}\n\n${extra.join(' · ')}` : head;
    // The prose description, when documented, goes below the type signature separated by a rule.
    const body = field.description ? `${signature}\n\n---\n\n${field.description}` : signature;
    // A footer link to the most relevant modding-wiki page for the field's owning class (a buff →
    // /Buffs, a part → /Data_fields, …), so a modder can read further from hover or completion. Only a
    // SPECIALIZED page is linked — the generic /Modding landing page is not, since a link that always
    // points at the same top-level page on every field is noise rather than help.
    const wiki = wikiUrlForType(owningType);
    return wiki ? `${body}\n\n_[Cosmoteer modding wiki ↗](${wiki})_` : body;
};

const WIKI = 'https://cosmoteer.wiki.gg/wiki';
/** The general modding-wiki landing page. Kept for reference, but deliberately NOT linked from hovers
 *  (see {@link wikiUrlForType}) — only class-specific pages are worth a footer link. */
export const MODDING_WIKI_URL = `${WIKI}/Modding`;

/** The inheritance chain of FullNames for a class (itself first, then each `extends`). */
const typeChain = (fullName: string): string[] => {
    const out: string[] = [];
    let cur: string | undefined = fullName;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
        guard.add(cur);
        out.push(cur);
        cur = schema.types[cur]?.extends;
    }
    return out;
};

/** The inheritance chain of a class, most-derived first (the class itself, then each `extends`). */
export const classAncestry = (fullName: string): string[] => typeChain(fullName);

/**
 * The most-derived class that is an ancestor of (or equal to) every class in `classes` — their nearest
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
 * The most relevant SPECIALIZED modding-wiki page for a class, matched against its inheritance chain so
 * a derived part/component/buff still resolves to its family's page. Ordered most-specific first.
 * Returns undefined when no specific page applies — the caller then links nothing rather than the
 * generic /Modding landing page, so a wiki link only appears where it points somewhere useful. Only
 * pages verified to exist on cosmoteer.wiki.gg are linked.
 */
export const wikiUrlForType = (owningType?: string): string | undefined => {
    if (!owningType) return undefined;
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

/** A short human label for a field's value type, for completion `detail` / hover. */
export const valueTypeLabel = (vt: ValueType): string => {
    switch (vt.kind) {
        case 'enum':
            return `enum ${vt.name}`;
        case 'reference':
            return `→ ${vt.targetName}`;
        case 'group':
        case 'polymorphicGroup':
            return vt.name;
        case 'list':
            return `${valueTypeLabel(vt.element)}[]`;
        case 'range':
            return `range<${valueTypeLabel(vt.element)}>`;
        case 'map':
            return `map<${valueTypeLabel(vt.key)}, ${valueTypeLabel(vt.value)}>`;
        case 'tuple':
            return `[${vt.elements.map(valueTypeLabel).join(', ')}]`;
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
            // modelled fields, but its C# type name is meaningful to show — far more useful than the
            // bare word `opaque`. A generic type parameter (`reason === 'typeParam'`) has no real name.
            return vt.reason === 'typeParam' ? 'any' : vt.type;
        default:
            return vt.kind;
    }
};

export { schema };
