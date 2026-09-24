/**
 * Reading the game's own log file.
 *
 * The game reports what it refused to load only in its log, and only while loading: a mod can be
 * shipped broken while the editor shows nothing, because the failure is a parse error the game hit
 * on a file the editor reads differently, or a reference that resolves only once every mod's actions
 * have been applied. Everything here is a recording of a past run, so nothing is inferred: a line
 * that does not match a shape the game's own throw sites produce is counted rather than guessed at.
 *
 * The shapes come from {@link ENGINE_MESSAGES}, which carries the format strings as the engine
 * writes them, each with the site it was read from. The patterns are derived from those strings
 * rather than written out by hand, so an entry can be checked against the engine one line at a time.
 *
 * What no shape matched is not dropped. A failure line the run wrote while it was loading its mods
 * is counted as unplaced, and a run that died applying a mod's actions is named, because an
 * affirmative all clear for such a run is the one answer this reader must never give.
 */

/** Each log line starts with an invariant-culture timestamp, whatever the user's locale is. */
const LINE_PREFIX = /^(\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d) {2}\| {2}/;

/** The inner exceptions of a `.NET` exception chain are indented with exactly this. */
const INNER_PREFIX = ' ---> ';

/** The censoring the logger applies to every line before writing it. */
export const HOME_FOLDER_TOKEN = "[user's home folder]";

/**
 * The line the game writes before it names the mods it is about to apply
 * (`Cosmoteer.Data/Assets.cs:431`). Everything the run failed at while it loaded its data stands
 * after this line.
 */
const LOAD_WINDOW_OPENS = 'Enabled mods:';

/**
 * The line the game writes once the whole rules tree is read (`Cosmoteer.Data/Assets.cs:407`). A
 * run that never wrote it did not finish loading.
 */
const LOAD_WINDOW_CLOSES = 'Loaded game data in ';

/**
 * A line that opens or continues a `.NET` exception chain. The class name is what marks it, since
 * the frames between the parts of a chain are written in the user's own language.
 */
const EXCEPTION_LINE = /^(?:[A-Za-z_]\w*\.)*\w*(?:Exception|Error): /;

/**
 * The wrapper `ModInfo.ApplyPreLoadMods` puts round every failure of a mod's actions
 * (`Cosmoteer.Mods/ModInfo.cs:121`). It carries the mod's display `Name`, which is not the `ID` the
 * roster line prints, so the name is reported rather than matched against anything.
 */
const MOD_LOAD_FAILURE = /^System\.Exception: Error loading mod: (.*)$/;

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

/**
 * A failure the run wrote while it was loading its mods that no shape here could place. It is kept
 * as written, with nowhere to put it, because saying which file it belongs to would be a guess.
 */
export interface UnplacedFailure {
    /** The outermost line of the chain, without the timestamp. */
    readonly text: string;
    /** The line of the log file it stands on, 1-based, so a reader can be taken to it. */
    readonly logLine: number;
    readonly time: string;
}

/** A run that died while one mod's actions were applied, so nothing after it loaded. */
export interface ModLoadFailure {
    /** The mod's display name, as the manifest's `Name` field writes it. */
    readonly name: string;
    /** The innermost line of the chain, which says what the action tripped over. */
    readonly detail: string;
    /** The line of the log file the wrapper stands on, 1-based. */
    readonly logLine: number;
    readonly time: string;
}

/** What one log says: which mods ran, which game version, and what failed. */
export interface GameLogReport {
    readonly path: string;
    readonly gameVersion?: string;
    /** The ids of the mods the run had enabled. A mod that failed to load is missing from this. */
    readonly modIds: readonly string[];
    readonly findings: readonly GameLogFinding[];
    /** Failures the run wrote while it loaded its mods that no shape here could place. */
    readonly unplaced: readonly UnplacedFailure[];
    /** The mods the run died on while their actions were applied. */
    readonly modLoadFailures: readonly ModLoadFailure[];
}

/** What one slot of a format string stands for. */
type SlotKind = 'source' | 'value' | 'int';

/**
 * What each kind of slot matches in a written line.
 *
 * A `source` is an `IOTNode.PathWithFile` (`halfling/Halfling.ObjectText/OTNode.cs:106`), which
 * renders as the file in angle brackets followed by one `/name` per step down the tree, so it
 * yields two groups rather than one.
 */
