import type { LintFinding } from '../findings';
import { LintSeverity, RULES, ruleById } from '../rule-ids';
import { fsPathToUri } from '../uri';
import { TOOL_INFORMATION_URI, TOOL_NAME, toolVersion } from '../version';
import type { LintReport } from './report';

// SARIF 2.1.0, the format code scanning services read. The caps below are GitHub's, and a file
// that breaks one of them is rejected whole rather than trimmed, so the writer trims instead and
// records what it left out where the service will show it.

/** The most results one rule may carry before the upload is refused. */
export const MAX_RESULTS_PER_RULE = 5000;

/** The most results one run may carry before the upload is refused. */
export const MAX_RESULTS_PER_RUN = 25000;

/** The base id every result's path is expressed against, when the run covers one folder. */
const URI_BASE_ID = 'SRCROOT';

/** SARIF has three levels for a real finding, so the editor's four map onto them. */
const SARIF_LEVEL: Record<LintSeverity, 'error' | 'warning' | 'note'> = {
    error: 'error',
    warning: 'warning',
    info: 'note',
    hint: 'note',
};

/** A note the run attaches to itself, for something the reader has to know about the whole file. */
interface Notification {
    level: 'warning' | 'error';
    id: string;
    text: string;
}

/**
 * The SARIF log for a run.
 *
 * @param report the assembled report.
 * @returns the JSON text, ending in a newline.
 */
export const sarifReport = (report: LintReport): string => {
    const notifications: Notification[] = [];
    if (!report.gameData.available) {
        notifications.push({
            level: 'warning',
            id: 'no-game-data',
            text:
                'This run did not read the game data, so it is not a clean bill of health. ' +
                `These checks did not run: ${report.gameData.skippedRules.join(', ')}. ` +
                'The reference and asset checks report every path into the game data as missing.',
        });
    }
    const kept = applyCaps(report.findings, notifications);
    const usedRuleIds = new Set(kept.map((finding) => finding.ruleId));
    // The rules go in table order rather than in the order the findings arrived, so two runs that
    // find the same things in a different order still produce the same file.
    const rules = RULES.filter((rule) => usedRuleIds.has(rule.id));
    const ruleIndex = new Map(rules.map((rule, index) => [rule.id, index]));

    const singleRoot = report.folders.length === 1 ? report.folders[0] : undefined;
    const log = {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
            {
                tool: {
                    driver: {
                        name: TOOL_NAME,
                        version: toolVersion(),
                        informationUri: TOOL_INFORMATION_URI,
                        rules: rules.map((rule) => ({
                            id: rule.id,
                            shortDescription: { text: rule.title },
                            fullDescription: { text: rule.description },
                            defaultConfiguration: { level: SARIF_LEVEL[rule.defaultLevel] },
                            help: { text: rule.description },
                        })),
                    },
                },
                ...(singleRoot
                    ? { originalUriBaseIds: { [URI_BASE_ID]: { uri: `${fsPathToUri(singleRoot)}/` } } }
                    : {}),
                invocations: [
                    {
                        executionSuccessful: true,
                        toolExecutionNotifications: notifications.map((notification) => ({
                            level: notification.level,
                            descriptor: { id: notification.id },
                            message: { text: notification.text },
                        })),
                    },
                ],
                results: kept.map((finding) => ({
                    ruleId: finding.ruleId,
                    ruleIndex: ruleIndex.get(finding.ruleId) ?? 0,
                    level: SARIF_LEVEL[finding.severity],
                    message: { text: finding.message },
                    locations: [
                        {
                            physicalLocation: {
                                artifactLocation: artifactLocation(finding, singleRoot),
                                region: {
                                    startLine: finding.startLine,
                                    startColumn: finding.startColumn,
                                    endLine: finding.endLine,
                                    endColumn: finding.endColumn,
                                },
                            },
                        },
                    ],
                })),
            },
        ],
    };
    return `${JSON.stringify(log, null, 2)}\n`;
};

/**
 * Where a finding's file is, expressed the way the reading service wants it.
 *
 * A run over one folder writes paths relative to that folder, which is what makes a report match a
 * checkout whatever directory it was produced in. A run over several folders has no single base to
 * be relative to, so every path stays absolute rather than becoming ambiguous.
 *
 * @param finding the finding.
 * @param singleRoot the one workspace folder, when the run covered exactly one.
 * @returns the artifact location.
 */
const artifactLocation = (finding: LintFinding, singleRoot: string | undefined): Record<string, string> => {
    if (singleRoot && !isAbsolute(finding.path)) {
        return { uri: encodeRelative(finding.path), uriBaseId: URI_BASE_ID };
    }
    return { uri: fsPathToUri(finding.file) };
};

/**
 * Whether a report path is absolute, which happens for a file outside every workspace folder.
 *
 * @param path the report path, always with forward slashes.
 * @returns true when it is absolute.
 */
const isAbsolute = (path: string): boolean => /^([a-zA-Z]:|\/)/.test(path);

/**
 * Percent-encode a relative path segment by segment, leaving the separators alone.
 *
 * @param path the report path.
 * @returns the encoded path.
 */
const encodeRelative = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/**
 * Trim the results down to what a code scanning service accepts, and say what was left out.
 *
 * The per-rule cap is applied first, because one noisy rule is the usual reason a file is over the
 * whole-run cap, and dropping its tail keeps every other rule complete.
 *
 * @param findings the findings the report carries, in report order.
 * @param notifications collects one note per cap that had to be applied.
 * @returns the findings that fit.
 */
const applyCaps = (findings: readonly LintFinding[], notifications: Notification[]): LintFinding[] => {
    const perRule = new Map<string, number>();
    const kept: LintFinding[] = [];
    const droppedByRule = new Map<string, number>();
    for (const finding of findings) {
        const seen = perRule.get(finding.ruleId) ?? 0;
        if (seen >= MAX_RESULTS_PER_RULE) {
            droppedByRule.set(finding.ruleId, (droppedByRule.get(finding.ruleId) ?? 0) + 1);
            continue;
        }
        perRule.set(finding.ruleId, seen + 1);
        kept.push(finding);
    }
    for (const [ruleId, dropped] of droppedByRule) {
        notifications.push({
            level: 'warning',
            id: 'rule-result-cap',
            text: `${ruleId} (${ruleById(ruleId)?.title ?? ruleId}) produced more than ${MAX_RESULTS_PER_RULE} findings, so ${dropped} of them are not in this file. Narrow the run or turn the rule off to see the rest.`,
        });
    }
    if (kept.length <= MAX_RESULTS_PER_RUN) return kept;
    const dropped = kept.length - MAX_RESULTS_PER_RUN;
    notifications.push({
        level: 'warning',
        id: 'run-result-cap',
        text: `This run found more than ${MAX_RESULTS_PER_RUN} findings, so ${dropped} of them are not in this file. Raise --min-severity or narrow the run to see the rest.`,
    });
    return kept.slice(0, MAX_RESULTS_PER_RUN);
};
