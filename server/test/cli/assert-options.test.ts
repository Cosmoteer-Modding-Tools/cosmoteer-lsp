import { describe, expect, it } from 'vitest';
import { helpText, LintOptions, parseArguments } from '../../src/cli/options';

// The load check is a mode of the lint command rather than a second command, so the command line
// has to refuse the combinations that would produce an answer nobody should trust.

/**
 * Parse a command line that is expected to be understood.
 *
 * @param argv the arguments.
 * @returns the options the run would use.
 */
const run = (...argv: string[]): LintOptions => {
    const parsed = parseArguments(argv);
    if (parsed.kind !== 'run') throw new Error(`expected a run, got ${parsed.kind}`);
    return parsed.options;
};

/**
 * Parse a command line that is expected to be refused.
 *
 * @param argv the arguments.
 * @returns the message the user is shown.
 */
const refused = (...argv: string[]): string => {
    const parsed = parseArguments(argv);
    if (parsed.kind !== 'error') throw new Error(`expected a refusal, got ${parsed.kind}`);
    return parsed.message;
};

describe('asking whether the mod loads', () => {
    it('is off unless it is asked for', () => {
        expect(run('mod').assertLoads).toBe(false);
        expect(run('mod').allowUnverifiable).toBe(false);
    });

    it('keeps the game data required, since every action target is a path into it', () => {
        const options = run('mod', '--assert-loads');
        expect(options.assertLoads).toBe(true);
        expect(options.useGame).toBe(true);
        expect(options.requireGame).toBe(true);
        expect(refused('mod', '--assert-loads', '--no-game')).toContain('needs the game data');
        expect(refused('mod', '--assert-loads', '--no-require-game')).toContain('needs the game data');
    });

    it('refuses a report format that cannot carry a whole-mod answer', () => {
        expect(refused('mod', '--assert-loads', '--format', 'sarif')).toContain('writes text or json');
        expect(refused('mod', '--assert-loads', '--format', 'github')).toContain('writes text or json');
        expect(run('mod', '--assert-loads', '--format', 'json').format).toBe('json');
    });

    it('refuses to accept an unfinished check that was never asked for', () => {
        expect(refused('mod', '--allow-unverifiable')).toContain('--assert-loads');
        expect(run('mod', '--assert-loads', '--allow-unverifiable').allowUnverifiable).toBe(true);
    });
});

describe('the help', () => {
    it('describes the mode, its flag and the code it answers an unfinished check with', () => {
        const text = helpText();
        expect(text).toContain('--assert-loads');
        expect(text).toContain('--allow-unverifiable');
        expect(text).toMatch(/\n {2}6 {2}/);
    });

    it('says that the game data cannot go into a build service', () => {
        expect(helpText()).toContain('cannot be copied into a build service');
    });
});
