import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ENTITY_FIELDS, entityDeclarationsOf, isEntityClass } from '../../../src/document/schema/entity-schema';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';

const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;

const only = (name: string) => {
    const c = ENTITY_FIELDS.get(name);
    expect(c).toHaveLength(1);
    return c![0];
};

describe('entity-schema: derived ENTITY_FIELDS', () => {
    it('maps the ID-keyed list entities', () => {
        expect(only('Factions')).toEqual({ elementClass: 'Cosmoteer.Factions.FactionRules', identityKey: 'ID' });
        expect(only('Doors').identityKey).toBe('ID');
        expect(only('PartStats').identityKey).toBe('ID');
    });

    it('maps the GUI *ID-keyed entities to their own SerialID field', () => {
        expect(only('PartColors')).toEqual({ elementClass: 'Cosmoteer.Game.PartColorGuiRules', identityKey: 'ColorID' });
        expect(only('PartToggles').identityKey).toBe('ToggleID');
        expect(only('PartTargeters').identityKey).toBe('TargeterID');
        expect(only('Choices').identityKey).toBe('ChoiceID'); // nested under PartToggles
    });

    it('keeps BOTH candidates for an ambiguous field name (Techs → two element classes)', () => {
        const techs = ENTITY_FIELDS.get('Techs');
        expect(techs?.length).toBe(2);
        const classes = techs!.map((c) => c.elementClass).sort();
        expect(classes).toContain('Cosmoteer.Modes.Career.TechTree.TechRules');
        expect(classes).toContain('Cosmoteer.Modes.Pvp.BuildBattle.BuildBattleTechRules');
    });

    it('isEntityClass recognizes a tracked element class', () => {
        expect(isEntityClass('Cosmoteer.Factions.FactionRules')).toBe(true);
        expect(isEntityClass('Cosmoteer.Ships.Parts.PartComponentRules')).toBe(false);
    });
});

describe('entity-schema: entityDeclarationsOf', () => {
    it('harvests ID-keyed list elements', () => {
        const doc = parse('Factions\n[\n\t{ ID = monolith }\n\t{ ID = cabal }\n]');
        const decls = [...entityDeclarationsOf(doc)];
        expect(decls.map((d) => d.id).sort()).toEqual(['cabal', 'monolith']);
        expect(decls.every((d) => d.elementClass === 'Cosmoteer.Factions.FactionRules')).toBe(true);
    });

    it('harvests *ID-keyed and nested entities', () => {
        const doc = parse('PartToggles\n[\n\t{\n\t\tToggleID = "on_off"\n\t\tChoices\n\t\t[\n\t\t\t{ ChoiceID = "on_off_on" }\n\t\t]\n\t}\n]');
        const decls = [...entityDeclarationsOf(doc)];
        const ids = decls.map((d) => d.id).sort();
        expect(ids).toContain('on_off');
        expect(ids).toContain('on_off_on'); // nested Choices
    });

    it('ignores a list whose name is not an entity field', () => {
        const doc = parse('Whatever\n[\n\t{ ID = x }\n]');
        expect([...entityDeclarationsOf(doc)]).toHaveLength(0);
    });
});

describe('entity-schema: group-name-keyed (map) entities via alias rooting', () => {
    const BUFFS_URI = 'file:///game/buffs/buffs.rules';
    const buffsDoc = () => parser(lexer('Engine {}\nFactory {}\nOverclock {}'), BUFFS_URI).value;

    it('harvests members of a whole-file map-aliased collection as entities', async () => {
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(
            parser(lexer('Buffs = &<buffs/buffs.rules>'), 'file:///game/cosmoteer.rules').value,
            async (ref) => (ref.includes('buffs') ? buffsDoc() : undefined)
        );
        const decls = [...entityDeclarationsOf(buffsDoc())];
        expect(decls.map((d) => d.id).sort()).toEqual(['Engine', 'Factory', 'Overclock']);
        expect(decls.every((d) => d.elementClass === 'Cosmoteer.Ships.Buffs.BuffType')).toBe(true);
    });

    it('harvests nothing when the file is not an aliased collection', () => {
        aliasRootIndex.invalidate();
        expect([...entityDeclarationsOf(buffsDoc())]).toHaveLength(0);
    });
});
