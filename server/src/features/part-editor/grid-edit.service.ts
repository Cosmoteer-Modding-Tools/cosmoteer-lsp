import { CancellationToken, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import * as l10n from '@vscode/l10n';
import {
    AbstractNode,
    AbstractNodeDocument,
    AssignmentNode,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { GridCell, GridMutation, GridPoint, PartGridEditResult } from './part-grid.types';
import {
    buildEffectiveFieldState,
    inheritedBoolean,
    inheritedEnumNames,
    inheritedIntList,
    inheritedMemberHasValues,
    locatePartGroup,
} from './part-grid-data.service';
import { childNamed, enumNameOf, numberOf, readMapEntries, readRect, readVector, readVectorEvaluated } from './vector-forms';
import {
    GridEditOptions,
    WriteSite,
    declarationOf,
    followToDeclaration,
    holdsReference,
    isRefusal,
} from './reference-writeback';
import { isReferenceValue } from '../navigation/definition.service';
import { evaluateNumericValue } from '../../semantics/value-evaluator';
import { normalizeUri } from '../navigation/reference-location';
import { offsetToPosition } from '../../utils/text.utils';

/**
 * Turns one grid editor mutation into a minimal WorkspaceEdit against the part's own file. Every
 * mutation is re-resolved against the current AST (the webview's geometry is only trusted for the
 * mutation payload itself), and each edit touches the smallest span that expresses the change:
 * append one list element, remove one element with its separator, or rewrite one vector in place,
 * preserving the authored form (`[x, y]` list vs `{X = .. Y = ..}` group). A field that only exists
 * on a base part is materialized as a full local override carrying the inherited value with the
 * mutation applied.
 */

/** A localized refusal from an edit builder. */
interface EditError {
    readonly error: string;
}

/**
 * A text edit plus the file it belongs in. An edit with no uri lands in the part's own document,
 * which is every edit that does not follow a reference out of it.
 */
interface TargetedEdit extends TextEdit {
    /** The file the edit applies to, when it is not the document being edited. */
    readonly uri?: string;
    /** What to tell the author about a write that followed a reference somewhere else. */
    readonly note?: string;
}

/** An edit outcome: LSP text edits, or a localized refusal. */
type EditOutcome = TargetedEdit[] | EditError;

/**
 * The file a write is currently landing in. Following a reference produces a new scope over the
 * declaring file, so the same writers serve a value written here and one written three files away.
 */
interface WriteScope {
    /** The uri of the file being written. */
    readonly uri: string;
    /** That file's text, which every offset in the produced edits is measured against. */
    readonly text: string;
    readonly options: GridEditOptions;
    readonly token: CancellationToken;
}

/** Everything an edit builder needs: the part it edits, its file, and the hooks to reach others. */
interface EditContext extends WriteScope {
    readonly part: GroupNode;
}

/**
 * Whether an edit builder refused instead of producing edits.
 *
 * @param outcome the builder's answer.
 * @returns true when it is a refusal carrying a message.
 */
export const isError = (outcome: EditOutcome): outcome is EditError => 'error' in outcome;

/** An LSP range between two byte offsets of `text`. */
const rangeBetween = (text: string, start: number, end: number): Range =>
    Range.create(offsetToPosition(text, start), offsetToPosition(text, end));

/** A replacement edit over a node's byte span. */
const replaceSpan = (text: string, start: number, end: number, newText: string): TextEdit => ({
    range: rangeBetween(text, start, end),
    newText,
});

/** An insertion edit at a byte offset. */
const insertAt = (text: string, offset: number, newText: string): TextEdit => {
    const position = offsetToPosition(text, offset);
    return { range: Range.create(position, position), newText };
};

/** Formats a number the way the data files write them (plain integers, short fractions). */
const formatNumber = (value: number): string => {
    if (Number.isInteger(value)) return String(value);
    return String(Math.round(value * 1000) / 1000);
};

/** Formats a vector for insertion (always the positional list form new entries use). */
const vectorText = (x: number, y: number): string => `[${formatNumber(x)}, ${formatNumber(y)}]`;

/** Formats an enum value list (`[Top, Right]`). */
const enumListText = (values: readonly string[]): string => `[${values.join(', ')}]`;

/** Formats a map entry the vanilla way. */
const mapEntryText = (cell: GridCell, values: readonly string[]): string =>
    `{ Key = ${vectorText(cell.x, cell.y)}; Value = ${enumListText(values)} }`;

/** Formats a virtual-cell pair entry. */
const pairEntryText = (external: GridCell, internal: GridCell): string =>
    `{ ExternalCell = ${vectorText(external.x, external.y)}; InternalCell = ${vectorText(internal.x, internal.y)} }`;

/** The tab depth at which a container's direct children are written (document root children = 0). */
const childIndentOf = (container: AbstractNode): number => {
    let depth = 1;
    for (let node = container.parent; node; node = node.parent) {
        if (isGroupNode(node) || isListNode(node)) depth++;
    }
    return depth;
};

const tabs = (count: number): string => '\t'.repeat(count);

/** The byte offset of a container's opening bracket/brace (after its identifier when named). */
const openerOffset = (text: string, node: GroupNode | ListNode): number => {
    const char = isListNode(node) ? '[' : '{';
    if (text[node.position.start] === char) return node.position.start;
    const from = node.identifier ? node.identifier.position.end : node.position.start;
    return text.indexOf(char, from);
};

/** The byte offset of a container's closing bracket/brace, or -1 when the span is not as recorded. */
const closerOffset = (text: string, node: GroupNode | ListNode): number => {
    const char = isListNode(node) ? ']' : '}';
    return text[node.position.end - 1] === char ? node.position.end - 1 : -1;
};

/** A member of a container with the nodes an edit needs: the value plus its assignment when `=` form. */
interface LocalMember {
    readonly value: AbstractNode;
    readonly assignment: AssignmentNode | null;
}

/** The container's direct member by exact name, in either `Name = value` or `Name { }` form. */
const localMember = (container: GroupNode, name: string): LocalMember | null => {
    for (const element of container.elements) {
        if (isAssignmentNode(element) && element.left.name === name && element.right) {
            return { value: element.right, assignment: element };
        }
        if ((isGroupNode(element) || isListNode(element)) && element.identifier?.name === name) {
            return { value: element, assignment: null };
        }
    }
    return null;
};

/**
 * Appends one element to an existing list, matching its layout: inline `, X` for a single-line
 * list, a new line replicating the previous element's indentation for a block list.
 *
 * Shared with the "register this part in a ship class" refactoring, whose append into a ship's
 * `Parts [ … ]` is exactly this edit and has to keep the file's own layout the same way.
 *
 * @param text the file's source text the edit is measured against.
 * @param list the container the element is appended to.
 * @param elementText the element as it should be written.
 * @returns the single insertion edit, or a refusal when the container's brackets are not where the
 *          recorded span says, so an edit could land outside them.
 */
export const appendElementEdit = (text: string, list: ListNode | GroupNode, elementText: string): EditOutcome => {
    const open = openerOffset(text, list);
    const close = closerOffset(text, list);
    if (open < 0 || close < 0 || close < open) return { error: l10n.t('The list could not be edited safely.') };
    const singleLine = !text.slice(open, close).includes('\n');
    const last = list.elements[list.elements.length - 1];
    if (singleLine) {
        if (!last) return [insertAt(text, open + 1, elementText)];
        return [insertAt(text, last.position.end, `, ${elementText}`)];
    }
    if (!last) {
        return [insertAt(text, open + 1, `\n${tabs(childIndentOf(list))}${elementText}`)];
    }
    // Replicate the last element's own leading whitespace so mixed tab/space files stay consistent.
    const lineStart = text.lastIndexOf('\n', last.position.start) + 1;
    const prefix = text.slice(lineStart, last.position.start);
    const indent = /^\s*$/.test(prefix) ? prefix : tabs(childIndentOf(list));
    return [insertAt(text, last.position.end, `\n${indent}${elementText}`)];
};

/** Removes one element from a list together with the separator run joining it to its neighbours. */
const removeElementEdit = (text: string, list: ListNode | GroupNode, element: AbstractNode): EditOutcome => {
    const index = list.elements.indexOf(element);
    if (index < 0) return { error: l10n.t('The list could not be edited safely.') };
    if (index > 0) {
        return [replaceSpan(text, list.elements[index - 1].position.end, element.position.end, '')];
    }
    if (list.elements.length > 1) {
        return [replaceSpan(text, element.position.start, list.elements[1].position.start, '')];
    }
    const open = openerOffset(text, list);
    if (open < 0) return { error: l10n.t('The list could not be edited safely.') };
    return [replaceSpan(text, open + 1, element.position.end, '')];
};

/** Grows a member's span to its whole line when the line holds nothing else, so removals stay clean. */
const memberRemovalSpan = (text: string, start: number, end: number): [number, number] => {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (!/^\s*$/.test(text.slice(lineStart, start))) return [start, end];
    let lineEnd = text.indexOf('\n', end);
    if (lineEnd < 0) lineEnd = text.length;
    else lineEnd++;
    if (!/^\s*$/.test(text.slice(end, lineEnd === text.length ? lineEnd : lineEnd - 1))) return [start, end];
    return [lineStart, lineEnd];
};

/**
 * Removes one element, or the whole member when it is the last element and removing the field
 * would not resurface inherited values. An emptied override of an inherited list WITH values stays
 * as an explicit empty list, but when the base's list is empty too (or no base defines the field)
 * the empty container is just leftover noise in the file.
 */
const removeElementOrMemberEdit = async (
    text: string,
    container: GroupNode,
    fieldName: string,
    member: LocalMember,
    element: AbstractNode,
    token: CancellationToken
): Promise<EditOutcome> => {
    const list = member.value as ListNode;
    if (list.elements.length === 1 && list.elements[0] === element) {
        if (!(await inheritedMemberHasValues(container, fieldName, token))) return removeMemberEdit(text, member);
    }
    return removeElementEdit(text, list, element);
};

/** Removes a whole member (assignment or identified container) including its now-empty line. */
const removeMemberEdit = (text: string, member: LocalMember): EditOutcome => {
    const start = member.assignment
        ? member.assignment.left.position.start
        : ((member.value as GroupNode | ListNode).identifier?.position.start ?? member.value.position.start);
    const [from, to] = memberRemovalSpan(text, start, member.value.position.end);
    return [replaceSpan(text, from, to, '')];
};

/** Rewrites a vector value in place, preserving its authored form. */
const replaceVectorEdit = (text: string, node: AbstractNode, x: number, y: number): EditOutcome => {
    if (isGroupNode(node)) {
        return [replaceSpan(text, node.position.start, node.position.end, `{X = ${formatNumber(x)}; Y = ${formatNumber(y)}}`)];
    }
    return [replaceSpan(text, node.position.start, node.position.end, vectorText(x, y))];
};

/** The group-form member names of the two numeric tuples the grid editor writes. */
const VECTOR_MEMBERS = ['X', 'Y'] as const;
const RECT_MEMBERS = ['X', 'Y', 'Width', 'Height'] as const;

/** Names the file every edit that does not already name one belongs to. */
const inFile = (uri: string, edits: readonly TargetedEdit[]): TargetedEdit[] =>
    edits.map((edit) => (edit.uri ? edit : { ...edit, uri }));

/**
 * What to say when two numbers a gesture has to move apart are written from one declaration. Read
 * at the moment of the refusal rather than once, so the sentence follows the editor's language.
 *
 * @returns the localized refusal.
 */
const SAME_DECLARATION = (): string =>
    l10n.t('Two of these numbers are the same declaration and cannot differ, edit them in the text.');

/**
 * Collapses the edits that landed on one span, which is what happens when two components of a tuple
 * are written from the same declaration. A square part sized `[&~/S, &~/S]` dragged to 3 by 3 asks
 * for the same number twice and is one edit. Asked for two different numbers, the gesture has no
 * meaning the file can hold, and it is refused rather than half applied.
 *
 * @param edits the edits the components produced.
 * @param scope the file the untagged edits belong to.
 * @returns the edits with duplicates collapsed, or null when two of them disagree.
 */
const collapseSameSpan = (edits: readonly TargetedEdit[], scope: WriteScope): TargetedEdit[] | null => {
    const bySpan = new Map<string, TargetedEdit>();
    for (const edit of edits) {
        const key = `${normalizeUri(edit.uri ?? scope.uri)}#${edit.range.start.line}:${edit.range.start.character}`;
        const seen = bySpan.get(key);
        if (!seen) {
            bySpan.set(key, edit);
            continue;
        }
        if (seen.newText !== edit.newText) return null;
    }
    return [...bySpan.values()];
};

/**
 * What to tell the author after a write followed a reference: where the value really lives, and how
 * many other places read it, since moving one handle moved every one of them.
 *
 * @param scope the file the write started from.
 * @param site the declaration the write landed in.
 * @returns the note for the editor's status line.
 */
const noteFor = async (scope: WriteScope, site: WriteSite): Promise<string> => {
    const path = site.uri.replace(/\\/g, '/');
    const file = path.slice(path.lastIndexOf('/') + 1);
    const readers = await (
        scope.options.countReaders?.(declarationOf(site.node), site.uri, scope.token) ?? Promise.resolve(null)
    ).catch(() => null);
    if (readers === null || readers <= 0) return l10n.t('Wrote through {0} in {1}.', site.through ?? '', file);
    return l10n.t('Wrote through {0} in {1}, which {2} other places read.', site.through ?? '', file, String(readers));
};

/**
 * Replaces one written value, following it to its declaration when the value is a reference. This
 * is what keeps `Location = &~/PORT_CELL` a sentence about `PORT_CELL` after a drag instead of
 * pasting a literal over the name.
 *
 * @param scope the file the value is written in.
 * @param node the value node the handle sits on.
 * @param newText the value as it should be written.
 * @returns the edits, or a refusal naming why the reference cannot be written through.
 */
const writeValue = async (scope: WriteScope, node: AbstractNode, newText: string): Promise<EditOutcome> => {
    if (!isReferenceValue(node)) {
        return [replaceSpan(scope.text, node.position.start, node.position.end, newText)];
    }
    const site = await followToDeclaration(node, scope.uri, scope.text, scope.options, scope.token);
    if (isRefusal(site)) return { error: site.error };
    const edit = replaceSpan(site.text, site.node.position.start, site.node.position.end, newText);
    return [{ ...edit, uri: site.uri, note: await noteFor(scope, site) }];
};

/**
 * {@link writeValue} for a value that has to stay a single one. A reference naming a whole group or
 * list is refused rather than written over, since a number pasted across a container's span would
 * delete every member it holds.
 *
 * @param scope the file the value is written in.
 * @param node the value node the handle sits on.
 * @param newText the value as it should be written.
 * @returns the edits, or a refusal.
 */
const writeScalar = async (scope: WriteScope, node: AbstractNode, newText: string): Promise<EditOutcome> => {
    if (!isReferenceValue(node)) {
        return [replaceSpan(scope.text, node.position.start, node.position.end, newText)];
    }
    const site = await followToDeclaration(node, scope.uri, scope.text, scope.options, scope.token);
    if (isRefusal(site)) return { error: site.error };
    if (isGroupNode(site.node) || isListNode(site.node)) {
        return { error: l10n.t('{0} names a group rather than a value, edit it in the text.', site.through ?? '') };
    }
    const edit = replaceSpan(site.text, site.node.position.start, site.node.position.end, newText);
    return [{ ...edit, uri: site.uri, note: await noteFor(scope, site) }];
};

/** The number a component currently holds, following references and math so a no-op is recognized. */
const currentNumber = async (node: AbstractNode, token: CancellationToken): Promise<number | null> => {
    const written = numberOf(node);
    if (written !== null) return written;
    return evaluateNumericValue(node, token).catch(() => null);
};

/** Writes one numeric component, and writes nothing when the file already says that number. */
const writeNumber = async (scope: WriteScope, node: AbstractNode, value: number): Promise<EditOutcome> => {
    const current = await currentNumber(node, scope.token);
    if (current !== null && current === value) return [];
    return writeScalar(scope, node, formatNumber(value));
};

/**
 * Writes a numeric tuple component by component, so only the numbers the gesture changed are
 * touched and each one lands wherever it is declared. A tuple that is itself a reference is
 * followed first, and the components are then written inside the file that declares it.
 *
 * @param scope the file the tuple is written in.
 * @param node the tuple's value node.
 * @param members the group-form member names, in positional order.
 * @param values the new numbers, in the same order.
 * @returns the edits, or a refusal when the target is not the shape the handle edits.
 */
const writeTuple = async (
    scope: WriteScope,
    node: AbstractNode,
    members: readonly string[],
    values: readonly number[]
): Promise<EditOutcome> => {
    if (isReferenceValue(node)) {
        const site = await followToDeclaration(node, scope.uri, scope.text, scope.options, scope.token);
        if (isRefusal(site)) return { error: site.error };
        const inner = { ...scope, uri: site.uri, text: site.text };
        const written = await writeTuple(inner, site.node, members, values);
        if (isError(written)) return written;
        if (!written.length) return [];
        const tagged = inFile(site.uri, written);
        return [{ ...tagged[0], note: tagged[0].note ?? (await noteFor(scope, site)) }, ...tagged.slice(1)];
    }

    const components: AbstractNode[] = [];
    if (isListNode(node) && node.elements.length === members.length) {
        components.push(...node.elements);
    } else if (isGroupNode(node)) {
        for (const name of members) {
            const child = childNamed(node, name);
            if (!child) return { error: l10n.t('The value is not written as a full {0} tuple.', String(members.length)) };
            components.push(child);
        }
    } else {
        return { error: l10n.t('The value is not written as a full {0} tuple.', String(members.length)) };
    }

    const edits: TargetedEdit[] = [];
    for (let index = 0; index < components.length; index++) {
        const written = await writeNumber(scope, components[index], values[index]);
        if (isError(written)) return written;
        edits.push(...written);
    }
    const collapsed = collapseSameSpan(edits, scope);
    if (!collapsed) return { error: SAME_DECLARATION() };
    return collapsed;
};

/**
 * Rewrites a vector: in one span when it is written out here, component by component through the
 * declarations when any part of it is a reference.
 */
const writeVector = async (scope: WriteScope, node: AbstractNode, x: number, y: number): Promise<EditOutcome> => {
    if (!holdsReference(node)) return replaceVectorEdit(scope.text, node, x, y);
    return writeTuple(scope, node, VECTOR_MEMBERS, [x, y]);
};

/** Rewrites a rect, following references the same way {@link writeVector} does. */
const writeRect = async (
    scope: WriteScope,
    node: AbstractNode,
    rect: { x: number; y: number; width: number; height: number }
): Promise<EditOutcome> => {
    if (!holdsReference(node)) {
        if (isGroupNode(node) && readRect(node)) {
            const groupText = `{X = ${formatNumber(rect.x)}; Y = ${formatNumber(rect.y)}; Width = ${formatNumber(rect.width)}; Height = ${formatNumber(rect.height)}}`;
            return [replaceSpan(scope.text, node.position.start, node.position.end, groupText)];
        }
        return [replaceSpan(scope.text, node.position.start, node.position.end, rectText(rect))];
    }
    return writeTuple(scope, node, RECT_MEMBERS, [rect.x, rect.y, rect.width, rect.height]);
};

/** Formats a rect in the positional form new fields are written with. */
const rectText = (rect: { x: number; y: number; width: number; height: number }): string =>
    `[${formatNumber(rect.x)}, ${formatNumber(rect.y)}, ${formatNumber(rect.width)}, ${formatNumber(rect.height)}]`;

/** Inserts a new `Name = value` member on its own line just before a container's closing brace. */
const insertMemberEdit = (text: string, container: GroupNode, memberText: string): EditOutcome => {
    const brace = closerOffset(text, container);
    if (brace < 0) return { error: l10n.t('The part group could not be edited safely.') };
    const indent = tabs(childIndentOf(container));
    return [insertAt(text, brace, `${indent}${memberText}\n`)];
};

/** Renders a full block-form list field (`Name\n[\n\telement\n...]`) at a container's child indent. */
const blockFieldText = (name: string, elements: readonly string[], indent: number): string => {
    const inner = elements.map((element) => `${tabs(indent + 1)}${element}`).join('\n');
    return `${name}\n${tabs(indent)}[\n${inner}\n${tabs(indent)}]`;
};

/**
 * Materializes a local override of a list/map field that currently only exists on a base part:
 * the inherited elements are written out locally with the mutation already applied.
 */
const materializeFieldEdit = (
    text: string,
    container: GroupNode,
    fieldName: string,
    elements: readonly string[]
): EditOutcome => {
    const brace = closerOffset(text, container);
    if (brace < 0) return { error: l10n.t('The part group could not be edited safely.') };
    const indent = childIndentOf(container);
    return [insertAt(text, brace, `${tabs(indent)}${blockFieldText(fieldName, elements, indent)}\n`)];
};

/** The nth readable vector element of a list-like member, with its element node. */
const vectorElementAt = (
    member: AbstractNode,
    index: number
): { node: AbstractNode; x: number; y: number } | null => {
    if (!isListNode(member) && !isGroupNode(member)) return null;
    let seen = 0;
    for (const element of member.elements) {
        const vector = readVector(element);
        if (!vector) continue;
        if (seen === index) return { node: element, x: vector.x, y: vector.y };
        seen++;
    }
    return null;
};

/** The nth readable pair element of a `VirtualInternalCells` member. */
const pairElementAt = (member: AbstractNode, index: number): AbstractNode | null => {
    if (!isListNode(member) && !isGroupNode(member)) return null;
    let seen = 0;
    for (const element of member.elements) {
        if (!isGroupNode(element)) continue;
        if (!readVector(childNamed(element, 'ExternalCell')) || !readVector(childNamed(element, 'InternalCell')))
            continue;
        if (seen === index) return element;
        seen++;
    }
    return null;
};

const cellEquals = (a: GridCell, b: GridCell): boolean => a.x === b.x && a.y === b.y;

/** Resolves a layer id (`fieldPath/fieldName`) back to its owning local container group. */
const containerForPath = (part: GroupNode, fieldPath: readonly string[]): GroupNode | null => {
    let current: GroupNode = part;
    for (const segment of fieldPath) {
        const next = childNamed(current, segment);
        if (!next || !isGroupNode(next)) return null;
        current = next;
    }
    return current;
};

/**
 * Splits a mutation's layer id into the container path, field name, and the optional entry member
 * (`Components/x/ResourceLevels:Offset` edits the `Offset` member of each list entry).
 */
const splitLayerId = (layerId: string): { fieldPath: string[]; fieldName: string; entryMember: string | null } => {
    const segments = layerId.split('/');
    const last = segments[segments.length - 1];
    const colon = last.indexOf(':');
    return {
        fieldPath: segments.slice(0, -1),
        fieldName: colon >= 0 ? last.slice(0, colon) : last,
        entryMember: colon >= 0 ? last.slice(colon + 1) : null,
    };
};

/**
 * Builds the edit for one mutation against the current document state.
 * @param document the parsed part document.
 * @param text the document's full source text.
 * @param uri the document uri the edits apply to.
 * @param anchorOffset the byte offset of the part group anchor the payload reported.
 * @param mutation the webview mutation.
 * @param token cancels inheritance resolution when materializing an override.
 * @param options the hooks a write that follows a reference into another file needs.
 * @returns the edit result (`ok` with a WorkspaceEdit, or a refusal status).
 */
export const buildPartGridEdit = async (
    document: AbstractNodeDocument,
    text: string,
    uri: string,
    anchorOffset: number,
    mutation: GridMutation,
    token: CancellationToken,
    options: GridEditOptions = {}
): Promise<PartGridEditResult> => {
    const part = locatePartGroup(document, anchorOffset);
    if (!part) return { status: 'notFound', message: l10n.t('No part was found in this document.') };

    const outcome = await mutationEdits({ part, text, uri, options, token }, mutation);
    if (isError(outcome)) return { status: 'error', message: outcome.error };
    return { status: 'ok', ...groupByFile(outcome, uri) };
};

/**
 * Groups the built edits by the file each one lands in, and collects the notes a write that
 * followed a reference left behind.
 *
 * @param edits the built edits, each naming its file when it is not the edited document.
 * @param uri the document being edited, which the untagged edits belong to.
 * @returns the WorkspaceEdit and the status note, if any.
 */
const groupByFile = (edits: readonly TargetedEdit[], uri: string): { edit: WorkspaceEdit; note?: string } => {
    const changes: Record<string, TextEdit[]> = {};
    const spellings = new Map<string, string>([[normalizeUri(uri), uri]]);
    const notes: string[] = [];
    for (const edit of edits) {
        // A reference resolving inside this same file answers with the uri its parse carries, which
        // need not be spelled the way the request spelled it. Two spellings of one file would be two
        // change lists, and a client applying the second against the text the first already moved
        // writes over the wrong span, so one spelling wins here.
        const written = edit.uri ?? uri;
        const folded = normalizeUri(written);
        const target = spellings.get(folded) ?? (spellings.set(folded, written), written);
        (changes[target] ??= []).push({ range: edit.range, newText: edit.newText });
        if (edit.note && !notes.includes(edit.note)) notes.push(edit.note);
    }
    // A gesture that changed nothing still answers `ok`, so the webview clears its queued click
    // rather than treating an empty edit as a failure.
    if (!Object.keys(changes).length) changes[uri] = [];
    return { edit: { changes }, note: notes.length ? notes.join(' ') : undefined };
};

/** Dispatches a mutation to its edit builder. */
const mutationEdits = async (ctx: EditContext, mutation: GridMutation): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    switch (mutation.op) {
        case 'addCell':
        case 'removeCell':
            return cellSetEdit(ctx, mutation.layerId, mutation.cell, mutation.op === 'addCell');
        case 'setEntryValues':
            return mapEntryEdit(ctx, mutation.layerId, mutation.cell, mutation.values);
        case 'addPoint':
            return pointAddEdit(ctx, mutation.layerId, mutation.point);
        case 'movePoint':
            return pointMoveEdit(ctx, mutation.layerId, mutation.index, mutation.point);
        case 'removePoint':
            return pointRemoveEdit(ctx, mutation.layerId, mutation.index);
        case 'setPair':
            return pairSetEdit(ctx, mutation.layerId, mutation.index, mutation.external, mutation.internal);
        case 'removePair':
            return pairRemoveEdit(ctx, mutation.layerId, mutation.index);
        case 'setRect':
            return rectEdit(ctx, mutation.layerId, mutation.rect);
        case 'setSize':
            return sizeEdit(ctx, mutation.size);
        case 'setBool': {
            if (mutation.value === null) {
                const member = localMember(part, mutation.field);
                return member ? removeMemberEdit(text, member) : [];
            }
            // Writing the inherited value back removes the local override instead.
            if ((await inheritedBoolean(part, mutation.field, token)) === mutation.value) {
                const member = localMember(part, mutation.field);
                return member ? removeMemberEdit(text, member) : [];
            }
            return scalarEdit(ctx, mutation.field, mutation.value ? 'true' : 'false');
        }
        case 'setIntList': {
            if (mutation.values) {
                const inherited = await inheritedIntList(part, mutation.field, token);
                if (
                    inherited &&
                    inherited.length === mutation.values.length &&
                    inherited.every((value, index) => value === mutation.values![index])
                ) {
                    const member = localMember(part, mutation.field);
                    return member ? removeMemberEdit(text, member) : [];
                }
            }
            return intListEdit(ctx, mutation.field, mutation.values);
        }
        case 'setPoint':
            return pointFieldEdit(ctx, mutation.layerId, mutation.point);
        case 'setCell':
            return cellFieldEdit(ctx, mutation.layerId, mutation.cell);
        case 'setDirection':
            return directionEdit(ctx, mutation.layerId, mutation.direction);
        case 'setNumber':
            return numberFieldEdit(ctx, mutation.layerId, mutation.field, mutation.value);
        case 'moveVertex':
            return vertexMoveEdit(ctx, mutation.layerId, mutation.index, mutation.point);
        case 'insertVertex':
            return vertexInsertEdit(ctx, mutation.layerId, mutation.index, mutation.point);
        case 'removeVertex':
            return vertexRemoveEdit(ctx, mutation.layerId, mutation.index);
        case 'setRectEntry':
            return rectEntryEdit(ctx, mutation.layerId, mutation.index, mutation.tag, mutation.rect);
        case 'removeRectEntry':
            return rectEntryRemoveEdit(ctx, mutation.layerId, mutation.index);
        case 'moveComponentLocation':
            return componentLocationEdit(ctx, mutation.component, mutation.point);
        case 'setComponentRotation':
            return componentRotationEdit(ctx, mutation.component, mutation.degrees);
        case 'setFlags':
            return flagsEdit(ctx, mutation.field, mutation.values);
        default:
            return { error: l10n.t('Unknown grid mutation.') };
    }
};

/**
 * Resolves a layer's local field member, or reports why it cannot be edited. A missing component
 * container means the whole component is inherited, which stays read-only in this version.
 */
const resolveLayerMember = (
    part: GroupNode,
    layerId: string
): { container: GroupNode; fieldName: string; member: LocalMember | null } | { error: string } => {
    const { fieldPath, fieldName } = splitLayerId(layerId);
    const container = containerForPath(part, fieldPath);
    if (!container) {
        return {
            error: l10n.t('The owning component is inherited from a base part. Declare it locally first.'),
        };
    }
    return { container, fieldName, member: localMember(container, fieldName) };
};

/** Toggle edits for the cell-set layers (door locations, blocked travel cells). */
const cellSetEdit = async (
    ctx: EditContext,
    layerId: string,
    cell: GridCell,
    add: boolean
): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    if (member) {
        if (add) return appendElementEdit(text, member.value as ListNode, vectorText(cell.x, cell.y));
        const existing = (isListNode(member.value) || isGroupNode(member.value) ? member.value.elements : [])
            .map((element) => ({ element, vector: readVector(element) }))
            .find(({ vector }) => vector && cellEquals(vector, cell));
        if (!existing) return { error: l10n.t('The cell is not present in the local field.') };
        return removeElementOrMemberEdit(text, container, fieldName, member, existing.element, token);
    }
    // Absent locally: materialize the inherited cells (when any) with the toggle applied.
    const inherited = await buildEffectiveFieldState(container, fieldName, token);
    const cells = inherited.cells.filter((candidate) => !cellEquals(candidate, cell));
    if (add) cells.push(cell);
    else if (cells.length === inherited.cells.length) {
        return { error: l10n.t('The cell is not present in the local field.') };
    }
    return materializeFieldEdit(
        text,
        container,
        fieldName,
        cells.map((candidate) => vectorText(candidate.x, candidate.y))
    );
};

