import { CodeAction, CodeActionKind, Position, Range, TextEdit } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    AssignmentNode,
    AstPosition,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { findNodeAtPosition } from '../../utils/ast.utils';
import * as l10n from '@vscode/l10n';

/** The minimum number of identical values before extracting to a shared field is offered. */
const MIN_OCCURRENCES = 2;

const rangeOf = (position: AstPosition): Range =>
    Range.create(position.line, position.characterStart, position.line, position.characterEnd);

/** A bare numeric literal, including the ObjectText unit suffixes (`50%`, `45d`, `2r`),
 *  which the parser types as String because only plain numbers become Number values. */
const NUMERIC_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)(%|d|r)?$/;

/**
 * True for a plain literal an extraction can share: an unparenthesized, unquoted number (or
 * suffixed number like `50%`/`45d`) that is the whole right-hand side of a `Name = value`
 * assignment. References, text strings (quoting and localization semantics), math expressions
 * and list elements are not extracted.
 */
const isExtractableValue = (node: AbstractNode | null | undefined): node is ValueNode =>
    isValueNode(node) &&
    !node.parenthesized &&
    !node.quoted &&
    (node.valueType.type === 'Number' ||
        (node.valueType.type === 'String' && NUMERIC_LITERAL.test(String(node.valueType.value))));

/**
 * The nested `Name = value` assignments in `document` whose right-hand side equals `value` exactly.
 * Root-level assignments are skipped: a root field already is a shared, referenceable constant.
 */
const findEqualAssignments = (document: AbstractNodeDocument, value: ValueNode): AssignmentNode[] => {
    const matches: AssignmentNode[] = [];
    const walk = (node: AbstractNode, isRoot: boolean): void => {
        if (isAssignmentNode(node)) {
            if (
                !isRoot &&
                node.assignmentType === 'Equals' &&
                isExtractableValue(node.right) &&
                node.right.valueType.type === value.valueType.type &&
                node.right.valueType.value === value.valueType.value
            ) {
                matches.push(node);
            }
            if (isGroupNode(node.right) || isListNode(node.right)) walk(node.right, false);
        } else if (isGroupNode(node) || isListNode(node)) {
            node.elements.forEach((element) => walk(element, false));
        }
    };
    document.elements.forEach((element) => walk(element, true));
    return matches;
};

/** `MaxHealth` -> `MAX_HEALTH`: a root-constant name in the conventional UPPER_SNAKE style. */
const constantNameFor = (fieldName: string): string =>
    fieldName
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9_]/g, '_')
        .toUpperCase();

/** The names of all root-level members of `document`, lower-cased for collision checks. */
const rootMemberNames = (document: AbstractNodeDocument): Set<string> => {
    const names = new Set<string>();
    for (const element of document.elements) {
        if (isAssignmentNode(element)) names.add(element.left.name.toLowerCase());
        else if ((isGroupNode(element) || isListNode(element)) && element.identifier)
            names.add(element.identifier.name.toLowerCase());
    }
    return names;
};

/**
 * The "extract repeated value to a shared root field" refactoring: when the cursor is on a numeric
 * assignment value that appears verbatim in at least {@link MIN_OCCURRENCES} assignments of the file,
 * offer to hoist it to a `NAME = value` root field and replace every occurrence with `&~/NAME`, the
 * single-source-of-truth idiom the game's own data uses. Returns undefined when the cursor value is
 * not extractable or not repeated.
 * @param document the parsed document the cursor is in.
 * @param text the document's full source text, to reuse the literal's exact spelling (`50%`, `45d`).
 * @param cursor the cursor position of the code-action request.
 * @param uri the document uri the edits apply to.
 * @returns the code action, or undefined when extraction does not apply.
 */
export const extractValueCodeAction = (
    document: AbstractNodeDocument,
    text: string,
    cursor: Position,
    uri: string
): CodeAction | undefined => {
    const node = findNodeAtPosition(document, cursor);
    if (!isExtractableValue(node)) return undefined;
    const occurrences = findEqualAssignments(document, node);
    if (occurrences.length < MIN_OCCURRENCES) return undefined;
    const cursorAssignment = occurrences.find((assignment) => assignment.right === node);
    if (!cursorAssignment) return undefined;

    const taken = rootMemberNames(document);
    let name = constantNameFor(cursorAssignment.left.name);
    for (let suffix = 2; taken.has(name.toLowerCase()); suffix++)
        name = `${constantNameFor(cursorAssignment.left.name)}_${suffix}`;

    const literal = text.substring(node.position.start, node.position.end);
    const firstElement = document.elements[0];
    if (!firstElement) return undefined;
    // Assignment nodes carry no position of their own; anchor the insert on their name identifier
    // (groups/lists on their identifier, falling back to the node position).
    const insertLine = isAssignmentNode(firstElement)
        ? firstElement.left.position?.line
        : ((isGroupNode(firstElement) || isListNode(firstElement)) && firstElement.identifier
              ? firstElement.identifier.position?.line
              : firstElement.position?.line);
    if (insertLine === undefined) return undefined;
    const edits: TextEdit[] = [
        TextEdit.insert(Position.create(insertLine, 0), `${name} = ${literal}\n`),
        ...occurrences.map((assignment) => TextEdit.replace(rangeOf(assignment.right.position), `&~/${name}`)),
    ];
    return {
        title: l10n.t('Extract value {0} to shared root field ({1} occurrences)', literal, occurrences.length),
        kind: CodeActionKind.RefactorExtract,
        edit: { changes: { [uri]: edits } },
    };
};
