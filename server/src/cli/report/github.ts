import type { LintFinding } from '../findings';
import { LintSeverity, ruleById } from '../rule-ids';
import { plural, type LintReport } from './report';

// GitHub workflow commands. A line written in this shape becomes an annotation on the pull request
// and in the run log. The escaping below is the one the runner defines, and getting it wrong is
// silent: the command is simply not recognised and the line reads as ordinary log output.

/** The workflow command each severity is annotated with. GitHub has three, so hints become notices. */
const COMMAND: Record<LintSeverity, 'error' | 'warning' | 'notice'> = {
    error: 'error',
    warning: 'warning',
    info: 'notice',
    hint: 'notice',
};

/**
 * Escape the message half of a workflow command.
 *
 * The percent sign goes first, since escaping it after the others would escape the escapes.
 *
 * @param text the text to escape.
 * @returns the escaped text.
 */
export const escapeMessage = (text: string): string =>
    text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * Escape a property value, which additionally may not carry the separators the command uses.
 *
 * @param text the text to escape.
 * @returns the escaped text.
 */
export const escapeProperty = (text: string): string =>
    escapeMessage(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * One annotation line.
 *
 * @param finding the finding to annotate.
 * @returns the workflow command line.
 */
export const annotationLine = (finding: LintFinding): string => {
    const title = ruleById(finding.ruleId)?.title ?? finding.ruleId;
    const properties = [
        `file=${escapeProperty(finding.path)}`,
        `line=${finding.startLine}`,
        `endLine=${finding.endLine}`,
        `col=${finding.startColumn}`,
        `endColumn=${finding.endColumn}`,
        `title=${escapeProperty(`${title} (${finding.ruleId})`)}`,
    ].join(',');
    return `::${COMMAND[finding.severity]} ${properties}::${escapeMessage(finding.message)}`;
};

/**
 * The annotations for a run, plus the lines that say what the run could not annotate.
 *
 * The cap exists because a pull request stops showing annotations well before a large mod runs out
 * of findings, and every one of them is also a line of workflow log.
 *
 * @param report the assembled report.
 * @returns the whole output, ending in a newline.
 */
export const githubReport = (report: LintReport): string => {
    const lines: string[] = [];
    if (!report.gameData.available) {
        lines.push(
            `::warning title=Cosmoteer Rules Lint::${escapeMessage(
                'This run did not read the game data, so it is not a clean bill of health. ' +
                    `These checks did not run: ${report.gameData.skippedRules.join(', ')}.`
            )}`
        );
    }
    const annotated = report.findings.slice(0, report.annotationLimit);
    for (const finding of annotated) lines.push(annotationLine(finding));
    const remaining = report.findings.length - annotated.length;
    if (remaining > 0) {
        lines.push(
            `::notice title=Cosmoteer Rules Lint::${escapeMessage(
                `The run annotates at most ${report.annotationLimit}, so ${plural(remaining, 'further finding')} did not get one. Raise the limit with --annotation-limit, or write the whole report with --format sarif.`
            )}`
        );
    }
    lines.push(
        `::notice title=Cosmoteer Rules Lint::${escapeMessage(
            `${plural(report.findings.length, 'finding')} in ${plural(report.files, 'file')}: ` +
                `${report.counts.error} error, ${report.counts.warning} warning, ${report.counts.info} note, ${report.counts.hint} hint.`
        )}`
    );
    return `${lines.join('\n')}\n`;
};
