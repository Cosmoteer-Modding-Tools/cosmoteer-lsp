import { describe, expect, it } from 'vitest';
import { annotationLine, escapeMessage, escapeProperty, githubReport } from '../../src/cli/report/github';
import { finding, report, withoutGameData } from './report-fixture';

describe('escaping a workflow command', () => {
    it('escapes the percent sign first, so the other escapes are not escaped again', () => {
        expect(escapeMessage('100% of\nit')).toBe('100%25 of%0Ait');
    });

    it('escapes both halves of a windows line ending', () => {
        expect(escapeMessage('a\r\nb')).toBe('a%0D%0Ab');
    });

    it('also escapes the separators a property value may not carry', () => {
        expect(escapeProperty('Parts/Foo: a, b')).toBe('Parts/Foo%3A a%2C b');
    });

    it('leaves ordinary text alone', () => {
        expect(escapeMessage('Part is missing the field "Size".')).toBe('Part is missing the field "Size".');
    });
});

describe('an annotation', () => {
    it('names the file, the span and the rule', () => {
        const line = annotationLine(
            finding({ path: 'parts/foo.rules', startLine: 3, startColumn: 5, endLine: 4, endColumn: 9 })
        );
        expect(line).toBe(
            '::error file=parts/foo.rules,line=3,endLine=4,col=5,endColumn=9,' +
                'title=Required fields (validateRequiredFields)::Part is missing the field "Size".'
        );
    });

    it('uses the three commands GitHub has for the four severities the editor has', () => {
        expect(annotationLine(finding({ severity: 'error' })).startsWith('::error ')).toBe(true);
        expect(annotationLine(finding({ severity: 'warning' })).startsWith('::warning ')).toBe(true);
        expect(annotationLine(finding({ severity: 'info' })).startsWith('::notice ')).toBe(true);
        expect(annotationLine(finding({ severity: 'hint' })).startsWith('::notice ')).toBe(true);
    });

    it('keeps a message that runs over several lines as one annotation', () => {
        const line = annotationLine(finding({ message: 'First line.\nSecond line.' }));
        expect(line.split('\n')).toHaveLength(1);
        expect(line.endsWith('First line.%0ASecond line.')).toBe(true);
    });
});

describe('the whole GitHub report', () => {
    it('stops at the annotation limit and says how many it left out', () => {
        const findings = Array.from({ length: 7 }, (_, index) => finding({ startLine: index + 1 }));
        const lines = githubReport(report({ findings, annotationLimit: 3 })).trimEnd().split('\n');
        expect(lines.filter((line) => line.startsWith('::error ')).length).toBe(3);
        expect(lines.some((line) => line.includes('4 further findings did not get one'))).toBe(true);
    });

    it('annotates nothing when the limit is zero, and still reports the totals', () => {
        const output = githubReport(report({ findings: [finding()], annotationLimit: 0 }));
        expect(output).not.toContain('::error ');
        expect(output).toContain('1 finding in 12 files');
    });

    it('leads with a warning when the run did not read the game data', () => {
        const output = githubReport(report({ gameData: withoutGameData, findings: [finding()] }));
        expect(output.split('\n')[0]).toContain('not a clean bill of health');
    });

    it('always ends with the totals, so a log says something even with nothing to annotate', () => {
        const output = githubReport(report({ findings: [] })).trimEnd().split('\n');
        expect(output[output.length - 1]).toContain('0 findings in 12 files');
    });
});
