import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { documentRootClass } from '../../../src/document/schema/document-root';

const rootOf = (src: string, name: string) =>
    documentRootClass(parser(lexer(src), `file:///c%3A/game/Data/ai/${name}`).value);

describe('AI file document rooting', () => {
    // A real AI behaviour file is a whole-file ShipAIRules, so its top-level fields and the module
    // `Type=` discriminators resolve against the schema (completion + validation) with no dedicated code.
    it('roots a real AI file as ShipAIRules', () => {
        const src = `NameKey = "AI/Normal"
UpdateInterval = [.25, .75]
StrategyModules
[
	{ Type = AreaPatrol }
	{ Type = AggroEnemies }
]
TargetingModules
[
	{ Type = ValueTargeter }
]`;
        expect(rootOf(src, 'ai_normal.rules')).toBe('Cosmoteer.Ships.AI.ShipAIRules');
    });

    it('does not root the ai_common fragment (shared module defs, no StrategyModules)', () => {
        const src = `CommsModulesDefault
[
	&~/DialogueModule
]
DialogueModule
{
	Type = "Dialogue"
}`;
        expect(rootOf(src, 'ai_common.rules')).toBeUndefined();
    });

    it('does not root the ai.rules index (name → ref map, no StrategyModules)', () => {
        const src = `Easy = &<ai_easy.rules>
Normal = &<ai_normal.rules>
Hard = &<ai_hard.rules>`;
        expect(rootOf(src, 'ai.rules')).toBeUndefined();
    });
});
