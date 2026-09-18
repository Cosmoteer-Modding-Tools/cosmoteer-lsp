import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    descendants,
    isAssignmentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { NUMERIC_DOMAIN_RULES, NumericDomainRule } from '../../document/schema/numeric-domains';
import { documentRootClass } from '../../document/schema/document-root';
import { classAncestry } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { flattenGroup } from '../../semantics/effective-group';
import { evaluateNumericValue } from '../../semantics/value-evaluator';
import { childNamed, numberOf } from '../../semantics/vector-forms';
import { ValidationError } from './validator';

/**
 * Whole-document pass (default on, settable off): a number the class reading it cannot survive,
 * and one list whose length its own sibling bounds.
 *
 * The schema carries no numeric domain, so a field typed `int` accepts every integer and the code
 * reading it divides by the value, sizes a buffer from it or loops on it. The generic division
 * check reads the expression written in the file and cannot see any of these, because the number
 * is well formed where it stands and only the consumer refuses it. The table beside this module
 * carries the fields, each keyed by the exact class its read belongs to.
 *
 * Every read goes through the inheritance fold, since a beam's body normally comes from a shot
 * file base and a local-only read would see neither half of the pairing. Two things are therefore
 * never guessed at: a value the evaluator cannot resolve to a number, and an absent field in a
 * chain that could not be read to the end, which looks exactly like a field nobody wrote.
 */

/** The resource whose nugget art is sliced into tiers, and the two members that must agree. */
const RESOURCE_RULES_CLASS = 'Cosmoteer.Resources.ResourceRules';
const NESTED_NUGGET_SPRITES = 'NestedNuggetSprites';
const MAX_PER_NUGGET = 'MaxPerNugget';

/** A group's effective members, keyed by the folded member name. */
type FoldedMembers = Map<string, AbstractNode>;

/**
 * The number a folded member holds, read through any arithmetic written on it.
 *
 * @param members the group's folded members.
 * @param field the member name.
 * @param cancellationToken cancels the evaluation.
 * @returns the value with the node it was written on, or null when it is absent or not a number.
 */
const effectiveNumber = async (
    members: FoldedMembers,
    field: string,
    cancellationToken: CancellationToken
): Promise<{ value: number; node: AbstractNode } | null> => {
    const node = members.get(field.toLowerCase());
    if (!node) return null;
    const plain = numberOf(node);
    if (plain !== null) return { value: plain, node };
    const evaluated = await evaluateNumericValue(node, cancellationToken).catch(() => null);
    return evaluated === null || !Number.isFinite(evaluated) ? null : { value: evaluated, node };
};

/**
 * The sentence saying what the consumer does with a number it cannot survive.
 *
 * @param rule the rule the value broke.
 * @param value the number the chain supplies.
 * @returns the finding's message.
 */
const messageFor = (rule: NumericDomainRule, value: number): string => {
    if (rule.effect === 'hangs') {
        return l10n.t(
            "'{0}' is the step a continuous beam advances its damage clock by, and at {1} the clock never moves, so the game stops responding the first time the beam fires. A beam whose Duration is above zero has to write one above zero.",
            rule.field,
            value
        );
    }
    return l10n.t(
        "'{0}' has to be at least {1}, and the game divides by the {2} this chain supplies the first time it reads the component.",
        rule.field,
        rule.atLeast === Number.MIN_VALUE ? 1 : rule.atLeast,
        value
    );
};

/**
 * Flags the fields of one group whose value its reading class refuses.
 *
 * @param group the group to judge.
 * @param cls the class the group resolves to.
 * @param members the group's folded members.
 * @param complete whether the fold read the whole inheritance chain.
 * @param cancellationToken cancels the evaluations.
 * @param errors collects the findings.
 */