/** Set/replace/remove edits for a map layer entry (walls by cell, travel directions). */
const mapEntryEdit = async (
    ctx: EditContext,
    layerId: string,
    cell: GridCell,
    values: readonly string[]
): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    if (member) {
        const entry = readMapEntries(member.value).find(({ key }) => cellEquals(key, cell));
        if (entry) {
            if (!values.length) return removeElementOrMemberEdit(text, container, fieldName, member, entry.entry, token);
            return writeValue(ctx, entry.value, enumListText(values));
        }
        if (!values.length) return { error: l10n.t('The cell has no entry to remove.') };
        return appendElementEdit(text, member.value as ListNode, mapEntryText(cell, values));
    }
    const inherited = await buildEffectiveFieldState(container, fieldName, token);
    const entries = inherited.entries.filter(({ key }) => !cellEquals(key, cell));
    if (values.length) entries.push({ key: cell, values: [...values] });
    else if (entries.length === inherited.entries.length) {
        return { error: l10n.t('The cell has no entry to remove.') };
    }
    return materializeFieldEdit(
        text,
        container,
        fieldName,
        entries.map(({ key, values: entryValues }) => mapEntryText(key, entryValues))
    );
};

/** Append edit for a fractional point layer. */
const pointAddEdit = async (ctx: EditContext, layerId: string, point: GridPoint): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    if (splitLayerId(layerId).entryMember) {
        return { error: l10n.t('This list has a fixed length, points can only be moved.') };
    }
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    if (member) return appendElementEdit(text, member.value as ListNode, vectorText(point.x, point.y));
    const inherited = await buildEffectiveFieldState(container, fieldName, token);
    const points = inherited.cells.concat([point]);
    return materializeFieldEdit(
        text,
        container,
        fieldName,
        points.map((candidate) => vectorText(candidate.x, candidate.y))
    );
};

