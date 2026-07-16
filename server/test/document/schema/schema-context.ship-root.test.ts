import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isGroupNode } from '../../../src/core/ast/ast';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';

/** Resolve the class of the file's first top-level group, as opened from `path`. */
const rootGroupClass = (src: string, path: string): string | undefined => {
    const doc = parser(lexer(src), `file:///c%3A/game/Data/${path}`).value;
    const group = doc.elements.find(isGroupNode);
    return group && resolveGroupClass(group);
};

describe('ship folder group rooting', () => {
    // A ship file is a single named group whose name is the ship's own (`Asteroid`, `Terran`, …), so no
    // fixed-identifier root rule can anchor it. The folder does. Rooted as ShipRules, its fields resolve
    // for completion and validation, and the `&<include>`s inside it (ExternalWalls, particle defs) root
    // in turn.
    it('roots a named ship group under ships/ as ShipRules', () => {
        const src = `Asteroid : <../base_ship.rules>
{
	ID = cosmoteer.asteroid
	OtherIDs = [Asteroid, Asteroids]
	NameKey = "ShipClasses/Asteroid"
	IsAsteroid = true
	ExternalWalls = &<asteroid_walls/external_walls.rules>
}`;
        expect(rootGroupClass(src, 'ships/asteroid/asteroid.rules')).toBe('Cosmoteer.Ships.ShipRules');
    });

    // The same folder holds part, wall and sprite files. A part group anchors as PartRules by its fixed
    // `Part` identifier (which wins over the folder rule), never as a ship.
    it('still roots a Part group under ships/ as PartRules, not ShipRules', () => {
        const src = `Part : <../base_part.rules>/Part
{
	ID = cosmoteer.rock_1x1
	Size = [1, 1]
	Mass = 1
}`;
        expect(rootGroupClass(src, 'ships/asteroid/rock_1x1.rules')).toBe('Cosmoteer.Ships.Parts.PartRules');
    });

    // The field-coverage guard rejects a group under ships/ whose members are not a ship's, so a stray
    // non-ship group is left unrooted rather than mis-typed as a ShipRules.
    it('does not root a non-ship group under ships/', () => {
        const src = `Sprites
{
	NotAShipField = 1
	AnotherOddField = 2
	ThirdOddField = 3
}`;
        expect(rootGroupClass(src, 'ships/asteroid/sprites.rules')).toBeUndefined();
    });

    // The folder rule is scoped: the same ship-shaped group outside ships/ does not root, so the rule
    // can't leak onto unrelated files that happen to share a class-like field set.
    it('does not root a ship-shaped group outside the ships folders', () => {
        const src = `Asteroid : <../base_ship.rules>
{
	ID = cosmoteer.asteroid
	NameKey = "ShipClasses/Asteroid"
	IsAsteroid = true
}`;
        expect(rootGroupClass(src, 'doodads/asteroid.rules')).toBeUndefined();
    });
});
