import {
    AbstractNode,
    GroupNode,
    isAssignmentNode,
    isFunctionCallNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isMathExpressionNode,
} from '../../../core/ast/ast';
import { MemberRecord } from './plan.types';

/**
 * The furthest byte offset any node of a subtree reaches. An assignment's value can be a math
 * expression or a function call whose own `position` covers only its first token, so the end of a
 * member is the maximum over its whole subtree rather than the value node's own `end`.
 *
 * @param node the node to measure.
 * @returns the highest end offset in the subtree, or 0 when the subtree carries no position.
 */
const maxEndOffset = (node: AbstractNode | null | undefined): number => {
    if (!node) return 0;
    let end = node.position?.end ?? 0;
    if (isGroupNode(node) || isListNode(node)) {
        for (const element of node.elements) end = Math.max(end, maxEndOffset(element));
        for (const base of node.inheritance ?? []) end = Math.max(end, maxEndOffset(base));
    } else if (isAssignmentNode(node)) {
        end = Math.max(end, maxEndOffset(node.left), maxEndOffset(node.right));
    } else if (isFunctionCallNode(node)) {
        for (const argument of node.arguments) end = Math.max(end, maxEndOffset(argument));
    } else if (isMathExpressionNode(node)) {
        for (const element of node.elements) end = Math.max(end, maxEndOffset(element));
    }
    return end;
};

/**
 * The source span of a top-level member, which no single node spans on its own: an assignment node
 * carries no position, and a group's or list's `position.start` is its `{`/`[`, leaving the name,
 * the `:` and the inheritance references outside it.
 *
 * @param node the member node (assignment, named container, or bare valueless field).
 * @returns the byte offsets of the member, or undefined when the node has no usable position (an
 * unclosed container leaves its end at zero).
 */
export const memberSpanOf = (node: AbstractNode): { start: number; end: number } | undefined => {
    let start: number | undefined;
    let end = 0;
    if (isAssignmentNode(node)) {
        start = node.left.position?.start;
        end = Math.max(maxEndOffset(node.left), maxEndOffset(node.right));
    } else if ((isGroupNode(node) || isListNode(node)) && node.identifier) {
        start = node.identifier.position?.start;
        end = maxEndOffset(node);
    } else if (isIdentifierNode(node)) {
        start = node.position?.start;
        end = node.position?.end ?? 0;
    }
    if (start === undefined || end <= start) return undefined;
    return { start, end };
};

/** Character codes the member scanners compare against, kept out of the loops. */
const QUOTE = 34;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const TAB = 9;
const NEWLINE = 10;

/**
 * The comparison form of a member's source: indentation dropped, runs of spaces and tabs inside a
 * line collapsed to one, blank lines dropped, and a trailing `,`/`;` removed. Line structure is kept
 * on purpose, since ObjectText ends an entry at an unsuppressed newline, so two texts that differ in
 * where their line breaks fall are not the same member.
 *
 * @param raw the member's exact source slice.
 * @returns the normalized text two members are compared by.
 */
export const normalizeMemberText = (raw: string): string => {
    // Scanned by char code over spans rather than character by character: the member texts of a
    // whole mod pass through here twice per scan, and appending one character at a time built a
    // string per character of every file in the project.
    const parts: string[] = [];
    let segmentStart = 0;
    // The last character written out, which decides whether a run of spaces collapses to one or to
    // nothing. -1 until something has been written.
    let last = -1;
    let quoted = false;
    const flush = (end: number): void => {
        if (end <= segmentStart) return;
        parts.push(raw.slice(segmentStart, end));
        last = raw.charCodeAt(end - 1);
    };
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        if (quoted) {
            // Quoted text is the value itself. Collapsing whitespace in it would make two members
            // whose strings differ only in spacing compare equal, and they would then be merged.
            if (code === QUOTE) quoted = false;
            continue;
        }
        if (code === QUOTE) {
            quoted = true;
            continue;
        }
        if (code === CARRIAGE_RETURN) {
            flush(i);
            segmentStart = i + 1;
            continue;
        }
        if (code === SPACE || code === TAB) {
            flush(i);
            if (last !== -1 && last !== SPACE && last !== NEWLINE) {
                parts.push(' ');
                last = SPACE;
            }
            segmentStart = i + 1;
        }
    }
    flush(raw.length);
    return parts
        .join('')
        .replace(/ +\n/g, '\n')
        .replace(/\n+/g, '\n')
        .replace(/^\n+|\n+$/g, '')
        .replace(/[ \n]*[,;][ \n]*$/, '')
        .trimEnd();
};

