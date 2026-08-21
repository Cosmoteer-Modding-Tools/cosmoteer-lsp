import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import { helpText, LintOptions, parseArguments } from '../../src/cli/options';
import { RULES } from '../../src/cli/rule-ids';

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

describe('the defaults', () => {
    it('checks the current directory with the game required and only errors failing the run', () => {
        const options = run();
        expect(options.folders).toEqual([resolve('.')]);
        expect(options.useGame).toBe(true);
        expect(options.requireGame).toBe(true);
        expect(options.failOn).toBe('error');
        expect(options.format).toBe('text');
        expect(options.scope).toBe('modRulesReachable');
        expect(options.freshCache).toBe(false);
    });

    it('reports everything down to a hint in the formats a person or a script reads', () => {
        expect(run().minSeverity).toBe('hint');
        expect(run('--format', 'json').minSeverity).toBe('hint');
    });

    it('leaves the hint-level passes out of a report meant to be uploaded', () => {
        expect(run('--format', 'sarif').minSeverity).toBe('warning');
        expect(run('--format', 'github').minSeverity).toBe('warning');
        expect(run('--format', 'sarif', '--min-severity', 'hint').minSeverity).toBe('hint');
    });
});

describe('reading the command line', () => {
    it('takes several folders', () => {
        expect(run('one', 'two').folders).toEqual([resolve('one'), resolve('two')]);
    });

    it('turns the game requirement off when the run was told not to use the game at all', () => {
        const options = run('--no-game');
        expect(options.useGame).toBe(false);
        expect(options.requireGame).toBe(false);
    });

    it('reads the rule filters', () => {
        expect([...run('--rule', 'parse-error', '--rule', 'schema').only!]).toEqual(['parse-error', 'schema']);
        expect([...run('--no-rule', 'validateDefaultValues').exclude]).toEqual(['validateDefaultValues']);
    });

    it('reads the timeout in seconds', () => {
        expect(run('--timeout', '30').timeoutMs).toBe(30000);
    });

    it('answers a request for the help and for the version', () => {
        expect(parseArguments(['--help']).kind).toBe('help');
        expect(parseArguments(['-h']).kind).toBe('help');
        expect(parseArguments(['--version']).kind).toBe('version');
    });
});

describe('refusing a command line it cannot follow', () => {
    it('names the option that was written with no value', () => {
        expect(refused('--game')).toContain('--game needs a value');
    });

    it('lists what an option accepts', () => {
        expect(refused('--format', 'xml')).toContain('text, json, sarif, github');
        expect(refused('--fail-on', 'fatal')).toContain('none');
        expect(refused('--scope', 'everything')).toContain('allFiles');
    });

    it('refuses a rule id no rule carries rather than filtering to nothing', () => {
        expect(refused('--rule', 'validateEverything')).toContain('no rule this tool reports');
    });

    it('refuses a number outside the range', () => {
        expect(refused('--max-problems', '0')).toContain('whole number');
        expect(refused('--timeout', 'soon')).toContain('whole number');
    });

    it('refuses two options that contradict each other', () => {
        expect(refused('--no-game', '--game', 'C:/Games/Cosmoteer')).toContain('contradict');
        expect(refused('--rule', 'schema', '--no-rule', 'parse-error')).toContain('cannot both be used');
    });

    it('refuses an option it does not know rather than reading it as a folder', () => {
        expect(refused('--strict')).toContain('is not an option this tool knows');
    });
});

describe('the help', () => {
    it('lists every rule, so the ids the filters take are documented', () => {
        const text = helpText();
        for (const rule of RULES) expect(text, rule.id).toContain(rule.id);
    });

    it('says what every exit code means', () => {
        const text = helpText();
        for (const code of ['0', '1', '2', '3', '4', '5']) expect(text).toMatch(new RegExp(`\\n {2}${code} {2}`));
    });

    it('tells the reader how the tool is started', () => {
        expect(helpText()).toContain('node out/server/src/cli/lint.mjs');
    });
});
