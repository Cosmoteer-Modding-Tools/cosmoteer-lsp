/**
 * The flat searchable table behind the schema search: one entry per thing a modder can look up by
 * name, which is every class, every declared field, every enum with its members, and every `Type=`
 * registry. Built once on the first query and rebuilt only when a code mod's merged schema surface
 * changes, keyed on {@link modSchemaSignature} so nothing here has to be told about the merge.
 *
 * It deliberately lives under `features/` rather than next to `schema.ts`: `server/src/document` is
 * a cache-build-id seed directory (see esbuild.cache-id.mjs), so a table placed there would pull
 * this whole module into the hashed closure and discard every user's on-disk caches on every future
 * edit to it. Nothing in the search feeds a cache, so it stays outside.
 *
 * The whole table is roughly 7,000 entries against the shipped bundle and costs a few milliseconds
 * to build, so a query is a linear scan over precomputed lower-cased keys rather than an inverted
 * index that would have to be invalidated alongside the schema.
 */
import { deprecatedField } from '../../document/schema/deprecations';
import { isModContributedClass, modSchemaSignature, schema, valueTypeLabel } from '../../document/schema/schema';
import { SchemaField } from '../../document/schema/schema.types';

/** What a search entry stands for, which decides how it is labelled, ranked, and documented. */
export type SchemaSearchEntryKind = 'type' | 'field' | 'enum' | 'enumMember' | 'registry';

/**
 * One searchable thing plus every key the ranking reads. The lower-cased keys are precomputed
 * because a query scans all of them: lowering 970,000 characters of prose per keystroke is what a
 * naive implementation spends its whole budget on.
 */
export interface SchemaSearchEntry {
    /** Stable id the detail and insert requests address the entry by. */
    readonly id: string;
    readonly kind: SchemaSearchEntryKind;
    /** What a modder writes: a discriminator for a derived type, the OT name for a field. */
    readonly label: string;
    /** The second spelling that also finds the entry (a derived type's C# name, a field alias). */
    readonly aliasLabel?: string;
    /** The owner shown next to the label: a class short name for a field, the FullName for a type. */
    readonly ownerLabel: string;
    /** The class, enum or registry FullName the entry belongs to, used for ancestry and lookups. */
    readonly ownerFullName: string;
    /** The declaring schema field, for a field entry. */
    readonly field?: SchemaField;
    /** The enum member's own name, for an enum-member entry. */
    readonly memberName?: string;
    /** The one-line kind/type description shown under the label. */
    readonly typeLabel: string;
    /** True when the game declares the field but never reads it. */
    readonly dead?: boolean;
    /** True when a game update removed the field. */
    readonly deprecated?: boolean;
    /** True when a code mod's assembly contributed the owning class. */
    readonly modContributed?: boolean;
    readonly nameLower: string;
    readonly aliasLower?: string;
    /** Byte offsets of the label's camel-hump, underscore and digit segment starts. */
    readonly humps: readonly number[];
    /** The lower-cased initials of those segments, so `mhf` finds `MaxHealthFraction`. */
    readonly acr: string;
    readonly ownerLower: string;
    readonly typeLower: string;
    readonly proseLower?: string;
}

/** Positional list-form names (Vector2's `0`/`1`), never a key anyone types inside a group. */
const isPositionalName = (name: string): boolean => /^\d+$/.test(name);

/**
 * The start offsets of a name's segments: each camel hump, each run after an underscore or dash, and
 * each digit run. `MaxHealthFraction` yields 0, 3, 9 and `Scale2In` yields 0, 5, 6, which is what
 * makes both a mid-name prefix match and the acronym rule possible.
 *
 * @param name the label to segment.
 * @returns the segment start offsets, ascending.
 */
