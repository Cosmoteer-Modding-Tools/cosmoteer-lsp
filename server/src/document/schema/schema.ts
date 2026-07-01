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

/** A registry by FullName, or by its short `name`. */
export const registryOf = (fullNameOrName: string): SchemaRegistry | undefined =>
    schema.registries[fullNameOrName] ??
    Object.values(schema.registries).find((r) => r.name === fullNameOrName);

/**
 * The full field set of a class: own fields plus inherited ones, walking `extends`.
 * The most-derived definition of a duplicated field name wins.
 */
export const fieldsOf = (fullName: string): SchemaField[] => {
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
    return out;
};

/**
 * A single field on a class, searching the inheritance chain. Matches the field's primary OT name
 * or any of its alternate aliases — the engine accepts a field written under any of its
 * `[Serialize(AlternateAliases=…)]` spellings (e.g. `LeftEdgeEffect` for `LeftAdd`), so all are
 * recognized for validation and completion.
 */
export const fieldOf = (fullName: string, fieldName: string): SchemaField | undefined =>
    fieldsOf(fullName).find((f) => f.name === fieldName || f.aliases?.includes(fieldName));

/**
 * Whether a value type is a Cosmoteer localization key (C# `KeyString`) — a slash-path into a
 * language strings file (`NameKey = "Parts/LaserBlasterSmall"`). Drives strings-key completion.
 */
export const isLocalizationKeyType = (valueType: ValueType | undefined): boolean =>
    valueType?.kind === 'string' && valueType.semantic === 'localizationKey';

let localizationKeyFieldNameSet: Set<string> | undefined;

/**
 * The names (and aliases) of every field typed as a localization key across the schema (`NameKey`,
 * `DescriptionKey`, `IconNameKey`, …). A cheap pre-filter for the existence validator: only a value
 * assigned to one of these names is worth the per-node schema resolution. Computed once and cached.
 */
export const localizationKeyFieldNames = (): ReadonlySet<string> => {
    if (!localizationKeyFieldNameSet) {
        localizationKeyFieldNameSet = new Set();
        for (const type of Object.values(schema.types)) {
            for (const field of type.fields) {
                if (!isLocalizationKeyType(field.valueType)) continue;
                localizationKeyFieldNameSet.add(field.name);
                for (const alias of field.aliases ?? []) localizationKeyFieldNameSet.add(alias);
            }
        }
    }
    return localizationKeyFieldNameSet;
};

/**
 * Whether a class deserializes inline **shader constants** — a material/sprite whose `Shader`'s
 * uniforms are written as sibling keys in the group (`_hotColor = …`, `_z = …`). True when the class
 * (or a base) carries a `ShaderConstantCollection` field. The exact constant names come from the
 * referenced `.shader`, so they cannot be enumerated from the schema. They follow the `_` convention.
 */
export const acceptsShaderConstants = (fullName: string): boolean =>
    fieldsOf(fullName).some((f) => f.valueType.kind === 'opaque' && f.valueType.type === 'ShaderConstantCollection');

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
    // /Buffs, a part → /Data_fields, …), so a modder can read further from hover or completion. The
    // wiki is the place for guides and worked examples; these field docs stay field-scoped.
    return `${body}\n\n_[Cosmoteer modding wiki ↗](${wikiUrlForType(owningType)})_`;
};

const WIKI = 'https://cosmoteer.wiki.gg/wiki';
/** The general modding wiki, linked when a field's class maps to no more specific page. */
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

/**
 * The most relevant modding-wiki page for a class, matched against its inheritance chain so a derived
 * part/component/buff still resolves to its family's page. Ordered most-specific first; falls back to
 * the general modding page. Only pages verified to exist on cosmoteer.wiki.gg are linked.
 */
export const wikiUrlForType = (owningType?: string): string => {
    if (!owningType) return MODDING_WIKI_URL;
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
    return MODDING_WIKI_URL;
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
        case 'number':
            return vt.unit ? `number (${vt.unit})` : 'number';
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
