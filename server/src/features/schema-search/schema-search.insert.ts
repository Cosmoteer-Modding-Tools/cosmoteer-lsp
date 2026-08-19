/**
 * Scaffolding a field found through the schema search straight into the file the picker was opened
 * from. The client sends nothing but the entry id and the caret it captured, and everything that
 * decides whether the write is legal is re-resolved here: the picker can sit open while the user
 * keeps typing, so its `insertable` flag is a hint, never a permission.
 */
import { CancellationToken, Position, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode } from '../../core/ast/ast';
import { findEnclosingContainer } from '../../document/schema/schema-context';
import { classAncestry, enumDef } from '../../document/schema/schema';
import { ValueType } from '../../document/schema/schema.types';
import { fieldSnippet } from '../completion/autocompletion.schema-fields';
import { memberIndentAt } from '../diagnostics/required-field-insert';
import { memberSpanOf } from '../refactor/shared-base/member-record';
import { resolveSchemaSearchContext } from './schema-search';
import { schemaSearchEntryById } from './schema-search.index';

/** The server command both clients send to scaffold a searched field at the caret. */
export const INSERT_SCHEMA_FIELD_COMMAND = 'cosmoteer.insertSchemaField';

/** What the client sends with the command. */
export interface InsertSchemaFieldArgs {
    uri: string;
    /** The caret the picker was opened from. */
    position: Position;
    /** The search hit's entry id. */
    id: string;
    /** The document version the caret was read at, refused when the buffer has moved on. */
    documentVersion?: number;
}

/** Why an insert did nothing, in a word the client turns into a sentence. */
export type InsertSchemaFieldFailure = 'stale' | 'notAField' | 'noContext' | 'classMismatch' | 'noAnchor' | 'editRejected';

/** What the command answers with. */
export interface InsertSchemaFieldResult {
    inserted: boolean;
    /** The field that was written, for the confirmation message. */
    field?: string;
    failure?: InsertSchemaFieldFailure;
}

/**
 * The literal a scaffolded field is written with. Same rules the required-field quick fix follows: a
 * neutral value the game loads for the kinds that have one, and nothing at all for the kinds where
 * inventing a value would be a guess (a reference or an asset names something that has to exist, a
 * subtype cannot be picked for the author). The empty stop leaves the caret's own line inside the
 * scaffold for those.
 *
 * @param valueType the schema type of the field being scaffolded.
 * @returns the literal to write, empty when the kind has no value worth inventing.
 */
const placeholderValue = (valueType: ValueType): string => {
    switch (valueType.kind) {
        case 'bool':
            return 'false';
        case 'int':
        case 'float':
        case 'number':
            return '0';
        case 'string':
            return '""';
        case 'enum':
            return enumDef(valueType.ref)?.members[0] ?? '';
        default:
            return '';
    }
};

/** Where the scaffold goes and how it is indented once it gets there. */
interface Placement {
    offset: number;
    indent: string;
    /** True when the text opens with a line break (it follows an existing member on that line). */
    leadingNewline: boolean;
}

/** The indent one level is written with in this file, read from whatever the file already uses. */
const indentUnit = (text: string): string => (/^[ ]*\t/m.test(text) ? '\t' : '    ');

/**
 * The end offset of the last member of a container that closes at or before the caret. This is what
 * makes the scaffold land where the user is looking: right under the member their caret is on or
 * past, rather than at a fixed end of the group.
 *
 * @param elements the container's members.
 * @param offset the caret byte offset.
 * @returns the anchor offset, or undefined when no member closes before the caret.
 */
const lastMemberEndBefore = (elements: readonly AbstractNode[], offset: number): number | undefined => {
    let anchor: number | undefined;
    for (const element of elements) {
        const span = memberSpanOf(element);
        if (!span || span.end > offset) continue;
        if (anchor === undefined || span.end > anchor) anchor = span.end;
    }
    return anchor;
};

/**
 * Where a new member of a group goes: after the last member the caret has passed, or right after the
 * opening brace when the caret sits before every member or the group is still empty.
 *
 * @param text the file's source.
 * @param group the group the field is written into.
 * @param offset the caret byte offset.
 * @returns the placement, or undefined when the group has no brace to write inside of.
 */
