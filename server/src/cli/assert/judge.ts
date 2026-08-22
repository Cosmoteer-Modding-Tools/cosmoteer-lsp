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
export interface ActionJudgement {
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
    const base = {
        path,
        file: record.file,
        line: record.line,
        column: record.column,
        verb,
        targets,
        findings: [...findings],
    };
    const disclosures: Disclosure[] = [];

    // Content the action wires in through a target the editor cannot type is never schema checked,
    // whatever else is true of the action, so this is collected before any verdict is reached.
    if (targets.length > 0 && targets.some((target) => !isTypableTarget(target)) && action.sources.length > 0) {
        disclosures.push({
            reason: 'untyped-fragment',
            path,
            line: record.line,
            detail: `The target ${quote(targets[0])} is not a plain path, so the editor cannot tell what the content this action adds has to look like, and that content was not checked against the game's own field list.`,
        });
    }

    /**
     * Finish with one verdict, carrying whatever was disclosed along the way.
     *
     * @param verdict the verdict to answer with.
     * @returns the judgement.
     */
    const done = (verdict: ActionVerdict): ActionJudgement => ({ verdict, disclosures });

    /**
     * Finish with a verdict that could not be reached, recording the reason as a disclosure too.
     *
     * @param reason why the action could not be judged.
     * @param detail the sentence the report prints.
     * @returns the judgement.
     */
    const unverifiable = (reason: UnverifiableReason, detail: string): ActionJudgement => {
        disclosures.push({ reason, path, line: record.line, detail });
        return done({ ...base, mark: 'unverifiable', reason, detail });
    };

    // The game reads the whole `Actions` list while it reads the manifest, so a verb it does not
    // know and a field it needs and cannot find both stop the manifest rather than the patching.
    if (action.type === 'Unknown') {
        return done({
            ...base,
            mark: 'failed',
            effect: 'mod-dropped',
            detail: `The game knows no action called ${quote(verb || '(none)')}. It cannot read the manifest, so it starts without this mod.`,
        });
    }
    const missing = VERB_SCHEMA[action.type].required.filter(
        (field) => !action.presentFields.has(field.toLowerCase())
    );
    if (missing.length > 0) {
        return done({
            ...base,
            mark: 'failed',
            effect: 'mod-dropped',
            detail: `This ${action.type} action is missing ${missing.map(quote).join(' and ')}. The game cannot read the manifest, so it starts without this mod.`,
        });
    }

    // A `RemoveMany []` with nothing in it, or a target field holding something that is not a path.
    // The game loops over no targets and the action does nothing at all.
    if (targets.length === 0) {
        return done({
            ...base,
            mark: 'ok',
            effect: 'no-effect',
            detail: 'The action names no target, so the game runs it over nothing and it changes nothing.',
        });
    }

    if (!context.checked(record.file)) {
        return unverifiable(
            'file-not-checked',
            'The scan published no result for this file, so its target was never resolved.'
        );
    }

    // An `Index` on an AddBase moves every base behind it one slot on, which the editor does not
    // follow, so nothing that depends on this target's inheritance was really checked.
    if (action.type === 'AddBase' && action.presentFields.has('index')) {
        return unverifiable(
            'indexed-add-base',
            'This AddBase inserts its base at an index, which moves the bases behind it. The editor reads the written inheritance only, so what this action leaves behind was not checked.'
        );
    }
    if (action.flags.CreateIfNotExisting === true) {
        return unverifiable(
            'create-if-not-existing',
            'The action creates its target when it is missing, so nothing checked whether the path names what you meant.'
        );
    }
    if (action.flags.IgnoreIfNotExisting === true) {
        const dataRoot = context.dataRoot;
        const outside = dataRoot
            ? targets.find((target) => {
                  const shape = targetPathShape(target);
                  return (
                      shape !== undefined &&
                      shape.file !== '' &&
                      !isInside(targetFilePath(shape.file, dataRoot), dataRoot)
                  );
              })
            : undefined;
        if (outside !== undefined) {
            return unverifiable(
                'cross-mod-target',
                `The target ${quote(outside)} lies outside the game's own data, so it belongs to another mod. Whether it is there depends on what the player has installed, and this run cannot tell.`
            );
        }
        return unverifiable(
            'tolerated-missing-target',
            'The action says its target may be missing, so the game skips it rather than failing. Nothing checked whether the target is really there, so this action may quietly do nothing.'
        );
    }

    const shapes = targets.map(targetPathShape);
    if (shapes.some((shape) => shape?.hasIndexSegment)) {
        return unverifiable(
            'index-segment',
            'The target names a position in a list. Mods load in order and every one of them sees the list as the mods before it left it, so which entry this position names in the running game cannot be told from the files alone.'
        );
    }
    if (shapes.some((shape) => shape?.hasNavigationSegment)) {
        return unverifiable(
            'navigation-segment',
            'The target steps through the tree with "^", "..", ":" or "#". The editor does not follow those in an action target, so this one was not resolved.'
        );
    }

    const errors = findings.filter((finding) => finding.severity === 'error');
    const unrecognised = errors.filter((finding) => !ACTION_FINDING_EFFECTS.has(finding.message));
    if (unrecognised.length > 0) {
        for (const finding of unrecognised) {
            disclosures.push({
                reason: 'unknown-finding',
                path,
                line: finding.startLine,
                detail: `The check reported "${finding.message}" here, which this version of the command does not recognise, so what the game does about it is not known.`,
            });
        }
        return done({
            ...base,
            mark: 'failed',
            effect: 'unknown',
            detail: `The check reported ${unrecognised.length === 1 ? 'a problem' : 'problems'} here that this version of the command cannot explain. Run the check without --assert-loads to read ${unrecognised.length === 1 ? 'it' : 'them'} in full.`,
        });
    }
    const blocking = errors.filter((finding) => effectOf(finding, verb) !== 'no-effect');
    if (blocking.length > 0) {
        const effect = effectOf(blocking[0], verb);
        return done({ ...base, mark: 'failed', effect, detail: `${blocking[0].message}. ${consequence(effect)}` });
    }
    const dead = errors.filter((finding) => effectOf(finding, verb) === 'no-effect');
    if (dead.length > 0) {
        return done({
            ...base,
            mark: 'ok',
            effect: 'no-effect',
            detail: `${dead[0].message}. ${consequence('no-effect')}`,
        });
    }
    return done({ ...base, mark: 'ok', detail: 'The target is there and the action applies.' });
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
