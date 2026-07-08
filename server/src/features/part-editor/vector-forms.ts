import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    GroupNode,
    isAssignmentNode,
    isExpressionNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { evaluateExpressionGroup } from '../../semantics/value-evaluator';

/**
 * Structural readers for the geometry value forms part fields are written in. ObjectText lets every
 * vector-like type appear either positionally (`[x, y]`, a ListNode) or named (`{X = .. Y = ..}`, a
 * GroupNode), and map-typed fields appear as lists of `{ Key = ..; Value = .. }` entry groups. The
 * readers accept both forms so the grid editor sees the same values however a mod authored them.
 */

/** A read 2D vector with the node it came from, so edits can target the exact source range. */
export interface ReadVector {
    readonly x: number;
    readonly y: number;
    /** The vector's own node (the `[x, y]` list or `{X Y}` group). */
    readonly node: AbstractNode;
}

/** A read rectangle with the node it came from. */
export interface ReadRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly node: AbstractNode;
}

/** A read map entry (`{ Key = [x, y]; Value = .. }`) with its participating nodes. */
export interface ReadMapEntry {
    /** The whole entry group. */
    readonly entry: GroupNode;
    readonly key: ReadVector;
    /** The entry's value node, whatever its shape. */
    readonly value: AbstractNode;
}

/**
 * The numeric literal of a value node.
 * @param node the node to read.
 * @returns the number, or null when the node is not a plain numeric value.
 */
export const numberOf = (node: AbstractNode | null | undefined): number | null =>
    isValueNode(node) && node.valueType.type === 'Number' ? (node.valueType.value as number) : null;

/**
 * A direct child of a group by member name: an assignment's value or an identified group/list.
 * @param group the group to look in.
 * @param name the member name (exact match, the forms the editor writes are case-preserving).
 * @returns the member's value node, or null.
 */
export const childNamed = (group: GroupNode, name: string): AbstractNode | null => {
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name === name && element.right) return element.right;
        if ((isGroupNode(element) || isListNode(element)) && element.identifier?.name === name) return element;
    }
    return null;
};

/**
 * Reads a written 2D vector in either form.
 * @param node the written value (`[x, y]` list or `{X = .. Y = ..}` group).
 * @returns the vector, or null when the node is not a plain two-number vector.
 */
export const readVector = (node: AbstractNode | null | undefined): ReadVector | null => {
    if (!node) return null;
    if (isListNode(node)) {
        if (node.elements.length !== 2) return null;
        const x = numberOf(node.elements[0]);
        const y = numberOf(node.elements[1]);
        return x !== null && y !== null ? { x, y, node } : null;
    }
    if (isGroupNode(node)) {
        const x = numberOf(childNamed(node, 'X'));
        const y = numberOf(childNamed(node, 'Y'));
        return x !== null && y !== null ? { x, y, node } : null;
    }
    return null;
};

/**
 * Reads a written rectangle in either form. The positional list maps to the schema's digit fields
 * (`[X, Y, Width, Height]`), the group form reads the named members.
 * @param node the written value.
 * @returns the rect, or null when the node is not a plain four-number rect.
 */
export const readRect = (node: AbstractNode | null | undefined): ReadRect | null => {
    if (!node) return null;
    if (isListNode(node)) {
        if (node.elements.length !== 4) return null;
        const numbers = node.elements.map(numberOf);
        if (numbers.some((n) => n === null)) return null;
        const [x, y, width, height] = numbers as number[];
        return { x, y, width, height, node };
    }
    if (isGroupNode(node)) {
        const x = numberOf(childNamed(node, 'X'));
        const y = numberOf(childNamed(node, 'Y'));
        const width = numberOf(childNamed(node, 'Width'));
        const height = numberOf(childNamed(node, 'Height'));
        return x !== null && y !== null && width !== null && height !== null
            ? { x, y, width, height, node }
            : null;
    }
    return null;
};

/**
 * Reads a written enum value set: a bare name (`ExternalWalls = All`) or a list of names
 * (`Value = [Top, Right]`).
 * @param node the written value.
 * @returns the enum member names in source order, or null when the node holds none.
 */
export const readEnumNames = (node: AbstractNode | null | undefined): string[] | null => {
    if (!node) return null;
    if (isValueNode(node)) {
        const { type, value } = node.valueType;
        return type === 'String' || type === 'Reference' ? [String(value)] : null;
    }
    if (isListNode(node)) {
        const names: string[] = [];
        for (const element of node.elements) {
            if (!isValueNode(element)) return null;
            names.push(String(element.valueType.value));
        }
        return names;
    }
    return null;
};

