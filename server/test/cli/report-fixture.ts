import { countBySeverity, LintFinding, sortFindings } from '../../src/cli/findings';
import type { GameDataStatus, LintReport } from '../../src/cli/report/report';
import { atLeastAsSevere, GAME_DATA_RULES, LintSeverity } from '../../src/cli/rule-ids';

/** The parts of a finding a test cares about, with everything else filled in. */
export interface FindingSeed {
    path?: string;
    ruleId?: string;
    named?: boolean;
    severity?: LintSeverity;
    message?: string;
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
    unnecessary?: boolean;
}

/**
 * Build one finding for a formatter test, without going near a language server.
 *
 * @param seed the fields the test cares about.
 * @returns a complete finding.
 */
export const finding = (seed: FindingSeed = {}): LintFinding => {
    const path = seed.path ?? 'parts/foo.rules';
    return {
        file: `C:\\mods\\demo\\${path.replace(/\//g, '\\')}`,
        path,
        ruleId: seed.ruleId ?? 'validateRequiredFields',
        named: seed.named ?? true,
        severity: seed.severity ?? 'error',
        message: seed.message ?? 'Part is missing the field "Size".',
        startLine: seed.startLine ?? 3,
        startColumn: seed.startColumn ?? 5,
        endLine: seed.endLine ?? 3,
        endColumn: seed.endColumn ?? 9,
        unnecessary: seed.unnecessary ?? false,
    };
};

/** The parts of a report a test sets, with everything else filled in. */
export interface ReportSeed {
    findings?: LintFinding[];
    folders?: string[];
    gameData?: Partial<GameDataStatus>;
    failLevel?: LintSeverity | 'none';
    annotationLimit?: number;
    files?: number;
    passes?: number;
}

/**
 * Build a report for a formatter test, with the counts and the failure total derived the way the
 * real run derives them.
 *
 * @param seed the fields the test cares about.
 * @returns a complete report.
 */
export const report = (seed: ReportSeed = {}): LintReport => {
    const findings = sortFindings(seed.findings ?? [finding()]);
    const failLevel = seed.failLevel ?? 'error';
    const gameData: GameDataStatus = {
        available: true,
        dataRoot: 'C:\\Games\\Cosmoteer\\Data',
        source: 'option',
        skippedRules: [],
        ...seed.gameData,
    };
    return {
        folders: seed.folders ?? ['C:\\mods\\demo'],
        scope: 'modRulesReachable',
        gameData,
        files: seed.files ?? 12,
        passes: seed.passes ?? 1,
        elapsedMs: 1234,
        scanned: findings,
        findings,
        counts: countBySeverity(findings),
        failLevel,
        failing:
            failLevel === 'none'
                ? 0
                : findings.filter((entry) => atLeastAsSevere(entry.severity, failLevel)).length,
        annotationLimit: seed.annotationLimit ?? 50,
    };
};

/** The status a run without the game's data carries, with every game-gated rule named as skipped. */
export const withoutGameData: Partial<GameDataStatus> = {
    available: false,
    dataRoot: undefined,
    source: undefined,
    reason: 'The run was started with --no-game.',
    skippedRules: GAME_DATA_RULES.map((rule) => rule.id),
};
