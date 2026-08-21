import { resolve } from 'path';
import { LintSeverity, RULES, SEVERITY_ORDER } from './rule-ids';

/** How the run writes its findings. */
export type OutputFormat = 'text' | 'json' | 'sarif' | 'github';

/** Which files the whole-workspace pass covers, in the server's own wording. */
export type ValidationScope = 'allFiles' | 'modRulesReachable';

/** Everything one run needs, after the command line has been read. */
export interface LintOptions {
    /** Absolute paths of the folders to check, at least one. */
    folders: string[];
    /** The game path given on the command line, when one was. */
    gamePath?: string;
    /** Whether the run uses the game's own `Data` tree at all. */
    useGame: boolean;
    /** Whether a missing game tree stops the run instead of narrowing it. */
    requireGame: boolean;
    format: OutputFormat;
    /** Where the report goes, or undefined for standard output. */
    outFile?: string;
    /** The least severe finding that makes the run fail, or 'none' to never fail on findings. */
    failOn: LintSeverity | 'none';
    /** The least severe finding the report carries. */
    minSeverity: LintSeverity;
    scope: ValidationScope;
    /** Rule ids to report, or undefined to report every rule. */
    only?: Set<string>;
    /** Rule ids to leave out. */
    exclude: Set<string>;
    /** Whether the run gets a cache directory of its own, unused by anything before it. */
    freshCache: boolean;
    /** The per-file problem cap the server applies. */
    maxProblems: number;
    /** How long the scan may take before the run gives up on it. */
    timeoutMs: number;
    /** How many annotations the GitHub format writes before it stops. */
    annotationLimit: number;
    /** An explicit server bundle to run, for a checkout whose layout differs from the default. */
    serverPath?: string;
    /** Whether a machine-readable report may be written from a run without the game's data. */
    force: boolean;
    /** Whether progress is written to the error stream while the scan runs. */
    quiet: boolean;
    /** Whether the run answers the one question "does the game load this mod" instead of listing
     *  everything the editor would report. */
    assertLoads: boolean;
    /** Whether a load check that could not judge everything still passes. */
    allowUnverifiable: boolean;
}

/** What reading the command line produced. */
export type ParsedArguments =
    | { kind: 'run'; options: LintOptions }
    | { kind: 'help' }
    | { kind: 'version' }
    | { kind: 'error'; message: string };

const FORMATS: readonly OutputFormat[] = ['text', 'json', 'sarif', 'github'];
const SCOPES: readonly ValidationScope[] = ['allFiles', 'modRulesReachable'];

/** The per-file problem cap, which is the largest the settings accept. Trimming a lint run's own
 *  findings is what the severity and rule filters are for, so the cap is left wide open. */
const DEFAULT_MAX_PROBLEMS = 100000;

/** How long a scan may run. A first pass over a large mod on a cold cache takes minutes. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** How many GitHub annotations one run writes. A pull request view stops showing them long before
 *  this, and every one of them costs a line of workflow log. */
const DEFAULT_ANNOTATION_LIMIT = 50;

/**
 * Read the command line.
 *
 * @param argv the arguments after the script name.
 * @returns the options to run with, a request for the help or the version, or the reason the
 *     command line could not be understood.
 */
