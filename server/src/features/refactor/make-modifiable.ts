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
import { findModRoot } from '../../mod/mod-root';
import { globalSettings } from '../../settings';
import { memberIndentAt } from '../diagnostics/required-field-insert';
import { memberSpanOf } from './shared-base/member-record';
import { snippetCodeAction } from './snippet-action';

/** The indentation one level deeper, which is what the game's own files are written with. */
const INDENT = '\t';

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
 * group and the member it sits on. A caret inside a `[ ]` stops the walk: a list element carries no
 * name for the schema to type it by.
 *
 * @param container the group or document to search.
 * @param offset the caret's byte offset.
 * @param chain the members found so far, appended to as the walk descends.
 * @returns the chain, empty when nothing holds the offset.
 */
const locateChain = (
    container: AbstractNodeDocument | GroupNode,
    offset: number,
    chain: Located[] = []
): Located[] => {
    for (const element of container.elements) {
        const span = memberSpanOf(element);
        if (!span || offset < span.start || offset >= span.end) continue;
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

/**
 * The value an assignment is written with, taken from the source rather than from the value node. A
 * parenthesized reference is spelled `(&…)` in the file while the node's own span starts after the
 * bracket, so the text is what decides here.
 *
 * @param text the file's source.
 * @param assignment the assignment to read.
 * @returns the value as the file spells it, empty when the assignment writes none.
 */
const writtenValueOf = (text: string, assignment: AssignmentNode): string => {
    const span = memberSpanOf(assignment);
    if (!span) return '';
    const equals = text.indexOf('=', assignment.left.position.end);
    if (equals < 0 || equals >= span.end) return '';
    return text.slice(equals + 1, span.end).trim();
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
 * has as its `BaseValue` and an empty `Modifiers` list for the caret to land in. Nothing the game
 * loads changes, which is what makes it safe to offer on any such field. The modifier itself is left
 * to the author, because every kind but one names something that has to exist, and the game throws on
 * a `Buff` modifier written without the buff it applies to.
 *
 * Collapsing is the inverse, and it is offered only where the group holds `BaseValue` and nothing
 * else, since every other member of the class changes the value the game arrives at.
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
        const value = writtenValueOf(text, base);
        if (value.length === 0) return [];
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
    const value = writtenValueOf(text, located.element);
    if (value.length === 0) return [];
    const indent = memberIndentAt(text, span.start);
    const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
    const body = [
        `${name}`,
        `${indent}{`,
        `${indent}${INDENT}${BASE_VALUE} = ${escapeSnippet(value)}`,
        `${indent}${INDENT}${MODIFIERS}`,
        `${indent}${INDENT}[`,
        `${indent}${INDENT}${INDENT}$0`,
        `${indent}${INDENT}]`,
        `${indent}}`,
    ].join(lineEnding);
    const title = l10n.t("Make '{0}' modifiable", name);
    return [snippetCodeAction({ title, kind: CodeActionKind.RefactorRewrite, uri }, range, body)];
};
