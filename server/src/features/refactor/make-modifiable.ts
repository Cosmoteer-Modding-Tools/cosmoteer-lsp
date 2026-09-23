import * as l10n from '@vscode/l10n';
import { CodeAction, CodeActionKind, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    AbstractNode,
    AbstractNodeDocument,
    AssignmentNode,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { memberTypeIn } from '../../document/schema/schema-context';
import { referenceNodesOf } from '../navigation/reference-nodes';
import { findModRoot } from '../../mod/mod-root';
import { globalSettings } from '../../settings';
import { memberIndentAt } from '../diagnostics/required-field-insert';
import { indentUnitOf, lineEndingOf } from './command-host';
import { memberHitSpansOf, memberSpanOf } from './shared-base/member-record';
import { snippetCodeAction } from './snippet-action';

/** The member a `ModifiableValue` group carries the plain number in. */
const BASE_VALUE = 'BaseValue';

/** The member the modifiers of a `ModifiableValue` are listed in. */
const MODIFIERS = 'Modifiers';

/** A member the caret sits on, together with the container that types it. */
interface Located {
    /** The member itself. */
    element: AbstractNode;
    /** The group or document that keys it, which is what the schema types the member through. */
    container: AbstractNodeDocument | GroupNode;
}

/**
 * The members the offset falls in, outermost first, so a caret inside a group body names both that
 * group and the member it sits on. The indentation a member is written behind counts as part of it,
 * so a selection that starts at the head of its line names the member on that line. A caret inside a
 * `[ ]` stops the walk: a list element carries no name for the schema to type it by.
 *
 * @param container the group or document to search.
 * @param offset the caret's byte offset.
 * @param chain the members found so far, appended to as the walk descends.
 * @returns the chain, empty when nothing holds the offset.
 */
const locateChain = (container: AbstractNodeDocument | GroupNode, offset: number, chain: Located[] = []): Located[] => {
    for (const { element, start, end } of memberHitSpansOf(container)) {
        if (offset < start || offset >= end) continue;
        chain.push({ element, container });
        const value = isAssignmentNode(element) ? element.right : element;
        if (isListNode(value)) return chain;
        if (isGroupNode(value) && offset >= value.position.start) locateChain(value, offset, chain);
        return chain;
    }
    return chain;
};

/**
 * The group class a member's slot also accepts, for a number the game reads as either a plain value
 * or a `{ BaseValue = … }` group. Absent for every other field.
 *
 * @param container the group or document keying the member.
 * @param name the member's name.
 * @returns the group class the slot accepts, or undefined when the slot takes no group form.
 */
const groupFormOf = (container: AbstractNodeDocument | GroupNode, name: string): string | undefined => {
    const valueType = memberTypeIn(container, name);
    if (!valueType) return undefined;
    if (valueType.kind !== 'number' && valueType.kind !== 'int' && valueType.kind !== 'float') return undefined;
    return valueType.groupForm;
};

/**
 * The name a member is keyed by, whether it is written as an assignment or as a named group.
 *
 * @param element the member.
 * @returns the name, or undefined for a member that carries none.
 */
const memberNameOf = (element: AbstractNode): string | undefined => {
    if (isAssignmentNode(element)) return element.assignmentType === 'Equals' ? element.left.name : undefined;
    if (isGroupNode(element)) return element.identifier?.name;
    return undefined;
};

/**
 * The value a member carries, which for a named group is the group itself.
 *
 * @param element the member.
 * @returns the value node, or undefined when the member writes none.
 */
const memberValueOf = (element: AbstractNode): AbstractNode | undefined => {
    if (isAssignmentNode(element)) return element.right ?? undefined;
    return isGroupNode(element) ? element : undefined;
};

/**
 * The single `BaseValue` assignment of a group that carries nothing else, which is the only shape a
 * collapse back to a plain number is safe on. `MinValue`, `MaxValue`, `BuffType` and `StatusType` all
 * change what the game computes, so a group holding any of them keeps its group form.
 *
 * @param group the group to read.
 * @returns the assignment, or undefined when the group holds anything besides one `BaseValue`.
 */
const soleBaseValue = (group: GroupNode): AssignmentNode | undefined => {
    if (group.inheritance?.length) return undefined;
    if (group.elements.length !== 1) return undefined;
    const only = group.elements[0];
    if (!only || !isAssignmentNode(only) || only.assignmentType !== 'Equals') return undefined;
    if (only.left.name !== BASE_VALUE || !only.right) return undefined;
    if (isGroupNode(only.right) || isListNode(only.right)) return undefined;
    return only;
};

/** One character of whitespace, which is what the value's own span is trimmed by. */
const WHITESPACE = /\s/;

/**
 * The span of the value an assignment is written with, taken from the source rather than from the
 * value node. A parenthesized reference is spelled `(&…)` in the file while the node's own span
 * starts after the bracket, so the text is what decides here.
 *
 * @param text the file's source.
 * @param assignment the assignment to read.
 * @returns the span of the value as the file spells it, or undefined when the assignment writes none.
 */
const writtenValueSpan = (text: string, assignment: AssignmentNode): { start: number; end: number } | undefined => {
    const span = memberSpanOf(assignment);
    if (!span) return undefined;
    const equals = text.indexOf('=', assignment.left.position.end);
    if (equals < 0 || equals >= span.end) return undefined;
    let start = equals + 1;
    let end = span.end;
    while (start < end && WHITESPACE.test(text[start])) start++;
    while (end > start && WHITESPACE.test(text[end - 1])) end--;
    return start < end ? { start, end } : undefined;
};

/**
 * The path a reference names, with the `&` sigil and any `<file>` prefix taken off, split into the
 * segments the game's own navigator walks.
 *
 * @param reference the reference as the file spells it.
 * @returns the segments after the root, empty for a reference that names nothing but a file.
 */
const pathSegmentsOf = (reference: string): string[] => {
    const body = reference.startsWith('&') ? reference.slice(1) : reference;
    const close = body.startsWith('<') ? body.indexOf('>') : -1;
    return (close >= 0 ? body.slice(close + 1) : body).split('/').filter((segment) => segment.length > 0);
};

/**
 * Whether a path names its own root rather than starting where it is written: the file root `~`, the
 * original root `/`, or another file `<…>`. Such a path means the same thing wherever it moves to.
 *
 * @param path the reference path, `&` already taken off.
 * @returns true when the path is rooted.
 */
const isRootedPath = (path: string): boolean => path.startsWith('~') || path.startsWith('/') || path.startsWith('<');

/**
 * The same path read from one group further down, which is where the wrap puts the value. The game
 * accepts `.` only as a path's first token, so a leading `.` is rewritten rather than prefixed.
 *
 * @param path the reference path, `&` already taken off.
 * @returns the path as it has to be spelled one level deeper.
 */
const deepenedPath = (path: string): string => {
    if (isRootedPath(path)) return path;
    if (path === '.') return '..';
    if (path.startsWith('./')) return `../${path.slice(2)}`;
    return `../${path}`;
};

/**
 * The same path read from one group further up, which is where the collapse puts the value. A path
 * with no `..` to give up names something inside the group that is about to go, so it cannot be
 * written one level up at all.
 *
 * @param path the reference path, `&` already taken off.
 * @returns the path as it has to be spelled one level up, or undefined when it cannot be.
 */
const shallowedPath = (path: string): string | undefined => {
    if (isRootedPath(path)) return path;
    if (path === '..') return '.';
    if (path.startsWith('../')) return path.slice(3) || '.';
    return undefined;
};

/**
 * The value an assignment is written with, with every relative reference in it rebased for the move
 * the refactoring makes. The game resolves a relative reference from the group the field sits in, so
 * a value that changes depth without its references being rewritten points one group off.
 *
 * @param text the file's source.
 * @param assignment the assignment whose value is moving.
 * @param rebase the new spelling of one path, or undefined when the path cannot make the move.
 * @returns the value to write, or undefined when it writes none or carries a path that cannot move.
 */
const rebasedValueOf = (
    text: string,
    assignment: AssignmentNode,
    rebase: (path: string) => string | undefined
): string | undefined => {
    const span = writtenValueSpan(text, assignment);
    if (!span) return undefined;
    let written = '';
    let read = span.start;
    for (const node of referenceNodesOf(assignment)) {
        const reference = String(node.valueType.value);
        const start = node.position.start;
        if (start < read || start + reference.length > span.end) continue;
        const moved = rebase(reference.startsWith('&') ? reference.slice(1) : reference);
        if (moved === undefined) return undefined;
        written += text.slice(read, start) + `&${moved}`;
        read = start + reference.length;
    }
    return written + text.slice(read, span.end);
};

/**
 * Whether the file reads the member through a reference, which is what the wrap breaks: the game's
 * expression evaluator throws on a reference that lands on a group instead of a field, and its
 * navigator answers nothing for one that reads through it.
 *
 * The match is on the name the path ends with rather than on a resolved target, so a file that
 * writes the name for a different field withholds the offer too. Withholding costs the author one
 * refactoring they could have taken, while offering costs them a file the game refuses to load.
 *
 * @param document the parsed file.
 * @param name the member the refactoring is about to move.
 * @param tail the segment the reference has to end with after `name`, for the collapse direction.
 * @returns true when some reference in the file reads the member.
 */
const isReadByReference = (document: AbstractNodeDocument, name: string, tail?: string): boolean => {
    for (const node of referenceNodesOf(document)) {
        const segments = pathSegmentsOf(String(node.valueType.value));
        const last = segments[segments.length - 1];
        if (tail === undefined) {
            if (last === name) return true;
            continue;
        }
        if (last === tail && segments[segments.length - 2] === name) return true;
    }
    return false;
};

/**
 * The value's own spelling, with anything a snippet would read as a tab stop escaped, so a reference
 * or a math expression is written back exactly as the file had it.
 *
 * @param value the text taken from the file.
 * @returns the same text, safe to put in a snippet body.
 */
const escapeSnippet = (value: string): string => value.replace(/[$\\}]/g, '\\$&');