/** The nth entry-member vector of a list of groups (`ResourceLevels [ { Offset = [x, y] } ]`). */
const entryMemberVectorAt = (member: AbstractNode, entryMember: string, index: number): AbstractNode | null => {
    if (!isListNode(member) && !isGroupNode(member)) return null;
    let seen = 0;
    for (const element of member.elements) {
        if (!isGroupNode(element)) continue;
        const vector = readVector(childNamed(element, entryMember));
        if (!vector) continue;
        if (seen === index) return vector.node;
        seen++;
    }
    return null;
};

/** In-place move edit for a fractional point (form-preserving, entry-member lists supported). */
const pointMoveEdit = async (
    ctx: EditContext,
    layerId: string,
    index: number,
    point: GridPoint
): Promise<EditOutcome> => {
    const resolved = resolveLayerMember(ctx.part, layerId);
    if ('error' in resolved) return resolved;
    const { member } = resolved;
    const { entryMember } = splitLayerId(layerId);
    if (entryMember) {
        const node = member && entryMemberVectorAt(member.value, entryMember, index);
        if (!node) return { error: l10n.t('The point is not present in the local field.') };
        return writeVector(ctx, node, point.x, point.y);
    }
    const target = member && vectorElementAt(member.value, index);
    if (!target) return { error: l10n.t('The point is not present in the local field.') };
    return writeVector(ctx, target.node, point.x, point.y);
};

