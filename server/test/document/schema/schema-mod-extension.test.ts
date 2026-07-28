import { afterEach, describe, expect, it } from 'vitest';
import {
    classByDiscriminator,
    extendSchemaWithMods,
    fieldOf,
    fieldsOf,
    fieldSignatureMarkdown,
    isModContributedClass,
    modAssemblyOfClass,
    modWorkshopLink,
    registryOf,
    typeDef,
    wikiUrlForType,
} from '../../../src/document/schema/schema';
import { ModSchemaExtension } from '../../../src/features/mod-schema/extract';

// The one write seam on the schema: a code mod's extracted types are merged in and taken back out
// again. The read side memoizes heavily (discriminator index, per-class field lists, field name
// index), so the risk is a stale memo serving the previous state, and the contract is that a mod may
// only ever ADD, so a broken or hostile assembly cannot turn valid vanilla content into diagnostics.

/** A game registry and one of its members, used as the thing a mod must not be able to overwrite. */
const COMPONENT_REGISTRY = 'Cosmoteer.Ships.Parts.PartComponentRules';
const VANILLA_COMPONENT = 'Cosmoteer.Ships.Statuses.StatusValueRegulatorRules';

const MOD_CLASS = 'TestMod.Modules.WidgetControllerRules';

/** An extension shaped exactly like a real extraction of a one-class code mod. */
const extension = (): ModSchemaExtension => ({
    types: {
        [MOD_CLASS]: {
            name: 'WidgetControllerRules',
            namespace: 'TestMod.Modules',
            extends: 'Cosmoteer.Ships.Parts.PartComponentRules',
            derivedType: 'WidgetController',
            registry: COMPONENT_REGISTRY,
            purelyReflective: true,
            fields: [{ name: 'WidgetCount', valueType: { kind: 'int' }, optional: true, default: 3 }],
        },
    },
    enums: { 'TestMod.Modules.WidgetKind': { name: 'WidgetKind', members: ['Small', 'Large'] } },
    registries: {},
    registryMembers: { [COMPONENT_REGISTRY]: { WidgetController: MOD_CLASS } },
    assemblyOf: { [MOD_CLASS]: 'C:/mods/TestMod.dll' },
    memberNames: { [MOD_CLASS]: { WidgetCount: 'WidgetCount' } },
    modLinks: {
        'C:/mods/TestMod.dll': {
            url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=123456',
            name: 'Widget Tender',
        },
    },
});

afterEach(() => extendSchemaWithMods(undefined));

