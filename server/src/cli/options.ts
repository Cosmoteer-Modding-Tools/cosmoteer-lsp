import { resolve } from 'path';
import { LintSeverity, RULES, SEVERITY_ORDER } from '../features/diagnostics/rule-ids';

/** How the run writes its findings. */
type OutputFormat = 'text' | 'json' | 'sarif' | 'github';

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
type ParsedArguments =
    { kind: 'run'; options: LintOptions } | { kind: 'help' } | { kind: 'version' } | { kind: 'error'; message: string };

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

/** Everything the written command line sets, before the run's options are made of it. */
interface ParseState {
    folders: string[];
    exclude: Set<string>;
    only?: Set<string>;
    gamePath?: string;
    useGame: boolean;
    requireGame: boolean;
    format: OutputFormat;
    outFile?: string;
    failOn: LintSeverity | 'none';
    /** The level that was asked for, or undefined to let the format decide it. */
    minSeverity?: LintSeverity;
    scope: ValidationScope;
    freshCache: boolean;
    maxProblems: number;
    timeoutMs: number;
    annotationLimit: number;
    serverPath?: string;
    force: boolean;
    quiet: boolean;
    assertLoads: boolean;
    allowUnverifiable: boolean;
}

/** One option the command line accepts. */
interface FlagRow {
    /** Every spelling that selects this row. */
    flags: readonly string[];
    /** Whether the argument after the flag belongs to it. */
    takesValue?: boolean;
    /**
     * Read one written option into the state the run is built from.
     *
     * @param state what the command line has set so far.
     * @param value the argument after the flag, empty for an option that takes none.
     * @param option the spelling that was written, for the failure message.
     * @returns the answer that ends the command line, or undefined when the option was read.
     */
    read(state: ParseState, value: string, option: string): ParsedArguments | undefined;
}

// Every option the tool accepts, as a table rather than as one long switch. The flag names are a
// public contract, so a row is the whole of what one option does and the help text below lists the
// same names in the words a reader needs.
const FLAG_ROWS: readonly FlagRow[] = [
    { flags: ['--help', '-h'], read: () => ({ kind: 'help' }) },
    { flags: ['--version'], read: () => ({ kind: 'version' }) },
    {
        flags: ['--game'],
        takesValue: true,
        read: (state, value) => {
            state.gamePath = value;
            return undefined;
        },
    },
    {
        flags: ['--no-game'],
        read: (state) => {
            state.useGame = false;
            return undefined;
        },
    },
    {
        flags: ['--require-game'],
        read: (state) => {
            state.requireGame = true;
            return undefined;
        },
    },
    {
        flags: ['--no-require-game'],
        read: (state) => {
            state.requireGame = false;
            return undefined;
        },
    },
    {
        flags: ['--format'],
        takesValue: true,
        read: (state, value, option) => {
            if (!isOneOf(FORMATS, value)) return oneOfError(option, FORMATS, value);
            state.format = value;
            return undefined;
        },
    },
    {
        flags: ['--out'],
        takesValue: true,
        read: (state, value) => {
            state.outFile = resolve(value);
            return undefined;
        },
    },
    {
        flags: ['--fail-on'],
        takesValue: true,
        read: (state, value, option) => {
            if (value !== 'none' && !isOneOf(SEVERITY_ORDER, value)) {
                return oneOfError(option, [...SEVERITY_ORDER, 'none'], value);
            }
            state.failOn = value;
            return undefined;
        },
    },
    {
        flags: ['--min-severity'],
        takesValue: true,
        read: (state, value, option) => {
            if (!isOneOf(SEVERITY_ORDER, value)) return oneOfError(option, SEVERITY_ORDER, value);
            state.minSeverity = value;
            return undefined;
        },
    },
    {
        flags: ['--scope'],
        takesValue: true,
        read: (state, value, option) => {
            if (!isOneOf(SCOPES, value)) return oneOfError(option, SCOPES, value);
            state.scope = value;
            return undefined;
        },
    },
    {
        flags: ['--rule'],
        takesValue: true,
        read: (state, value, option) => {
            if (!isKnownRule(value)) return unknownRule(option, value);
            (state.only ??= new Set<string>()).add(value);
            return undefined;
        },
    },
    {
        flags: ['--no-rule'],
        takesValue: true,
        read: (state, value, option) => {
            if (!isKnownRule(value)) return unknownRule(option, value);
            state.exclude.add(value);
            return undefined;
        },
    },
    {
        flags: ['--no-cache'],
        read: (state) => {
            state.freshCache = true;
            return undefined;
        },
    },
    {
        flags: ['--max-problems'],
        takesValue: true,
        read: (state, value, option) => {
            const count = readCount(value, option, 1, DEFAULT_MAX_PROBLEMS);
            if (typeof count !== 'number') return count;
            state.maxProblems = count;
            return undefined;
        },
    },
    {
        flags: ['--timeout'],
        takesValue: true,
        read: (state, value, option) => {
            const count = readCount(value, option, 1, 24 * 60 * 60);
            if (typeof count !== 'number') return count;
            state.timeoutMs = count * 1000;
            return undefined;
        },
    },
    {
        flags: ['--annotation-limit'],
        takesValue: true,
        read: (state, value, option) => {
            const count = readCount(value, option, 0, 1000000);
            if (typeof count !== 'number') return count;
            state.annotationLimit = count;
            return undefined;
        },
    },
    {
        flags: ['--server'],
        takesValue: true,
        read: (state, value) => {
            state.serverPath = resolve(value);
            return undefined;
        },
    },
    {
        flags: ['--force'],
        read: (state) => {
            state.force = true;
            return undefined;
        },
    },
    {
        flags: ['--quiet', '-q'],
        read: (state) => {
            state.quiet = true;
            return undefined;
        },
    },
    {
        flags: ['--assert-loads'],
        read: (state) => {
            state.assertLoads = true;
            return undefined;
        },
    },
    {
        flags: ['--allow-unverifiable'],
        read: (state) => {
            state.allowUnverifiable = true;
            return undefined;
        },
    },
];

