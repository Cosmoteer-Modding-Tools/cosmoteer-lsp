import { CancellationToken } from 'vscode-languageserver';
import * as l10n from '@vscode/l10n';
import {
    AbstractNode,
    ValueNode,
    isExpressionNode,
    isFunctionCallNode,
    isListNode,
    isMathExpressionNode,
    isValueNode,
} from '../core/ast/ast';
import { listElementType } from '../document/schema/schema-context';
import { ValueType } from '../document/schema/schema.types';
import { fieldOfAssignedNode } from '../features/completion/autocompletion.schema';
import { formatNumber } from './value-evaluator';

/**
 * The unit a rendered number carries, so a hover or an inlay hint can name what a figure is instead
 * of leaving the reader to decode it. The game's ExpressionEvaluator rewrites the `%`, `d` and `r`
 * suffixes before mXparser sees the string (`50%` becomes 0.5, `90d` becomes radians, `2r` keeps its
 * digits), which is why `-2.5d` computes to -0.043633. The evaluator has to return exactly those
 * numbers, so the unit is attached out here, in the callers that render them.
 */

/** A unit a rendered number can carry. `angle` means radians, `percent` a fraction, `seconds` a duration. */
export type ValueUnit = 'angle' | 'percent' | 'seconds';

/** The operators that hand their operands' unit to the result. Everything else changes what the number is. */
const UNIT_PRESERVING_OPERATORS: ReadonlySet<string> = new Set(['+', '-', '*', '/']);

/**
 * The unit a suffixed number literal carries, mirroring the suffix rules of the evaluator's
 * `evaluateValue` exactly, so a literal is labelled only when the evaluator really rewrote it. `d`
 * and `r` both land on radians, so both read as an angle.
 *
 * @param node the value node to inspect.
 * @returns the unit, or undefined when the node is not a suffixed number literal.
 */
const suffixUnitOf = (node: ValueNode): ValueUnit | undefined => {
    if (node.quoted) return undefined;
    const literal = String(node.valueType.value).replace(/\s+/g, '');
    if (/^-?\d*\.?\d+%$/.test(literal)) return 'percent';
    if (/^-?\d*\.?\d+[dr]$/.test(literal)) return 'angle';
    return undefined;
};

/**
 * The unit the written source of an evaluated number carries. Every suffixed literal in the
 * expression has to agree, and the expression has to be plain arithmetic. A function call turns
 * radians into degrees (`deg`) or an angle into a bare ratio (the trigonometry family), and a
 * relation or boolean operator collapses its operands to 0 or 1, so both leave the unit undecidable
 * and nothing is labelled.
 *
 * References are not followed. What a reference resolves to lives in another scope, and the field's
 * declared type covers the cases where that matters.
 *
 * @param nodes the source nodes the number was evaluated from.
 * @returns the unit every written literal agrees on, or undefined when there is none.
 */
export const sourceUnitOf = (nodes: readonly AbstractNode[]): ValueUnit | undefined => {
    const found = new Set<ValueUnit>();
    let decidable = true;
    const walk = (node: AbstractNode | null | undefined): void => {
        if (!node || !decidable) return;
        if (isFunctionCallNode(node)) {
            decidable = false;
            return;
        }
        if (isExpressionNode(node)) {
            if (!UNIT_PRESERVING_OPERATORS.has(node.expressionType)) decidable = false;
            return;
        }
        if (isMathExpressionNode(node)) {
            for (const element of node.elements) walk(element);
            return;
        }
        if (isValueNode(node)) {
            const unit = suffixUnitOf(node);
            if (unit) found.add(unit);
        }
    };
    for (const node of nodes) walk(node);
    return decidable && found.size === 1 ? [...found][0] : undefined;
};

/**
 * The unit a numeric slot's declared type names. `Halfling.Geometry.Angle` and
 * `Halfling.Geometry.Direction` both hold a `_radians` float and `Cosmoteer.Ships.ModifiableAngle`
 * wraps an `Angle`, so all three read as radians. Their ObjectText constructor parses the written
 * text straight into that field, so a bare `FiringArc = 220` really is 220 radians. The bundle's
 * `unit: "degrees"` names the suffix an author writes into such a field, not what the game stores.
 * `ModifiableTime` wraps `Halfling.Timing.Time`, which the engine documents as seconds.
 *
 * @param valueType the declared type of the slot the value sits in.
 * @returns the unit, or undefined when the type names none.
 */
const declaredUnitOf = (valueType: ValueType | undefined): ValueUnit | undefined => {
    if (valueType?.kind !== 'number') return undefined;
    if (valueType.unit === 'degrees' || valueType.type === 'ModifiableAngle') return 'angle';
    if (valueType.type === 'ModifiableTime') return 'seconds';
    return undefined;
};

/**
 * The unit of the slot a number is written into: the declaring field of a `key = value`, or the
 * element type for a value inside a list, which is what types the endpoints of a `range<Angle>`
 * written as `Arc = [22.5d, 360d]`.
 *
 * @param node the node the number was evaluated from.
 * @param cancellationToken cancellation for the inheritance walk resolving the container's class.
 * @returns the unit, or undefined when the slot is untyped or names none.
 */
export const fieldUnitOf = async (
    node: AbstractNode,
    cancellationToken: CancellationToken
): Promise<ValueUnit | undefined> => {
    const parent = node.parent;
    if (parent && isListNode(parent)) return declaredUnitOf(listElementType(parent));
    const field = await fieldOfAssignedNode(node, cancellationToken).catch(() => undefined);
    return declaredUnitOf(field?.valueType);
};

/**
 * The unit to render an evaluated number with. The declared type wins over the written suffix,
 * because it says what the game stores while a suffix only says how one operand was spelled.
 *
 * @param nodes the source nodes the number was evaluated from.
 * @param cancellationToken cancellation for the schema lookup.
 * @returns the unit, or undefined when neither source decides one.
 */
export const unitForValue = async (
    nodes: readonly AbstractNode[],
    cancellationToken: CancellationToken
): Promise<ValueUnit | undefined> => {
    const declared = nodes.length ? await fieldUnitOf(nodes[0], cancellationToken) : undefined;
    return declared ?? sourceUnitOf(nodes);
};

/**
 * Render an evaluated number with its unit. An angle shows the radians the game stores next to the
 * degrees they are, a fraction shows its percent, a duration shows its seconds. A number with no
 * known unit renders exactly as {@link formatNumber} returns it, so nothing changes where nothing
 * is known.
 *
 * @param value the evaluated number.
 * @param unit the unit decided for it, or undefined when none was.
 * @returns the display text.
 */
export const formatWithUnit = (value: number, unit: ValueUnit | undefined): string => {
    switch (unit) {
        case 'angle':
            return l10n.t('{0} rad ({1}°)', formatNumber(value), formatNumber((value * 180) / Math.PI));
        case 'percent':
            return l10n.t('{0} ({1}%)', formatNumber(value), formatNumber(value * 100));
        case 'seconds':
            return l10n.t('{0} s', formatNumber(value));
        default:
            return formatNumber(value);
    }
};
