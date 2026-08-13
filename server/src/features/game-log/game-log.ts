/**
 * Reading the game's own log file.
 *
 * The game reports what it refused to load only in its log, and only while loading: a mod can be
 * shipped broken while the editor shows nothing, because the failure is a parse error the game hit
 * on a file the editor reads differently, or a reference that resolves only once every mod's actions
 * have been applied. Everything here is a recording of a past run, so nothing is inferred: a line
 * that does not match a shape the game's own throw sites produce is ignored rather than guessed at.
 *
 * Every message shape below was taken from the throwing code in the game's assemblies, so the
 * grammar is the complete one rather than whatever a particular log happened to contain.
 */

/** Each log line starts with an invariant-culture timestamp, whatever the user's locale is. */
const LINE_PREFIX = /^(\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d) {2}\| {2}/;

/** The inner exceptions of a `.NET` exception chain are indented with exactly this. */
const INNER_PREFIX = ' ---> ';

/** The censoring the logger applies to every line before writing it. */
export const HOME_FOLDER_TOKEN = "[user's home folder]";

/** One thing the game refused to load, as the log recorded it. */
export interface GameLogFinding {
    /** The file the game named, still as written in the log (the home folder may be censored). */
    readonly file: string;
    /** The path inside that file, empty when the message named none. */
    readonly otPath: string;
    /** The message to report, without the timestamp or the exception class name. */
    readonly message: string;
    /** The line the game reported, 1-based as the game counts, when it reported one. */
    readonly line?: number;
    /** The column the game reported, 1-based and counted in code units, when it reported one. */
    readonly character?: number;
    readonly severity: 'error' | 'warning';
    /** The timestamp of the line, which is when the game hit it. */
    readonly time: string;
}

/** What one log says: which mods ran, which game version, and what failed. */
export interface GameLogReport {
    readonly path: string;
    readonly gameVersion?: string;
    /** The ids of the mods the run had enabled. A mod that failed to load is missing from this. */
    readonly modIds: readonly string[];
    readonly findings: readonly GameLogFinding[];
}

/** One recognized message shape, and how to turn its match into a finding. */
interface Shape {
    readonly pattern: RegExp;
    readonly build: (match: RegExpExecArray) => Omit<GameLogFinding, 'severity' | 'time'> & {
        readonly severity?: GameLogFinding['severity'];
    };
}

const SHAPES: Shape[] = [
    // A file the game could not parse at all. The wrapper of the token error below, kept because a
    // premature end of file reports its position without a usable file name.
    {
        pattern: /^Halfling\.ObjectText\.OTParseException: Unable to parse file "([^"]+)"\.$/,
        build: (match) => ({ file: match[1], otPath: '', message: `The game could not read this file.` }),
    },
    // The token the parser stopped at. Line and Char are both 1-based, and Char counts code units
    // within the line, which is exactly what the editor's own positions count.
    {
        pattern: /^Halfling\.ObjectText\.OTParseException: Unexpected (?:"([^"]*)"|(EOF)) at position Line=(\d+),Char=(\d+) in file "([^"]+)"\.$/,
        build: (match) => ({
            file: match[5],
            otPath: '',
            message: match[2]
                ? 'The game reached the end of the file while it was still reading a value.'
                : `The game stopped reading here: unexpected ${describeToken(match[1])}.`,
            line: Number(match[3]),
            character: Number(match[4]),
        }),
    },
    // An end of file the parser did not expect. The game interpolates the wrong member into the file
    // slot here, so the file is taken from the wrapper above rather than from this message.
    {
        pattern: /^Halfling\.ObjectText\.OTParseException: Unexpected end-of-file at (?:position )?Line=(\d+),Char=(\d+) in file "[^"]*"\.$/,
        build: (match) => ({
            file: '',
            otPath: '',
            message: 'The game reached the end of the file while it was still reading a value.',
            line: Number(match[1]),
            character: Number(match[2]),
        }),
    },
    {
        pattern: /^Halfling\.Serialization\.DeserializeException: Deserialization from source "<([^>]*)>((?:\/[^"]*)?)" failed\.$/,
        build: (match) => ({ file: match[1], otPath: match[2], message: 'The game could not read this into the type it expects.' }),
    },
    {
        pattern: /^Halfling\.Serialization\.DeserializeException: Type name '([^']*)' at path '<([^>]*)>((?:\/[^']*)?)' is not a deserializable subclass of '([^']*)'\.$/,
        build: (match) => ({
            file: match[2],
            otPath: match[3],
            message: `The game does not know a '${match[1]}' here. It reads this as a ${shortName(match[4])}.`,
        }),
    },
    {
        pattern: /^Halfling\.ObjectText\.OTNavigateException: Unable to find final target "([^"]*)" of Reference at path "<([^>]*)>((?:\/[^"]*)?)"\.$/,
        build: (match) => ({
            file: match[2],
            otPath: match[3],
            message: `The reference here points at nothing: '${match[1]}' was not found.`,
        }),
    },
    {
        pattern: /^Halfling\.ObjectText\.OTNavigateException: Unable to find final target "([^"]*)" of inheritance reference at path <([^>]*)>((?:\/\S*)?)\.$/,
        build: (match) => ({
            file: match[2],
            otPath: match[3],
            message: `The inheritance here points at nothing: '${match[1]}' was not found.`,
        }),
    },
    {
        pattern: /^Halfling\.ObjectText\.OTNavigateException: Reference at "<([^>]*)>((?:\/\S*)?)" is circular\.$/,
        build: (match) => ({ file: match[1], otPath: match[2], message: 'This reference eventually points at itself.' }),
    },
    // The shader compiler, which reports its own line and column directly.
    {
        pattern: /^(.*?\.shader)\((\d+),(\d+)(?:-\d+)?\): (warning|error) (X\d+): (.*)$/,
        build: (match) => ({
            file: match[1],
            otPath: '',
            message: `${match[5]}: ${match[6]}`,
            line: Number(match[2]),
            character: Number(match[3]),
            severity: match[4] === 'error' ? ('error' as const) : ('warning' as const),
        }),
    },
];