const segmentStarts = (name: string): number[] => {
    const starts: number[] = [];
    let expectStart = true;
    for (let index = 0; index < name.length; index++) {
        const char = name[index];
        if (char === '_' || char === '-' || char === '.' || char === ' ') {
            expectStart = true;
            continue;
        }
        const prev = index > 0 ? name[index - 1] : '';
        const next = index + 1 < name.length ? name[index + 1] : '';
        const isUpper = char >= 'A' && char <= 'Z';
        const isDigit = char >= '0' && char <= '9';
        const prevUpper = prev >= 'A' && prev <= 'Z';
        const prevLower = prev >= 'a' && prev <= 'z';
        const prevDigit = prev >= '0' && prev <= '9';
        const nextLower = next >= 'a' && next <= 'z';
        const camelStart = isUpper && (prevLower || prevDigit || (prevUpper && nextLower));
        const digitStart = isDigit !== prevDigit && prev !== '';
        if (expectStart || camelStart || digitStart) {
            starts.push(index);
            expectStart = false;
        }
    }
    return starts;
};

/** The lower-cased initials of a name's segments, the key the acronym tier matches against. */
const acronymOf = (name: string, starts: readonly number[]): string => {
    let out = '';
    for (const start of starts) out += name[start].toLowerCase();
    return out;
};

/** The fields a search entry's keys are built from, before the derived keys are attached. */
interface EntrySeed {
    id: string;
    kind: SchemaSearchEntryKind;
    label: string;
    aliasLabel?: string;
    ownerLabel: string;
    ownerFullName: string;
    field?: SchemaField;
    memberName?: string;
    typeLabel: string;
    /** Extra text the owner tier matches, beyond the owner label (a namespace, a discriminator). */
    ownerSearch: string;
    prose?: string;
    dead?: boolean;
    deprecated?: boolean;
    modContributed?: boolean;
}

/** Attaches the precomputed lower-cased and segment keys to a seed. */
const toEntry = (seed: EntrySeed): SchemaSearchEntry => {
    const humps = segmentStarts(seed.label);
    return {
        id: seed.id,
        kind: seed.kind,
        label: seed.label,
        aliasLabel: seed.aliasLabel,
        ownerLabel: seed.ownerLabel,
        ownerFullName: seed.ownerFullName,
        field: seed.field,
        memberName: seed.memberName,
        typeLabel: seed.typeLabel,
        dead: seed.dead,
        deprecated: seed.deprecated,
        modContributed: seed.modContributed,
        nameLower: seed.label.toLowerCase(),
        aliasLower: seed.aliasLabel?.toLowerCase(),
        humps,
        acr: acronymOf(seed.label, humps),
        ownerLower: seed.ownerSearch.toLowerCase(),
        typeLower: seed.typeLabel.toLowerCase(),
        proseLower: seed.prose?.toLowerCase(),
    };
};

/**
 * The entry id of a field, which is the only id the insert command ever needs.
 *
 * @param ownerFullName the FullName of the class that declares the field.
 * @param fieldName the field's OT name.
 * @returns the stable entry id.
 */
export const fieldEntryId = (ownerFullName: string, fieldName: string): string =>
    `f:${ownerFullName}:${fieldName}`;

/** The last dotted segment of a C# FullName, the short name a modder recognizes. */
const shortNameOf = (fullName: string): string => fullName.split('.').pop() ?? fullName;

/**
 * Builds the whole table in one pass over the merged bundle.
 *
 * A derived type is labelled by its `Type=` discriminator rather than by its C# short name, because
 * that is the word a modder writes (`Type = Beam`, not `BeamEffectRules`). The short name is kept as
 * the alias, so both spellings find it. 405 of the 408 derived types in the shipped bundle have a
 * discriminator that differs from their class name, so labelling by class name would make the most
 * obvious query in the whole feature miss.
 *
 * @returns every searchable entry, in bundle order.
 */