/**
 * Whether a quoted string in the member runs across a line break. Such a member is left alone: the
 * base file re-indents continuation lines, and doing that inside a string literal would change the
 * value rather than just move it.
 *
 * @param raw the member's exact source slice.
 * @returns true when a quoted string spans more than one line, or a quote is never closed.
 */
export const hasMultiLineString = (raw: string): boolean => {
    let quoted = false;
    for (const char of raw) {
        if (char === '"') quoted = !quoted;
        else if (quoted && char === '\n') return true;
    }
    return quoted;
};

/**
 * A copy of a string that shares nothing with the text it was cut from. V8 keeps a slice as a view
 * onto its parent, so a record cached for the session would otherwise pin the whole source file it
 * came from, which over a four thousand file mod is the file set held in memory twice.
 *
 * @param text the slice to detach.
 * @returns an equal string that owns its own storage.
 */
const detach = (text: string): string => (text.length < 13 ? text : Buffer.from(text, 'utf-8').toString('utf-8'));

/**
 * Every comment span in a file, deliberately over-inclusive: anything that could read as a comment
 * marker outside a quoted string starts one. A member overlapping such a span is refused rather than
 * moved, so a false positive here only costs coverage, never correctness. The block form ends at the
 * first closing marker, which is at or before where the game's odd-star rule ends it.
 *
 * @param text the file's full source text.
 * @returns the comment spans, in ascending order and non-overlapping.
 */
export const commentRanges = (text: string): Array<{ start: number; end: number }> => {
    const ranges: Array<{ start: number; end: number }> = [];
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') {
            quoted = true;
            continue;
        }
        if (char !== '/') continue;
        if (text[i + 1] === '/') {
            const newline = text.indexOf('\n', i);
            const end = newline === -1 ? text.length : newline;
            ranges.push({ start: i, end });
            i = end - 1;
        } else if (text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            const end = close === -1 ? text.length : close + 2;
            ranges.push({ start: i, end });
            i = end - 1;
        }
    }
    return ranges;
};

/**
 * Whether any comment overlaps the byte span, used to leave a commented member (or a member a banner
 * comment introduces) where the author wrote it.
 *
 * @param ranges the file's comment spans from {@link commentRanges}.
 * @param start the span's inclusive start offset.
 * @param end the span's exclusive end offset.
 * @returns true when a comment touches the span.
 */
export const overlapsComment = (
    ranges: ReadonlyArray<{ start: number; end: number }>,
    start: number,
    end: number
): boolean => ranges.some((range) => range.start < end && range.end > start);

/**
 * The top-level members of a container, in document order, each with the span a rewrite deletes and
 * the normalized text used to compare it against another file's member.
 *
 * The member's node rides along for the caller's own checks and is never stored on the record: a
 * record outlives its pass, and a node keeps its whole document's AST alive with it.
 *
 * @param container the group whose direct members are read.
 * @param text the full source text of the file the group lives in.
 * @returns one record per member that has a usable span, skipping anything the parser left incomplete.
 */
export const topLevelMembersOf = (
    container: GroupNode,
    text: string
): Array<MemberRecord & { node: AbstractNode }> => {
    const records: Array<MemberRecord & { node: AbstractNode }> = [];
    for (const element of container.elements) {
        const span = memberSpanOf(element);
        if (!span) continue;
        // The name node is also the line anchor: an assignment carries no position of its own, and a
        // container's own position starts at its `{`, which can sit on the line below the name.
        const named = isAssignmentNode(element)
            ? element.left
            : (isGroupNode(element) || isListNode(element)) && element.identifier
              ? element.identifier
              : isIdentifierNode(element)
                ? element
                : undefined;
        if (!named) continue;
        const raw = detach(text.slice(span.start, span.end));
        let indentStart = span.start;
        while (indentStart > 0 && (text[indentStart - 1] === ' ' || text[indentStart - 1] === '\t')) indentStart--;
        records.push({
            indent: text.slice(indentStart, span.start),
            key: named.name.toLowerCase(),
            name: named.name,
            node: element,
            start: span.start,
            end: span.end,
            raw,
            norm: normalizeMemberText(raw),
            line: named.position.line,
        });
    }
    return records;
};
