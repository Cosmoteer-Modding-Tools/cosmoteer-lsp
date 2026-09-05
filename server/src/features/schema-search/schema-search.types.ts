/**
 * The entries of the schema search table: what one searchable thing stands for and every key the
 * ranking reads off it. The table is built in `schema-search.index.ts` and queried in
 * `schema-search.ts`.
 */

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
    /** The entry's own prose: a field's description, or a class or registry summary. */
    readonly prose?: string;
    readonly proseLower?: string;
}