const SLOT_PATTERNS: Readonly<Record<SlotKind, string>> = {
    source: '<([^>]*)>((?:/[^"\'\\n]*)?)',
    value: '(.*?)',
    int: '(\\d+)',
};

/** The file and the inner path one `source` slot matched. */
interface SourceSlot {
    file: string;
    otPath: string;
}

/** What a format string's slots matched in one line. */
export interface Slots {
    /**
     * The text one `value` or `int` slot matched.
     *
     * @param name the slot's name as the format string writes it.
     * @returns the matched text, empty when the slot matched nothing.
     */
    value(name: string): string;
    /**
     * The file and inner path one `source` slot matched.
     *
     * @param name the slot's name as the format string writes it.
     * @returns the two halves of the path.
     */
    source(name: string): SourceSlot;
}

/** One message the engine writes, as its format string stands in the decompiled source. */
export interface EngineMessage {
    /** The exception class the game prints in front of the message. */
    exception: string;
    /** The format string as the engine writes it, with `{name}` where it interpolates. */
    format: string;
    /** The site the format string was read from, so one entry can be rechecked on its own. */
    engine: string;
    /**
     * Turn what the slots matched into the finding to report.
     *
     * @param slots what the format string's slots matched.
     * @returns the finding, without the severity and the time the reader adds.
     */
    to: (slots: Slots) => Omit<GameLogFinding, 'severity' | 'time'> & { severity?: GameLogFinding['severity'] };
}

/**
 * The target of a mod action, or of anything else that walks a path through the tree
 * (`halfling/Halfling.ObjectText/OTNode.cs:185` and `:203`, reached from
 * `cosmoteer/Cosmoteer.Mods/ModAddAction.cs:59` and its sibling verbs).
 *
 * The path is the one the action wrote, so it names a file of the game's own data or of another mod
 * rather than a file of this mod, and the reader reports it as the run's own words instead of
 * putting a mark on a file it cannot identify. The slot is a `source`, so a bare path with no file
 * in it, which the same throw site also produces from a type's own read, matches nothing and is left
 * to be counted as unplaced.
 *
 * @param verb the word the message uses for what it was doing.
 * @param format the format string as the engine writes it.
 * @returns the entry.
 */
const navigateMessage = (verb: string, format: string): EngineMessage => ({
    exception: 'Halfling.ObjectText.OTNavigateException',
    format,
    engine: `halfling/Halfling.ObjectText/OTNode.cs, ${verb}`,
    to: (slots) => ({
        file: '',
        otPath: '',
        message: `The game found nothing at "${pathText(slots.source('source'))}", which something points at.`,
    }),
});

/**
 * Every engine message this reader places, in the order it tries them. The ones whose format string
 * is a prefix of another stand first, since the first match wins.
 *
 * The deserialization family is the long one on purpose. `BaseSerializer` wraps a failure as
 * `Deserialization from source "…" failed.` only when what it caught is not itself a
 * `DeserializeException` (`halfling/Halfling.Serialization.Base/BaseSerializer.cs:2328` and `:2403`
 * both read `when (!(ex is ThreadAbortException) && !(ex is DeserializeException))`), so a failure
 * the serializer raises itself reaches the log with no wrapper round it whenever no reflected
 * constructor sits between the two. Matching the wrapper alone therefore misses whole families.
 */
