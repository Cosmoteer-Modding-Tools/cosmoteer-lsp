import type { LintFinding } from '../findings';
import type { GameDataStatus } from '../report/report';

// The vocabulary of the load check. It answers one question, "does the game load this mod", and it
// has to answer "I could not tell" as often as it answers yes or no, so the three-state verdict is
// the centre of the model rather than a footnote on it. The same three states are what the part
// wiring report already shows, so the two read the same way.

/** Whether a check could be made at all, and how it came out. */
export type AssertMark = 'ok' | 'failed' | 'unverifiable';

/**
 * What the game does with a mod that fails a check. The two are far apart for the author, so the
 * report never blurs them.
 *
 * `game-stops`: the action throws out of `ApplyAction` while the rules tree is patched. The loader
 * thread has no catch, so the game ends at its error box instead of reaching the main menu, and no
 * later action of the mod runs.
 * `mod-dropped`: the manifest itself cannot be read. `ModInfo.TryLoadMod` catches that, so this one
 * mod is skipped and the game starts.
 * `no-effect`: the action applies without complaint and changes nothing in the running game.
 * `unknown`: this build of the tool does not recognise the finding, so it will not claim to know.
 */
export type LoadEffect = 'game-stops' | 'mod-dropped' | 'no-effect' | 'unknown';

/**
 * Why an action could not be judged. Every one of these is a real hole in what the check can see,
 * and each is reported rather than counted as a pass.
 */
export type UnverifiableReason =
    | 'indexed-add-base'
    | 'index-segment'
    | 'navigation-segment'
    | 'create-if-not-existing'
    | 'tolerated-missing-target'
    | 'cross-mod-target'
    | 'untyped-fragment'
    | 'file-not-checked'
    | 'unfollowed-include'
    | 'manifest-choice'
    | 'unknown-finding';

/**
 * One finding on a file the game reads that costs the whole file. The game's parser refuses the
 * file outright, so the action that pulls it in throws, and this is the only kind of finding the
 * load check folds in from a file rather than from an action entry.
 *
 * The list is deliberately short. Every entry names the engine site that refuses the file, and a
 * finding the list does not carry is left to the ordinary check, because folding in every error on
 * every reachable file would turn a field the game reads past into "does not load".
 */
export interface FileLoadBlocker {
    /** The rule the pass tags the finding with. */
    ruleId: string;
    /** The start of the message, empty when every error of the rule is one of these. */
    messageStart: string;
    /** The engine site that refuses the file, so the entry can be checked against the game. */
    engine: string;
}

/**
 * What the game refuses a whole file for, in the findings this build's own passes write.
 *
 * `OTFile` parses a file in one go and wraps whatever the tokenizer or the tree builder threw as
 * `Unable to parse file "…"`, so nothing of a file that does not parse reaches the game at all. A
 * name written twice in one scope is the same kind of failure rather than a silent overwrite,
 * because `OTGroupNode` registers each child under its name and throws when the scope already
 * holds it.
 */
export const FILE_LOAD_BLOCKERS: readonly FileLoadBlocker[] = [
    {
        ruleId: 'parse-error',
        messageStart: '',
        engine: 'halfling/Halfling.ObjectText/OTFile.cs:314',
    },
    {
        ruleId: 'document-duplicate',
        messageStart: 'Duplicate field "',
        engine: 'halfling/Halfling.ObjectText/OTGroupNode.cs:1676',
    },
    {
        ruleId: 'syntax-and-references',
        messageStart: 'Duplicate field "',
        engine: 'halfling/Halfling.ObjectText/OTGroupNode.cs:1676',
    },
];

/**
 * Whether one finding says the game refuses the whole file it is in.
 *
 * @param finding the finding to weigh.
 * @returns true when the finding is one of {@link FILE_LOAD_BLOCKERS}.
 */
export const refusesTheFile = (finding: LintFinding): boolean =>
    finding.severity === 'error' &&
    FILE_LOAD_BLOCKERS.some(
        (blocker) => blocker.ruleId === finding.ruleId && finding.message.startsWith(blocker.messageStart)
    );

/** One thing the check could not see, in the words the report prints. */
export interface Disclosure {
    reason: UnverifiableReason;
    /** The file it is about, relative to the mod folder. */
    path: string;
    /** The line the action starts on, when the disclosure is about one action. */
    line?: number;
    /** One sentence naming what was not checked and why. */
    detail: string;
}

