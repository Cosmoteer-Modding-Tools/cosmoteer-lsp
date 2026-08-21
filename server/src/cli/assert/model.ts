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
    // Not a failure. The game inserts the base and moves the others on, which the editor does not
    // follow, so this one says the check is limited rather than that the mod is broken.
    ['This AddBase inserts at an index, which the editor does not follow', 'editor-limit'],
]);

/** The rule id the mod action pass tags its findings with. */
export const MOD_ACTION_RULE_ID = 'mod-action';

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