describe('extendSchemaWithMods', () => {
    it('resolves the mod discriminator, its class and its fields once merged', () => {
        expect(classByDiscriminator('WidgetController')).toBeUndefined();
        extendSchemaWithMods(extension());
        expect(classByDiscriminator('WidgetController')).toBe(MOD_CLASS);
        expect(typeDef(MOD_CLASS)?.name).toBe('WidgetControllerRules');
        expect(fieldOf(MOD_CLASS, 'WidgetCount')?.default).toBe(3);
    });

    it('inherits the game base class fields through the mod class', () => {
        extendSchemaWithMods(extension());
        const names = fieldsOf(MOD_CLASS).map((field) => field.name);
        const baseNames = fieldsOf(COMPONENT_REGISTRY).map((field) => field.name);
        expect(baseNames.length).toBeGreaterThan(0);
        for (const name of baseNames) expect(names).toContain(name);
    });

    it('takes everything back out again, leaving the game schema untouched', () => {
        const before = fieldsOf(VANILLA_COMPONENT).length;
        extendSchemaWithMods(extension());
        extendSchemaWithMods(undefined);
        expect(classByDiscriminator('WidgetController')).toBeUndefined();
        expect(typeDef(MOD_CLASS)).toBeUndefined();
        expect(fieldsOf(VANILLA_COMPONENT).length).toBe(before);
    });

    it('never lets a mod redefine a game type or repoint a game discriminator', () => {
        const vanillaFields = fieldsOf(VANILLA_COMPONENT).length;
        const hijack = extension();
        hijack.types[VANILLA_COMPONENT] = { name: 'Hijacked', namespace: 'TestMod', fields: [] };
        const existing = Object.entries(registryOf(COMPONENT_REGISTRY)?.members ?? {})[0];
        expect(existing).toBeDefined();
        hijack.registryMembers[COMPONENT_REGISTRY][existing[0]] = MOD_CLASS;
        extendSchemaWithMods(hijack);
        expect(typeDef(VANILLA_COMPONENT)?.name).not.toBe('Hijacked');
        expect(fieldsOf(VANILLA_COMPONENT).length).toBe(vanillaFields);
        expect(classByDiscriminator(existing[0])).toBe(existing[1]);
        // The refused entry must not be treated as the mod's on the way back out either, or
        // unmerging would delete a game type the merge never touched.
        expect(isModContributedClass(VANILLA_COMPONENT)).toBe(false);
        extendSchemaWithMods(undefined);
        expect(typeDef(VANILLA_COMPONENT)?.name).not.toBe('Hijacked');
        expect(fieldsOf(VANILLA_COMPONENT).length).toBe(vanillaFields);
        expect(classByDiscriminator(existing[0])).toBe(existing[1]);
    });

    it('reports where a mod class came from, and only for a mod class', () => {
        extendSchemaWithMods(extension());
        expect(modAssemblyOfClass(MOD_CLASS)).toBe('C:/mods/TestMod.dll');
        expect(modAssemblyOfClass(VANILLA_COMPONENT)).toBeUndefined();
        expect(isModContributedClass(MOD_CLASS)).toBe(true);
        expect(isModContributedClass(VANILLA_COMPONENT)).toBe(false);
    });

    it('links no wiki page for a mod class, while its game base still links one', () => {
        // The mod class descends from PartComponentRules, so without the mod-aware gate its ancestry
        // would match the Components page, which documents nothing about this class.
        expect(wikiUrlForType(COMPONENT_REGISTRY)).toContain('/Modding/Components');
        extendSchemaWithMods(extension());
        expect(wikiUrlForType(MOD_CLASS)).toBeUndefined();
        expect(wikiUrlForType(COMPONENT_REGISTRY)).toContain('/Modding/Components');
        expect(wikiUrlForType(VANILLA_COMPONENT)).toContain('cosmoteer.wiki.gg');
    });

    it("footers a mod class's field with the mod's workshop page instead of the wiki", () => {
        extendSchemaWithMods(extension());
        const field = fieldOf(MOD_CLASS, 'WidgetCount')!;
        const markdown = fieldSignatureMarkdown(field, MOD_CLASS);
        expect(markdown).toContain('[Widget Tender on the Steam Workshop ↗]');
        expect(markdown).toContain('https://steamcommunity.com/sharedfiles/filedetails/?id=123456');
        expect(markdown).not.toContain('cosmoteer.wiki.gg');
        expect(modWorkshopLink(MOD_CLASS)?.name).toBe('Widget Tender');
        expect(modWorkshopLink(VANILLA_COMPONENT)).toBeUndefined();
    });

    it('footers a game class the way it always did', () => {
        extendSchemaWithMods(extension());
        const field = fieldsOf(VANILLA_COMPONENT)[0];
        expect(fieldSignatureMarkdown(field, VANILLA_COMPONENT)).toContain('cosmoteer.wiki.gg');
    });

    it('leaves a locally-developed mod without a footer link, having no page to point at', () => {
        const local = extension();
        local.modLinks = {};
        extendSchemaWithMods(local);
        const markdown = fieldSignatureMarkdown(fieldOf(MOD_CLASS, 'WidgetCount')!, MOD_CLASS);
        expect(markdown).not.toContain('Steam Workshop');
        expect(markdown).not.toContain('cosmoteer.wiki.gg');
    });
});
