import { describe, expect, it } from 'vitest';
import { applyFieldDocs } from '../../../src/document/schema/field-docs';
import { SchemaBundle } from '../../../src/document/schema/schema.types';
import { fieldOf, fieldSignatureMarkdown, wikiUrlForType } from '../../../src/document/schema/schema';

const bundleWith = (fields: { name: string; aliases?: string[] }[]): SchemaBundle => ({
    meta: {},
    registries: {},
    enums: {},
    unresolved: { types: {}, generics: {} },
    types: {
        'X.Y': {
            name: 'Y',
            fields: fields.map((f) => ({
                name: f.name,
                aliases: f.aliases,
                valueType: { kind: 'string' as const },
                optional: true,
            })),
        },
    },
});

describe('applyFieldDocs', () => {
    it('attaches a description to a field by its name', () => {
        const bundle = bundleWith([{ name: 'Foo' }]);
        applyFieldDocs(bundle, { 'X.Y': { Foo: 'the foo value' } });
        expect(bundle.types['X.Y'].fields[0].description).toBe('the foo value');
    });

    it('matches a description to a field by an alias spelling', () => {
        const bundle = bundleWith([{ name: 'LeftAdd', aliases: ['LeftEdgeEffect'] }]);
        applyFieldDocs(bundle, { 'X.Y': { LeftEdgeEffect: 'documented under the alias' } });
        expect(bundle.types['X.Y'].fields[0].description).toBe('documented under the alias');
    });

    it('ignores docs for types and fields that do not exist', () => {
        const bundle = bundleWith([{ name: 'Foo' }]);
        expect(() => applyFieldDocs(bundle, { 'No.Such': { Bar: 'x' }, 'X.Y': { Nope: 'y' } })).not.toThrow();
        expect(bundle.types['X.Y'].fields[0].description).toBeUndefined();
    });
});

describe('fieldSignatureMarkdown with a description', () => {
    it('renders the prose below the type signature, separated by a rule', () => {
        const md = fieldSignatureMarkdown(
            {
                name: 'Foo',
                valueType: { kind: 'string' },
                optional: true,
                description: 'the foo value',
            },
            // A class with a specialized wiki page, so the footer link is present after the prose.
            'Cosmoteer.Ships.Buffs.BuffType'
        );
        expect(md).toContain('**Foo**');
        expect(md).toContain('\n\n---\n\n');
        expect(md).toContain('the foo value');
        // the wiki footer follows the prose
        expect(md).toContain('cosmoteer.wiki.gg');
    });

    it('shows the wiki footer for a specialized class even when a field has no description', () => {
        const md = fieldSignatureMarkdown(
            { name: 'Foo', valueType: { kind: 'string' }, optional: true },
            'Cosmoteer.Ships.Parts.PartComponentRules'
        );
        // no description rule, but the specialized wiki link is present
        expect(md).not.toContain('---');
        expect(md).toContain('cosmoteer.wiki.gg');
    });

    it('omits the wiki footer when the class maps to no specialized page', () => {
        // No owning class (and an unmapped class) → the generic /Modding page is not linked.
        expect(fieldSignatureMarkdown({ name: 'Foo', valueType: { kind: 'string' }, optional: true })).not.toContain(
            'cosmoteer.wiki.gg'
        );
        expect(
            fieldSignatureMarkdown({ name: 'Foo', valueType: { kind: 'string' }, optional: true }, 'Halfling.Gui.WindowBox`1')
        ).not.toContain('cosmoteer.wiki.gg');
    });
});

describe('wikiUrlForType', () => {
    it('maps a class to its most specific modding-wiki page via the inheritance chain', () => {
        expect(wikiUrlForType('Cosmoteer.Ships.Buffs.BuffType')).toContain('/Modding/Buffs');
        expect(wikiUrlForType('Cosmoteer.Ships.Parts.PartRules')).toContain('/Modding/Data_fields');
        expect(wikiUrlForType('Cosmoteer.Ships.Parts.PartComponentRules')).toContain('/Modding/Components');
        expect(wikiUrlForType('Cosmoteer.Bullets.BulletRules')).toContain('/Modding/Projectile');
        expect(wikiUrlForType('Cosmoteer.Factions.FactionRules')).toContain('/Modding/Factions');
    });

    it('returns undefined for an unmapped or missing class (no generic-page fallback)', () => {
        expect(wikiUrlForType('Halfling.Gui.WindowBox`1')).toBeUndefined();
        expect(wikiUrlForType(undefined)).toBeUndefined();
    });

    it('renders the resolved page in the field footer', () => {
        const md = fieldSignatureMarkdown(
            { name: 'Foo', valueType: { kind: 'string' }, optional: true },
            'Cosmoteer.Ships.Buffs.BuffType'
        );
        expect(md).toContain('/Modding/Buffs');
    });
});

describe('bundled field-docs.json seed', () => {
    it('documents Cosmoteer.Data.Rules.IndicatorMaterial from the shipped docs', () => {
        expect(fieldOf('Cosmoteer.Data.Rules', 'IndicatorMaterial')?.description).toBe(
            'The material used to render indicator sprites.'
        );
    });
});
