import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { childNodesOf } from '../../utils/ast.utils';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { classAncestry } from '../../document/schema/schema';
import { RefusalConsequence, REFUSED_ENUM_RULES, RefusedEnumRule } from '../../document/schema/refused-enum-values';
import { ValidationError } from './validator';

/**
 * The member written under `name` in a group, in both spellings the format allows.
 *
 * @param group the group to read.
 * @param name the member name, matched the case-insensitive way the game matches it.
 * @returns the member's value, or undefined when the group does not write it.
 */
const memberOf = (group: GroupNode, name: string): AbstractNode | undefined => {
    const wanted = name.toLowerCase();
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === wanted) return element.right ?? undefined;
        if ((isGroupNode(element) || isListNode(element)) && element.identifier?.name.toLowerCase() === wanted) {
            return element;
        }
    }
    return undefined;
};

/**
 * The node a rule's member path leads to, walking group by group from the class that owns the read.
 *
 * @param group the group the rule matched.
 * @param path the member names to walk.
 * @returns the node at the end of the path, or undefined when the file does not write it.
 */
const memberAtPath = (group: GroupNode, path: readonly string[]): AbstractNode | undefined => {
    let current: AbstractNode | undefined = group;
    for (const segment of path) {
        if (!current || !isGroupNode(current)) return undefined;
        current = memberOf(current, segment);
    }
    return current;
};

/**
 * The enum members a node writes, which is one value or, for a list-valued rule, each element.
 *
 * @param node the node the rule's path led to.
 * @param listed whether the rule reads a list.
 * @returns the value nodes spelling a plain member name.
 */
const writtenMembers = (node: AbstractNode | undefined, listed: boolean): ValueNode[] => {
    if (!node) return [];
    const candidates = listed ? (isListNode(node) ? node.elements : [node]) : [node];
    return candidates.filter(
        (candidate): candidate is ValueNode =>
            isValueNode(candidate) &&
            candidate.valueType.type !== 'Reference' &&
            String(candidate.valueType.value).trim() !== ''
    );
};

/**
 * What the game does with a member the consumer refuses, worded for the reader.
 *
 * @param consequence the row's consequence.
 * @param written the member as it was written.
 * @param accepted the members the consumer does handle.
 * @returns the diagnostic message.
 */
const messageFor = (consequence: RefusalConsequence, written: string, accepted: string): string => {
    switch (consequence) {
        case 'load':
            return l10n.t(
                "A fixed weapon reads only {0} here. The game refuses to load the data tree when it finds '{1}'.",
                accepted,
                written
            );
        case 'targetSearch':
            return l10n.t(
                "A bullet's target search handles only {0}. The game throws once the search reaches '{1}'.",
                accepted,
                written
            );
        case 'bulletDeath':
            return l10n.t(
                "A death component reads only {0} as its frame of reference. The game throws on '{1}' when the bullet dies.",
                accepted,
                written
            );
        case 'beamHit':
            return l10n.t(
                "A beam has no bullet to take its frame of reference from, so it reads only {0}. The game throws on '{1}' when the beam hits something it draws effects for.",
                accepted,
                written
            );
    }
};

/**
 * Flags an enum member the field's own type allows and the class reading it refuses.
 *
 * The schema types such a field by its enum, so every member of it validates and every member of
 * it is offered while typing. The class consuming the value handles fewer: a fixed weapon takes
 * one of the seven target types and the reader throws on the rest, a bullet's target search has
 * four arms and a throwing default, and a frame of reference legal for a bullet is refused by a
 * beam. The rows come from those guards, see `document/schema/refused-enum-values.ts`.
 *
 * Judged only where the group's class resolves and the value is written as a plain member name. A
 * whole block assigned by reference carries its member somewhere else, so the check sees nothing
 * and says nothing.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk when the document changed under us.
 * @returns one finding per written member the consuming class refuses.
 */
export const validateRefusedEnumValues = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const rulesFor = (cls: string): RefusedEnumRule[] => {
        const ancestry = new Set(classAncestry(cls));
        return REFUSED_ENUM_RULES.filter((rule) => ancestry.has(rule.owner));
    };
    const visit = (node: AbstractNode): void => {
        if (cancellationToken.isCancellationRequested) return;
        if (isGroupNode(node)) {
            const cls = resolveGroupClass(node);
            for (const rule of cls ? rulesFor(cls) : []) {
                const accepted = new Set(rule.accepted.map((member) => member.toLowerCase()));
                for (const value of writtenMembers(memberAtPath(node, rule.path), rule.listed === true)) {
                    const written = String(value.valueType.value).trim();
                    if (accepted.has(written.toLowerCase())) continue;
                    errors.push({
                        message: messageFor(rule.consequence, written, rule.accepted.join(', ')),
                        node: value,
                        severity: rule.severity,
                    });
                }
            }
        }
        for (const child of childNodesOf(node)) visit(child);
    };
    visit(document);
    return errors;
};
