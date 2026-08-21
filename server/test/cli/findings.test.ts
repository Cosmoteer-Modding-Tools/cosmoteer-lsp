import { describe, expect, it } from 'vitest';
import { countBySeverity, filterFindings, sortFindings, toFinding } from '../../src/cli/findings';
import { reportPath, uriToFsPath } from '../../src/cli/uri';
import { UNTAGGED_RULE_ID } from '../../src/cli/rule-ids';
import { finding } from './report-fixture';

const ROOTS = process.platform === 'win32' ? ['C:\\mods\\demo'] : ['/mods/demo'];
const FILE_URI =
    process.platform === 'win32' ? 'file:///C%3A/mods/demo/parts/foo.rules' : 'file:///mods/demo/parts/foo.rules';

/**
 * A diagnostic as it arrives on the wire, with the fields a test does not care about filled in.
 *
 * @param overrides the fields the test sets.
 * @returns the wire diagnostic.
 */
const wire = (overrides: Partial<Parameters<typeof toFinding>[2]> = {}) => ({
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
    severity: 1,
    message: 'Something is wrong.',
    ...overrides,
});

describe('turning a published diagnostic into a finding', () => {
    it('moves the zero-based wire positions onto the one-based positions a report shows', () => {
        const result = toFinding(FILE_URI, ROOTS, wire());
        expect(result.startLine).toBe(3);
        expect(result.startColumn).toBe(5);
        expect(result.endLine).toBe(3);
        expect(result.endColumn).toBe(9);
    });

    it('maps every severity the protocol has, and reads a missing one as an error', () => {
        expect(toFinding(FILE_URI, ROOTS, wire({ severity: 1 })).severity).toBe('error');
        expect(toFinding(FILE_URI, ROOTS, wire({ severity: 2 })).severity).toBe('warning');
        expect(toFinding(FILE_URI, ROOTS, wire({ severity: 3 })).severity).toBe('info');
        expect(toFinding(FILE_URI, ROOTS, wire({ severity: 4 })).severity).toBe('hint');
        expect(toFinding(FILE_URI, ROOTS, wire({ severity: undefined })).severity).toBe('error');
    });

    it('takes the rule the diagnostic names, and says so when it names none', () => {
        const named = toFinding(FILE_URI, ROOTS, wire({ code: 'validateDefaultValues' }));
        expect(named.ruleId).toBe('validateDefaultValues');
        expect(named.named).toBe(true);

        const unnamed = toFinding(FILE_URI, ROOTS, wire());
        expect(unnamed.ruleId).toBe(UNTAGGED_RULE_ID);
        expect(unnamed.named).toBe(false);
    });

    it('records the tag that fades a span out', () => {
        expect(toFinding(FILE_URI, ROOTS, wire({ tags: [1] })).unnecessary).toBe(true);
        expect(toFinding(FILE_URI, ROOTS, wire({ tags: [2] })).unnecessary).toBe(false);
    });

    it('reports the file relative to its folder, with forward slashes', () => {
        expect(toFinding(FILE_URI, ROOTS, wire()).path).toBe('parts/foo.rules');
    });
});

describe('paths', () => {
    it('decodes the percent-encoded drive colon the server publishes', () => {
        const path = uriToFsPath('file:///C%3A/mods/my%20mod/a.rules');
        expect(path.replace(/\\/g, '/')).toBe('C:/mods/my mod/a.rules');
    });

    it('leaves a file outside every folder absolute rather than inventing a way up to it', () => {
        const outside = process.platform === 'win32' ? 'C:\\elsewhere\\other.rules' : '/elsewhere/other.rules';
        expect(reportPath(ROOTS, outside)).toBe(outside.replace(/\\/g, '/'));
    });
});

describe('ordering findings', () => {
    it('puts them in a fixed order whatever order they arrived in', () => {
        const unordered = [
            finding({ path: 'b.rules', startLine: 1 }),
            finding({ path: 'a.rules', startLine: 9, startColumn: 2 }),
            finding({ path: 'a.rules', startLine: 9, startColumn: 1 }),
            finding({ path: 'a.rules', startLine: 2 }),
        ];
        expect(sortFindings(unordered).map((entry) => `${entry.path}:${entry.startLine}:${entry.startColumn}`)).toEqual(
            ['a.rules:2:5', 'a.rules:9:1', 'a.rules:9:2', 'b.rules:1:5']
        );
    });

    it('separates two findings on the same span by rule and by message', () => {
        const same = [
            finding({ ruleId: 'schema', message: 'Second' }),
            finding({ ruleId: 'schema', message: 'First' }),
            finding({ ruleId: 'parse-error', message: 'Third' }),
        ];
        expect(sortFindings(same).map((entry) => entry.message)).toEqual(['Third', 'First', 'Second']);
    });

    it('does not change the array it was given', () => {
        const original = [finding({ path: 'b.rules' }), finding({ path: 'a.rules' })];
        sortFindings(original);
        expect(original[0].path).toBe('b.rules');
    });
});

describe('filtering findings', () => {
    const all = [
        finding({ severity: 'error', ruleId: 'parse-error' }),
        finding({ severity: 'warning', ruleId: 'validateLocalizationKeys' }),
        finding({ severity: 'info', ruleId: 'validateUndeclaredDependencies' }),
        finding({ severity: 'hint', ruleId: 'validateDefaultValues' }),
    ];

    it('keeps everything at or above the threshold', () => {
        expect(filterFindings(all, { minSeverity: 'warning', exclude: new Set() }).map((f) => f.severity)).toEqual([
            'error',
            'warning',
        ]);
        expect(filterFindings(all, { minSeverity: 'hint', exclude: new Set() })).toHaveLength(4);
    });

    it('keeps only the named rules when a rule filter is given', () => {
        const only = new Set(['parse-error']);
        expect(filterFindings(all, { minSeverity: 'hint', only, exclude: new Set() })).toHaveLength(1);
    });

    it('drops the excluded rules', () => {
        const exclude = new Set(['validateDefaultValues']);
        expect(filterFindings(all, { minSeverity: 'hint', exclude })).toHaveLength(3);
    });

    it('counts every severity, including the ones with nothing in them', () => {
        expect(countBySeverity([all[0]])).toEqual({ error: 1, warning: 0, info: 0, hint: 0 });
    });
});
