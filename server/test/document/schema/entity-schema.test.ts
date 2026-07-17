import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    BUILTIN_SHIP_CLASS,
    ENTITY_FIELDS,
    LABEL_DECLARATION_FIELDS,
    REGISTRY_LIST_FIELDS,
    entityDeclarationsOf,
    isEntityClass,
} from '../../../src/document/schema/entity-schema';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';

const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;

// ENTITY_FIELDS is keyed lower-case, mirroring the game's case-insensitive node lookup.
const only = (name: string) => {
    const c = ENTITY_FIELDS.get(name.toLowerCase());
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
        const techs = ENTITY_FIELDS.get('techs');
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

    it('harvests entities from a list written in a different case (game lookup ignores case)', () => {
        const doc = parse('factions\n[\n\t{ id = monolith }\n]');
        const decls = [...entityDeclarationsOf(doc)];
        expect(decls.map((d) => d.id)).toEqual(['monolith']);
    });
});

// A built-in ship writes no `ID`: the game composes it as `IDPrefix + " " + (ID ?? ship-name-of-File)`,
// so the id has to be derived the same way or the class ends up with no declarations at all.
describe('entity-schema: built-in ship ids are derived, not written', () => {
    const shipIds = (src: string) =>
        [...entityDeclarationsOf(parse(src))]
            .filter((d) => d.elementClass === BUILTIN_SHIP_CLASS)
            .map((d) => d.id);

    it('derives the id from the File name when no ID is written', () => {
        expect(shipIds('Ships\n[\n\t{ File="Courier.ship.png"; Tier=3 }\n]')).toEqual(['Courier']);
    });

    it('prefixes every ship with the IDPrefix the file root declares (inherited via `:~`)', () => {
        const src = 'Faction = fringe\nIDPrefix = "Fringe"\n\nShips\n[\n\t:~{ File="Small Laser Platform.ship.png"; Tier=2 }\n]';
        expect(shipIds(src)).toEqual(['Fringe Small Laser Platform']);
    });

    it('prefixes a written ID too, and keeps OtherIDs aliases unprefixed (the game does not prefix them)', () => {
        const src = 'IDPrefix = "Fringe"\nShips\n[\n\t:~{ File="a.ship.png"; ID = "Real Name"; OtherIDs=["Legacy"] }\n]';
        expect(shipIds(src)).toEqual(['Fringe Real Name', 'Legacy']);
    });

    it('sanitizes the derived name the way the game does (format characters are dropped, letters kept)', () => {
        // U+200B (zero-width space, category Cf) is dropped; the accented letter survives.
        expect(shipIds('Ships\n[\n\t{ File="Fá​elán.ship.png" }\n]')).toEqual(['Fáelán']);
    });

    it('ignores an element whose File is not a ship file', () => {
        expect(shipIds('Ships\n[\n\t{ File="notaship.png" }\n]')).toEqual([]);
    });
});

// A registry class declares its instances by naming them in its own lists (`LowerBuckets [ … ]`):
// there is no `ID` anywhere, so the ordinary harvest saw nothing and every bucket reference in the
// game went unchecked.
describe('entity-schema: self-referential registry lists', () => {
    const BUCKETS = 'Cosmoteer.Simulation.MediaEffects.MediaEffectBucketsRules';

    it('maps every field of a pure registry class, and nothing else', () => {
        expect(REGISTRY_LIST_FIELDS.get('lowerbuckets')).toBe(BUCKETS);
        expect(REGISTRY_LIST_FIELDS.get('upperbuckets')).toBe(BUCKETS);
        expect(new Set(REGISTRY_LIST_FIELDS.values())).toEqual(new Set([BUCKETS]));
    });

    it('harvests each named id as a declaration', () => {
        const decls = [...entityDeclarationsOf(parse('LowerBuckets\n[\n\tBulletLower1,\n\tBulletHit,\n]'))];
        expect(decls.map((d) => d.id)).toEqual(['BulletLower1', 'BulletHit']);
        expect(decls.every((d) => d.elementClass === BUCKETS)).toBe(true);
    });

    // The guard that keeps this rule honest: a class with an `ID` declares through it, so its own
    // self-referential lists name OTHER instances. Harvesting those would let a typo declare itself.
    it('does NOT treat a consumer list on an ID-carrying class as a declaration', () => {
        expect(REGISTRY_LIST_FIELDS.has('prerequisites')).toBe(false); // TechRules.Prerequisites
        expect(REGISTRY_LIST_FIELDS.has('upgradedfrom')).toBe(false); // TechRules.UpgradedFrom
        expect(REGISTRY_LIST_FIELDS.has('flipwhenloadingids')).toBe(false); // PartRules.FlipWhenLoadingIDs
    });
});