/** Removal edit for a fractional point. */
const pointRemoveEdit = async (ctx: EditContext, layerId: string, index: number): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    if (splitLayerId(layerId).entryMember) {
        return { error: l10n.t('This list has a fixed length, points can only be moved.') };
    }
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    const target = member && vectorElementAt(member.value, index);
    if (!target) return { error: l10n.t('The point is not present in the local field.') };
    return removeElementOrMemberEdit(text, container, fieldName, member!, target.node, token);
};

/** Set (append or replace) edit for a virtual-cell pair. */
const pairSetEdit = async (
    ctx: EditContext,
    layerId: string,
    index: number | null,
    external: GridCell,
    internal: GridCell
): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    if (member) {
        if (index === null) return appendElementEdit(text, member.value as ListNode, pairEntryText(external, internal));
        const entry = pairElementAt(member.value, index);
        if (!entry) return { error: l10n.t('The pair is not present in the local field.') };
        // A pair whose cells are written as references keeps them: each cell goes through its own
        // declaration instead of the whole entry being replaced with two literals.
        const externalNode = childNamed(entry as GroupNode, 'ExternalCell');
        const internalNode = childNamed(entry as GroupNode, 'InternalCell');
        if (externalNode && internalNode && (holdsReference(externalNode) || holdsReference(internalNode))) {
            const first = await writeVector(ctx, externalNode, external.x, external.y);
            if (isError(first)) return first;
            const second = await writeVector(ctx, internalNode, internal.x, internal.y);
            if (isError(second)) return second;
            // Both cells can name one declaration, and a pair whose two ends are the same number is
            // a pair the file cannot hold once they have to differ.
            const collapsed = collapseSameSpan([...first, ...second], ctx);
            if (!collapsed) return { error: SAME_DECLARATION() };
            return collapsed;
        }
        return [replaceSpan(text, entry.position.start, entry.position.end, pairEntryText(external, internal))];
    }
    const inherited = await buildEffectiveFieldState(container, fieldName, token);
    const pairs = inherited.pairs.concat([{ external, internal }]);
    return materializeFieldEdit(
        text,
        container,
        fieldName,
        pairs.map((pair) => pairEntryText(pair.external, pair.internal))
    );
};