/** The verdict on one action entry. */
export interface ActionVerdict {
    /** The file holding the action, relative to the mod folder. */
    path: string;
    /** The same file, absolute. */
    file: string;
    /** One-based, the form every report and every editor uses. */
    line: number;
    column: number;
    /** The verb as written, which is not always one the game knows. */
    verb: string;
    /** The target paths as written. */
    targets: string[];
    mark: AssertMark;
    /** Why it could not be judged, when it could not. */
    reason?: UnverifiableReason;
    /** What the game does with it, when it fails. */
    effect?: LoadEffect;
    /** One sentence saying what happens, which is what a reader of the report needs. */
    detail: string;
    /** The scan's own findings inside this action, kept so the report can quote them. */
    findings: LintFinding[];
}

/**
 * Something about the manifest itself that stops the mod loading, rather than something about one
 * of its actions. Every one of these fails while the game reads the file, so the mod is dropped and
 * the game starts.
 */
export interface ManifestFailure {
    /** What the failure is about: a field name, or the file when it does not parse. */
    subject: string;
    /** The file it is in, relative to the mod folder. */
    path: string;
    detail: string;
    line: number;
    column: number;
}

/** One `mod.rules` of a mod, with everything judged against it. */
export interface ManifestAssertion {
    /** The manifest, relative to the mod folder. */
    path: string;
    /** The same manifest, absolute. */
    file: string;
    /** Whether this is the manifest the game reads. False for one it passes over. */
    selected: boolean;
    /** Why it is or is not the one, when the mod ships more than one. */
    selectionNote?: string;
    /** What stops the game reading this manifest, empty when nothing does. */
    failures: ManifestFailure[];
    /** Every action this manifest runs, its own and the ones it pulls in. */
    actions: ActionVerdict[];
}

/** How many actions came out each way. */
export interface AssertCounts {
    actions: number;
    ok: number;
    failed: number;
    unverifiable: number;
}

/** The verdict on one mod folder. */
export interface ModAssertion {
    /** The mod folder, absolute. */
    folder: string;
    /** The mod's `Name`, when the selected manifest declares one. */
    name?: string;
    /** The mod's `ID`, when the selected manifest declares one. */
    id?: string;
    manifests: ManifestAssertion[];
    /** What stops the mod loading before any manifest is read, such as there being none. */
    failures: ManifestFailure[];
    /** Files holding an `Actions` list that no manifest of this mod was seen to pull in, with how
     *  many entries each of them holds. The game runs none of them unless something includes the
     *  file in a way this check could not follow, so they are named and never judged. */
    orphanActionFiles: { path: string; actions: number }[];
    /** Files that could not be read or parsed while the actions were collected. */
    unreadableFiles: { path: string; reason: string }[];
    disclosures: Disclosure[];
    counts: AssertCounts;
    /** How many findings say the mod does not load, manifest metadata included. */
    loadBlocking: number;
    /** Whether the game loads the mod, or whether that could not be told. */
    verdict: 'loads' | 'does-not-load' | 'unknown';
}

/** Everything one load check produced. */
export interface AssertReport {
    /** The folders the run covered, absolute. */
    folders: string[];
    gameData: GameDataStatus;
    mods: ModAssertion[];
    /** How many files the server published results for, clean ones included. */
    files: number;
    /** How many whole-workspace passes ran before the result settled. */
    passes: number;
    /** How long the scan took, which only the text report shows. */
    elapsedMs: number;
    /** How many findings across every mod say a mod does not load. */
    loadBlocking: number;
    /** How many things the check could not judge across every mod. */
    unverifiable: number;
    /** Whether every action was judged and every file holding one was checked. */
    complete: boolean;
}

/**
 * The English message of every finding the mod action pass produces, with what the game does about
 * it. The pass is `server/src/features/diagnostics/validator.mod-action.ts`, and the CLI ships with
 * the server build it drives, so matching on the message is matching against one repository rather
 * than against a protocol. The table is pinned by a test that reads that file, and a message the
 * table does not carry is reported as an unrecognised finding rather than silently passed over.
 */
export const ACTION_FINDING_EFFECTS: ReadonlyMap<string, LoadEffect | 'editor-limit'> = new Map<
    string,
    LoadEffect | 'editor-limit'
