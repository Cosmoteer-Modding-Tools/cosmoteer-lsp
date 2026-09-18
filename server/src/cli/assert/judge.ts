import { resolve } from 'path';
import { VERB_SCHEMA } from '../../mod/action';
import type { LintFinding } from '../findings';
import { ActionRecord } from './actions';
import { isInside } from './documents';
import {
    ACTION_FINDING_EFFECTS,
    ActionVerdict,
    Disclosure,
    LoadEffect,
    SOURCE_SHAPE_MESSAGE,
    UnverifiableReason,
} from './model';

// Judging one action. The order the tests run in is the whole design: a failure the check is
// certain of comes first, then every reason the check could not judge the action at all, and only
// then the scan's own findings. Turning that around would let a hole in what the check can see be
// reported as a pass, which is the one outcome this command must never produce.

/** What the judge needs to know about the run around the action. */
export interface JudgeContext {
    /** The mod folder, absolute. */
    modRoot: string;
    /** The game `Data` folder the run used. */
    dataRoot?: string;
    /**
     * Whether the scan checked a file.
     *
     * @param file the absolute path of the file.
     * @returns true when the server published a result for it.
     */
    checked: (file: string) => boolean;
    /**
     * The path a report shows for a file.
     *
     * @param file the absolute path of the file.
     * @returns the path relative to the mod folder.
     */
    relative: (file: string) => string;
}

/** What judging one action produced. */
interface ActionJudgement {
    verdict: ActionVerdict;
    /** Everything the check could not see about this action, which may stand beside a pass. */
    disclosures: Disclosure[];
}

/**
 * The shape of a target path, in the terms that decide whether it can be judged.
 *
 * This repeats the rule `isTypableTargetPath` applies in `server/src/mod/action-rooting.index.ts`
 * rather than importing it, because that module builds an index over the whole game tree and the
 * command line must not carry one to answer a question about a string. A test pins the two against
 * each other by reading that file, so they cannot drift apart in silence.
 *
 * @param raw the target path as written, with quotes already gone.
 * @returns what the path holds, or undefined when it is not a path at all.
 */
export const targetPathShape = (
    raw: string
): { file: string; segments: string[]; hasIndexSegment: boolean; hasNavigationSegment: boolean } | undefined => {
    const match = /^&?\s*<([^>]*)>\s*(?:\/(.*))?$/.exec(raw.trim());
    if (!match) return undefined;
    const segments = (match[2] ?? '').split('/').map((segment) => segment.trim());
    return {
        file: match[1].trim(),
        segments,
        hasIndexSegment: segments.some((segment) => /^\d+$/.test(segment)),
        hasNavigationSegment: segments.some((segment) => ['^', '..', ':', '#'].includes(segment)),
    };
};

/**
 * Whether a target path is one the editor can type the wired-in content against. A path it cannot
 * type leaves the fragment the action adds unchecked, which is worth saying even when the action
 * itself loads.
 *
 * @param raw the target path as written.
 * @returns true when the path is a file followed by plain member names.
 */
export const isTypableTarget = (raw: string): boolean => {
    const shape = targetPathShape(raw);
    return !!shape && !shape.hasIndexSegment && !shape.hasNavigationSegment;
};

/**
 * Where a target path lands on disk. Targets resolve against the game's `Data` folder, and a path
 * starting with `./` against the folder the game runs from, which is one level above `Data`.
 *
 * @param file the file part of the target path.
 * @param dataRoot the game `Data` folder.
 * @returns the absolute path the game would read.
 */
export const targetFilePath = (file: string, dataRoot: string): string =>
    file.startsWith('./') ? resolve(dataRoot, '..', file.slice(2)) : resolve(dataRoot, file);

/** What every verdict of one action carries, whichever verdict it turns out to be. */
type ActionBase = Pick<ActionVerdict, 'path' | 'file' | 'line' | 'column' | 'verb' | 'targets' | 'findings'>;