/** Removal edit for a virtual-cell pair. */
const pairRemoveEdit = async (ctx: EditContext, layerId: string, index: number): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    const entry = member && pairElementAt(member.value, index);
    if (!entry) return { error: l10n.t('The pair is not present in the local field.') };
    return removeElementOrMemberEdit(text, container, fieldName, member!, entry, token);
};

/** Set/remove edit for a rect layer (`PhysicalRect`, `SaveRect`). */
const rectEdit = async (
    ctx: EditContext,
    layerId: string,
    rect: { x: number; y: number; width: number; height: number } | null
): Promise<EditOutcome> => {
    const { part, text } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    if (!rect) {
        if (!member) return { error: l10n.t('There is no local rect field to remove.') };
        return removeMemberEdit(text, member);
    }
    if (member) return writeRect(ctx, member.value, rect);
    return insertMemberEdit(text, container, `${fieldName} = ${rectText(rect)}`);
};

/** Replace-or-insert edit for the part's `Size`. */
const sizeEdit = async (ctx: EditContext, size: { width: number; height: number }): Promise<EditOutcome> => {
    const { part, text } = ctx;
    const member = localMember(part, 'Size');
    if (member) return writeVector(ctx, member.value, size.width, size.height);
    return insertMemberEdit(text, part, `Size = ${vectorText(size.width, size.height)}`);
};