// A free-form label field is itself the declaration (`TargetCategory = laser`), the shape the `DamageType`
// case already had. The consumer lists that reference these labels outnumber the declaration sites
// ~35:1 in vanilla, which is where the checking value is.
describe('entity-schema: label-declared entities', () => {
    it('admits exactly the two label classes, and no GUI id field', () => {
        expect(LABEL_DECLARATION_FIELDS.get('targetcategory')).toBe('Cosmoteer.Bullets.Targeting.BulletTargetableRules');
        expect(LABEL_DECLARATION_FIELDS.get('signal')).toBe('Cosmoteer.Ships.Blueprints.BlueprintNetworkOverlaySignalRules');
        // The guard that matters: a part references a toggle by writing `ToggleID = "on_off"` in a
        // UIToggle component, the same field name the toggle declares itself with. Admitting it would
        // make every reference declare itself and the toggle check would never fire again.
        expect(LABEL_DECLARATION_FIELDS.has('toggleid')).toBe(false);
        expect(LABEL_DECLARATION_FIELDS.has('colorid')).toBe(false);
        expect(LABEL_DECLARATION_FIELDS.size).toBe(2);
    });

    it('harvests a written label as a declaration', () => {
        const doc = parse('Components\n[\n\tTargetable\n\t{\n\t\tType = BulletTargetable\n\t\tTargetCategory = "laser"\n\t}\n]');
        const decls = [...entityDeclarationsOf(doc)].filter((d) => d.elementClass.includes('BulletTargetable'));
        expect(decls.map((d) => d.id)).toEqual(['laser']);
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

// The game root pulls its ships in as a LIST of file aliases (`Ships [ &<terran.rules>/Terran ]`),
// which the forward alias walk used to skip entirely (it followed only `Field = &<file>` assignments).
// The declaring file therefore never rooted, and its `ID` was never harvested.
describe('entity-schema: instances reached through a list of file aliases', () => {
    const SHIP_URI = 'file:///game/ships/terran/terran.rules';
    const DOOR_URI = 'file:///game/ships/terran/door/door.rules';
    // A ship group carrying its id and aliases, whose own `Doors [ &<door.rules> ]` pulls in a door file.
    const shipDoc = () =>
        parser(
            lexer('Terran\n{\n\tID = cosmoteer.terran\n\tOtherIDs = [Terran, PlayerShips]\n\tDoors [ &<door/door.rules> ]\n}'),
            SHIP_URI
        ).value;
    const doorDoc = () => parser(lexer('ID = cosmoteer.door\nOtherIDs = [door]'), DOOR_URI).value;

    const buildRoot = async () => {
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(
            parser(lexer('Ships\n[\n\t&<ships/terran/terran.rules>/Terran\n]'), 'file:///game/cosmoteer.rules').value,
            async (ref) => (ref.includes('door') ? (doorDoc() as never) : ref.includes('terran') ? (shipDoc() as never) : undefined)
        );
    };

    it('harvests the aliased ship group\'s ID and its OtherIDs aliases', async () => {
        await buildRoot();
        const decls = [...entityDeclarationsOf(shipDoc())].filter((d) => d.elementClass === 'Cosmoteer.Ships.ShipRules');
        expect(decls.map((d) => d.id)).toEqual(['cosmoteer.terran', 'Terran', 'PlayerShips']);
        expect(decls.filter((d) => d.alias).map((d) => d.id)).toEqual(['Terran', 'PlayerShips']);
    });

    it('roots the file the ship itself aliases in, so its own id harvests too (one hop deeper)', async () => {
        await buildRoot();
        const decls = [...entityDeclarationsOf(doorDoc())].filter((d) => d.elementClass === 'Cosmoteer.Ships.Doors.DoorRules');
        expect(decls.map((d) => d.id)).toEqual(['cosmoteer.door', 'door']);
    });
});
