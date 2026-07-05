import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { fieldOf } from '../../../src/document/schema/schema';
import { groupDiscriminator } from '../../../src/document/schema/schema-context';
import { isGroupNode } from '../../../src/core/ast/ast';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';

const token = CancellationToken.None;
const parse = (src: string, uri = 'file:///t.rules') => parser(lexer(src), uri).value;

// The game resolves node names through a case-insensitive dictionary (OTGroupNode keys its
// children with InvariantCultureIgnoreCase, verified in HalflingCore.dll), so `maxhealth = 100`
// selects the `MaxHealth` field in game and the schema layer must recognize it the same way.
describe('schema field lookup ignores case like the game', () => {
    it('fieldOf matches a field name in any casing', () => {
        const canonical = fieldOf('Cosmoteer.Ships.Parts.PartRules', 'MaxHealth');
        expect(canonical).toBeDefined();
        expect(fieldOf('Cosmoteer.Ships.Parts.PartRules', 'maxhealth')).toBe(canonical);
        expect(fieldOf('Cosmoteer.Ships.Parts.PartRules', 'MAXHEALTH')).toBe(canonical);
        expect(fieldOf('Cosmoteer.Ships.Parts.PartRules', 'Bogus')).toBeUndefined();
    });

    it('fieldOf matches an alternate alias in any casing', () => {
        // EdgeRules aliases: LeftEdgeEffect is an AlternateAlias of LeftAdd (schema-integrity relies
        // on the alias set, so pick the pair via the canonical name and probe its alias case-folded).
        const byAlias = fieldOf('Cosmoteer.Simulation.HeightMap.EdgeRules', 'leftedgeeffect');
        const byName = fieldOf('Cosmoteer.Simulation.HeightMap.EdgeRules', 'LeftAdd');
        if (byName) expect(byAlias).toBe(byName);
    });

    it('groupDiscriminator reads a lowercase `type =` field', () => {
        const doc = parse('X\n{\n\ttype = MultiToggle\n}');
        const group = doc.elements.find(isGroupNode)!;
        expect(groupDiscriminator(group)).toBe('MultiToggle');
    });

    it('does not flag a valid enum on a field written in a different case', async () => {
        // `mode` must resolve to the MultiToggle component's `Mode` enum field for its value to
        // validate; a case-sensitive lookup would silently skip (or mis-flag) it.
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tX\n\t\t{\n\t\t\ttype = MultiToggle\n\t\t\tmode = All\n\t\t}\n\t}\n}';
        expect(await validateSchema(parse(src), token)).toHaveLength(0);
    });

    it('still flags an invalid enum value on a case-folded field name', async () => {
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tX\n\t\t{\n\t\t\ttype = MultiToggle\n\t\t\tmode = Nonsense\n\t\t}\n\t}\n}';
        const errors = await validateSchema(parse(src), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Nonsense');
    });
});