/** Replace-or-insert edit for a scalar part-root field (the rotation booleans). */
const scalarEdit = async (ctx: EditContext, fieldName: string, valueText: string): Promise<EditOutcome> => {
    const { part, text } = ctx;
    const member = localMember(part, fieldName);
    if (member) return writeValue(ctx, member.value, valueText);
    return insertMemberEdit(text, part, `${fieldName} = ${valueText}`);
};

/** Replace, insert, or remove edit for an int-list rotation field. */
const intListEdit = async (
    ctx: EditContext,
    fieldName: string,
    values: readonly number[] | null
): Promise<EditOutcome> => {
    const { part, text } = ctx;
    const member = localMember(part, fieldName);
    if (!values) {
        if (!member) return [];
        return removeMemberEdit(text, member);
    }
    const listText = `[${values.map(formatNumber).join(', ')}]`;
    if (member) return writeValue(ctx, member.value, listText);
    return insertMemberEdit(text, part, `${fieldName} = ${listText}`);
};

/** The synthetic point layers backed by two scalar fields instead of a vector. */
const SCALAR_PAIR_FIELDS: Readonly<Record<string, { x: string; y: string }>> = {
    RailgunStart: { x: 'XStartOffset', y: 'YStartOffset' },
    RailgunEnd: { x: 'XEndOffset', y: 'YEndOffset' },
};

