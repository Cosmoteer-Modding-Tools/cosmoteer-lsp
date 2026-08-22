import type { LintFinding } from '../findings';
import type { GamePathSource } from '../game-path';
import type { ValidationScope } from '../options';
import type { LintSeverity } from '../rule-ids';

/** What the run knows about the game's own data, which decides how much the result is worth. */
export interface GameDataStatus {
    /** Whether the game `Data` tree was found and handed to the server. */
    available: boolean;
    /** The `Data` directory the run used, when it had one. */
    dataRoot?: string;
    /** Where the path came from, when there was one. */
    source?: GamePathSource;
    /** Why there is none, when there is none. */
    reason?: string;
    /** The ids of the rules that could not run without it. */
    skippedRules: string[];
}

/** Everything a report writer needs. Assembled once so every format says the same thing. */
export interface LintReport {
    /** The folders the run covered, absolute. */
    folders: string[];
    scope: ValidationScope;
    gameData: GameDataStatus;
    /** How many files the server published results for, clean ones included. */
    files: number;
    /** How many whole-workspace passes ran before the result settled. */
    passes: number;
    /** How long the scan took, which only the text report shows. */
    elapsedMs: number;
    /** Everything the scan produced, before the severity and rule filters. */
    scanned: LintFinding[];
    /** The findings this report carries, in report order. */
    findings: LintFinding[];
    /** How many of the reported findings carry each severity. */
    counts: Record<LintSeverity, number>;
    /** The level a finding has to reach to fail the run. */
    failLevel: LintSeverity | 'none';
    /** How many reported findings reached that level. */
    failing: number;
    /** How many findings the GitHub format may annotate. */
    annotationLimit: number;
}

/**
 * Format a count with its noun, in singular or plural.
 *
 * @param count how many.
 * @param singular the noun for one.
 * @param plural the noun for any other number, defaulting to the singular with an s.
 * @returns the count and the noun.
 */
export const plural = (count: number, singular: string, plural = `${singular}s`): string =>
    `${count} ${count === 1 ? singular : plural}`;

/**
 * Say where the game path came from, in words rather than in the flag that produced it.
 *
 * @param source the source recorded on the status.
 * @returns a phrase to put after the path.
 */
export const gamePathOrigin = (source: GamePathSource | undefined): string => {
    if (source === 'option') return 'given with --game';
    if (source === 'environment') return 'read from the environment';
    if (source === 'auto-detect') return 'found by searching the Steam libraries';
    return 'not set';
};