const judgeDomains = async (
    group: GroupNode,
    cls: string,
    members: FoldedMembers,
    complete: boolean,
    cancellationToken: CancellationToken,
    errors: ValidationError[]
): Promise<void> => {
    const ancestry = new Set(classAncestry(cls));
    for (const rule of NUMERIC_DOMAIN_RULES) {
        if (!ancestry.has(rule.owner)) continue;
        if (rule.onlyWhenSiblingAbove) {
            const sibling = await effectiveNumber(members, rule.onlyWhenSiblingAbove.field, cancellationToken);
            if (!sibling || sibling.value <= rule.onlyWhenSiblingAbove.value) continue;
        }
        const written = await effectiveNumber(members, rule.field, cancellationToken);
        // Judging an absent field means reading its initialiser, and only a chain read to the end
        // proves it absent. A beam whose body comes from a shot file this server could not reach
        // looks exactly like a beam that writes no interval at all.
        if (!written && (rule.whenAbsent === undefined || !complete)) continue;
        const value = written ? written.value : (rule.whenAbsent as number);
        if (value >= rule.atLeast) continue;
        errors.push({
            message: messageFor(rule, value),
            node: written?.node ?? group.identifier ?? group,
            severity: 'error',
        });
    }
};

/**
 * Flags a resource whose nugget art carries more tiers than the stack it is sliced against.
 *
 * `GetAtlasSprite` divides by `floor((n+1)*Max/L) - floor(n*Max/L)`, with `L` the outer length of
 * the sprite list, and that difference is at least one for every tier only when `Max` is at least
 * `L`. Below it the first nugget drawn divides by zero. The flat spellings of the field give an
 * outer length of one and are always safe.
 *
 * @param group the resource group.
 * @param members the resource's folded members.
 * @param cancellationToken cancels the evaluations.
 * @param errors collects the finding.
 */
const judgeNuggetTiers = async (
    group: GroupNode | AbstractNodeDocument,
    members: FoldedMembers,
    cancellationToken: CancellationToken,
    errors: ValidationError[]
): Promise<void> => {
    const written = childNamed(group as GroupNode, NESTED_NUGGET_SPRITES);
    if (!written || !isListNode(written)) return;
    const tiers = written.elements.filter(isListNode).length;
    // A list whose elements are not all lists is one of the flat spellings, or a shape this reader
    // does not model, and either way its tier count is not what the engine slices by.
    if (tiers === 0 || written.elements.length !== tiers) return;
    const maximum = await effectiveNumber(members, MAX_PER_NUGGET, cancellationToken);
    if (!maximum || maximum.value >= tiers) return;
    errors.push({
        message: l10n.t(
            'The nugget art is sliced into {0} tiers against a stack of {1}, and the game divides by the size of a tier, which is zero once there are more tiers than the stack holds. The first nugget of this resource that is drawn stops the game.',
            tiers,
            maximum.value
        ),
        node: written.identifier ?? written,
        severity: 'error',
    });
};

/**
 * Runs the numeric-domain checks over a document.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk and the inheritance reads.
 * @returns the findings, in source order.
 */
export const validateNumericDomains = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    // A resource is a whole-file root, so its members sit at document level with no group around
    // them and the walk below never reaches them.
    if (documentRootClass(document) === RESOURCE_RULES_CLASS) {
        const rootMembers: FoldedMembers = new Map();
        for (const element of document.elements) {
            if (isAssignmentNode(element) && element.right) {
                rootMembers.set(element.left.name.toLowerCase(), element.right);
            }
        }
        await judgeNuggetTiers(document, rootMembers, cancellationToken, errors);
    }
    for (const node of descendants(document)) {
        if (cancellationToken.isCancellationRequested) return errors;
        if (!isGroupNode(node)) continue;
        const cls = resolveGroupClass(node);
        if (!cls) continue;
        const ancestry = classAncestry(cls);
        const owned = NUMERIC_DOMAIN_RULES.some((rule) => ancestry.includes(rule.owner));
        if (!owned && cls !== RESOURCE_RULES_CLASS) continue;
        const folded = await flattenGroup(node, cancellationToken).catch(() => null);
        const members: FoldedMembers = new Map();
        for (const member of folded?.members ?? []) {
            if (member.value) members.set(member.name.toLowerCase(), member.value);
        }
        if (owned) await judgeDomains(node, cls, members, folded?.complete === true, cancellationToken, errors);
        if (cls === RESOURCE_RULES_CLASS) await judgeNuggetTiers(node, members, cancellationToken, errors);
    }
    return errors;
};