/** Replace-or-insert edit for a single scalar member of a container. */
const scalarMemberEdit = async (
    scope: WriteScope,
    container: GroupNode,
    field: string,
    valueText: string
): Promise<EditOutcome> => {
    const member = localMember(container, field);
    if (member) return writeValue(scope, member.value, valueText);
    return insertMemberEdit(scope.text, container, `${field} = ${valueText}`);
};

/** Replace-or-insert edit for a numeric member, written through a reference and skipped when equal. */
const numberMemberEdit = async (
    scope: WriteScope,
    container: GroupNode,
    field: string,
    value: number
): Promise<EditOutcome> => {
    const member = localMember(container, field);
    if (member) return writeNumber(scope, member.value, value);
    return insertMemberEdit(scope.text, container, `${field} = ${formatNumber(value)}`);
};

/** Replace-or-insert edit for a vector member, written through any reference it is spelled with. */
const vectorMemberEdit = async (
    scope: WriteScope,
    container: GroupNode,
    field: string,
    x: number,
    y: number
): Promise<EditOutcome> => {
    const member = localMember(container, field);
    if (member) return writeVector(scope, member.value, x, y);
    return insertMemberEdit(scope.text, container, `${field} = ${vectorText(x, y)}`);
};

/** Set/remove edit for a single-point layer (also the railgun scalar-pair synthetics). */
const pointFieldEdit = async (
    ctx: EditContext,
    layerId: string,
    point: GridPoint | null
): Promise<EditOutcome> => {
    const { part, text } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    const pair = SCALAR_PAIR_FIELDS[fieldName];
    if (pair) {
        if (!point) return { error: l10n.t('The segment endpoints cannot be removed here.') };
        const x = await numberMemberEdit(ctx, container, pair.x, point.x);
        const y = await numberMemberEdit(ctx, container, pair.y, point.y);
        if (isError(x)) return x;
        if (isError(y)) return y;
        const collapsed = collapseSameSpan([...x, ...y], ctx);
        if (!collapsed) return { error: SAME_DECLARATION() };
        return collapsed;
    }
    if (!point) {
        if (!member) return [];
        return removeMemberEdit(text, member);
    }
    if (member) return writeVector(ctx, member.value, point.x, point.y);
    return insertMemberEdit(text, container, `${fieldName} = ${vectorText(point.x, point.y)}`);
};

/** Set/remove edit for a single-cell layer. */
const cellFieldEdit = async (ctx: EditContext, layerId: string, cell: GridCell | null): Promise<EditOutcome> => {
    const { part, text } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    if (!cell) {
        if (!member) return [];
        return removeMemberEdit(text, member);
    }
    if (member) {
        // A `Line { Location Direction MaxTiles }` group: the cell lands on its inner Location.
        if (isGroupNode(member.value) && !readVector(member.value)) {
            return vectorMemberEdit(ctx, member.value, 'Location', cell.x, cell.y);
        }
        return writeVector(ctx, member.value, cell.x, cell.y);
    }
    return insertMemberEdit(text, container, `${fieldName} = ${vectorText(cell.x, cell.y)}`);
};

/**
 * Sets a layer's facing. When the layer's own member is a sub-group (`Line`), the direction is
 * written inside it, otherwise the `Direction` sibling of the layer's field on the container (the
 * network port form).
 */
const directionEdit = async (ctx: EditContext, layerId: string, direction: string): Promise<EditOutcome> => {
    const resolved = resolveLayerMember(ctx.part, layerId);
    if ('error' in resolved) return resolved;
    const { container, member } = resolved;
    if (member && isGroupNode(member.value) && !readVector(member.value)) {
        return scalarMemberEdit(ctx, member.value, 'Direction', direction);
    }
    return scalarMemberEdit(ctx, container, 'Direction', direction);
};

/** Sets a numeric sibling of a layer (`MaxTiles` inside `Line`, `BuffRadius` on the container). */
const numberFieldEdit = async (
    ctx: EditContext,
    layerId: string,
    field: string,
    value: number | null
): Promise<EditOutcome> => {
    const { part, text } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, member } = resolved;
    const target = member && isGroupNode(member.value) && !readVector(member.value) ? member.value : container;
    if (value === null) {
        const existing = localMember(target, field);
        if (!existing) return [];
        return removeMemberEdit(text, existing);
    }
    return numberMemberEdit(ctx, target, field, value);
};

/**
 * The nth polygon vertex element, counting the same elements the payload builder shows: plain
 * vectors and reference or math vectors that evaluate. A vertex written as a reference is moved
 * through its declaration rather than being rewritten to literals here.
 */
const polygonVertexAt = async (
    member: AbstractNode,
    index: number,
    token: CancellationToken
): Promise<AbstractNode | null> => {
    if (!isListNode(member) && !isGroupNode(member)) return null;
    let seen = 0;
    for (const element of member.elements) {
        const readable = readVector(element) ?? (await readVectorEvaluated(element, token).catch(() => null));
        if (!readable) continue;
        if (seen === index) return element;
        seen++;
    }
    return null;
};

/** In-place move edit for a polygon vertex. */
const vertexMoveEdit = async (
    ctx: EditContext,
    layerId: string,
    index: number,
    point: GridPoint
): Promise<EditOutcome> => {
    const resolved = resolveLayerMember(ctx.part, layerId);
    if ('error' in resolved) return resolved;
    const target = resolved.member && (await polygonVertexAt(resolved.member.value, index, ctx.token));
    if (!target) return { error: l10n.t('The vertex is not present in the local field.') };
    return writeVector(ctx, target, point.x, point.y);
};

/** Insert edit for a polygon vertex before `index` (appends when index equals the vertex count). */
const vertexInsertEdit = async (
    ctx: EditContext,
    layerId: string,
    index: number,
    point: GridPoint
): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    if (!member || (!isListNode(member.value) && !isGroupNode(member.value))) {
        // No local list (removed, or never written): start it fresh with this vertex.
        return materializeFieldEdit(text, container, fieldName, [vectorText(point.x, point.y)]);
    }
    const target = await polygonVertexAt(member.value, index, token);
    if (!target) return appendElementEdit(text, member.value as ListNode, vectorText(point.x, point.y));
    // Insert just before the target vertex, replicating the separator style around it.
    const open = openerOffset(text, member.value as ListNode);
    const close = closerOffset(text, member.value as ListNode);
    if (open < 0 || close < 0) return { error: l10n.t('The list could not be edited safely.') };
    const singleLine = !text.slice(open, close).includes('\n');
    if (singleLine) return [insertAt(text, target.position.start, `${vectorText(point.x, point.y)}, `)];
    const lineStart = text.lastIndexOf('\n', target.position.start) + 1;
    const prefix = text.slice(lineStart, target.position.start);
    const indent = /^\s*$/.test(prefix) ? prefix : tabs(childIndentOf(member.value));
    return [insertAt(text, target.position.start, `${vectorText(point.x, point.y)}\n${indent}`)];
};