export const parseArguments = (argv: readonly string[]): ParsedArguments => {
    const folders: string[] = [];
    const exclude = new Set<string>();
    let only: Set<string> | undefined;
    let gamePath: string | undefined;
    let useGame = true;
    let requireGame = true;
    let format: OutputFormat = 'text';
    let outFile: string | undefined;
    let failOn: LintSeverity | 'none' = 'error';
    let minSeverity: LintSeverity | undefined;
    let scope: ValidationScope = 'modRulesReachable';
    let freshCache = false;
    let maxProblems = DEFAULT_MAX_PROBLEMS;
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    let annotationLimit = DEFAULT_ANNOTATION_LIMIT;
    let serverPath: string | undefined;
    let force = false;
    let quiet = false;
    let assertLoads = false;
    let allowUnverifiable = false;

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        /**
         * The value of the option being read, with a clear failure when it is missing.
         *
         * @returns the next argument, or undefined when the option was written last with no value.
         */
        const value = (): string | undefined => argv[++index];
        switch (argument) {
            case '--help':
            case '-h':
                return { kind: 'help' };
            case '--version':
                return { kind: 'version' };
            case '--game': {
                const given = value();
                if (given === undefined) return missingValue(argument);
                gamePath = given;
                break;
            }
            case '--no-game':
                useGame = false;
                break;
            case '--require-game':
                requireGame = true;
                break;
            case '--no-require-game':
                requireGame = false;
                break;
            case '--format': {
                const given = value();
                if (given === undefined) return missingValue(argument);
                if (!isOneOf(FORMATS, given)) return oneOfError(argument, FORMATS, given);
                format = given;
                break;
            }
            case '--out': {
                const given = value();
                if (given === undefined) return missingValue(argument);
                outFile = resolve(given);
                break;
            }
            case '--fail-on': {
                const given = value();
                if (given === undefined) return missingValue(argument);
                if (given !== 'none' && !isOneOf(SEVERITY_ORDER, given)) {
                    return oneOfError(argument, [...SEVERITY_ORDER, 'none'], given);
                }
                failOn = given;
                break;
            }
            case '--min-severity': {
                const given = value();
                if (given === undefined) return missingValue(argument);
                if (!isOneOf(SEVERITY_ORDER, given)) return oneOfError(argument, SEVERITY_ORDER, given);
                minSeverity = given;
                break;
            }
            case '--scope': {
                const given = value();
                if (given === undefined) return missingValue(argument);
                if (!isOneOf(SCOPES, given)) return oneOfError(argument, SCOPES, given);
                scope = given;
                break;
            }
            case '--rule': {
                const given = value();
                if (given === undefined) return missingValue(argument);
                if (!isKnownRule(given)) return unknownRule(argument, given);
                (only ??= new Set<string>()).add(given);
                break;
            }
            case '--no-rule': {
                const given = value();
                if (given === undefined) return missingValue(argument);
                if (!isKnownRule(given)) return unknownRule(argument, given);
                exclude.add(given);
                break;
            }
            case '--no-cache':
                freshCache = true;
                break;
            case '--max-problems': {
                const given = readCount(value(), argument, 1, DEFAULT_MAX_PROBLEMS);
                if (typeof given !== 'number') return given;
                maxProblems = given;
                break;
            }
            case '--timeout': {
                const given = readCount(value(), argument, 1, 24 * 60 * 60);
                if (typeof given !== 'number') return given;
                timeoutMs = given * 1000;
                break;
            }
            case '--annotation-limit': {
                const given = readCount(value(), argument, 0, 1000000);
                if (typeof given !== 'number') return given;
                annotationLimit = given;
                break;
            }
            case '--server': {
                const given = value();
                if (given === undefined) return missingValue(argument);
                serverPath = resolve(given);
                break;
            }
            case '--force':
                force = true;
                break;
            case '--quiet':
            case '-q':
                quiet = true;
                break;
            case '--assert-loads':
                assertLoads = true;
                break;
            case '--allow-unverifiable':
                allowUnverifiable = true;
                break;
            default:
                if (argument.startsWith('-')) {
                    return { kind: 'error', message: `"${argument}" is not an option this tool knows.` };
                }
                folders.push(resolve(argument));
        }
    }

    if (folders.length === 0) folders.push(resolve('.'));
    if (gamePath !== undefined && !useGame) {
        return { kind: 'error', message: 'A game path was given together with --no-game, which contradict each other.' };
    }
    if (only && exclude.size > 0) {
        return { kind: 'error', message: '--rule and --no-rule cannot both be used in one run.' };
    }
    if (assertLoads) {
        // Every target of an action is a path into the game's own data, so without that data every
        // one of them resolves to nothing and the check would report that no mod loads. There is no
        // weaker answer worth giving, so the two ways of asking for one are refused.
        if (!useGame || !requireGame) {
            return {
                kind: 'error',
                message:
                    '--assert-loads needs the game data, because every action target is a path into it. ' +
                    'Without it the check would report that no mod loads at all, so --no-game and --no-require-game cannot be used with it.',
            };
        }
        if (format === 'sarif' || format === 'github') {
            return {
                kind: 'error',
                message: `--assert-loads writes text or json. A ${format} report carries findings on lines, and this check answers one question about the whole mod.`,
            };
        }
    }
    if (allowUnverifiable && !assertLoads) {
        return { kind: 'error', message: '--allow-unverifiable only means something together with --assert-loads.' };
    }
    return {
        kind: 'run',
        options: {
            folders,
            gamePath,
            useGame,
            // Requiring a game tree that the run was told not to use could never be satisfied, so
            // asking for one turns the other off.
            requireGame: useGame && requireGame,
            format,
            outFile,
            failOn,
            // A machine-readable report is usually uploaded somewhere with a per-rule result cap,
            // and the hint-level passes alone produce thousands of findings on a large mod. Text
            // and JSON are read by a person or a script that asked for everything.
            minSeverity: minSeverity ?? (format === 'sarif' || format === 'github' ? 'warning' : 'hint'),
            scope,
            only,
            exclude,
            freshCache,
            maxProblems,
            timeoutMs,
            annotationLimit,
            serverPath,
            force,
            quiet,
            assertLoads,
            allowUnverifiable,
        },
    };
};

/**
 * Whether a value is one of a fixed set, narrowing it to that set's member type.
 *
 * @param allowed the accepted values.
 * @param value the value that was given.
 * @returns true when the value is one of them.
 */
const isOneOf = <T extends string>(allowed: readonly T[], value: string): value is T =>
    (allowed as readonly string[]).includes(value);

/**
 * Whether a rule id names a rule this build reports.
 *
 * @param id the id that was given.
 * @returns true when a rule carries it.
 */
const isKnownRule = (id: string): boolean => RULES.some((rule) => rule.id === id);

/**
 * The failure for an option written with no value after it.
 *
 * @param option the option name.
 * @returns the parse failure.
 */