/**
 * The two directions of the modifiable-value refactoring, offered on whichever one the caret sits on.
 *
 * Wrapping writes the group form the game also reads at that slot, with the number the file already
 * has as its `BaseValue` and an empty `Modifiers` list for the caret to land in. The modifier itself
 * is left to the author, because every kind but one names something that has to exist, and the game
 * throws on a `Buff` modifier written without the buff it applies to.
 *
 * Collapsing is the inverse, and it is offered only where the group holds `BaseValue` and nothing
 * else, since every other member of the class changes the value the game arrives at.
 *
 * Both directions move the value by one group, so both rebase the relative references the value
 * carries, and both are withheld where the file reads the member through a reference. The game's
 * expression evaluator throws on a reference that lands on a group rather than a field, and its
 * navigator answers nothing for a path whose depth changed under it, so a refactoring that moved
 * either without the other would write a file the game refuses to load.
 *
 * @param document the parsed document the caret is in.
 * @param textDocument the buffer the caret's offsets are converted against.
 * @param offset the caret's byte offset.
 * @param uri the document's uri.
 * @returns the offered refactorings, empty when the caret sits on no such field.
 */
export const makeModifiableCodeActions = (
    document: AbstractNodeDocument,
    textDocument: TextDocument,
    offset: number,
    uri: string
): CodeAction[] => {
    // The game's own install is read-only unless the one switch every refactoring reads says otherwise.
    if (!findModRoot(uri) && !globalSettings.allowEditingVanillaFiles) return [];
    // The caret can sit on the field itself or inside the group form it already carries, so the chain
    // is read from the inside out and the first member whose slot takes a group form is the one meant.
    const located = locateChain(document, offset)
        .reverse()
        .find(({ element, container }) => {
            const name = memberNameOf(element);
            return name !== undefined && groupFormOf(container, name) !== undefined;
        });
    if (!located) return [];
    const name = memberNameOf(located.element);
    const span = memberSpanOf(located.element);
    if (name === undefined || !span) return [];

    const text = textDocument.getText();
    const range: Range = { start: textDocument.positionAt(span.start), end: textDocument.positionAt(span.end) };
    const written = memberValueOf(located.element);

    if (isGroupNode(written)) {
        const base = soleBaseValue(written);
        if (!base) return [];
        // A reader spelling the group's own `BaseValue` reads nothing once the group is gone, so the
        // collapse is withheld rather than written.
        if (isReadByReference(document, name, BASE_VALUE)) return [];
        const value = rebasedValueOf(text, base, shallowedPath);
        if (value === undefined || value.length === 0) return [];
        const title = l10n.t("Replace '{0}' with its plain value", name);
        return [
            snippetCodeAction(
                { title, kind: CodeActionKind.RefactorInline, uri },
                range,
                `${name} = ${escapeSnippet(value)}`
            ),
        ];
    }

    if (!isAssignmentNode(located.element)) return [];
    // A reference landing on the field reads a group once the wrap is written, and the game's
    // expression evaluator throws on that, so the offer is withheld rather than written.
    if (isReadByReference(document, name)) return [];
    const value = rebasedValueOf(text, located.element, deepenedPath);
    if (value === undefined || value.length === 0) return [];
    const indent = memberIndentAt(text, span.start);
    const lineEnding = lineEndingOf(text);
    // One level deeper in whatever the file itself indents with, so a space-indented mod stays one.
    const step = indentUnitOf(text);
    const body = [
        `${name}`,
        `${indent}{`,
        `${indent}${step}${BASE_VALUE} = ${escapeSnippet(value)}`,
        `${indent}${step}${MODIFIERS}`,
        `${indent}${step}[`,
        `${indent}${step}${step}$0`,
        `${indent}${step}]`,
        `${indent}}`,
    ].join(lineEnding);
    const title = l10n.t("Make '{0}' modifiable", name);
    return [snippetCodeAction({ title, kind: CodeActionKind.RefactorRewrite, uri }, range, body)];
};
