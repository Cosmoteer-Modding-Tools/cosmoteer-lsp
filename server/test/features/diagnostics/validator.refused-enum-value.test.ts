import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateRefusedEnumValues } from '../../../src/features/diagnostics/validator.refused-enum-value';
import { acceptedMembersAt } from '../../../src/document/schema/refused-enum-values';
import { isGroupNode } from '../../../src/core/ast/ast';
import { workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;

const findings = async (text: string, path: string): Promise<string[]> =>
    (await validateRefusedEnumValues(parser(lexer(text), path).value, token)).map((error) => error.message);

const PART_PATH = workspaceFile('parts', 'weapon_part.rules');
const SHOT_PATH = workspaceFile('shots', 'test_shot.rules');

/**
 * A part carrying one weapon component of the given kind.
 *
 * @param type the component's `Type` discriminator.
 * @param body the component's members.
 * @returns the part file text.
 */
const partWith = (type: string, body: string[]): string =>
    ['Part', '{', '\tID = test.weapon', '\tComponents', '\t{', '\t\tGun', '\t\t{', `\t\t\tType = ${type}`, ...body.map((line) => '\t\t\t' + line), '\t\t}', '\t}', '}', ''].join('\n');

// The schema types each of these fields by its enum, so every member of it passes the schema check.
// The class doing the reading handles fewer, and says so by throwing.
describe('enum members the reading class refuses', () => {
    it('says nothing about the member a fixed weapon does read', async () => {
        expect(await findings(partWith('FixedWeapon', ['AutoTarget', '{', '\tTargetType = ShipParts', '}']), PART_PATH)).toEqual([]);
    });

    it('flags a fixed weapon auto-targeting anything else', async () => {
        expect(await findings(partWith('FixedWeapon', ['AutoTarget', '{', '\tTargetType = Bullets', '}']), PART_PATH)).toEqual([
            "A fixed weapon reads only ShipParts here. The game refuses to load the data tree when it finds 'Bullets'.",
        ]);
    });

    it('leaves a turret alone, which handles every member', async () => {
        expect(
            await findings(partWith('TurretWeapon', ['AutoTargets', '[', '\t{ TargetType = Bullets }', ']']), PART_PATH)
        ).toEqual([]);
    });

    it('flags a target search priority the update loop has no arm for', async () => {
        const text = ['Bullet', '{', '\tComponents', '\t{', '\t\tSearch', '\t\t{', '\t\t\tType = TargetSearch', '\t\t\tTargetTypesByPriority = [ShipParts, Salvage]', '\t\t}', '\t}', '}', ''].join('\n');
        expect(await findings(text, SHOT_PATH)).toEqual([
            "A bullet's target search handles only ShipParts, ShipCenters, Bullets, Crew. The game throws once the search reaches 'Salvage'.",
        ]);
    });

    it('leaves a reference alone, since what it names is not in this text', async () => {
        expect(await findings(partWith('FixedWeapon', ['AutoTarget', '{', '\tTargetType = &~/TYPE', '}']), PART_PATH)).toEqual([]);
    });

    // The popup reads the same table, so a member the game refuses is never offered in the first
    // place. Walking up one container is what ties the nested block to the class that reads it.
    it('answers the popup with the members the reading class takes', async () => {
        const text = partWith('FixedWeapon', ['AutoTarget', '{', '	TargetType = ShipParts', '}']);
        const document = parser(lexer(text), PART_PATH).value;
        const findGroup = (node: { elements?: unknown[] }, name: string): unknown => {
            for (const child of (node.elements ?? []) as { identifier?: { name: string } }[]) {
                if (child.identifier?.name === name) return child;
                const found = findGroup(child as { elements?: unknown[] }, name);
                if (found) return found;
            }
            return undefined;
        };
        const autoTarget = findGroup(document as unknown as { elements?: unknown[] }, 'AutoTarget');
        expect(autoTarget && isGroupNode(autoTarget as never)).toBe(true);
        expect(acceptedMembersAt(autoTarget as never, 'TargetType')).toEqual(['ShipParts']);
    });

    it('leaves a field no row covers to its whole enum', async () => {
        const text = partWith('TurretWeapon', ['AutoTargets', '[', '	{ TargetType = Bullets }', ']']);
        const document = parser(lexer(text), PART_PATH).value;
        expect(acceptedMembersAt(document.elements[0] as never, 'SomeOtherField')).toBeUndefined();
    });
});
