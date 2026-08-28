import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { childNodesOf } from '../../utils/ast.utils';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { classAncestry } from '../../document/schema/schema';
import { evaluateNumericValue } from '../../semantics/value-evaluator';
import { RangeDirectionEffect, RANGE_DIRECTION_RULES } from '../../document/schema/value-ranges';
import { ValidationError } from './validator';

/** The two members a range written as a group carries. */
const MIN_MEMBER = 'min';
const MAX_MEMBER = 'max';

/**
 * The member written under `name` in a group, in both spellings the format allows.
 *
 * @param group the group to read.
 * @param name the folded member name.
 * @returns the member's value, or undefined when the group does not write it.
 */
const memberOf = (group: GroupNode, name: string): AbstractNode | undefined => {
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === name) return element.right ?? undefined;
        if ((isGroupNode(element) || isListNode(element)) && element.identifier?.name.toLowerCase() === name) {
            return element;
        }
    }
    return undefined;
};

/** The two ends of a range, and the node to underline when they are the wrong way round. */
interface Endpoints {
    readonly low: AbstractNode;
    readonly high: AbstractNode;
    readonly anchor: AbstractNode;
}

/**
 * The endpoints of a range written in either of the two spellings the game reads.
 *
 * A range declaring a base is left alone: its own entries are appended after the inherited ones, so
 * the first two written here are not the two the game ends up with.
 *
 * @param node the value the range field carries.
 * @returns the endpoints, or undefined when the value is not a pair.
 */
const endpointsOf = (node: AbstractNode | undefined): Endpoints | undefined => {
    if (!node) return undefined;
    if (isListNode(node)) {
        if (node.inheritance?.length || node.elements.length !== 2) return undefined;
        return { low: node.elements[0], high: node.elements[1], anchor: node };
    }
    if (isGroupNode(node)) {
        if (node.inheritance?.length) return undefined;
        const low = memberOf(node, MIN_MEMBER);
        const high = memberOf(node, MAX_MEMBER);
        return low && high ? { low, high, anchor: node } : undefined;
    }
    return undefined;
};

/**
 * What the consumer does with a range the wrong way round, worded for the reader.
 *
 * @param effect the row's effect.
 * @param low the lower end as it works out.
 * @param high the upper end as it works out.
 * @returns the diagnostic message.
 */
const messageFor = (effect: RangeDirectionEffect, low: number, high: number): string =>
    effect === 'throws'
        ? l10n.t(
              'The game rolls a whole number between these, and refuses a high end below the low one, so it throws here with {0} above {1}.',
              String(low),
              String(high)
          )
        : l10n.t(
              'This window is empty with {0} above {1}, so nothing ever falls inside it and the feature never comes on.',
              String(low),
              String(high)
          );

/**
 * Flags a range written the wrong way round where the class reading it cares.
 *
 * Most ranges are interpolation bounds and count down on purpose, which is why range ordering is
 * not judged in general. A few are rolled instead, and the whole-number roll refuses a high end
 * below its low one rather than swapping them. A few more are compared, where a window the wrong
 * way round is simply one nothing can fall into. Both sets come from following the endpoints to
 * their consumer, see `document/schema/value-ranges.ts`.
 *
 * Only endpoints that work out to a number are judged, so a reference this server cannot resolve, a
 * modifiable value written as a group of its own and anything a buff can move are all left alone.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk and the value resolution.
 * @returns one finding per range whose direction its consumer refuses.
 */
export const validateValueRanges = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const groups: GroupNode[] = [];
    const collect = (node: AbstractNode): void => {
        if (isGroupNode(node)) groups.push(node);
        for (const child of childNodesOf(node)) collect(child);
    };
    for (const element of document.elements) collect(element);

    for (const group of groups) {
        if (cancellationToken.isCancellationRequested) return errors;
        const cls = resolveGroupClass(group);
        if (!cls) continue;
        // Matched through the ancestry, since the class that reads the range is often the base a
        // handful of concrete kinds derive from. The two rows sharing a field name sit on classes
        // deriving from neither, so nothing is conflated by this.
        const ancestry = new Set(classAncestry(cls));
        for (const rule of RANGE_DIRECTION_RULES) {
            if (!ancestry.has(rule.owner)) continue;
            const written = memberOf(group, rule.field.toLowerCase());
            if (!written) continue;
            const endpoints = rule.upperField
                ? ((): Endpoints | undefined => {
                      const high = memberOf(group, rule.upperField.toLowerCase());
                      return high ? { low: written, high, anchor: high } : undefined;
                  })()
                : endpointsOf(written);
            if (!endpoints) continue;
            const low = await evaluateNumericValue(endpoints.low, cancellationToken).catch(() => null);
            const high = await evaluateNumericValue(endpoints.high, cancellationToken).catch(() => null);
            if (low === null || high === null || low <= high) continue;
            errors.push({
                message: messageFor(rule.effect, low, high),
                node: endpoints.anchor,
                severity: rule.effect === 'throws' ? 'error' : 'warning',
            });
        }
    }
    return errors;
};
