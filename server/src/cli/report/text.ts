import { UNTAGGED_RULE_ID, ruleById, GAME_DATA_RULES, LintSeverity } from '../rule-ids';
import { TOOL_NAME, toolVersion } from '../version';
import { gamePathOrigin, LintReport, plural } from './report';

/** The severities in report order, with the word each one is counted under. */
const SEVERITY_NOUNS: readonly [LintSeverity, string][] = [
    ['error', 'error'],
    ['warning', 'warning'],
    ['info', 'note'],
    ['hint', 'hint'],
];

/**
 * The report a person reads: the run's inputs, the findings grouped by file, and a summary that
 * says plainly whether the run passed and what it could not check.
 *
 * @param report the assembled report.
 * @returns the whole text, ending in a newline.
 */
export const textReport = (report: LintReport): string => {
    const lines: string[] = [`${TOOL_NAME} ${toolVersion()}`, ''];
    lines.push(`Folders    ${report.folders.join('\n           ')}`);
    lines.push(
        report.gameData.available
            ? `Game data  ${report.gameData.dataRoot} (${gamePathOrigin(report.gameData.source)})`
            : 'Game data  not used'
    );
    lines.push(`Scope      ${report.scope}`);
    lines.push('');

    if (!report.gameData.available) {
        lines.push(...missingGameDataBanner(report), '');
    }

    lines.push(...findingLines(report));

    if (report.findings.length > 0) {
        lines.push('Findings by rule', ...ruleBreakdown(report), '');
    }

    lines.push(`Checked ${plural(report.files, 'file')} in ${(report.elapsedMs / 1000).toFixed(1)} s.`);
    if (report.passes > 1) {
        lines.push(`The result settled after ${plural(report.passes, 'pass', 'passes')}.`);
    }
    lines.push(summaryLine(report));

    const hidden = report.scanned.length - report.findings.length;
    if (hidden > 0) lines.push(`${plural(hidden, 'further finding')} left out by the severity and rule filters.`);

    const untagged = report.findings.filter((finding) => !finding.named).length;
    if (untagged > 0) {
        lines.push(
            `${plural(untagged, 'finding')} came from a server build that does not name the check behind a finding, ` +
                `so the report puts ${untagged === 1 ? 'it' : 'them'} under "${UNTAGGED_RULE_ID}".`
        );
    }

    lines.push(verdictLine(report));
    return `${lines.join('\n')}\n`;
};

/**
 * The findings, grouped under the file they are in.
 *
 * @param report the assembled report.
 * @returns the lines, ending in a blank line when there is anything to show.
 */
const findingLines = (report: LintReport): string[] => {
    if (report.findings.length === 0) return [];
    const lines: string[] = [];
    // The findings are already in report order, so a change of path is a change of group.
    let currentPath: string | undefined;
    const positionWidth = Math.max(...report.findings.map((finding) => position(finding).length));
    const severityWidth = Math.max(...report.findings.map((finding) => finding.severity.length));
    const ruleWidth = Math.max(...report.findings.map((finding) => finding.ruleId.length));
    for (const finding of report.findings) {
        if (finding.path !== currentPath) {
            if (currentPath !== undefined) lines.push('');
            currentPath = finding.path;
            lines.push(currentPath);
        }
        const message = finding.message.replace(/\s*\n\s*/g, ' ');
        lines.push(
            `  ${position(finding).padEnd(positionWidth)}  ${finding.severity.padEnd(severityWidth)}  ` +
                `${finding.ruleId.padEnd(ruleWidth)}  ${message}`
        );
    }
    lines.push('');
    return lines;
};

/**
 * The `line:column` a finding starts at.
 *
 * @param finding the finding.
 * @returns the position as one string.
 */
const position = (finding: { startLine: number; startColumn: number }): string =>
    `${finding.startLine}:${finding.startColumn}`;

/**
 * The counts, one line, in the four levels the editor uses.
 *
 * @param report the assembled report.
 * @returns the summary line.
 */
const summaryLine = (report: LintReport): string =>
    SEVERITY_NOUNS.map(([severity, noun]) => plural(report.counts[severity], noun)).join(', ') + '.';

/**
 * The line that says whether the run passed, in the terms `--fail-on` was given in.
 *
 * @param report the assembled report.
 * @returns the verdict line.
 */
const verdictLine = (report: LintReport): string => {
    if (report.failLevel === 'none') return 'Nothing was set to fail this run.';
    if (report.failing === 0) return `Nothing reached the ${report.failLevel} level.`;
    return `${plural(report.failing, 'finding')} reached the ${report.failLevel} level.`;
};

/**
 * The banner for a run without the game's own data, naming both what did not run and what ran
 * badly. A run in this state cannot be read as a clean bill of health, and saying so is the whole
 * point of the banner.
 *
 * @param report the assembled report.
 * @returns the banner lines.
 */
const missingGameDataBanner = (report: LintReport): string[] => {
    const names = GAME_DATA_RULES.map((rule) => rule.title.toLowerCase()).join(', ');
    const lines = ['This run did not read the game data, so it is not a clean bill of health.'];
    if (report.gameData.reason) lines.push(`  ${report.gameData.reason}`);
    lines.push(`  These checks did not run: ${names}.`);
    lines.push(
        '  The reference and asset checks did run, and without the game files they report every path',
        '  into the game data as missing, so much of what follows is not a real problem.',
        '  Point the run at the install with --game to get the full result.'
    );
    return lines;
};

/**
 * The one-line summary of which rules a report carries, for a reader deciding what to filter.
 *
 * @param report the assembled report.
 * @returns the rule ids that produced findings, with their counts, most findings first.
 */
export const ruleBreakdown = (report: LintReport): string[] => {
    const counts = new Map<string, number>();
    for (const finding of report.findings) counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([id, count]) => `  ${id.padEnd(32)}${String(count).padStart(6)}  ${ruleById(id)?.title ?? ''}`);
};
