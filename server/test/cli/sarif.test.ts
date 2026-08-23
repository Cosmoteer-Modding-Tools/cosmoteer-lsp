import { describe, expect, it } from 'vitest';
import { MAX_RESULTS_PER_RULE, MAX_RESULTS_PER_RUN, sarifReport } from '../../src/cli/report/sarif';
import { finding, report, withoutGameData } from './report-fixture';

/**
 * Render a report and read the log back, which is what a code scanning service does with it.
 *
 * @param log the rendered SARIF text.
 * @returns the parsed log.
 */
const parse = (log: string): any => JSON.parse(log);

describe('the SARIF log', () => {
    it('says which version of the format it is, so a reader can validate it', () => {
        const log = parse(sarifReport(report()));
        expect(log.version).toBe('2.1.0');
        expect(log.$schema).toContain('sarif-2.1.0');
        expect(log.runs).toHaveLength(1);
    });

    it('carries a rule for every result, and no rule that nothing uses', () => {
        const log = parse(
            sarifReport(
                report({
                    findings: [
                        finding({ ruleId: 'parse-error', path: 'a.rules' }),
                        finding({ ruleId: 'parse-error', path: 'b.rules' }),
                        finding({ ruleId: 'validateDefaultValues', path: 'c.rules', severity: 'hint' }),
                    ],
                })
            )
        );
        const declared = log.runs[0].tool.driver.rules.map((rule: { id: string }) => rule.id);
        expect(declared).toEqual(['parse-error', 'validateDefaultValues']);
        for (const result of log.runs[0].results) {
            expect(declared).toContain(result.ruleId);
            expect(declared[result.ruleIndex]).toBe(result.ruleId);
        }
    });

    it('maps the four editor severities onto the three levels SARIF has', () => {
        const log = parse(
            sarifReport(
                report({
                    findings: [
                        finding({ severity: 'error', path: 'a.rules', ruleId: 'parse-error' }),
                        finding({ severity: 'warning', path: 'b.rules', ruleId: 'validateLocalizationKeys' }),
                        finding({ severity: 'info', path: 'c.rules', ruleId: 'validateUndeclaredDependencies' }),
                        finding({ severity: 'hint', path: 'd.rules', ruleId: 'validateDefaultValues' }),
                    ],
                })
            )
        );
        expect(log.runs[0].results.map((result: { level: string }) => result.level)).toEqual([
            'error',
            'warning',
            'note',
            'note',
        ]);
    });

    it('writes regions in the one-based form SARIF wants, keeping the end exclusive', () => {
        const log = parse(
            sarifReport(
                report({ findings: [finding({ startLine: 3, startColumn: 5, endLine: 4, endColumn: 9 })] })
            )
        );
        expect(log.runs[0].results[0].locations[0].physicalLocation.region).toEqual({
            startLine: 3,
            startColumn: 5,
            endLine: 4,
            endColumn: 9,
        });
    });

    it('writes paths relative to the one workspace folder, with no drive letter', () => {
        const log = parse(sarifReport(report({ findings: [finding({ path: 'parts/my part/foo.rules' })] })));
        const location = log.runs[0].results[0].locations[0].physicalLocation.artifactLocation;
        expect(location.uri).toBe('parts/my%20part/foo.rules');
        expect(location.uriBaseId).toBe('SRCROOT');
        expect(log.runs[0].originalUriBaseIds.SRCROOT.uri.endsWith('/')).toBe(true);
    });

    it('leaves paths absolute when several folders were checked, since none of them is the base', () => {
        const log = parse(
            sarifReport(report({ folders: ['C:\\mods\\one', 'C:\\mods\\two'], findings: [finding()] }))
        );
        const location = log.runs[0].results[0].locations[0].physicalLocation.artifactLocation;
        expect(location.uri.startsWith('file://')).toBe(true);
        expect(location.uriBaseId).toBeUndefined();
        expect(log.runs[0].originalUriBaseIds).toBeUndefined();
    });

    it('says on the run itself that the game data was not read', () => {
        const log = parse(sarifReport(report({ gameData: withoutGameData })));
        const notifications = log.runs[0].invocations[0].toolExecutionNotifications;
        expect(notifications[0].descriptor.id).toBe('no-game-data');
        expect(notifications[0].level).toBe('warning');
        expect(notifications[0].message.text).toContain('not a clean bill of health');
        expect(notifications[0].message.text).toContain('validateLocalizationKeys');
    });

    it('produces the same bytes twice for the same findings', () => {
        const findings = [
            finding({ path: 'b.rules', ruleId: 'schema' }),
            finding({ path: 'a.rules', ruleId: 'parse-error' }),
        ];
        expect(sarifReport(report({ findings }))).toBe(sarifReport(report({ findings: [...findings].reverse() })));
    });
});

describe('the caps a code scanning service enforces', () => {
    it('drops the tail of a rule that produced more than the per-rule cap, and says how many', () => {
        const many = Array.from({ length: MAX_RESULTS_PER_RULE + 25 }, (_, index) =>
            finding({ ruleId: 'validateDefaultValues', severity: 'hint', startLine: index + 1 })
        );
        const log = parse(sarifReport(report({ findings: many })));
        expect(log.runs[0].results).toHaveLength(MAX_RESULTS_PER_RULE);
        const notification = log.runs[0].invocations[0].toolExecutionNotifications[0];
        expect(notification.descriptor.id).toBe('rule-result-cap');
        expect(notification.message.text).toContain('25 of them are not in this file');
    });

    it('keeps a rule under the cap complete while another is trimmed', () => {
        const findings = [
            ...Array.from({ length: MAX_RESULTS_PER_RULE + 5 }, (_, index) =>
                finding({ ruleId: 'validateDefaultValues', severity: 'hint', path: 'a.rules', startLine: index + 1 })
            ),
            ...Array.from({ length: 3 }, (_, index) =>
                finding({ ruleId: 'parse-error', path: 'b.rules', startLine: index + 1 })
            ),
        ];
        const log = parse(sarifReport(report({ findings })));
        const perRule = log.runs[0].results.reduce((counts: Record<string, number>, result: { ruleId: string }) => {
            counts[result.ruleId] = (counts[result.ruleId] ?? 0) + 1;
            return counts;
        }, {});
        expect(perRule['parse-error']).toBe(3);
        expect(perRule['validateDefaultValues']).toBe(MAX_RESULTS_PER_RULE);
    });

    it('never writes more results than one run may carry', () => {
        // Six rules of five thousand each is thirty thousand, which is over the whole-run cap even
        // though no single rule is over its own.
        const ruleIds = [
            'validateDefaultValues',
            'validateIgnoredFields',
            'validateUnusedConstants',
            'validateRedundantOverrides',
            'validateDuplicateFields',
            'validateRedundantSeparators',
        ];
        const findings = ruleIds.flatMap((ruleId, ruleNumber) =>
            Array.from({ length: MAX_RESULTS_PER_RULE }, (_, index) =>
                finding({ ruleId, severity: 'hint', path: `f${ruleNumber}.rules`, startLine: index + 1 })
            )
        );
        const log = parse(sarifReport(report({ findings })));
        expect(log.runs[0].results).toHaveLength(MAX_RESULTS_PER_RUN);
        const ids = log.runs[0].invocations[0].toolExecutionNotifications.map(
            (notification: { descriptor: { id: string } }) => notification.descriptor.id
        );
        expect(ids).toContain('run-result-cap');
    });
});
