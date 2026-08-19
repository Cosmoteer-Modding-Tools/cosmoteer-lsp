import { afterEach, describe, expect, it } from 'vitest';
import { extendSchemaWithMods, schema } from '../../../src/document/schema/schema';
import { ModSchemaExtension } from '../../../src/features/mod-schema/extract';
import {
    SchemaSearchEntry,
    fieldEntryId,
    schemaSearchEntries,
    schemaSearchEntryById,
} from '../../../src/features/schema-search/schema-search.index';

const isPositional = (name: string): boolean => /^\d+$/.test(name);

const entriesOfKind = (kind: SchemaSearchEntry['kind']): SchemaSearchEntry[] =>
    schemaSearchEntries().filter((entry) => entry.kind === kind);

/** A code mod's surface: one new class with one documented field, plus a discriminator for it. */
const modExtension = (): ModSchemaExtension => ({
    types: {
        'TestMod.Rules.GravityWellRules': {
            name: 'GravityWellRules',
            namespace: 'TestMod.Rules',
            derivedType: 'GravityWell',
            registry: 'Cosmoteer.Ships.Parts.PartComponentRules',
            fields: [
                {
                    name: 'PullStrength',
                    valueType: { kind: 'float' },
                    optional: false,
                    description: 'How hard the well pulls on nearby ships.',
                },
            ],
        },
    },
    enums: {},
    registries: {},
    registryMembers: { 'Cosmoteer.Ships.Parts.PartComponentRules': { GravityWell: 'TestMod.Rules.GravityWellRules' } },
    assemblyOf: { 'TestMod.Rules.GravityWellRules': 'C:/mods/testmod.dll' },
    memberNames: {},
    modLinks: {},
});

// The table is the only thing standing between a query and the bundle, so what it does and does not
// contain is the feature's ground truth. Counts are derived from the bundle rather than pinned, so a
// schemagen regen after a game update changes them without failing the suite.
describe('schemaSearchEntries', () => {
    afterEach(() => {
        extendSchemaWithMods(undefined);
    });

    it('indexes every declared non-positional field exactly once', () => {
        const expected: string[] = [];
        for (const [fullName, type] of Object.entries(schema.types)) {
            for (const field of type.fields) {
                if (!isPositional(field.name)) expected.push(fieldEntryId(fullName, field.name));
            }
        }
        const actual = entriesOfKind('field').map((entry) => entry.id);
        expect(actual.length).toBe(expected.length);
        expect(new Set(actual).size).toBe(actual.length);
        expect(new Set(actual)).toEqual(new Set(expected));
    });

    it('leaves the positional list-form names out', () => {
        // Vector2's `0`/`1` are the names the deserializer reads from `[7.2, 7.2]`, never keys anyone
        // types inside a group, so offering them would be noise in every query that hits a digit.
        expect(schemaSearchEntries().filter((entry) => isPositional(entry.label))).toEqual([]);
        const positional = Object.values(schema.types).flatMap((type) =>
            type.fields.filter((field) => isPositional(field.name))
        );
        expect(positional.length).toBeGreaterThan(0);
    });

    it('labels a registry member by its discriminator and keeps the class name as the alias', () => {
        const byOwner = new Map(entriesOfKind('type').map((entry) => [entry.ownerFullName, entry]));
        let checked = 0;
        for (const [fullName, type] of Object.entries(schema.types)) {
            if (!type.derivedType) continue;
            const entry = byOwner.get(fullName);
            if (!entry) continue; // a registry base is documented by its registry entry instead
            expect(entry.label).toBe(type.derivedType);
            expect(entry.aliasLabel).toBe(type.derivedType === type.name ? undefined : type.name);
            checked++;
        }
        expect(checked).toBeGreaterThan(300);
    });

    it('indexes every enum member under its own enum', () => {
        const members = entriesOfKind('enumMember');
        const expected = Object.entries(schema.enums).flatMap(([fullName, def]) =>
            def.members.map((member) => `${fullName}:${member}`)
        );
        expect(members.length).toBe(expected.length);
        for (const entry of members) {
            expect(schema.enums[entry.ownerFullName]?.members).toContain(entry.memberName);
            expect(entry.ownerLabel).toBe(schema.enums[entry.ownerFullName]?.name);
        }
    });

    it('gives every registry one entry, and none to its base class as a plain type', () => {
        const registries = entriesOfKind('registry');
        expect(registries.length).toBe(Object.keys(schema.registries).length);
        const typeOwners = new Set(entriesOfKind('type').map((entry) => entry.ownerFullName));
        for (const fullName of Object.keys(schema.registries)) expect(typeOwners.has(fullName)).toBe(false);
    });

    it('carries the prose of every documented field as a lower-cased search key', () => {
        let documented = 0;
        for (const entry of entriesOfKind('field')) {
            expect(!!entry.proseLower).toBe(!!entry.field?.description);
            if (entry.field?.description) {
                expect(entry.proseLower).toBe(entry.field.description.toLowerCase());
                documented++;
            }
        }
        // Every field schemagen extracted is documented today (5623 of them). The remainder are the
        // hand-authored overlay's synthetic members, which carry no `docs/fields/` prose. Nearly the
        // whole surface being searchable is what makes a prose query worth running at all.
        expect(documented / entriesOfKind('field').length).toBeGreaterThan(0.95);
    });

    it('round-trips every entry id', () => {
        for (const entry of schemaSearchEntries()) expect(schemaSearchEntryById(entry.id)).toBe(entry);
        expect(schemaSearchEntryById('f:Nothing.Here:AtAll')).toBeUndefined();
    });

    it('reuses the built table until the merged mod schema changes', () => {
        expect(schemaSearchEntries()).toBe(schemaSearchEntries());
    });

    it('rebuilds when a code mod is merged, and again when it is dropped', () => {
        const before = schemaSearchEntries();
        const modFieldId = fieldEntryId('TestMod.Rules.GravityWellRules', 'PullStrength');
        expect(schemaSearchEntryById(modFieldId)).toBeUndefined();

        extendSchemaWithMods(modExtension());
        const merged = schemaSearchEntries();
        expect(merged).not.toBe(before);
        const field = schemaSearchEntryById(modFieldId);
        expect(field?.modContributed).toBe(true);
        expect(field?.ownerLabel).toBe('GravityWell');
        const type = schemaSearchEntryById('t:TestMod.Rules.GravityWellRules');
        expect(type?.label).toBe('GravityWell');
        expect(type?.aliasLabel).toBe('GravityWellRules');
        expect(type?.modContributed).toBe(true);

        extendSchemaWithMods(undefined);
        expect(schemaSearchEntries()).not.toBe(merged);
        expect(schemaSearchEntryById(modFieldId)).toBeUndefined();
    });
});