/**
 * Reads a map-typed field's entries. The authored form is a list (or group) of `{ Key = [x, y];
 * Value = .. }` groups. Entries whose key is not a plain vector are skipped.
 * @param node the field's container node.
 * @returns the readable entries in source order (empty when the container holds none).
 */
export const readMapEntries = (node: AbstractNode | null | undefined): ReadMapEntry[] => {
    if (!isListNode(node) && !isGroupNode(node)) return [];
    const entries: ReadMapEntry[] = [];
    for (const element of node.elements) {
        if (!isGroupNode(element)) continue;
        const key = readVector(childNamed(element, 'Key'));
        const value = childNamed(element, 'Value');
        if (!key || !value) continue;
        entries.push({ entry: element, key, value });
    }
    return entries;
};

/**
 * Reads a written list of integers (`FlipHRotate = [0, 2, 1, 3]`).
 * @param node the written value.
 * @returns the numbers in source order, or null when the node is not a plain number list.
 */
export const readIntList = (node: AbstractNode | null | undefined): number[] | null => {
    if (!isListNode(node)) return null;
    const numbers = node.elements.map(numberOf);
    return numbers.every((n): n is number => n !== null) ? numbers : null;
};

/**
 * Reads a written boolean value.
 * @param node the written value.
 * @returns the boolean, or null when the node is not a plain boolean.
 */
export const booleanOf = (node: AbstractNode | null | undefined): boolean | null => {
    if (!isValueNode(node)) return null;
    if (node.valueType.type === 'Boolean') return node.valueType.value as boolean;
    // The lexer classifies bare `true`/`false` context-dependently, so tolerate the string forms.
    const text = String(node.valueType.value).toLowerCase();
    return text === 'true' ? true : text === 'false' ? false : null;
};

/**
 * Reads a rotation angle written as a degree literal (`90d`, `-150d`) or a plain number (radians
 * are rare in part data and are not converted here).
 * @param node the written value.
 * @returns the angle in degrees, or null when the node is not a literal angle.
 */
export const degreesOf = (node: AbstractNode | null | undefined): number | null => {
    if (!isValueNode(node)) return null;
    if (node.valueType.type === 'Number') return node.valueType.value as number;
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+))d$/.exec(String(node.valueType.value).trim());
    return match ? Number(match[1]) : null;
};

/**
 * Reads a bare enum-name value (`Direction = Down`).
 * @param node the written value.
 * @returns the name, or null when the node is not a bare word.
 */
export const enumNameOf = (node: AbstractNode | null | undefined): string | null => {
    if (!isValueNode(node)) return null;
    const { type, value } = node.valueType;
    return type === 'String' || type === 'Reference' ? String(value) : null;
};

/**
 * Reads a written 2D vector, additionally evaluating components that are math or references.
 * Lists store math inline-flattened with the commas dropped (`[64/64, 53/64]` parses to
 * `[64, /, 64, 53, /, 64]`), so the elements are re-segmented by the operand-after-operand rule
 * before evaluation, the same way the inlay hints do.
 * @param node the written value.
 * @param token cancels reference resolution.
 * @returns the vector (without a source node when evaluated), or null.
 */
export const readVectorEvaluated = async (
    node: AbstractNode | null | undefined,
    token: CancellationToken
): Promise<{ x: number; y: number } | null> => {
    const plain = readVector(node);
    if (plain) return { x: plain.x, y: plain.y };
    if (!isListNode(node)) return null;
    const segments: AbstractNode[][] = [];
    let current: AbstractNode[] = [];
    let prevWasOperand = false;
    for (const element of node.elements) {
        if (isExpressionNode(element)) {
            current.push(element);
            prevWasOperand = false;
            continue;
        }
        if (prevWasOperand && current.length) {
            segments.push(current);
            current = [];
        }
        current.push(element);
        prevWasOperand = true;
    }
    if (current.length) segments.push(current);
    if (segments.length !== 2) return null;
    const x = await evaluateExpressionGroup(segments[0], token).catch(() => null);
    const y = await evaluateExpressionGroup(segments[1], token).catch(() => null);
    return x !== null && y !== null ? { x, y } : null;
};