/** Removal edit for a polygon vertex. */
const vertexRemoveEdit = async (ctx: EditContext, layerId: string, index: number): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    const target = member && (await polygonVertexAt(member.value, index, token));
    if (!target) return { error: l10n.t('The vertex is not present in the local field.') };
    return removeElementOrMemberEdit(text, container, fieldName, member!, target, token);
};

/** The nth tagged rect row (`[category, [x, y, w, h]]`) of a prohibit list. */
const rectEntryAt = (member: AbstractNode, index: number): ListNode | null => {
    if (!isListNode(member) && !isGroupNode(member)) return null;
    let seen = 0;
    for (const element of member.elements) {
        if (!isListNode(element) || element.elements.length !== 2 || !readRect(element.elements[1])) continue;
        if (seen === index) return element;
        seen++;
    }
    return null;
};

/** Formats a tagged rect row. */
const rectEntryText = (tag: string, rect: { x: number; y: number; width: number; height: number }): string =>
    `[${tag}, [${formatNumber(rect.x)}, ${formatNumber(rect.y)}, ${formatNumber(rect.width)}, ${formatNumber(rect.height)}]]`;

/** Set (append or replace) edit for a tagged rect entry. */
const rectEntryEdit = async (
    ctx: EditContext,
    layerId: string,
    index: number | null,
    tag: string | null,
    rect: { x: number; y: number; width: number; height: number }
): Promise<EditOutcome> => {
    const { part, text } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    const firstTag = (): string | null => {
        if (!member || (!isListNode(member.value) && !isGroupNode(member.value))) return null;
        const first = rectEntryAt(member.value, 0);
        return first ? (enumNameOf(first.elements[0]) ?? null) : null;
    };
    const effectiveTag = tag ?? firstTag();
    if (!effectiveTag) return { error: l10n.t('A prohibit category is needed for the first rect.') };
    if (member && index !== null) {
        const entry = rectEntryAt(member.value, index);
        if (!entry) return { error: l10n.t('The rect is not present in the local field.') };
        if (tag) return [replaceSpan(text, entry.position.start, entry.position.end, rectEntryText(effectiveTag, rect))];
        return writeRect(ctx, entry.elements[1], rect);
    }
    if (member) return appendElementEdit(text, member.value as ListNode, rectEntryText(effectiveTag, rect));
    const indent = childIndentOf(container);
    const brace = closerOffset(text, container);
    if (brace < 0) return { error: l10n.t('The part group could not be edited safely.') };
    return [
        insertAt(text, brace, `${tabs(indent)}${blockFieldText(fieldName, [rectEntryText(effectiveTag, rect)], indent)}\n`),
    ];
};

/** Removal edit for a tagged rect entry. */
const rectEntryRemoveEdit = async (ctx: EditContext, layerId: string, index: number): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    const resolved = resolveLayerMember(part, layerId);
    if ('error' in resolved) return resolved;
    const { container, fieldName, member } = resolved;
    const entry = member && rectEntryAt(member.value, index);
    if (!entry) return { error: l10n.t('The rect is not present in the local field.') };
    return removeElementOrMemberEdit(text, container, fieldName, member!, entry, token);
};

/** Moves a component's own `Location`, through the declaration when it is written as a reference. */
const componentLocationEdit = async (
    ctx: EditContext,
    component: string,
    point: GridPoint
): Promise<EditOutcome> => {
    const container = containerForPath(ctx.part, ['Components', component]);
    if (!container) return { error: l10n.t('The component is inherited from a base part. Declare it locally first.') };
    return vectorMemberEdit(ctx, container, 'Location', point.x, point.y);
};

/** Sets a component's `Rotation` in the degree-suffixed form, null removes the local field. */
const componentRotationEdit = async (
    ctx: EditContext,
    component: string,
    degrees: number | null
): Promise<EditOutcome> => {
    const container = containerForPath(ctx.part, ['Components', component]);
    if (!container) return { error: l10n.t('The component is inherited from a base part. Declare it locally first.') };
    if (degrees === null) {
        const member = localMember(container, 'Rotation');
        if (!member) return [];
        return removeMemberEdit(ctx.text, member);
    }
    return scalarMemberEdit(ctx, container, 'Rotation', `${formatNumber(degrees)}d`);
};

/** The AdjacencyFlags composites expanded to their edge/corner members, for set comparison. */
const expandAdjacencyFlags = (names: readonly string[]): Set<string> => {
    const EDGES = ['Top', 'Right', 'Bottom', 'Left'];
    const CORNERS = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'];
    const expanded = new Set<string>();
    for (const name of names) {
        if (name === 'All') [...EDGES, ...CORNERS].forEach((flag) => expanded.add(flag));
        else if (name === 'Sides') EDGES.forEach((flag) => expanded.add(flag));
        else if (name === 'Corners') CORNERS.forEach((flag) => expanded.add(flag));
        else if (name !== 'None') expanded.add(name);
    }
    return expanded;
};

/** The game defaults of the part-root flags fields, from their field initializers. */
const FLAG_FIELD_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
    AllowedContiguity: ['Sides'],
};

/**
 * Sets a part-root flags field (`AllowedContiguity`), written bare for one flag, as a list for
 * more. Writing the set the part would inherit anyway (from a base, or the game default) removes
 * the local field instead, so toggling away and back leaves no redundant override behind.
 */
const flagsEdit = async (
    ctx: EditContext,
    field: string,
    values: readonly string[] | null
): Promise<EditOutcome> => {
    const { part, text, token } = ctx;
    if (!values) {
        const member = localMember(part, field);
        if (!member) return [];
        return removeMemberEdit(text, member);
    }
    if (!values.length) return { error: l10n.t('At least one flag is needed, or remove the field.') };
    const inherited = await inheritedEnumNames(part, field, token);
    const baseline = expandAdjacencyFlags(inherited ?? FLAG_FIELD_DEFAULTS[field] ?? []);
    const target = expandAdjacencyFlags(values);
    if (baseline.size === target.size && [...target].every((flag) => baseline.has(flag))) {
        const member = localMember(part, field);
        return member ? removeMemberEdit(text, member) : [];
    }
    const valueText = values.length === 1 ? values[0] : enumListText(values);
    return scalarMemberEdit(ctx, part, field, valueText);
};