/** The roster line naming one enabled mod, which is how a log is matched to a workspace. */
const ROSTER = /^\t\[(?:User Folder|Workshop ID \d+)\] - (\S+) \(.*\)$/;

/** The game version the run was, from the header line every log carries. */
const VERSION = /^Cosmoteer version (\S+) build \S+$/;

/**
 * The game prints the offending character as its numeric code, so it is rendered back as the
 * character itself where that reads better than the number.
 *
 * @param token the token text the log carried.
 * @returns the text to put in the message.
 */
const describeToken = (token: string): string => {
    const code = /^\d+$/.test(token) ? Number(token) : NaN;
    if (Number.isFinite(code) && code >= 32 && code <= 0x10ffff) return `'${String.fromCodePoint(code)}'`;
    return `'${token}'`;
};

/** The last segment of a dotted C# type name, which is what an author recognizes. */
const shortName = (fullName: string): string => fullName.split('.').pop() ?? fullName;

/**
 * Reads one game log.
 *
 * Exception chains are printed outermost first, with each inner exception on its own line, and the
 * innermost is the one that names the file the author has to fix: the outer ones name the files that
 * were loading it. So a chain reports one finding, the innermost recognized line.
 *
 * @param text the log file's contents.
 * @param path the log file's path, carried into the report.
 * @returns what the log says.
 */
export const parseGameLog = (text: string, path: string): GameLogReport => {
    const findings: GameLogFinding[] = [];
    const modIds: string[] = [];
    let gameVersion: string | undefined;
    let pending: GameLogFinding | undefined;
    // The wrapper naming the file, carried into an inner message whose own file slot is unusable.
    let wrapperFile = '';

    const flush = (): void => {
        if (pending) findings.push(pending);
        pending = undefined;
    };

    // Three of ten logs on this machine mix line endings, since the shader compiler block writes
    // bare newlines into a file the logger otherwise writes with carriage returns.
    for (const raw of text.split(/\r?\n/)) {
        const prefix = LINE_PREFIX.exec(raw);
        if (!prefix) continue;
        const time = prefix[1];
        const body = raw.slice(prefix[0].length);
        const inner = body.startsWith(INNER_PREFIX);
        const content = inner ? body.slice(INNER_PREFIX.length) : body;

        const version = VERSION.exec(content);
        if (version) {
            gameVersion = version[1];
            continue;
        }
        const roster = ROSTER.exec(content);
        if (roster) {
            modIds.push(roster[1]);
            continue;
        }
        // The game also logs a localized "could not load mod X" line, which repeats an exception it
        // has already printed in full, so nothing is read out of it.
        if (!content.startsWith('Halfling.') && !inner && !content.includes('.shader(')) continue;

        for (const shape of SHAPES) {
            const match = shape.pattern.exec(content);
            if (!match) continue;
            const built = shape.build(match);
            const finding: GameLogFinding = {
                ...built,
                file: built.file || wrapperFile,
                severity: built.severity ?? 'error',
                time,
            };
            if (built.file) wrapperFile = built.file;
            // An inner exception replaces the wrapper it came from, since the wrapper names the file
            // that was doing the loading while the innermost names the file to fix. A chain is only
            // ended by the next message that is not itself an inner one, since the stack frames
            // between them are written in the user's own language and cannot be recognized.
            if (inner && pending) pending = finding;
            else {
                flush();
                wrapperFile = built.file;
                pending = finding;
            }
            break;
        }
    }
    flush();

    // The same failure is logged again every time the game re-enumerates the mods, so one run can
    // report it three times.
    const seen = new Set<string>();
    const unique = findings.filter((finding) => {
        const key = `${finding.file}\u0000${finding.otPath}\u0000${finding.message}\u0000${finding.line ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return { path, gameVersion, modIds, findings: unique };
};
