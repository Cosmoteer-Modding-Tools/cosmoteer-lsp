import { describe, expect, it } from 'vitest';
import { textReport } from '../../src/cli/report/text';
import { jsonReport } from '../../src/cli/report/json';
import { UNTAGGED_RULE_ID } from '../../src/cli/rule-ids';
import { finding, report, withoutGameData } from './report-fixture';

describe('the report a person reads', () => {
    it('names the folders, the game data and the scope before anything else', () => {
        const text = textReport(report());
        expect(text).toContain('Folders    C:\\mods\\demo');
        expect(text).toContain('Game data  C:\\Games\\Cosmoteer\\Data (given with --game)');
        expect(text).toContain('Scope      modRulesReachable');
    });

    it('groups the findings under the file they are in', () => {
        const text = textReport(
            report({
                findings: [
                    finding({ path: 'a.rules', startLine: 1 }),
                    finding({ path: 'a.rules', startLine: 2 }),
                    finding({ path: 'b.rules', startLine: 1 }),
                ],
            })
        );
        const lines = text.split('\n');
        expect(lines.filter((line) => line === 'a.rules')).toHaveLength(1);
        expect(lines.filter((line) => line === 'b.rules')).toHaveLength(1);
    });

    it('puts the position, the severity and the rule in front of every message', () => {
        const text = textReport(report({ findings: [finding({ startLine: 12, startColumn: 3 })] }));
        expect(text).toMatch(/ {2}12:3 {2}error {2}validateRequiredFields {2}Part is missing the field "Size"\./);
    });

    it('folds a message that runs over several lines onto one line', () => {
        const text = textReport(report({ findings: [finding({ message: 'First.\n   Second.' })] }));
        expect(text).toContain('First. Second.');
    });

    it('says plainly that nothing failed, and how many findings did', () => {
        expect(textReport(report({ findings: [finding({ severity: 'hint' })] }))).toContain(
            'Nothing reached the error level.'
        );
        expect(textReport(report({ findings: [finding({ severity: 'error' })] }))).toContain(
            '1 finding reached the error level.'
        );
        expect(textReport(report({ failLevel: 'none' }))).toContain('Nothing was set to fail this run.');
    });

    it('counts every severity in the summary', () => {
        const text = textReport(
            report({
                findings: [
                    finding({ severity: 'error', path: 'a.rules' }),
                    finding({ severity: 'warning', path: 'b.rules' }),
                    finding({ severity: 'warning', path: 'c.rules' }),
                ],
            })
        );
        expect(text).toContain('1 error, 2 warnings, 0 notes, 0 hints.');
    });

    it('lists how many findings each rule produced', () => {
        const text = textReport(
            report({
                findings: [
                    finding({ ruleId: 'parse-error', path: 'a.rules' }),
                    finding({ ruleId: 'parse-error', path: 'b.rules' }),
                    finding({ ruleId: 'schema', path: 'c.rules' }),
                ],
            })
        );
        expect(text).toContain('Findings by rule');
        expect(text).toMatch(/parse-error\s+2\s+Parse error/);
    });

    it('refuses to read as a clean run when the game data was not used', () => {
        const text = textReport(report({ gameData: withoutGameData, findings: [] }));
        expect(text).toContain('Game data  not used');
        expect(text).toContain('This run did not read the game data, so it is not a clean bill of health.');
        expect(text).toContain('The run was started with --no-game.');
        expect(text).toContain('component references');
        expect(text).toContain('unreceivable buffs');
        expect(text).toContain('report every path');
    });

    it('says when findings came from a build that does not name its checks', () => {
        const text = textReport(
            report({ findings: [finding({ ruleId: UNTAGGED_RULE_ID, named: false })] })
        );
        expect(text).toContain(`under "${UNTAGGED_RULE_ID}"`);
    });

    it('says how many findings the filters left out', () => {
        const base = report({ findings: [finding()] });
        const text = textReport({ ...base, scanned: [...base.findings, finding({ path: 'other.rules' })] });
        expect(text).toContain('1 further finding left out by the severity and rule filters.');
    });

    it('mentions a second pass only when there was one', () => {
        expect(textReport(report({ passes: 1 }))).not.toContain('settled after');
        expect(textReport(report({ passes: 2 }))).toContain('The result settled after 2 passes.');
    });
});

describe('the machine-readable report', () => {
    it('carries the findings and the run, and nothing that changes between two runs', () => {
        const parsed = JSON.parse(jsonReport(report()));
        expect(parsed.run.scope).toBe('modRulesReachable');
        expect(parsed.run.files).toBe(12);
        expect(parsed.summary.error).toBe(1);
        expect(parsed.findings[0].ruleId).toBe('validateRequiredFields');
        expect(JSON.stringify(parsed)).not.toContain('elapsed');
    });

    it('records what the run could not check', () => {
        const parsed = JSON.parse(jsonReport(report({ gameData: withoutGameData })));
        expect(parsed.run.gameData.available).toBe(false);
        expect(parsed.run.gameData.reason).toContain('--no-game');
        expect(parsed.run.gameData.skippedRules).toContain('validateDuplicateIds');
    });

    it('produces the same bytes for the same findings twice', () => {
        expect(jsonReport(report())).toBe(jsonReport(report()));
    });
});