/** Everything one check of an action is given, and where what it could not see is collected. */
interface ActionScope {
    /** The action entry and where it is written. */
    record: ActionRecord;
    /** The scan's mod action findings that fall inside the entry. */
    findings: readonly LintFinding[];
    /** What the judge knows about the run around the action. */
    context: JudgeContext;
    /** The fields every verdict of this action carries. */
    base: ActionBase;
    /** The target paths as written. */
    targets: string[];
    /** The verb as written, empty when the entry names none. */
    verb: string;
    /** Everything the check could not see about this action, added to as the checks run. */
    disclosures: Disclosure[];
}

/** One check of an action, answering with a verdict or leaving the next check to it. */
type ActionCheck = (scope: ActionScope) => ActionJudgement | undefined;

/**
 * Finish with one verdict, carrying whatever was disclosed along the way.
 *
 * @param scope what the checks were given.
 * @param verdict the verdict to answer with.
 * @returns the judgement.
 */
const done = (scope: ActionScope, verdict: ActionVerdict): ActionJudgement => ({
    verdict,
    disclosures: scope.disclosures,
});

/**
 * Finish with a verdict that could not be reached, recording the reason as a disclosure too.
 *
 * @param scope what the checks were given.
 * @param reason why the action could not be judged.
 * @param detail the sentence the report prints.
 * @returns the judgement.
 */
const unverifiable = (scope: ActionScope, reason: UnverifiableReason, detail: string): ActionJudgement => {
    scope.disclosures.push({ reason, path: scope.base.path, line: scope.record.line, detail });
    return done(scope, { ...scope.base, mark: 'unverifiable', reason, detail });
};

/**
 * The scan's own errors inside this action entry.
 *
 * @param scope what the checks were given.
 * @returns the findings of error severity, in report order.
 */
const errorFindings = (scope: ActionScope): LintFinding[] =>
    scope.findings.filter((finding) => finding.severity === 'error');

/**
 * Say so when the action wires content in through a target the editor cannot type, which leaves
 * that content unchecked whatever else is true of the action. This is collected before any verdict
 * is reached, so it stands beside a pass too.
 *
 * @param scope what the checks were given.
 */
const discloseUntypedFragment = (scope: ActionScope): void => {
    const { targets } = scope;
    if (targets.length === 0 || scope.record.action.sources.length === 0) return;
    if (targets.every(isTypableTarget)) return;
    scope.disclosures.push({
        reason: 'untyped-fragment',
        path: scope.base.path,
        line: scope.record.line,
        detail: `The target ${quote(targets[0])} is not a plain path, so the editor cannot tell what the content this action adds has to look like, and that content was not checked against the game's own field list.`,
    });
};

/**
 * A verb the game does not know. The game reads the whole `Actions` list while it reads the
 * manifest, so this stops the manifest rather than the patching.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when the verb is one the game knows.
 */
const unknownVerb: ActionCheck = (scope) => {
    if (scope.record.action.type !== 'Unknown') return undefined;
    return done(scope, {
        ...scope.base,
        mark: 'failed',
        effect: 'mod-dropped',
        detail: `The game knows no action called ${quote(scope.verb || '(none)')}. It cannot read the manifest, so it starts without this mod.`,
    });
};

/**
 * A field the verb needs and the entry does not carry, which the game hits while it reads the
 * manifest.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when every field the verb needs is there.
 */
const missingRequiredField: ActionCheck = (scope) => {
    const { action } = scope.record;
    if (action.type === 'Unknown') return undefined;
    const missing = VERB_SCHEMA[action.type].required.filter((field) => !action.presentFields.has(field.toLowerCase()));
    if (missing.length === 0) return undefined;
    return done(scope, {
        ...scope.base,
        mark: 'failed',
        effect: 'mod-dropped',
        detail: `This ${action.type} action is missing ${missing.map(quote).join(' and ')}. The game cannot read the manifest, so it starts without this mod.`,
    });
};

/**
 * An action with nothing to run over: a `RemoveMany []` with nothing in it, or a target field
 * holding something that is not a path. The game loops over no targets and nothing happens.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when the action names a target.
 */
const noTarget: ActionCheck = (scope) => {
    if (scope.targets.length > 0) return undefined;
    return done(scope, {
        ...scope.base,
        mark: 'ok',
        effect: 'no-effect',
        detail: 'The action names no target, so the game runs it over nothing and it changes nothing.',
    });
};

/**
 * A file the scan published no result for, whose targets were therefore never resolved.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when the scan checked the file.
 */
