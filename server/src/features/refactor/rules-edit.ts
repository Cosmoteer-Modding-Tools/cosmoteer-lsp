import { Range, TextEdit } from 'vscode-languageserver';
import {
    AbstractNode,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { offsetToPosition } from '../../utils/text.utils';
import { indentUnitOf } from './command-host';

/**
 * The primitives every writer into a `.rules` buffer shares: where a member really starts and ends,
 * where a container's brackets are, what one more member is indented with, and how a written value
 * is replaced without leaving half of it behind.
 *
 * Two features write through these. The part table writes a number the reader typed over the value
 * a cell was read from, and adds a member to a part that only inherits the value. The grid editor
 * turns one gesture into list appends, element removals and vector rewrites. Both land in files the
 * author wrote by hand, so every edit here touches the smallest span that expresses the change and
 * keeps the layout the file already has.
 *
 * The shapes handled are the two the game's object text writes members in. `Name = value` parses as
 * an assignment, which carries no span of its own, only its name and its value do. `Name { … }` and
 * `Name [ … ]` parse as a container whose own span starts at the opening bracket, with the name
 * hanging off it as an identifier node that also sits in the parent's element list. A span that
 * ignores that identifier reads the name as part of the indentation before the member, which is
 * what made the older copies of this code fall back to a guessed tab.
 */

/** A start and end byte offset into a file's text. */
export interface ByteSpan {
    /** The offset the span starts at. */
    readonly start: number;
    /** The offset one past the span's last character. */
    readonly end: number;
}

/**
 * The LSP range between two byte offsets.
 *
 * @param text the file's text the offsets are measured against.
 * @param start the first offset.
 * @param end the offset one past the last character.
 * @returns the range.
 */
export const rangeBetween = (text: string, start: number, end: number): Range =>
    Range.create(offsetToPosition(text, start), offsetToPosition(text, end));

/**
 * The edit that writes text over a byte span.
 *
 * @param text the file's text the offsets are measured against.
 * @param start the first offset.
 * @param end the offset one past the last character.
 * @param newText what the span becomes.
 * @returns the edit.
 */
export const replaceSpan = (text: string, start: number, end: number, newText: string): TextEdit => ({
    range: rangeBetween(text, start, end),
    newText,
});

/**
 * The edit that inserts text at a byte offset, changing nothing around it.
 *
 * @param text the file's text the offset is measured against.
 * @param offset where the text goes.
 * @param newText what is inserted.
 * @returns the edit.
 */
export const insertAt = (text: string, offset: number, newText: string): TextEdit => {
    const position = offsetToPosition(text, offset);
    return { range: Range.create(position, position), newText };
};

/**
 * The byte span one member of a container occupies, from the first character the author typed for
 * it to the last. An assignment runs from its name to its value, since the assignment node itself
 * carries no position. A named container runs from its name to its closing bracket, since the
 * container's own span starts at the bracket and would leave the name outside the member.
 *
 * @param element the member.
 * @returns the span, or null when the member has no measurable position.
 */
export const memberSpan = (element: AbstractNode): ByteSpan | null => {
    if (isAssignmentNode(element)) {
        const end = element.right?.position.end ?? element.left.position.end;
        return { start: element.left.position.start, end };
    }
    if (!element.position) return null;
    const named = isGroupNode(element) || isListNode(element) ? element.identifier : undefined;
    return { start: named ? named.position.start : element.position.start, end: element.position.end };
};

/**
 * The span of the last member a container writes. A named container keeps its own name in the
 * parent's element list as well, so the members are read through {@link memberSpan} rather than by
 * taking the last element, which also skips anything the parse left without a position.
 *
 * @param container the container to read.
 * @returns the last member's span, or null when the container writes no member with a position.
 */
const lastMemberSpan = (container: GroupNode | ListNode): ByteSpan | null => {
    for (let index = container.elements.length - 1; index >= 0; index--) {
        const span = memberSpan(container.elements[index]);
        if (span) return span;
    }
    return null;
};

/**
 * The byte offset of a container's opening bracket. The parse records the bracket itself as the
 * container's start, and the search from the name is the fallback for a parse that did not.
 *
 * @param text the file's current text.
 * @param node the container.
 * @returns the offset of the `{` or `[`, or -1 when the text no longer holds one.
 */
export const openerOffset = (text: string, node: GroupNode | ListNode): number => {
    const char = isListNode(node) ? '[' : '{';
    if (text[node.position.start] === char) return node.position.start;
    const from = node.identifier ? node.identifier.position.end : node.position.start;
    return text.indexOf(char, from);
};

/**
 * The byte offset of a container's closing bracket, which is also the guard that the text still
 * reads the way the parse recorded it. A buffer that has moved on since answers -1, and the caller
 * refuses rather than writing somewhere the container no longer is.
 *
 * @param text the file's current text.
 * @param node the container.
 * @returns the offset of the `}` or `]`, or -1 when the span does not end in one.
 */
export const closerOffset = (text: string, node: GroupNode | ListNode): number =>
    text[node.position.end - 1] === (isListNode(node) ? ']' : '}') ? node.position.end - 1 : -1;

/**
 * How many levels deep a container's direct members sit, counting the document's own children as
 * level zero. This is what a new member is indented by when the container holds no member to copy
 * the indentation from.
 *
 * @param container the container the members belong to.
 * @returns the number of indentation levels.
 */
export const nestingDepthOf = (container: AbstractNode): number => {
    let depth = 1;
    for (let node = container.parent; node; node = node.parent) {
        if (isGroupNode(node) || isListNode(node)) depth++;
    }
    return depth;
};

/**
 * The indentation a container's direct members are written with, in the file's own indentation
 * step. A file indented with spaces keeps its spaces, and one with nothing indented yet gets the
 * tab the game's own files are written with.
 *
 * @param text the file's current text.
 * @param container the container the members belong to.
 * @returns the whitespace one member is prefixed with.
 */
export const childIndentOf = (text: string, container: AbstractNode): string =>
    indentUnitOf(text).repeat(nestingDepthOf(container));

/**
 * The leading whitespace of the line an offset sits on, when the offset is the first thing on that
 * line. A member that shares its line with something else has no indentation to copy.
 *
 * @param text the file's current text.
 * @param offset where the member starts.
 * @returns the whitespace before it, or null when it does not start its line.
 */
const lineIndentAt = (text: string, offset: number): string | null => {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    return /^[ \t]*$/.test(prefix) ? prefix : null;
};

/**
 * The indentation one more member of a container is written with: the indentation the container's
 * last member already has, or the file's own step at the container's depth when there is no member
 * to copy it from. A caller that renders a member spanning several lines needs this to indent the
 * lines {@link appendMemberEdit} does not write for it.
 *
 * A last member that shares its line with its siblings has no indentation to copy, so the depth is
 * used instead. The required-field fix reads the same thing from an offset and takes that line's own
 * leading whitespace, which is the one case where the two answers differ.
 *
 * @param text the file's current text.
 * @param container the container the member goes into.
 * @returns the whitespace the member is prefixed with.
 */
export const memberIndentOf = (text: string, container: GroupNode | ListNode): string => {
    const last = lastMemberSpan(container);
    return (last && lineIndentAt(text, last.start)) ?? childIndentOf(text, container);
};

/** Where one more member goes inside a container that is written over several lines. */
export type MemberPlacement =
    /** On a new line right after the last member, which leaves anything trailing that line alone. */
    | 'afterLast'
    /** On its own line right before the closing bracket, which keeps a trailing comment where it is. */
    | 'beforeCloser';

/** How {@link appendMemberEdit} writes one more member into a container. */
export interface AppendMemberOptions {
    /**
     * What joins the new member to the previous one when the whole container sits on one line, the
     * `, ` a list is written with. Left out, a one-line container is broken open and the member goes
     * on a line of its own, which is what a group of `Name = value` members wants.
     */
    readonly inlineSeparator?: string;
    /** Where the member goes in a container written over several lines. Defaults to `afterLast`. */
    readonly placement?: MemberPlacement;
}

/**
 * The edit that writes one more member into a container, keeping the layout the container already
 * has. A container written over several lines takes the member on a line of its own, indented the
 * way its last member is indented, falling back to the file's own indentation step at the
 * container's depth. A container on one line takes the member inline when the caller says what
 * separates its members, and is broken open otherwise. An empty container takes the member on the
 * line after its opening bracket.
 *
 * @param text the file's current text.
 * @param container the container the member goes into.
 * @param memberText the member as it should be written.
 * @param options the layout choices the two callers differ on.
 * @returns the single insertion, or null when the container's brackets are not where the parse
 *          recorded them, so the edit could land outside them.
 */
export const appendMemberEdit = (
    text: string,
    container: GroupNode | ListNode,
    memberText: string,
    options: AppendMemberOptions = {}
): TextEdit | null => {
    const open = openerOffset(text, container);
    const close = closerOffset(text, container);
    if (open < 0 || close < 0 || close < open) return null;
    const last = lastMemberSpan(container);
    if (options.inlineSeparator !== undefined && !text.slice(open, close).includes('\n')) {
        if (!last) return insertAt(text, open + 1, memberText);
        return insertAt(text, last.end, `${options.inlineSeparator}${memberText}`);
    }
    const indent = memberIndentOf(text, container);
    if (options.placement === 'beforeCloser') return insertAt(text, close, `${indent}${memberText}\n`);
    if (!last) return insertAt(text, open + 1, `\n${indent}${memberText}`);
    return insertAt(text, last.end, `\n${indent}${memberText}`);
};

/**
 * The byte span a written value occupies, with its parentheses balanced. The parser leaves a
 * leading `(` out of a value's span while keeping the trailing `)`, so writing over the recorded
 * span alone would leave `(9500` behind. Every unmatched closing parenthesis inside the span is
 * paid for by taking in the opening one before it, and the other way round.
 *
 * @param text the file's current text.
 * @param node the value node.
 * @returns the start and end offsets of the whole written value.
 */
export const valueSpan = (text: string, node: AbstractNode): ByteSpan => {
    let { start, end } = node.position;
    const balance = (): number => {
        let open = 0;
        for (let index = start; index < end; index++) {
            if (text[index] === '(') open++;
            else if (text[index] === ')') open--;
        }
        return open;
    };
    for (let unmatched = balance(); unmatched < 0; unmatched++) {
        const before = text.lastIndexOf('(', start - 1);
        if (before === -1 || text.slice(before + 1, start).trim().length > 0) break;
        start = before;
    }
    for (let unmatched = balance(); unmatched > 0; unmatched--) {
        const after = text.indexOf(')', end);
        if (after === -1 || text.slice(end, after).trim().length > 0) break;
        end = after + 1;
    }
    return { start, end };
};

/**
 * The edit that writes a value over the one a node holds, taking in the parentheses the parse left
 * out of the node's span. This is the whole of an overwrite in place: the value the author reads in
 * the file goes away and the new one stands where it stood.
 *
 * @param text the file's current text.
 * @param node the value node being written over.
 * @param newText the value as it should be written.
 * @returns the edit.
 */
export const overwriteValueEdit = (text: string, node: AbstractNode, newText: string): TextEdit => {
    const span = valueSpan(text, node);
    return replaceSpan(text, span.start, span.end, newText);
};

/**
 * Whether a node's recorded span still holds the text it was parsed from. A caller that kept nodes
 * from an earlier parse, as the part table's walk does, would otherwise take an edit to wherever
 * those offsets now point in a buffer that has moved on. A caller that re-reads the document for
 * every edit, as the grid editor does, never needs this.
 *
 * @param text the file's current text.
 * @param node the node to check.
 * @returns true when the span reads as the value it was parsed from.
 */
export const spanIsCurrent = (text: string, node: AbstractNode): boolean => {
    const slice = text.slice(node.position.start, node.position.end).trim();
    if (slice.length === 0) return false;
    if (isValueNode(node)) {
        const written = String(node.valueType.value).trim();
        return slice === written || slice.replace(/^\(|\)$/g, '') === written || Number(slice) === Number(written);
    }
    return true;
};
