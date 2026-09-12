import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isExpressionNode,
    isFunctionCallNode,
    isGroupNode,
    isListNode,
    isMathExpressionNode,
    isValueNode,
} from '../../core/ast/ast';
import { childNodesOf } from '../../utils/ast.utils';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { fieldOf } from '../../document/schema/schema';
import { ValueType } from '../../document/schema/schema.types';
import { evaluateNumericValueChecked } from '../../semantics/value-evaluator';
import { ValidationError } from './validator';

// The two operators that can carry a zero divisor: `/` and the modulo `#`.
const DIVISION_OPERATORS = new Set(['/', '#']);

// The same two inside a single unspaced token, the `10/0` a mod writes inside a vector. The
// operator has to follow a number or a closing paren. A `/` anywhere else is a reference path or a
// file path, never a division.
const GLUED_DIVISION = /[\d)]\s*[/#]/;

/**
 * Whether a value carries a division at all, so it is worth resolving. Everything else is left
 * unevaluated, which keeps this pass off the numeric fields that do no arithmetic.
 *
 * @param node the written value.
 * @returns true when the value divides somewhere inside it.
 */
const couldDivide = (node: AbstractNode): boolean => {
    if (isExpressionNode(node)) return DIVISION_OPERATORS.has(node.expressionType);
    if (isValueNode(node)) {
        const text = String(node.valueType.value);
        return !text.includes('&') && GLUED_DIVISION.test(text);
    }
    // Math expressions and calls carry their operands themselves, the shared child walk stops at
    // the value they are written as.
    if (isMathExpressionNode(node)) return node.elements.some(couldDivide);
    if (isFunctionCallNode(node)) return node.arguments.some(couldDivide);
    for (const child of childNodesOf(node)) if (couldDivide(child)) return true;
    return false;
};

/**
 * Whether a value type requires a whole number, which is where the game's NaN becomes a refused
 * file rather than a stored value. Mirrors the integer types the schema validator recognizes: a CLR
 * `int` primitive and the `ModifiableInt` engine scalar.
 *
 * @param valueType the field's declared type.
 * @returns true for an integer-only field.
 */
const requiresWholeNumber = (valueType: ValueType): boolean =>
    valueType.kind === 'int' || (valueType.kind === 'number' && valueType.type === 'ModifiableInt');

/**
 * Whether a value type reads a plain number, of either kind.
 *
 * @param valueType the field's declared type.
 * @returns true for a numeric scalar field.
 */
const readsNumber = (valueType: ValueType): boolean =>
    valueType.kind === 'float' || valueType.kind === 'number' || valueType.kind === 'int';

/**
 * The numeric type a written value is read as, or undefined when the slot is not numeric. A list,
 * range or interpolated field is judged by its element type, since that is what each written
 * element is converted to.
 *
 * @param valueType the field's declared type.
 * @returns the numeric type the value lands in.
 */
const numericSlot = (valueType: ValueType): ValueType | undefined => {
    if (readsNumber(valueType)) return valueType;
    if (valueType.kind === 'list' || valueType.kind === 'range' || valueType.kind === 'interpolated') {
        return readsNumber(valueType.element) ? valueType.element : undefined;
    }
    return undefined;
};

/** One written value, together with the type the game converts it to. */
interface Candidate {
    readonly node: AbstractNode;
    readonly valueType: ValueType;
    readonly fieldName: string;
}

/**
 * Every value of an assignment that ends up in a numeric slot: the value itself, or each element
 * of a list written into a numeric list, range or positional group field (`Location = [1/0, 2]`,
 * whose elements are read through the target class's digit fields).
 *
 * A list declaring a base is skipped. Its own elements are appended after the inherited ones, so
 * the written index is not the index the game reads them at.
 *
 * @param value the written value.
 * @param valueType the field's declared type.
 * @param fieldName the field's name, for the message.
 * @returns the values to resolve.
 */
const candidatesOf = (value: AbstractNode, valueType: ValueType, fieldName: string): Candidate[] => {
    const slot = numericSlot(valueType);
    if (slot && !isListNode(value)) return [{ node: value, valueType: slot, fieldName }];
    if (!isListNode(value) || value.inheritance?.length) return [];
    if (slot) return value.elements.map((element) => ({ node: element, valueType: slot, fieldName }));
    // A positional group value (`GridSize = [1, 2]`): the deserializer reads element N through the
    // target class's digit field "N", so each element takes that field's type.
    if (valueType.kind !== 'group') return [];
    const found: Candidate[] = [];
    value.elements.forEach((element, index) => {
        const positional = fieldOf(valueType.ref, String(index));
        const elementSlot = positional && numericSlot(positional.valueType);
        if (elementSlot) found.push({ node: element, valueType: elementSlot, fieldName });
    });
    return found;
};

/**
 * Division by zero in a value the game reads as a number.
 *
 * The game's own `ExpressionEvaluator` answers `NaN` for every spelling of it, the plain `1 / 0`,
 * an expression that works out to a zero divisor, and the modulo `10 # 0` alike. What happens next
 * is the field's type: a fractional field stores the NaN and the game runs on with it, while a
 * whole-number field throws an `OverflowException` converting it and the file never loads.
 *
 * Only a division written in the value itself is reported. One inside a field this value merely
 * references belongs to that field, which is reported there.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk and the value resolution.
 * @returns one finding per value that divides by zero.
 */
export const validateDivisionByZero = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const candidates: Candidate[] = [];
    const collect = (node: AbstractNode): void => {
        if (isAssignmentNode(node) && node.right && couldDivide(node.right)) {
            const parent = node.parent;
            const cls = parent && isGroupNode(parent) ? resolveGroupClass(parent) : undefined;
            const field = cls ? fieldOf(cls, node.left.name) : undefined;
            if (field) candidates.push(...candidatesOf(node.right, field.valueType, node.left.name));
        }
        for (const child of childNodesOf(node)) collect(child);
    };
    for (const element of document.elements) collect(element);

    for (const candidate of candidates) {
        if (cancellationToken.isCancellationRequested) return errors;
        const checked = await evaluateNumericValueChecked(candidate.node, cancellationToken).catch(() => ({
            value: null,
            dividedByZero: false,
        }));
        if (!checked.dividedByZero) continue;
        const whole = requiresWholeNumber(candidate.valueType);
        errors.push({
            message: whole
                ? l10n.t(
                      "This value divides by zero, which the game reads as NaN. '{0}' is a whole-number field, so the conversion throws and the game refuses to load the file.",
                      candidate.fieldName
                  )
                : l10n.t(
                      "This value divides by zero, so the game stores NaN in '{0}' instead of a number.",
                      candidate.fieldName
                  ),
            node: candidate.node,
            severity: whole ? 'error' : 'warning',
        });
    }
    return errors;
};