const fileNotChecked: ActionCheck = (scope) => {
    if (scope.context.checked(scope.record.file)) return undefined;
    return unverifiable(
        scope,
        'file-not-checked',
        'The scan published no result for this file, so its target was never resolved.'
    );
};

/**
 * An `Index` on an AddBase, which moves every base behind it one slot on. The editor does not
 * follow that, so nothing depending on this target's inheritance was really checked.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined for any other action.
 */
const indexedAddBase: ActionCheck = (scope) => {
    const { action } = scope.record;
    if (action.type !== 'AddBase' || !action.presentFields.has('index')) return undefined;
    return unverifiable(
        scope,
        'indexed-add-base',
        'This AddBase inserts its base at an index, which moves the bases behind it. The editor reads the written inheritance only, so what this action leaves behind was not checked.'
    );
};

/**
 * An action that creates its target when it is missing, so nothing said whether the path names
 * what the author meant.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when the action does not carry the flag.
 */
const createIfNotExisting: ActionCheck = (scope) => {
    if (scope.record.action.flags.CreateIfNotExisting !== true) return undefined;
    return unverifiable(
        scope,
        'create-if-not-existing',
        'The action creates its target when it is missing, so nothing checked whether the path names what you meant.'
    );
};

/**
 * An action that says its target may be missing. A target outside the game's own data belongs to
 * another mod, which is a different thing to tell the author about.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when the action does not carry the flag.
 */
const toleratedMissingTarget: ActionCheck = (scope) => {
    if (scope.record.action.flags.IgnoreIfNotExisting !== true) return undefined;
    const { dataRoot } = scope.context;
    const outside = dataRoot
        ? scope.targets.find((target) => {
              const shape = targetPathShape(target);
              return (
                  shape !== undefined && shape.file !== '' && !isInside(targetFilePath(shape.file, dataRoot), dataRoot)
              );
          })
        : undefined;
    if (outside !== undefined) {
        return unverifiable(
            scope,
            'cross-mod-target',
            `The target ${quote(outside)} lies outside the game's own data, so it belongs to another mod. Whether it is there depends on what the player has installed, and this run cannot tell.`
        );
    }
    return unverifiable(
        scope,
        'tolerated-missing-target',
        'The action says its target may be missing, so the game skips it rather than failing. Nothing checked whether the target is really there, so this action may quietly do nothing.'
    );
};

/**
 * A target naming a position in a list, which no run can resolve from the files alone.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when no target carries an index segment.
 */
const indexSegment: ActionCheck = (scope) => {
    if (!scope.targets.some((target) => targetPathShape(target)?.hasIndexSegment)) return undefined;
    return unverifiable(
        scope,
        'index-segment',
        'The target names a position in a list. Mods load in order and every one of them sees the list as the mods before it left it, so which entry this position names in the running game cannot be told from the files alone.'
    );
};

/**
 * A target stepping through the tree, which the editor does not follow in an action target.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when no target carries a navigation segment.
 */
const navigationSegment: ActionCheck = (scope) => {
    if (!scope.targets.some((target) => targetPathShape(target)?.hasNavigationSegment)) return undefined;
    return unverifiable(
        scope,
        'navigation-segment',
        'The target steps through the tree with "^", "..", ":" or "#". The editor does not follow those in an action target, so this one was not resolved.'
    );
};

/**
 * An error this version of the command has no entry for, which it will not claim to understand.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when every error inside the entry is one the table carries.
 */
const unrecognisedFinding: ActionCheck = (scope) => {
    const unrecognised = errorFindings(scope).filter((finding) => !ACTION_FINDING_EFFECTS.has(finding.message));
    if (unrecognised.length === 0) return undefined;
    for (const finding of unrecognised) {
        scope.disclosures.push({
            reason: 'unknown-finding',
            path: scope.base.path,
            line: finding.startLine,
            detail: `The check reported "${finding.message}" here, which this version of the command does not recognise, so what the game does about it is not known.`,
        });
    }
    return done(scope, {
        ...scope.base,
        mark: 'failed',
        effect: 'unknown',
        detail: `The check reported ${unrecognised.length === 1 ? 'a problem' : 'problems'} here that this version of the command cannot explain. Run the check without --assert-loads to read ${unrecognised.length === 1 ? 'it' : 'them'} in full.`,
    });
};