const groupPlacement = (text: string, group: GroupNode, offset: number): Placement | undefined => {
    const groupStart = group.position.start;
    const groupEnd = group.position.end;
    // An unclosed group ends at zero, and there is no closing brace to keep the scaffold in front of.
    if (groupEnd <= groupStart || text[groupStart] !== '{') return undefined;
    const anchor = lastMemberEndBefore(group.elements, offset);
    if (anchor !== undefined && anchor > groupStart && anchor < groupEnd) {
        return { offset: anchor, indent: memberIndentAt(text, anchor), leadingNewline: true };
    }
    // Before the first member (or in an empty group): open a line right under the brace, indented one
    // level past whatever the line the brace sits on is indented with.
    const firstMember = group.elements.map(memberSpanOf).find((span) => !!span);
    const indent = firstMember
        ? memberIndentAt(text, firstMember.start)
        : memberIndentAt(text, groupStart) + indentUnit(text);
    return { offset: groupStart + 1, indent, leadingNewline: true };
};

/**
 * Where a new member of a whole-file-root document goes: after the last top-level member the caret
 * has passed, or at the very top of the file when there is none.
 *
 * @param text the file's source.
 * @param document the parsed document.
 * @param offset the caret byte offset.
 * @returns the placement.
 */
const documentPlacement = (text: string, document: AbstractNodeDocument, offset: number): Placement => {
    const anchor = lastMemberEndBefore(document.elements, offset);
    return anchor !== undefined
        ? { offset: anchor, indent: memberIndentAt(text, anchor), leadingNewline: true }
        : { offset: 0, indent: '', leadingNewline: false };
};

/**
 * Builds the single edit that scaffolds a searched field at a caret, refusing every case where the
 * write would land somewhere the game does not read the field.
 *
 * @param args the entry id, the caret, and the version it was captured at.
 * @param document the open document the edit applies to.
 * @param parserResult the document's parsed AST.
 * @param cancellationToken cancellation for the caret's inheritance resolution.
 * @returns the edit with the field's name, or the reason nothing was written.
 */
export const buildInsertSchemaFieldEdit = async (
    args: InsertSchemaFieldArgs,
    document: TextDocument,
    parserResult: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<{ edit: TextEdit; field: string } | { failure: InsertSchemaFieldFailure }> => {
    if (args.documentVersion !== undefined && args.documentVersion !== document.version) return { failure: 'stale' };
    const entry = schemaSearchEntryById(args.id);
    if (!entry || entry.kind !== 'field' || !entry.field) return { failure: 'notAField' };

    const text = document.getText();
    const offset = document.offsetAt(args.position);
    // The picker's `insertable` flag was computed when it opened, so the class is resolved again
    // here: the user can have moved the caret, or edited the group, in the meantime.
    const contextClass = await resolveSchemaSearchContext(parserResult, offset, cancellationToken);
    if (!contextClass) return { failure: 'noContext' };
    // Ancestry, not equality: a field declared on a base class is legally written in every deriving
    // group, which is exactly the field set completion offers there.
    if (!classAncestry(contextClass).includes(entry.ownerFullName)) return { failure: 'classMismatch' };

    const container = findEnclosingContainer(parserResult, offset);
    // A list element is a value, not a named member, so a field name written there is not a field.
    if (container && isListNode(container)) return { failure: 'noContext' };
    const placement =
        container && isGroupNode(container)
            ? groupPlacement(text, container, offset)
            : documentPlacement(text, parserResult, offset);
    if (!placement) return { failure: 'noAnchor' };

    const snippet = fieldSnippet(entry.field.name, entry.field.valueType, placeholderValue(entry.field.valueType));
    const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
    const body = snippet
        .split('\n')
        .map((line) => `${placement.indent}${line}`)
        .join(lineEnding);
    const newText = placement.leadingNewline ? `${lineEnding}${body}` : `${body}${lineEnding}`;
    return { edit: TextEdit.insert(document.positionAt(placement.offset), newText), field: entry.field.name };
};