const buildEntries = (): SchemaSearchEntry[] => {
    const seeds: EntrySeed[] = [];
    for (const [fullName, type] of Object.entries(schema.types)) {
        const modContributed = isModContributedClass(fullName) || undefined;
        // A registry base class gets one entry, the registry's, which documents its subtypes and its
        // own fields together. Two rows with the same label would only make the picker ambiguous.
        if (!schema.registries[fullName]) {
            const details = [type.abstract ? 'abstract' : undefined, type.registry ? shortNameOf(type.registry) : undefined];
            seeds.push({
                id: `t:${fullName}`,
                kind: 'type',
                label: type.derivedType ?? type.name,
                aliasLabel: type.derivedType && type.derivedType !== type.name ? type.name : undefined,
                ownerLabel: fullName,
                ownerFullName: fullName,
                typeLabel: ['type', ...details.filter((part): part is string => !!part)].join(' · '),
                ownerSearch: `${type.derivedType ?? ''} ${fullName}`,
                modContributed,
            });
        }
        for (const field of type.fields) {
            if (isPositionalName(field.name)) continue;
            seeds.push({
                id: fieldEntryId(fullName, field.name),
                kind: 'field',
                label: field.name,
                aliasLabel: field.aliases?.[0],
                ownerLabel: type.derivedType ?? type.name,
                ownerFullName: fullName,
                field,
                typeLabel: `${valueTypeLabel(field.valueType)}${field.optional ? '' : ' · required'}`,
                ownerSearch: `${type.derivedType ?? ''} ${fullName}`,
                prose: field.description,
                dead: field.dead || undefined,
                deprecated: deprecatedField(fullName, field.name) ? true : undefined,
                modContributed,
            });
        }
    }
    for (const [fullName, def] of Object.entries(schema.enums)) {
        seeds.push({
            id: `e:${fullName}`,
            kind: 'enum',
            label: def.name,
            ownerLabel: fullName,
            ownerFullName: fullName,
            typeLabel: `enum · ${def.members.length} values`,
            ownerSearch: fullName,
        });
        for (const member of def.members) {
            seeds.push({
                id: `m:${fullName}:${member}`,
                kind: 'enumMember',
                label: member,
                ownerLabel: def.name,
                ownerFullName: fullName,
                memberName: member,
                typeLabel: `enum ${def.name}`,
                ownerSearch: fullName,
            });
        }
    }
    for (const [fullName, registry] of Object.entries(schema.registries)) {
        const subtypes = Object.keys(registry.members).length;
        seeds.push({
            id: `r:${fullName}`,
            kind: 'registry',
            label: registry.name,
            ownerLabel: fullName,
            ownerFullName: fullName,
            typeLabel: `${registry.typeField}= registry · ${subtypes} subtypes`,
            ownerSearch: fullName,
            modContributed: isModContributedClass(fullName) || undefined,
        });
    }
    return seeds.map(toEntry);
};

/** The built table, and the mod-schema signature it was built under. */
let entries: SchemaSearchEntry[] | undefined;
let entriesById: Map<string, SchemaSearchEntry> | undefined;
let builtSignature: string | undefined;

/** Rebuilds the table when a code mod's merged surface has changed since the last build. */
const ensureEntries = (): void => {
    const signature = modSchemaSignature();
    if (entries && entriesById && builtSignature === signature) return;
    entries = buildEntries();
    entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    builtSignature = signature;
};

/**
 * Every searchable entry over the schema as it stands right now, building the table on first use.
 *
 * @returns the entry table, stable between mod-schema merges.
 */
export const schemaSearchEntries = (): readonly SchemaSearchEntry[] => {
    ensureEntries();
    return entries as SchemaSearchEntry[];
};

/**
 * One entry by the id a search hit carried.
 *
 * @param id the entry id from a previous search result.
 * @returns the entry, or undefined when the schema no longer declares it.
 */
export const schemaSearchEntryById = (id: string): SchemaSearchEntry | undefined => {
    ensureEntries();
    return entriesById?.get(id);
};
