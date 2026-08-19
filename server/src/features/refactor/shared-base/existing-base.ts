import { dirname } from 'path';
import { AbstractNode, GroupNode, isGroupNode, isListNode, isValueNode } from '../../../core/ast/ast';
import { foldPathCase } from '../../../workspace/fs-cache';
import { BaseTarget, readRulesFile, resolveBaseTarget } from './base-index';
import { baseIdentityOf } from './duplicate-field.analysis';
import { topLevelMembersOf } from './member-record';
import { BaseLocation, ExtractionPlan } from './plan.types';
import { analyzeReferences } from './reference-safety';

/**
 * A path folded for comparison. `foldPathCase` only folds case, and the two sides of these
 * comparisons come from different producers: a directory walk hands back the platform separator
 * while a resolved base location is always slash-normalized, so the separators have to be evened out
 * here or the comparison silently never matches on Windows.
 *
 * @param path the path to fold.
 * @returns the comparison key.
 */
const pathKey = (path: string): string => foldPathCase(path.replace(/\\/g, '/'));

/**
 * Why a set of containers cannot put its repeated fields into the base it already inherits. Returned
 * rather than a bare boolean so the reason can be asserted in a test and explained in a review.
 */
export type UpgradeRefusal =
    /** Something else in the mod inherits that base, and would silently gain the fields. */
    | 'otherInheritors'
    /** The base is not a file of the mod being edited, so it must not be rewritten. */
    | 'foreignBase'
    /** The base file also holds one of the containers being rewritten. */
    | 'selfHosted'
    /** The base file cannot be read, or no longer holds the group the reference names. */
    | 'unreadableBase'
    /** The base already declares one of the fields, so moving it would overwrite a value. */
    | 'alreadyDeclared'
    /** A moved member carries a path that cannot be re-expressed from the base file's directory. */
    | 'unsafeFromBase';

/**
 * Whether a plan's fields can move into the base file its participants already inherit, instead of
 * into a new file wedged in between.
 *
 * The one thing that has to be proven is that no container is changed by the move. A field put on a
 * base is handed to everything that inherits it, so every direct inheritor in the mod has to be
 * either one of the containers giving the field up or one that declares the field itself, since its
 * own declaration wins over anything the base supplies. Indirect inheritors need no separate check:
 * every path to the base runs through one of those, and both keep the value they have today.
 *
 * @param plan the `sharedBase` plan to judge.
 * @param modRoot the root of the mod being edited, which the base file has to live under.
 * @param inheritorCounts how many containers in the mod inherit each base, keyed by identity.
 * @param locations where each of those bases lives, keyed by identity.
 * @param inheritorFiles which files hold those containers, keyed by identity. Without it a base with
 * any inheritor beyond the plan is refused outright, which is the answer for a caller that has not
 * indexed them.
 * @returns the resolved target, or the reason the fields have to go into a new file instead.
 */
export const judgeExistingBase = async (
    plan: ExtractionPlan,
    modRoot: string,
    inheritorCounts: ReadonlyMap<string, number>,
    locations: ReadonlyMap<string, BaseLocation>,
    inheritorFiles?: ReadonlyMap<string, ReadonlySet<string>>
): Promise<BaseTarget | UpgradeRefusal> => {
    const identity = plan.baseIdentity;
    if (!identity) return 'foreignBase';
    // The cheap refusals come first. Most mod files inherit a base of the game's own data, and
    // proving the inheritors of one of those would read every file of the mod that names it.
    const location = locations.get(identity);
    if (!location) return 'foreignBase';
    const modPrefix = `${pathKey(modRoot).replace(/\/+$/, '')}/`;
    if (!pathKey(location.fsPath).startsWith(modPrefix)) return 'foreignBase';
    // One file holding both the base and a container that gives fields up would need an insert and a
    // set of removals in the same edit list, which is more entanglement than the offer is worth.
    const baseKey = pathKey(location.fsPath);
    if (plan.participants.some((participant) => pathKey(participant.fsPath) === baseKey)) return 'selfHosted';
    if ((inheritorCounts.get(identity) ?? 0) !== plan.participants.length) {
        const files = inheritorFiles?.get(identity);
        if (!files || !(await othersAreUnaffected(plan, identity, files))) return 'otherInheritors';
    }

    const target = await resolveBaseTarget(location);
    if (!target) return 'unreadableBase';
    if (plan.fields.some((key) => target.declaredKeys.has(key))) return 'alreadyDeclared';

    // The members are written into a directory the plan did not pick, so their paths are re-proven
    // against it rather than assumed from the anchor-relative comparison.
    const donorDir = dirname(plan.donor.fsPath);
    const baseDir = dirname(location.fsPath);
    for (const key of plan.fields) {
        const member = plan.donor.members.get(key);
        if (!member) return 'unsafeFromBase';
        if (!analyzeReferences(member.raw, donorDir, baseDir).safe) return 'unsafeFromBase';
    }
    return target;
};