export const ENGINE_MESSAGES: readonly EngineMessage[] = [
    {
        exception: 'Halfling.ObjectText.OTParseException',
        format: 'Unable to parse file "{value}".',
        engine: 'halfling/Halfling.ObjectText/OTFile.cs:314',
        to: (slots) => ({ file: slots.value('value'), otPath: '', message: 'The game could not read this file.' }),
    },
    {
        exception: 'Halfling.ObjectText.OTParseException',
        format: "Group at path '{source}' already contains a node named '{value}'.",
        engine: 'halfling/Halfling.ObjectText/OTGroupNode.cs:1676',
        to: (slots) => ({
            ...slots.source('source'),
            message: `"${slots.value('value')}" is written twice in this scope, so the game refuses the whole file.`,
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: 'Deserialization from source "{source}" failed.',
        engine: 'halfling/Halfling.Serialization.Base/BaseSerializer.cs:2329',
        to: (slots) => ({
            ...slots.source('source'),
            message: 'The game could not read this into the type it expects.',
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: 'Reflecting from source "{source}" failed.',
        engine: 'halfling/Halfling.Serialization.Base/BaseSerializer.cs:2524',
        to: (slots) => ({
            ...slots.source('source'),
            message: 'The game could not read the fields of this into the type it expects.',
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: "Deserializing from null source '{source}' but the requested type '{value}' isn't nullable.",
        engine: 'halfling/Halfling.Serialization.Base/BaseSerializer.cs:2214',
        to: (slots) => ({
            ...slots.source('source'),
            message: `This is empty, and the game reads it as a ${shortName(slots.value('value'))}, which cannot be empty.`,
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: 'Unable to find source for non-optional field "{value}" in source "{source}".',
        engine: 'halfling/Halfling.Serialization.Base/BaseSerializer.cs:2452',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The game needs a field called "${slots.value('value')}" here and found none.`,
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: 'Unable to find source for non-optional property "{value}" in source "{source}".',
        engine: 'halfling/Halfling.Serialization.Base/BaseSerializer.cs:2496',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The game needs a field called "${slots.value('value')}" here and found none.`,
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: "Type name '{value}' at path '{source}' is not a deserializable subclass of '{value2}'.",
        engine: 'halfling/Halfling.Serialization.Base/BaseSerializer.cs:933',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The game does not know a '${slots.value('value')}' here. It reads this as a ${shortName(slots.value('value2'))}.`,
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: 'Unable to find node at path "{value}" or any of its aliases relative to "{source}".',
        engine: 'halfling/Halfling.Serialization.ObjectText/ObjectTextSerializer.cs:98',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The game looked for "${slots.value('value')}" or one of its other names here and found neither.`,
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: 'Unable to find node at path "{value}" relative to "{source}".',
        engine: 'halfling/Halfling.Serialization.ObjectText/ObjectTextSerializer.cs:75',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The game looked for "${slots.value('value')}" here and found none.`,
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: 'Error evaluating math expression at path "{source}": {value}',
        engine: 'halfling/Halfling.Serialization.ObjectText/ExpressionEvaluator.cs:82',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The game could not work out this math expression: ${slots.value('value')}`,
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: 'Math expression at path "{source}" evaluated to {value} which is not compatible with the desired type \'{value2}\'',
        engine: 'halfling/Halfling.Serialization.ObjectText/ExpressionEvaluator.cs:91',
        to: (slots) => ({
            ...slots.source('source'),
            message: `This math expression works out to ${slots.value('value')}, which the game cannot read as a ${shortName(slots.value('value2'))}.`,
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: "Reference '{value}' in expression at path '{source}' does not refer to a field node.",
        engine: 'halfling/Halfling.Serialization.ObjectText/ExpressionEvaluator.cs:117',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The reference '${slots.value('value')}' in this expression does not name a field.`,
        }),
    },
    {
        exception: 'Halfling.ObjectText.OTNavigateException',
        format: 'Unable to find final target "{value}" of Reference at path "{source}".',
        engine: 'halfling/Halfling.ObjectText/OTReferenceNode.cs:183',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The reference here points at nothing: '${slots.value('value')}' was not found.`,
        }),
    },
    {
        exception: 'Halfling.ObjectText.OTNavigateException',
        format: 'Unable to find final target "{value}" of inheritance reference at path {source}.',
        engine: 'halfling/Halfling.ObjectText/OTGroupNode.cs:1475',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The inheritance here points at nothing: '${slots.value('value')}' was not found.`,
        }),
    },
    {
        exception: 'Halfling.ObjectText.OTNavigateException',
        format: "The Group at path '{source}' specifies that it inherits from a Group at path '{source2}' but the node at that path is not a Group.",
        engine: 'halfling/Halfling.ObjectText/OTGroupNode.cs:1482',
        to: (slots) => ({
            ...slots.source('source'),
            message: `This inherits from "${pathText(slots.source('source2'))}", which is not a group.`,
        }),
    },
    {
        exception: 'Halfling.ObjectText.OTNavigateException',
        format: 'The List at path "{source}" specifies that it inherits from a List at path "{source2}" but the node at that path is not a List.',
        engine: 'halfling/Halfling.ObjectText/OTListNode.cs:1311',
        to: (slots) => ({
            ...slots.source('source'),
            message: `This inherits from "${pathText(slots.source('source2'))}", which is not a list.`,
        }),
    },
    navigateMessage('FindAtPath', 'Unable to find node at path "{source}".'),
    navigateMessage('MakeAtPath', 'Unable to find or make node at path "{source}".'),
    {
        exception: 'Halfling.ObjectText.OTNavigateException',
        format: 'Reference at "{source}" is circular.',
        engine: 'halfling/Halfling.ObjectText/OTNode.cs:431',
        to: (slots) => ({ ...slots.source('source'), message: 'This reference eventually points at itself.' }),
    },
    // The value deserializers each write their own sentence and end it with the node they were
    // reading, so the two entries below stand for the whole family of them: `Halfling.Graphics`
    // Color.cs:5153, `Halfling.Geometry` Vector2.cs:1638 and IntRect.cs:995, `Halfling` Range.cs:186
    // and some thirty more. They are last, because their sentence half matches anything.
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: '{value} at path "{source}".',
        engine: 'halfling/Halfling.Geometry/Vector2.cs:1638 and the other value deserializers',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The game could not read this value: ${slots.value('value')}.`,
        }),
    },
    {
        exception: 'Halfling.Serialization.DeserializeException',
        format: "{value} at path '{source}'.",
        engine: 'halfling/Halfling.Graphics/Color.cs:5153 and the other value deserializers',
        to: (slots) => ({
            ...slots.source('source'),
            message: `The game could not read this value: ${slots.value('value')}.`,
        }),
    },
];

/** One recognized message shape, and how to turn its match into a finding. */
interface Shape {
    readonly pattern: RegExp;
    readonly build: (match: RegExpExecArray) => Omit<GameLogFinding, 'severity' | 'time'> & {
        readonly severity?: GameLogFinding['severity'];
    };
}

/**
 * Turn one engine message into the shape the reader matches lines against.
 *
 * @param message the format string and what to make of it.
 * @returns the compiled shape.
 */
const compile = (message: EngineMessage): Shape => {
    const names: { name: string; kind: SlotKind }[] = [];
    let pattern = `^${escape(message.exception)}: `;
    let rest = message.format;
    for (;;) {
        const slot = /\{(\w+)\}/.exec(rest);
        if (!slot) break;
        pattern += escape(rest.slice(0, slot.index));
        const name = slot[1];
        const kind: SlotKind = name.startsWith('source') ? 'source' : name.startsWith('int') ? 'int' : 'value';
        names.push({ name, kind });
        pattern += SLOT_PATTERNS[kind];
        rest = rest.slice(slot.index + slot[0].length);
    }
    pattern += `${escape(rest)}$`;
    return {
        pattern: new RegExp(pattern),
        build: (match) => message.to(slotsOf(match, names)),
    };
};

/**
 * Read the slots of one match back out under the names the format string gave them.
 *
 * @param match the match of the compiled pattern.
 * @param names the slots in the order the format string wrote them.
 * @returns the accessor the entry's `to` reads.
 */
const slotsOf = (match: RegExpExecArray, names: readonly { name: string; kind: SlotKind }[]): Slots => {
    const values = new Map<string, string>();
    const sources = new Map<string, SourceSlot>();
    let group = 1;
    for (const slot of names) {
        if (slot.kind === 'source') {
            sources.set(slot.name, { file: match[group] ?? '', otPath: match[group + 1] ?? '' });
            group += 2;
        } else {
            values.set(slot.name, match[group] ?? '');
            group += 1;
        }
    }
    return {
        value: (name) => values.get(name) ?? '',
        source: (name) => sources.get(name) ?? { file: '', otPath: '' },
    };
};

/**
 * Escape a literal run of a format string so it matches itself.
 *
 * @param text the literal text.
 * @returns the text with every regular expression character quoted.
 */
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The file and inner path of a source slot, written the way the game writes it.
 *
 * @param source the two halves of the path.
 * @returns the path as one string.
 */
const pathText = (source: SourceSlot): string => `<${source.file}>${source.otPath}`;

// The two parser positions and the shader compiler are written by hand, because neither is a plain
// format string: the parser writes either a token or the bare word EOF into one slot, and the
// shader compiler is not a `.NET` exception at all.
const HAND_WRITTEN: readonly Shape[] = [
    // The token the parser stopped at. Line and Char are both 1-based, and Char counts code units
    // within the line, which is exactly what the editor's own positions count.
    //
    // The file clause is optional because `OTParseException.GetMessage` writes it only when the
    // throw site passed a path, and the tokenizer's own two sites
    // (`halfling/Halfling.ObjectText/OTTokenizer.cs:359` and `:566`) pass none. The file then comes
    // from the `Unable to parse file "…"` wrapper the tokenizer always throws inside.
    {
        pattern:
            /^Halfling\.ObjectText\.OTParseException: Unexpected (?:"((?:[^"\\]|\\.)*)"|(EOF)) at position Line=(\d+),Char=(\d+)(?: in file "([^"]*)")?\.$/,
        build: (match) => ({
            file: match[5] ?? '',
            otPath: '',
            message:
                match[2] || tokenText(match[1]) === END_OF_INPUT_TOKEN
                    ? 'The game reached the end of the file while it was still reading a value.'
                    : `The game stopped reading here: unexpected '${tokenText(match[1])}'.`,
            line: Number(match[3]),
            character: Number(match[4]),
        }),
    },
    // A reference whose target is not a path at all. The file slot is empty whenever the node is not
    // attached to a file yet, which an inheritance reference never is, so it falls back to the
    // wrapper the way the end-of-file shape does
    // (`halfling/Halfling.ObjectText/OTReferenceNode.cs:336`).
    {
        pattern:
            /^Halfling\.ObjectText\.OTParseException: The reference target at Line=(\d+),Char=(\d+) in file "([^"]*)" is not a valid path: (.*)$/,
        build: (match) => ({
            file: match[3],
            otPath: '',
            message: `The game could not read a reference here. What it reached the end of the target on was "${match[4]}".`,
            line: Number(match[1]),
            character: Number(match[2]),
        }),
    },
    // An end of file the parser did not expect. The game interpolates the wrong member into the file
    // slot here, so the file is taken from the wrapper above rather than from this message.
    {
        pattern:
            /^Halfling\.ObjectText\.OTParseException: Unexpected end-of-file at (?:position )?Line=(\d+),Char=(\d+) in file "[^"]*"\.$/,
        build: (match) => ({
            file: '',
            otPath: '',
            message: 'The game reached the end of the file while it was still reading a value.',
            line: Number(match[1]),
            character: Number(match[2]),
        }),
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

const SHAPES: readonly Shape[] = [...HAND_WRITTEN, ...ENGINE_MESSAGES.map(compile)];

/**
 * The roster line naming one enabled mod, which is how a log is matched to a workspace. The three
 * labels are English literals the game interpolates (`cosmoteer/Cosmoteer.Data/Assets.cs:434`), so
 * they are enumerated rather than matched loosely: the branch runs before the class-name gate, and a
 * loose pattern would read a tab-indented line of some other dump as a mod that ran.
 */
const ROSTER = /^\t\[(?:User Folder|Built-in|Workshop ID \d+)\] - (\S+) \(.*\)$/;

/** The game version the run was, from the header line every log carries. */
const VERSION = /^Cosmoteer version (\S+) build \S+$/;

/**
 * The offending token, as the message should read it.
 *
 * The game writes the token through `StringTools.FormatString` with `forceFormat`
 * (`halfling/Halfling/StringTools.cs`), which quotes it and escapes a quote, a backslash and the
 * control characters. The quote and the backslash are read back so a quoted key reads as the author
 * wrote it, and the control escapes are left as the game wrote them, since "\n" reads better in a
 * sentence than the character itself would.
 *
 * @param token the token slot as the log carried it, without its quotes.
 * @returns the text to put in the message.
 */
const tokenText = (token: string): string => token.replace(/\\(["\\])/g, '$1');

/**
 * What the tokenizer writes when it ran out of text. It reads the next character as -1 and writes
 * that as a character, so the token is U+FFFF rather than anything in the file
 * (`halfling/Halfling.ObjectText/OTTokenizer.cs:358`).
 */
const END_OF_INPUT_TOKEN = '\uffff';

/**
 * The last segment of a dotted C# type name, which is what an author recognizes.
 *
 * @param fullName the type name as the game wrote it.
 * @returns its last segment.
 */
const shortName = (fullName: string): string => fullName.split('.').pop() ?? fullName;

/** One exception chain of a log, while its lines are still being read. */
interface Chain {
    /** The outermost line, without the timestamp. */
    text: string;
    /** The innermost line read so far, which is the one that says what went wrong. */
    innermost: string;
    /** The line of the log file the chain opens on, 1-based. */
    logLine: number;
    time: string;
    /** Whether any line of the chain matched a shape and named a file, so the chain was placed. */
    placed: boolean;
    /** The message of the innermost line a shape matched, which reads better than the raw line. */
    recognized?: string;
    /** Whether the chain opened inside the window the run loads its mods in. */
    inLoadWindow: boolean;
    /** The mod named by an `Error loading mod:` wrapper, when the chain opens with one. */
    modName?: string;
}

/**
 * Reads one game log.
 *
 * Exception chains are printed outermost first, with each inner exception on its own line, and the
 * innermost is the one that names the file the author has to fix: the outer ones name the files that
 * were loading it. So a chain reports one finding, the innermost recognized line.
 *
 * A chain no line of which was recognized is counted instead, as long as it stands between the line
 * naming the enabled mods and the line saying the game data is loaded. Outside that window the log
 * carries the whole session, and an exception from the running game says nothing about a mod.
 *
 * @param text the log file's contents.
 * @param path the log file's path, carried into the report.
 * @returns what the log says.
 */
export const parseGameLog = (text: string, path: string): GameLogReport => {
    const findings: GameLogFinding[] = [];
    const modIds: string[] = [];
    const unplaced: UnplacedFailure[] = [];
    const modLoadFailures: ModLoadFailure[] = [];
    let gameVersion: string | undefined;
    let pending: GameLogFinding | undefined;
    // The wrapper naming the file, carried into an inner message whose own file slot is unusable.
    let wrapperFile = '';
    let inLoadWindow = false;
    let chain: Chain | undefined;

    const flush = (): void => {
        if (pending) findings.push(pending);
        pending = undefined;
    };

    const closeChain = (): void => {
        if (!chain) return;
        if (chain.modName !== undefined) {
            modLoadFailures.push({
                name: chain.modName,
                detail: chain.recognized ?? chain.innermost,
                logLine: chain.logLine,
                time: chain.time,
            });
        } else if (!chain.placed && chain.inLoadWindow) {
            unplaced.push({ text: chain.text, logLine: chain.logLine, time: chain.time });
        }
        chain = undefined;
    };

    // Three of ten logs on this machine mix line endings, since the shader compiler block writes
    // bare newlines into a file the logger otherwise writes with carriage returns.
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const raw = lines[index];
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
        if (content === LOAD_WINDOW_OPENS) {
            inLoadWindow = true;
            continue;
        }
        if (content.startsWith(LOAD_WINDOW_CLOSES)) {
            closeChain();
            inLoadWindow = false;
            continue;
        }

        if (EXCEPTION_LINE.test(content)) {
            if (!inner || !chain) {
                closeChain();
                // A chain the reader drops must not leave its file behind for the next one to pick
                // up, which would put a finding on a file the game never named.
                flush();
                wrapperFile = '';
                chain = {
                    text: content,
                    innermost: content,
                    logLine: index + 1,
                    time,
                    placed: false,
                    inLoadWindow,
                    modName: MOD_LOAD_FAILURE.exec(content)?.[1],
                };
            } else {
                chain.innermost = content;
            }
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
            if (chain) chain.recognized = built.message;
            // A message the reader understood and has no file for is read but never reported: every
            // finding is published against a file, and the mod action targets the game's own data,
            // so the only file such a message could name is one the author cannot fix. The chain
            // keeps it as its own text, so the run still reads as one that failed.
            if (!finding.file) break;
            if (chain) chain.placed = true;
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
    closeChain();

    // The same failure is logged again every time the game re-enumerates the mods, so one run can
    // report it three times.
    return {
        path,
        gameVersion,
        modIds,
        findings: distinct(
            findings,
            (finding) => `${finding.file}\u0000${finding.otPath}\u0000${finding.message}\u0000${finding.line ?? ''}`
        ),
        unplaced: distinct(unplaced, (entry) => entry.text),
        modLoadFailures: distinct(modLoadFailures, (entry) => `${entry.name}\u0000${entry.detail}`),
    };
};

/**
 * Keep the first of every entry that reads the same, since the game logs one failure again each
 * time it re-enumerates its mods.
 *
 * @param entries the entries in the order they were read.
 * @param keyOf what makes two entries the same.
 * @returns the entries with the repeats dropped.
 */
const distinct = <T>(entries: readonly T[], keyOf: (entry: T) => string): T[] => {
    const seen = new Set<string>();
    return entries.filter((entry) => {
        const key = keyOf(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};
