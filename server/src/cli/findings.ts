import { atLeastAsSevere, LintSeverity, ruleIdFor, UNTAGGED_RULE_ID } from './rule-ids';
import { reportPath, uriToFsPath } from './uri';

/** One diagnostic as it arrives over the wire, in the shape the LSP defines. */
export interface WireDiagnostic {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity?: number;
    code?: string | number;
    message: string;
    source?: string;
    tags?: number[];
}

/** One finding, in the file-and-line form every report format writes. */
export interface LintFinding {
    /** The absolute on-disk path of the file the finding is in. */
    file: string;
    /** The same file relative to its workspace folder, with forward slashes. */
    path: string;
    /** The rule that produced the finding, or {@link UNTAGGED_RULE_ID} when the server named none. */
    ruleId: string;
    /** Whether the server named the rule itself, rather than the report falling back. */
    named: boolean;
    severity: LintSeverity;
    message: string;
    /** One-based, the form every report format and every editor uses. The wire form is zero-based. */
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    /** Whether the editor fades the span out rather than underlining it (the LSP unnecessary tag). */
    unnecessary: boolean;
}

/** The LSP severity numbers, which the protocol leaves as bare integers. */
const WIRE_SEVERITY: Record<number, LintSeverity> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

/** The LSP diagnostic tag for a span the editor fades out. */
const UNNECESSARY_TAG = 1;

/**
 * Turn one published diagnostic into a finding.
 *
 * A diagnostic with no severity is an error, which is what the protocol says a client should
 * assume, and what the server itself does when a validator leaves the severity out.
 *
 * @param uri the URI the diagnostic was published for.
 * @param roots the workspace folder paths, used to shorten the reported file path.
 * @param diagnostic the diagnostic as it arrived.
 * @returns the finding.
 */
export const toFinding = (uri: string, roots: readonly string[], diagnostic: WireDiagnostic): LintFinding => {
    const file = uriToFsPath(uri);
    const ruleId = ruleIdFor(diagnostic.code);
    return {
        file,
        path: reportPath(roots, file),
        ruleId,
        named: ruleId !== UNTAGGED_RULE_ID,
        severity: WIRE_SEVERITY[diagnostic.severity ?? 1] ?? 'error',
        message: diagnostic.message,
        startLine: diagnostic.range.start.line + 1,
        startColumn: diagnostic.range.start.character + 1,
        endLine: diagnostic.range.end.line + 1,
        endColumn: diagnostic.range.end.character + 1,
        unnecessary: (diagnostic.tags ?? []).includes(UNNECESSARY_TAG),
    };
};

/**
 * Order findings so two runs over the same files produce byte-identical reports.
 *
 * The scan validates files concurrently, so the order they are published in is a race. Sorting on
 * the finding itself rather than on arrival is what makes a report diffable between runs. File
 * paths are compared as plain code points, since a locale-aware comparison would reorder a report
 * depending on the machine that produced it.
 *
 * @param findings the findings to order, which are not modified.
 * @returns a new array in report order.
 */
export const sortFindings = (findings: readonly LintFinding[]): LintFinding[] =>
    [...findings].sort(
        (a, b) =>
            compare(a.path, b.path) ||
            a.startLine - b.startLine ||
            a.startColumn - b.startColumn ||
            a.endLine - b.endLine ||
            a.endColumn - b.endColumn ||
            compare(a.ruleId, b.ruleId) ||
            compare(a.severity, b.severity) ||
            compare(a.message, b.message)
    );

/**
 * Compare two strings by code point, so the order never depends on the machine's locale.
 *
 * @param a the first string.
 * @param b the second string.
 * @returns a negative number, zero or a positive number, as a sort comparator wants.
 */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Which findings a report carries, and which of them decide the exit code. */
export interface FindingFilter {
    /** The least severe finding the report carries. */
    minSeverity: LintSeverity;
    /** Rule ids to keep, or undefined to keep every rule. */
    only?: ReadonlySet<string>;
    /** Rule ids to drop. */
    exclude: ReadonlySet<string>;
}

/**
 * Apply the severity threshold and the rule filters.
 *
 * @param findings the findings to filter.
 * @param filter what to keep.
 * @returns the findings that survive, in the order they were given.
 */
export const filterFindings = (findings: readonly LintFinding[], filter: FindingFilter): LintFinding[] =>
    findings.filter(
        (finding) =>
            atLeastAsSevere(finding.severity, filter.minSeverity) &&
            (filter.only === undefined || filter.only.has(finding.ruleId)) &&
            !filter.exclude.has(finding.ruleId)
    );

/**
 * Count the findings per severity.
 *
 * @param findings the findings to count.
 * @returns the count of each severity, including the ones that are zero.
 */
export const countBySeverity = (findings: readonly LintFinding[]): Record<LintSeverity, number> => {
    const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const finding of findings) counts[finding.severity]++;
    return counts;
};
