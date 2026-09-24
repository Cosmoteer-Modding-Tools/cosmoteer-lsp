import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, GroupNode, isGroupNode, isListNode } from '../../core/ast/ast';
import { childNamed, readVector, readVectorEvaluated } from '../../semantics/vector-forms';

/**
 * The reader the grid editor's picture and its writer share. The game reads every coordinate through
 * its expression evaluator, so `[2-1, 0]` and `[(&~/SIZE/0), 1]` are cells it places like any other,
 * and a reader that only accepts two literals shows a part the game does not have. Worse, the writer
 * then counts elements the picture never showed, so an index the webview sent names a different
 * element and a cell that is already written reads as free. Both sides go through here so the entry
 * the author sees at position n is the entry position n edits.
 */

/** A vector read off the file, with the node it is written at and how it had to be read. */
export interface GridVector {
    readonly x: number;
    readonly y: number;
    /** The node the value is written at, which provenance and in-place edits are anchored on. */
    readonly node: AbstractNode;
    /** True when the numbers came out of math or a reference rather than out of two literals. */
    readonly computed: boolean;
}

/** A map entry (`{ Key = [x, y]; Value = .. }`) with its key read the same way. */
export interface GridMapEntry {
    /** The whole entry group. */
    readonly entry: GroupNode;
    readonly key: GridVector;
    /** The entry's value node, whatever its shape. */
    readonly value: AbstractNode;
}

/**
 * Reads one written vector, evaluating math and references when it is not two plain literals.
 *
 * @param node the written value.
 * @param token cancels reference resolution.
 * @returns the vector, or null when nothing readable stands there.
 */
export const readGridVector = async (
    node: AbstractNode | null | undefined,
    token: CancellationToken
): Promise<GridVector | null> => {
    if (!node) return null;
    const plain = readVector(node);
    if (plain) return { x: plain.x, y: plain.y, node: plain.node, computed: false };
    const evaluated = await readVectorEvaluated(node, token).catch(() => null);
    return evaluated ? { x: evaluated.x, y: evaluated.y, node, computed: true } : null;
};

/**
 * Reads the vector elements of a list-shaped member in source order, skipping the elements no
 * reader can name.
 *
 * @param member the field's container node.
 * @param token cancels reference resolution.
 * @returns the readable vectors, empty when the member is not a container.
 */
export const readGridVectors = async (
    member: AbstractNode | null | undefined,
    token: CancellationToken
): Promise<GridVector[]> => {
    if (!isListNode(member) && !isGroupNode(member)) return [];
    const vectors: GridVector[] = [];
    for (const element of member.elements) {
        const vector = await readGridVector(element, token);
        if (vector) vectors.push(vector);
    }
    return vectors;
};

/**
 * Reads the named vector member of every entry group of a list (`ResourceLevels [ { Offset } ]`).
 *
 * @param member the field's container node.
 * @param name the member name each entry carries the vector under.
 * @param token cancels reference resolution.
 * @returns the readable vectors, in source order.
 */
export const readGridMemberVectors = async (
    member: AbstractNode | null | undefined,
    name: string,
    token: CancellationToken
): Promise<GridVector[]> => {
    if (!isListNode(member) && !isGroupNode(member)) return [];
    const vectors: GridVector[] = [];
    for (const element of member.elements) {
        if (!isGroupNode(element)) continue;
        const vector = await readGridVector(childNamed(element, name), token);
        if (vector) vectors.push(vector);
    }
    return vectors;
};

/**
 * Reads a map field's entries, keys included, in source order.
 *
 * @param member the field's container node.
 * @param token cancels reference resolution.
 * @returns the readable entries, empty when the member is not a container.
 */
export const readGridMapEntries = async (
    member: AbstractNode | null | undefined,
    token: CancellationToken
): Promise<GridMapEntry[]> => {
    if (!isListNode(member) && !isGroupNode(member)) return [];
    const entries: GridMapEntry[] = [];
    for (const element of member.elements) {
        if (!isGroupNode(element)) continue;
        const value = childNamed(element, 'Value');
        if (!value) continue;
        const key = await readGridVector(childNamed(element, 'Key'), token);
        if (key) entries.push({ entry: element, key, value });
    }
    return entries;
};

/**
 * Whether a map field holds an entry whose key no reader can name. The game builds these fields
 * with `Dictionary.Add`, which throws on a repeated key and stops the whole rules load, so a new
 * entry must not be appended next to a key the editor cannot compare against.
 *
 * @param member the field's container node.
 * @param token cancels reference resolution.
 * @returns true when at least one entry group carries an unreadable key.
 */
export const hasUnreadableMapKey = async (
    member: AbstractNode | null | undefined,
    token: CancellationToken
): Promise<boolean> => {
    if (!isListNode(member) && !isGroupNode(member)) return false;
    for (const element of member.elements) {
        if (!isGroupNode(element)) continue;
        if (!childNamed(element, 'Value')) continue;
        if (!(await readGridVector(childNamed(element, 'Key'), token))) return true;
    }
    return false;
};