/** Every named container of a file that inherits one particular base, at any depth. */
const containersInheriting = (
    document: { elements: readonly AbstractNode[] },
    declaringDir: string,
    identity: string
): GroupNode[] => {
    const out: GroupNode[] = [];
    const visit = (node: AbstractNode): void => {
        if (!isGroupNode(node) && !isListNode(node)) return;
        if (isGroupNode(node) && node.identifier) {
            for (const base of node.inheritance ?? []) {
                if (!isValueNode(base) || base.valueType.type !== 'Reference') continue;
                if (baseIdentityOf(String(base.valueType.value), declaringDir) === identity) {
                    out.push(node);
                    break;
                }
            }
        }
        for (const element of node.elements) visit(element);
    };
    for (const element of document.elements) visit(element);
    return out;
};

/**
 * Whether every inheritor of a base that is not taking part in the plan declares the moved fields
 * itself, and so keeps its own value no matter what the base gains.
 *
 * @param plan the plan being judged.
 * @param identity the base's identity.
 * @param files the mod's files that hold a container inheriting it.
 * @returns true when no container outside the plan can be changed by the move.
 */
const othersAreUnaffected = async (
    plan: ExtractionPlan,
    identity: string,
    files: ReadonlySet<string>
): Promise<boolean> => {
    const participating = new Set(
        plan.participants.map((participant) => `${pathKey(participant.fsPath)}#${participant.nameStart}`)
    );
    for (const fsPath of files) {
        const file = await readRulesFile(fsPath);
        // A file that cannot be read could hold anything, so the move is not offered.
        if (!file) return false;
        for (const container of containersInheriting(file.document, dirname(fsPath), identity)) {
            const at = container.identifier?.position.start ?? -1;
            if (participating.has(`${pathKey(fsPath)}#${at}`)) continue;
            const declared = new Set(topLevelMembersOf(container, file.text).map((member) => member.key));
            if (!plan.fields.every((field) => declared.has(field))) return false;
        }
    }
    return true;
};

/**
 * Turn every plan that can into one that adds to the base file its participants already inherit.
 *
 * @param plans the plans a mod's candidates produced.
 * @param modRoot the root of the mod being edited.
 * @param inheritorCounts how many containers in the mod inherit each base, keyed by identity.
 * @param locations where each of those bases lives, keyed by identity.
 * @param inheritorFiles which files hold those containers, keyed by identity.
 * @returns the plans, with the eligible ones retiered, in the order they came in.
 */
export const upgradePlansToExistingBase = async (
    plans: readonly ExtractionPlan[],
    modRoot: string,
    inheritorCounts: ReadonlyMap<string, number>,
    locations: ReadonlyMap<string, BaseLocation>,
    inheritorFiles?: ReadonlyMap<string, ReadonlySet<string>>
): Promise<ExtractionPlan[]> => {
    const out: ExtractionPlan[] = [];
    for (const plan of plans) {
        if (plan.tier !== 'sharedBase') {
            out.push(plan);
            continue;
        }
        const judged = await judgeExistingBase(plan, modRoot, inheritorCounts, locations, inheritorFiles);
        out.push(
            typeof judged === 'string'
                ? plan
                : {
                      ...plan,
                      tier: 'existingBase',
                      baseFsPath: judged.fsPath,
                      inheritedRef: undefined,
                      existingBase: { fsPath: judged.fsPath, groupPath: [...judged.groupPath] },
                  }
        );
    }
    return out;
};