const missingValue = (option: string): ParsedArguments => ({
    kind: 'error',
    message: `${option} needs a value after it.`,
});

/**
 * The failure for an option given a value outside its fixed set.
 *
 * @param option the option name.
 * @param allowed the values it accepts.
 * @param given the value that was written.
 * @returns the parse failure.
 */
const oneOfError = (option: string, allowed: readonly string[], given: string): ParsedArguments => ({
    kind: 'error',
    message: `${option} accepts ${allowed.join(', ')}, and "${given}" is none of them.`,
});

/**
 * The failure for a rule id no rule carries, listing what this build does report.
 *
 * @param option the option name.
 * @param given the id that was written.
 * @returns the parse failure.
 */
const unknownRule = (option: string, given: string): ParsedArguments => ({
    kind: 'error',
    message: `${option} was given "${given}", which is no rule this tool reports. Run --help to see the list.`,
});

/**
 * Read a whole number option and keep it inside its range.
 *
 * @param given the value that was written, if any.
 * @param option the option name, for the failure message.
 * @param least the smallest accepted value.
 * @param most the largest accepted value.
 * @returns the number, or the parse failure explaining what was wrong with it.
 */
const readCount = (
    given: string | undefined,
    option: string,
    least: number,
    most: number
): number | ParsedArguments => {
    if (given === undefined) return missingValue(option);
    const parsed = Number(given);
    if (!Number.isInteger(parsed) || parsed < least || parsed > most) {
        return { kind: 'error', message: `${option} accepts a whole number from ${least} to ${most}.` };
    }
    return parsed;
};

/**
 * The help text, which is also the reference for what a rule id means.
 *
 * @returns the text to print.
 */
export const helpText = (): string => {
    const ruleLines = RULES.map((rule) => `  ${rule.id.padEnd(32)}${rule.title}`).join('\n');
    return `Check a Cosmoteer mod the way the editor checks it, and report what it finds.

Usage
  node out/server/src/cli/lint.mjs [options] [folder...]

With no folder, the current directory is checked. Every folder given is checked as one project.

Game data
  --game <path>            The Cosmoteer install to read the game's own data from. The path has to
                           end with Data, Cosmoteer or common. Without this the Steam libraries are
                           searched, and COSMOTEER_GAME or COSMOTEER_DATA_DIR are read first.
  --no-game                Run without the game's data at all. Several checks cannot run, and the
                           reference and asset checks report vanilla paths as missing, so the run is
                           not a clean bill of health. Cannot be used with --assert-loads.
  --require-game           Stop with exit code 3 when the game's data cannot be found. This is the
                           default, because a run without it reports far less and far worse.
  --no-require-game        Run anyway when the game's data cannot be found.

What is checked
  --scope <scope>          allFiles, or modRulesReachable to check only the files the game loads
                           through the manifest. Default modRulesReachable.
  --rule <id>              Report only this rule. May be given more than once.
  --no-rule <id>           Leave this rule out. May be given more than once.
  --min-severity <level>   error, warning, info or hint. Default hint for text and json, warning for
                           sarif and github.
  --max-problems <n>       The per-file limit the server applies. Default ${DEFAULT_MAX_PROBLEMS}.

Output
  --format <format>        text, json, sarif or github. Default text.
  --out <file>             Write the report to a file instead of standard output.
  --annotation-limit <n>   How many annotations the github format writes. Default ${DEFAULT_ANNOTATION_LIMIT}.
  --force                  Write a sarif or github report even from a run without the game's data.
  --quiet, -q              Do not write progress to the error stream.

Does the mod load
  --assert-loads           Answer one question instead of listing findings: does the game load this
                           mod. Every folder given has to hold a mod.rules. The report says what
                           stops the mod loading, and names everything it could not judge rather
                           than counting it as a pass. Writes text or json.
  --allow-unverifiable     Let such a run pass when nothing failed and something could not be
                           judged. Without it that run ends with exit code 6.

Running
  --fail-on <level>        The least severe finding that makes the run fail: error, warning, info,
                           hint or none. Default error.
  --no-cache               Give the run a cache directory of its own, so nothing from an earlier run
                           is reused. Slower, and the only way to compare two runs honestly.
  --timeout <seconds>      Give up on a scan that takes longer. Default ${DEFAULT_TIMEOUT_MS / 1000}.
  --server <path>          The server bundle to run. Defaults to server.mjs beside this file.
  --version                Print the version and exit.
  --help, -h               Print this text and exit.

Exit codes
  0  The scan finished and nothing reached the level --fail-on names, or the mod loads.
  1  The scan finished and something reached that level, or something stops the mod loading.
  2  The command line could not be understood.
  3  The game's data was required and could not be used.
  4  The scan did not finish.
  5  The report could not be written.
  6  The load check found nothing that fails and could not judge everything it found.

Rules
${ruleLines}

The game's own data cannot be copied into a build service, so a run there needs Cosmoteer installed
on the machine that runs it. Without it the run stops with exit code 3 rather than reporting a
result it did not earn.
`;
};
