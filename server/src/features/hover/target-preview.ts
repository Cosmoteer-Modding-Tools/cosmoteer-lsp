import * as l10n from '@vscode/l10n';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    ValueNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { code } from '../report/markdown-link';

/**
 * What a reference points at, rendered on one line.
 *
 * A reference that works out to a number is answered by the evaluator, and that is most of them. The
 * rest are the ones a reader cannot resolve by looking: a sprite path kept in a constant, a rect
 * written once and shared, a whole bullet file named from a weapon. Following one of those meant
 * opening the file it names.
 *
 * The preview is the target's own written content, not its effective one. What a chain folds into a
 * container is a different question with a report of its own, and answering it here would put a
 * value in a one-line label that the file does not contain.
 */

/** How many characters of a written value the markdown form shows before it is cut. */
const VALUE_WIDTH = 60;

/** How many entries of a container the markdown form shows before it is cut. */
const PREVIEW_ENTRIES = 12;

/** How many characters the inline form shows, which sits inside the line of code. */
const INLINE_WIDTH = 40;

/** How many entries the inline form shows. */
const INLINE_ENTRIES = 6;

/** The caps one rendering runs under. */
interface PreviewCaps {
    readonly width: number;
    readonly entries: number;
}

/**
 * A written value as one token, cut to the cap.
 *
 * @param node the value node.
 * @param caps the caps this rendering runs under.
 * @returns the display text.
 */
const valueText = (node: ValueNode, caps: PreviewCaps): string => {
    // A multi-line string is one value to the parser and two lines to a reader, and both consumers of
    // this preview are single-line: an inlay label, and a code span inside a hover.
    const text = String(node.valueType.value).replace(/\s+/g, ' ');
    // Cut on code points, so a character written in two units is never left half-written.
    const characters = [...text];
    return characters.length > caps.width ? `${characters.slice(0, caps.width).join('')}…` : text;
};

/**
 * One element of a container, rendered flat. A container inside a container is named by its shape
 * rather than expanded, since a preview that nests stops being one line.
 *
 * @param node the element.
 * @param caps the caps this rendering runs under.
 * @returns the display text.
 */
const elementText = (node: AbstractNode, caps: PreviewCaps): string => {
    if (isValueNode(node)) return valueText(node, caps);
    if (isListNode(node)) return '[…]';
    if (isGroupNode(node)) return '{…}';
    if (isAssignmentNode(node)) {
        const right = node.right;
        return `${node.left.name} = ${right ? elementText(right, caps) : ''}`.trimEnd();
    }
    // A bare key with no value is a member the game reads by name, so the name is what it is.
    if (isIdentifierNode(node)) return node.name;
    return '…';
};

/**
 * The entries of a container, joined and cut to the cap.
 *
 * @param elements the container's elements.
 * @param caps the caps this rendering runs under.
 * @returns the joined text, empty when the container holds nothing worth showing.
 */
const entriesText = (elements: readonly AbstractNode[], caps: PreviewCaps): string => {
    const shown = elements.slice(0, caps.entries).map((element) => elementText(element, caps));
    if (shown.length === 0) return '';
    const rest = elements.length - shown.length;
    return rest > 0 ? `${shown.join(', ')}, …` : shown.join(', ');
};

/**
 * The one-line body of a target: a literal, a list's entries or a group's fields.
 *
 * @param target the resolved target.
 * @param caps the caps this rendering runs under.
 * @returns the body, or null when the target has no one-line spelling.
 */
const bodyOf = (target: AbstractNode, caps: PreviewCaps): string | null => {
    if (isValueNode(target)) return valueText(target, caps);
    if (isListNode(target)) {
        const entries = entriesText((target as ListNode).elements, caps);
        return entries ? `[${entries}]` : null;
    }
    if (isGroupNode(target) || isDocumentNode(target)) {
        const entries = entriesText((target as GroupNode | AbstractNodeDocument).elements, caps);
        return entries ? `{${entries}}` : null;
    }
    return null;
};

/**
 * A preview cut to a width, keeping the bracket that closes a container. A body cut without it reads
 * as an unfinished line rather than as a shortened one.
 *
 * @param body the assembled preview.
 * @param width how many characters it may take.
 * @returns the body, cut if it had to be.
 */
const cutToWidth = (body: string, width: number): string => {
    const characters = [...body];
    if (characters.length <= width) return body;
    const closer = body.endsWith('}') ? '}' : body.endsWith(']') ? ']' : '';
    return `${characters.slice(0, width - closer.length).join('')}…${closer}`;
};

/**
 * What a reference points at, for the hover's resolved-target line.
 *
 * @param target the resolved target, a node or a whole file.
 * @returns the markdown text, or null when there is nothing to show.
 */
export const describeTargetMarkdown = (target: AbstractNode | FileWithPath): string | null => {
    const caps = { width: VALUE_WIDTH, entries: PREVIEW_ENTRIES };
    if (isFile(target as FileWithPath)) return l10n.t('the file {0}', code((target as FileWithPath).name));
    const node = target as AbstractNode;
    const body = bodyOf(node, caps);
    if (isGroupNode(node) || isListNode(node)) {
        const name = node.identifier?.name;
        // An anonymous container with nothing to preview keeps the spelling it has always had.
        const placeholder = isGroupNode(node) ? '{ … }' : '[ … ]';
        if (isGroupNode(node)) {
            if (name && body) return l10n.t('group {0} {1}', code(name), code(body));
            return l10n.t('group {0}', code(name ?? body ?? placeholder));
        }
        if (name && body) return l10n.t('list {0} {1}', code(name), code(body));
        return l10n.t('list {0}', code(name ?? body ?? placeholder));
    }
    return body ? code(body) : null;
};

/**
 * What a reference points at, for an inlay label sitting inside the line of code. Shorter than the
 * markdown form and carrying no formatting, since the editor renders it as plain text.
 *
 * @param target the resolved target, a node or a whole file.
 * @returns the label text, or null when there is nothing worth showing.
 */
export const describeTargetInline = (target: AbstractNode | FileWithPath): string | null => {
    if (isFile(target as FileWithPath)) return (target as FileWithPath).name;
    const body = bodyOf(target as AbstractNode, { width: INLINE_WIDTH, entries: INLINE_ENTRIES });
    if (!body) return null;
    return cutToWidth(body, INLINE_WIDTH);
};
