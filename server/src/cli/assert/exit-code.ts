import type { AssertReport } from './model';

// The exit code is the whole product of this mode: a build gate reads the number and nothing else.
// It keeps the codes the lint command already promises and adds one, because "the mod loads" and
// "nothing that was checked failed, and some of it was not checked" are different answers and a
// gate that cannot tell them apart is the failure this command exists to prevent.

/** Every action was judged and none of them stops the mod loading. */
const EXIT_LOADS = 0;
/** Something stops the game loading the mod. */
const EXIT_DOES_NOT_LOAD = 1;
/** Nothing failed, and something could not be judged at all. */
const EXIT_NOT_FULLY_CHECKED = 6;

/**
 * The exit code for a finished load check.
 *
 * A failure wins over an incomplete check: a run that found both has found the more serious of the
 * two, and a gate keyed on code 1 has to see it. `--allow-unverifiable` only lowers the incomplete
 * answer, never the failing one.
 *
 * @param report the finished report.
 * @param allowUnverifiable whether the run accepts a check that could not judge everything.
 * @returns the code the process ends with.
 */
export const assertExitCode = (report: AssertReport, allowUnverifiable: boolean): number => {
    if (report.loadBlocking > 0) return EXIT_DOES_NOT_LOAD;
    if (report.complete || allowUnverifiable) return EXIT_LOADS;
    return EXIT_NOT_FULLY_CHECKED;
};