>([
    // The `Action` discriminator is read while the manifest is deserialized, so an unknown verb
    // never reaches the patching stage at all.
    ['Unknown mod action verb', 'mod-dropped'],
    ['Mod action is missing a required field', 'mod-dropped'],
    // Each entry of the list supplies one action, whose verb the reader takes from the entry's own
    // members, so an entry that is not a group fails while the manifest is read.
    ['Mod action entry is not a group', 'mod-dropped'],
    // The source of an AddMany is an `OTNode[]` and of an Overrides a name to node map, so the wrong
    // shape fails while the manifest is read rather than while it is applied.
    ['Mod action source has the wrong shape', 'mod-dropped'],
    // `FindAtPath` throws `OTNavigateException` for a missing file and for a missing member alike.
    ['Action target not found', 'game-stops'],
    // The action patches the rules tree happily. The game reads the language files separately, so
    // the patch is never seen.
    ['Mod action cannot target a language string file', 'no-effect'],
    ['Add action is missing the Name field', 'game-stops'],
    ['Mod action cannot target a whole .rules file', 'game-stops'],
    ['Mod action target has the wrong shape', 'game-stops'],
    ['Mod action adds a whole list as one entry', 'game-stops'],
    // Not a failure. The game inserts the base and moves the others on, which the editor does not
    // follow, so this one says the check is limited rather than that the mod is broken.
    ['This AddBase inserts at an index, which the editor does not follow', 'editor-limit'],
]);

/** The rule id the mod action pass tags its findings with. */
export const MOD_ACTION_RULE_ID = 'mod-action';

/** The rule id the value pass tags a reference it could not resolve with. */
export const REFERENCE_RULE_ID = 'syntax-and-references';

/**
 * The message the value pass writes on a reference that resolves to nothing. It is a warning there
 * on purpose, because the game loads past a dangling reference in its data and vanilla ships some,
 * but a reference written on a mod action is read long before that: `BaseSerializer.Read` hands
 * every member it reads to `ObjectTextSerializer.DereferenceSource`
 * (`halfling/Halfling.Serialization.ObjectText/ObjectTextSerializer.cs:279`), which calls
 * `OTReferenceNode.FindFinalTarget` and throws when the target is not there. The throw happens
 * inside the `ModInfo` constructor, which `ModInfo.TryLoadMod` catches, so the whole mod is dropped.
 *
 * The message is matched rather than a code, the way {@link ACTION_FINDING_EFFECTS} is, and a test
 * pins it against the pass that writes it.
 */
export const DANGLING_REFERENCE_MESSAGE = 'Reference name is not known';

/**
 * Whether one finding says a reference resolves to nothing.
 *
 * @param finding the finding to weigh.
 * @returns true when it is the value pass's unresolved reference.
 */
export const isDanglingReference = (finding: LintFinding): boolean =>
    finding.ruleId === REFERENCE_RULE_ID && finding.message === DANGLING_REFERENCE_MESSAGE;

/**
 * The one message whose effect depends on the verb it is reported on. An AddMany reads its source
 * into an `OTNode[]` and an Overrides into a name to node map, so a wrongly shaped one fails while
 * the manifest is read. An AddBase takes any node at all and only carries the wrong one into an
 * inheritance list, and what the game makes of that was not established, so it is reported as
 * broken with the effect left open rather than guessed at.
 */
export const SOURCE_SHAPE_MESSAGE = 'Mod action source has the wrong shape';

/**
 * What each reason means, in the words the report prints under "what this check could not see".
 * Exhaustive over {@link UnverifiableReason}, so a new reason cannot be added without a sentence.
 */
export const REASON_TITLES: Readonly<Record<UnverifiableReason, string>> = {
    'indexed-add-base': 'an AddBase that inserts at an index',
    'index-segment': 'a target path that names a list position',
    'navigation-segment': 'a target path that steps through the tree',
    'create-if-not-existing': 'a target the action creates when it is missing',
    'tolerated-missing-target': 'a target the action says may be missing',
    'cross-mod-target': 'a target in another mod',
    'untyped-fragment': 'content wired in through a target that cannot be typed',
    'file-not-checked': 'a file the scan did not check',
    'unfollowed-include': 'an included action list that could not be followed',
    'manifest-choice': 'a mod that ships several manifests',
    'unknown-finding': 'a finding this version does not recognise',
};