/** Every spelling the command line accepts, pointing at the row that reads it. */
const FLAG_BY_NAME = new Map(FLAG_ROWS.flatMap((row) => row.flags.map((flag) => [flag, row] as const)));

/**
 * The state a run starts from, before the command line has set anything.
 *
 * @returns the defaults, as a fresh object every call.
 */
const initialState = (): ParseState => ({
    folders: [],
    exclude: new Set<string>(),
    useGame: true,
    requireGame: true,
    format: 'text',
    failOn: 'error',
    scope: 'modRulesReachable',
    freshCache: false,
    maxProblems: DEFAULT_MAX_PROBLEMS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    annotationLimit: DEFAULT_ANNOTATION_LIMIT,
    force: false,
    quiet: false,
    assertLoads: false,
    allowUnverifiable: false,
});

/**
 * Read the command line.
 *
 * @param argv the arguments after the script name.
 * @returns the options to run with, a request for the help or the version, or the reason the
 *     command line could not be understood.
 */
export const parseArguments = (argv: readonly string[]): ParsedArguments => {
    const state = initialState();
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        const row = FLAG_BY_NAME.get(argument);
        if (!row) {
            if (argument.startsWith('-')) {
                return { kind: 'error', message: `"${argument}" is not an option this tool knows.` };
            }
            state.folders.push(resolve(argument));
            continue;
        }
        let value = '';
        if (row.takesValue) {
            const given = argv[++index];
            if (given === undefined) return missingValue(argument);
            value = given;
        }
        const answer = row.read(state, value, argument);
        if (answer) return answer;
    }
    return runOptions(state);
};

/**
 * Make the run's options out of what the command line set, refusing the options that contradict
 * each other.
 *
 * @param state what the command line set.
 * @returns the options to run with, or the reason the command line could not be followed.
 */
const runOptions = (state: ParseState): ParsedArguments => {
    if (state.folders.length === 0) state.folders.push(resolve('.'));
    if (state.gamePath !== undefined && !state.useGame) {
        return {
            kind: 'error',
            message: 'A game path was given together with --no-game, which contradict each other.',
        };
    }
    if (state.only && state.exclude.size > 0) {
        return { kind: 'error', message: '--rule and --no-rule cannot both be used in one run.' };
    }
    if (state.assertLoads) {
        // Every target of an action is a path into the game's own data, so without that data every
        // one of them resolves to nothing and the check would report that no mod loads. There is no
        // weaker answer worth giving, so the two ways of asking for one are refused.
        if (!state.useGame || !state.requireGame) {
            return {
                kind: 'error',
                message:
                    '--assert-loads needs the game data, because every action target is a path into it. ' +
                    'Without it the check would report that no mod loads at all, so --no-game and --no-require-game cannot be used with it.',
            };
        }
        if (state.format === 'sarif' || state.format === 'github') {
            return {
                kind: 'error',
                message: `--assert-loads writes text or json. A ${state.format} report carries findings on lines, and this check answers one question about the whole mod.`,
            };
        }
    }
    if (state.allowUnverifiable && !state.assertLoads) {
        return { kind: 'error', message: '--allow-unverifiable only means something together with --assert-loads.' };
    }
    return {
        kind: 'run',
        options: {
            folders: state.folders,
            gamePath: state.gamePath,
            useGame: state.useGame,
            // Requiring a game tree that the run was told not to use could never be satisfied, so
            // asking for one turns the other off.
            requireGame: state.useGame && state.requireGame,
            format: state.format,
            outFile: state.outFile,
            failOn: state.failOn,
            // A machine-readable report is usually uploaded somewhere with a per-rule result cap,
            // and the hint-level passes alone produce thousands of findings on a large mod. Text
            // and JSON are read by a person or a script that asked for everything.
            minSeverity:
                state.minSeverity ?? (state.format === 'sarif' || state.format === 'github' ? 'warning' : 'hint'),
            scope: state.scope,
            only: state.only,
            exclude: state.exclude,
            freshCache: state.freshCache,
            maxProblems: state.maxProblems,
            timeoutMs: state.timeoutMs,
            annotationLimit: state.annotationLimit,
            serverPath: state.serverPath,
            force: state.force,
            quiet: state.quiet,
            assertLoads: state.assertLoads,
            allowUnverifiable: state.allowUnverifiable,
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
 * @param given the value that was written.
 * @param option the option name, for the failure message.
 * @param least the smallest accepted value.
 * @param most the largest accepted value.
 * @returns the number, or the parse failure explaining what was wrong with it.
 */
const readCount = (given: string, option: string, least: number, most: number): number | ParsedArguments => {
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
  cosmoteer-rules-lint [options] [folder...]

Installed globally that is the command. Without installing it, "npx cosmoteer-rules-lint" runs the
same thing, and a copy unpacked from a release archive is started as
"node cosmoteer-rules-lint/cli/lint.mjs".

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