/**
 * An error the table says the game does something about.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when no error inside the entry changes what the game does.
 */
const blockingFinding: ActionCheck = (scope) => {
    const blocking = errorFindings(scope).find((finding) => effectOf(finding, scope.verb) !== 'no-effect');
    if (!blocking) return undefined;
    const effect = effectOf(blocking, scope.verb);
    return done(scope, {
        ...scope.base,
        mark: 'failed',
        effect,
        detail: `${blocking.message}. ${consequence(effect)}`,
    });
};

/**
 * An error the table says the game loads past, leaving the action to change nothing.
 *
 * @param scope what the checks were given.
 * @returns the verdict, or undefined when the entry holds no such error.
 */
const deadFinding: ActionCheck = (scope) => {
    const dead = errorFindings(scope).find((finding) => effectOf(finding, scope.verb) === 'no-effect');
    if (!dead) return undefined;
    return done(scope, {
        ...scope.base,
        mark: 'ok',
        effect: 'no-effect',
        detail: `${dead.message}. ${consequence('no-effect')}`,
    });
};

// The checks one action is put through, in the order the comment at the top of this file describes.
// The order is the whole design, so moving a row changes the verdict a real action gets.
const ACTION_CHECKS: readonly ActionCheck[] = [
    unknownVerb,
    missingRequiredField,
    noTarget,
    fileNotChecked,
    indexedAddBase,
    createIfNotExisting,
    toleratedMissingTarget,
    indexSegment,
    navigationSegment,
    unrecognisedFinding,
    blockingFinding,
    deadFinding,
];

/**
 * Judge one action.
 *
 * @param record the action entry and where it is written.
 * @param findings the scan's mod action findings that fall inside this entry.
 * @param context what the judge needs to know about the run.
 * @returns the verdict and everything the check could not see about it.
 */
export const judgeAction = (
    record: ActionRecord,
    findings: readonly LintFinding[],
    context: JudgeContext
): ActionJudgement => {
    const { action } = record;
    const path = context.relative(record.file);
    const targets = action.targets.map((target) => String(target.valueType.value));
    const verb = action.verbText ?? '';
    const scope: ActionScope = {
        record,
        findings,
        context,
        base: {
            path,
            file: record.file,
            line: record.line,
            column: record.column,
            verb,
            targets,
            findings: [...findings],
        },
        targets,
        verb,
        disclosures: [],
    };

    discloseUntypedFragment(scope);
    for (const check of ACTION_CHECKS) {
        const judged = check(scope);
        if (judged) return judged;
    }
    return done(scope, { ...scope.base, mark: 'ok', detail: 'The target is there and the action applies.' });
};

/**
 * What the game does about one finding.
 *
 * @param finding the finding to look up.
 * @param verb the verb the action was written with, which decides the one message that depends on
 *     it (see {@link SOURCE_SHAPE_MESSAGE}).
 * @returns the effect, and 'unknown' for a message the table does not carry.
 */
const effectOf = (finding: LintFinding, verb: string): LoadEffect => {
    const known = ACTION_FINDING_EFFECTS.get(finding.message);
    if (known === undefined || known === 'editor-limit') return 'unknown';
    if (finding.message === SOURCE_SHAPE_MESSAGE && verb === 'AddBase') return 'unknown';
    return known;
};

/**
 * The sentence that says what the game does, in the words a mod author needs.
 *
 * @param effect what the game does.
 * @returns the consequence, as one sentence.
 */
const consequence = (effect: LoadEffect): string => {
    switch (effect) {
        case 'mod-dropped':
            return 'The game cannot read the manifest, so it starts without this mod.';
        case 'game-stops':
            return 'The game throws while it applies this action and stops loading, and no action of this mod after it runs.';
        case 'no-effect':
            return 'The game loads the mod and this action changes nothing.';
        case 'unknown':
            return 'This leaves the mod broken, and what the game does about it was not established here.';
    }
};

/**
 * Put a value in quotes for a sentence.
 *
 * @param text the value.
 * @returns the value in double quotes.
 */
const quote = (text: string): string => `"${text}"`;
