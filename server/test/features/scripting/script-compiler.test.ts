import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { scriptingSurface } from '../../../src/document/schema/schema';
import { compileScript } from '../../../src/features/scripting/script-compiler';

const CODEX = 'Cosmoteer.Codex.CodexConditionContext';
const ON_SEEN = 'Cosmoteer.Codex.CodexOnSeenContext';
const MUSIC = 'Cosmoteer.Music.MusicParameters';
const BOOL = 'System.Boolean';

/** The game's message for a script, or undefined when it compiles. */
const errorOf = (script: string, context = CODEX, returns = BOOL): string | undefined =>
    compileScript(script, scriptingSurface(), context, returns).error?.message;

describe('compileScript', () => {
    it('accepts what vanilla and the workshop write', () => {
        expect(errorOf("? game.HasPartCategoryInHand('logic')")).toBeUndefined();
        expect(
            errorOf("? game.HasPartCategoryInHand('Inserter') or game.HasTechUnlocked('janiTNT.inserters')")
        ).toBeUndefined();
        expect(errorOf('sim.SelectedShip is not None and sim.SelectedShip.Name == "x"')).toBeUndefined();
        expect(errorOf('zoom < 0.5 and not battle', MUSIC)).toBeUndefined();
        expect(errorOf('CalculateZoomVolume(1, 0.5, 2, 1) if battle else 0', MUSIC, 'System.Single')).toBeUndefined();
        expect(errorOf("SetSetting('ShowTutorials', False)", ON_SEEN, 'System.Void')).toBeUndefined();
    });

    it('answers with the game message for what the compiler refuses', () => {
        expect(errorOf('stats.Kills > 3')).toBe("Unknown variable 'stats'.");
        expect(errorOf('paused')).toBe("Unknown variable 'paused'.");
        expect(errorOf('1 < zoom < 2', MUSIC)).toBe('Chained comparisons are not supported.');
        expect(errorOf('game.HasTechUnlocked')).toBe("'HasTechUnlocked' is a method and must be called.");
        expect(errorOf('game.Missing')).toBe("GameScriptAccess has no property named 'Missing'.");
        expect(errorOf("[x for x in 'ab']")).toBe("Unexpected character '['.");
        expect(errorOf('zoom', MUSIC)).toBe('Cannot convert Single to Boolean.');
        expect(errorOf('game.Fame and game.IsCareerMode')).toBe('Expected a bool but found Int32.');
        expect(errorOf("SetSetting('ShowTutorials')", ON_SEEN, 'System.Void')).toBe(
            "'SetSetting' cannot be called with arguments (String)."
        );
        expect(errorOf('game.HasTechUnlocked(1)')).toBe("'HasTechUnlocked' cannot be called with arguments (Int32).");
        expect(errorOf('')).toBe('Script is empty.');
        expect(errorOf("'open")).toBe('Unterminated string.');
        expect(errorOf('game.Fame +')).toBe("Expected an expression but found 'end of script'.");
        expect(errorOf('zoom zoom', MUSIC)).toBe("Unexpected 'zoom'.");
        expect(errorOf('battle if zoom else menu', MUSIC)).toBe('Expected a bool but found Single.');
        expect(errorOf("1 if battle else 'a'", MUSIC, 'System.Single')).toBe('Cannot combine Int32 and String.');
    });

    it('places the error on the offending token of the written string', () => {
        const result = compileScript('  ? game.Fame > stats', scriptingSurface(), CODEX, BOOL);
        expect(result.error).toMatchObject({ start: 16, end: 21 });
    });

    it('records what each name bound to, and the type left of every dot', () => {
        const result = compileScript('sim.SelectedShip.Name == ""', scriptingSurface(), CODEX, BOOL);
        expect(result.bindings.map((b) => `${b.role}:${b.members[0].name}`)).toEqual([
            'variable:sim',
            'property:SelectedShip',
            'property:Name',
        ]);
        expect(result.accesses.map((a) => a.target)).toEqual([
            'Cosmoteer.Simulation.SimScriptAccess',
            'Cosmoteer.Ships.ShipScriptAccess',
        ]);
    });

    it('judges only the syntax against a context the server cannot describe', () => {
        expect(errorOf('anything.Goes(1) > 2', 'Mod.Context')).toBeUndefined();
        expect(errorOf('anything ;', 'Mod.Context')).toBe("Unexpected character ';'.");
    });
});

interface GameAnswer {
    script: string;
    context: string;
    returns: string;
    /** What the game's own compiler (0.30.5 RC6) answered, column counted in the trimmed script. */
    game: { message: string; column: number } | null;
}

describe('compileScript against answers recorded from the game compiler', () => {
    const answers: GameAnswer[] = JSON.parse(
        readFileSync(join(__dirname, '../../fixtures/scripting/game-compiler-answers.json'), 'utf8')
    );

    it.each(answers.map((answer) => [answer.script, answer] as const))('%j', (_, answer) => {
        const result = compileScript(answer.script, scriptingSurface(), answer.context, answer.returns);
        if (!answer.game) {
            expect(result.error).toBeUndefined();
            return;
        }
        expect(result.error?.message).toBe(answer.game.message);
        const trimmed = answer.script.trim();
        const body = /^[?>]/.test(trimmed) ? trimmed.slice(1).trim() : trimmed;
        // An empty script has no token to point at, so only the message is compared.
        if (body.length === 0) return;
        expect((result.error?.start ?? 0) - answer.script.indexOf(body) + 1).toBe(answer.game.column);
    });
});
