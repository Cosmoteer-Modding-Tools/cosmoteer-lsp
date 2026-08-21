import { TOOL_NAME, toolVersion } from '../version';
import type { LintReport } from './report';

/**
 * The machine-readable report, for a script that wants the findings rather than a page to read.
 *
 * It deliberately carries no clock: the time a run took is the one thing that never repeats, and a
 * report that changes between two runs over unchanged files cannot be diffed, which is how a lint
 * gate is checked for drift in the first place.
 *
 * @param report the assembled report.
 * @returns the JSON text, ending in a newline.
 */
export const jsonReport = (report: LintReport): string =>
    `${JSON.stringify(
        {
            tool: { name: TOOL_NAME, version: toolVersion() },
            run: {
                folders: report.folders,
                scope: report.scope,
                files: report.files,
                passes: report.passes,
                gameData: {
                    available: report.gameData.available,
                    dataRoot: report.gameData.dataRoot ?? null,
                    source: report.gameData.source ?? null,
                    reason: report.gameData.reason ?? null,
                    skippedRules: report.gameData.skippedRules,
                },
            },
            summary: {
                reported: report.findings.length,
                scanned: report.scanned.length,
                error: report.counts.error,
                warning: report.counts.warning,
                info: report.counts.info,
                hint: report.counts.hint,
                failLevel: report.failLevel,
                failing: report.failing,
            },
            findings: report.findings.map((finding) => ({
                path: finding.path,
                ruleId: finding.ruleId,
                named: finding.named,
                severity: finding.severity,
                message: finding.message,
                startLine: finding.startLine,
                startColumn: finding.startColumn,
                endLine: finding.endLine,
                endColumn: finding.endColumn,
                unnecessary: finding.unnecessary,
            })),
        },
        null,
        2
    )}\n`;
