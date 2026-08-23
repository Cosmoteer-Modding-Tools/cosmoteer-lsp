import { GroupNode } from '../../core/ast/ast';
import { enumDef } from '../../document/schema/schema';
import { SchemaField, ValueType } from '../../document/schema/schema.types';
import { fieldSnippet } from '../completion/autocompletion.schema-fields';
import { memberSpanOf } from '../refactor/shared-base/member-record';
import type { ValidationErrorData } from './validator';

/** The payload a required-field diagnostic carries for its quick fix, see {@link ValidationErrorData}. */
type RequiredFieldInsert = NonNullable<ValidationErrorData['insertRequiredFields']>;

/**
 * The literal a scaffolded field is written with, neutral enough to read as a placeholder and still a
 * value the game loads. Only the kinds that have such a value are covered, and every other kind is
 * refused rather than guessed at: a group needs members the schema cannot promise, a reference or an
 * asset names something that has to exist, and a subtype cannot be picked for the author. Writing no
 * value at all is not an option either, since the game throws on a `Field =` standing in front of a
 * closing brace and drops the whole file with it.
 *
 * @param valueType the schema type of the field being scaffolded.
 * @returns the literal to write, or null when the kind has no value the fix may invent.
 */
const placeholderValue = (valueType: ValueType): string | null => {
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
            return enumDef(valueType.ref)?.members[0] ?? null;
        default:
            return null;
    }
};

/**
 * The indentation the group's members are written with, read from the line the insertion point sits
 * on. This is the same run of spaces and tabs a member record keeps as its own indent, taken from the
 * text rather than from a node, so a file written with spaces keeps them.
 *
 * @param text the file's source.
 * @param offset the insertion point.
 * @returns the leading whitespace of that line, empty when the line opens with something else.
 */
export const memberIndentAt = (text: string, offset: number): string => {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    let end = lineStart;
    while (end < offset && (text[end] === ' ' || text[end] === '\t')) end++;
    return text.slice(lineStart, end);
};

/**
 * The insert payload for a group the required-field check found members missing on. The offset is the
 * end of the group's last member, so the scaffolded lines open their own line and the closing brace
 * stays where the author put it.
 *
 * @param group the group the findings were raised on.
 * @param missing the required fields the check found absent, in schema order.
 * @returns the payload without the per-diagnostic field index, or undefined when the group has no
 * safe insertion point or no missing field a value can be written for.
 */
export const requiredFieldInsert = (
    group: GroupNode,
    missing: readonly SchemaField[]
): Omit<RequiredFieldInsert, 'fieldIndex'> | undefined => {
    // An unclosed group ends at zero, and there is no brace to write in front of.
    const groupEnd = group.position.end;
    if (groupEnd <= group.position.start) return undefined;

    let offset = 0;
    for (const element of group.elements) {
        const span = memberSpanOf(element);
        if (span) offset = Math.max(offset, span.end);
    }
    // A group whose members the parser left without a span is left alone rather than written into at
    // a guessed offset. Every group the check reaches carries at least the member its `Type` sits in.
    if (offset <= group.position.start || offset >= groupEnd) return undefined;

    const fields: Array<{ name: string; text: string }> = [];
    for (const field of missing) {
        const value = placeholderValue(field.valueType);
        if (value !== null) fields.push({ name: field.name, text: fieldSnippet(field.name, field.valueType, value) });
    }
    return fields.length > 0 ? { offset, groupEnd, fields } : undefined;
};

/**
 * The text the quick fix inserts at the payload's offset, indented to sit with the group's other
 * members and written with the line ending the file already uses.
 *
 * @param text the current source of the file the fix runs in.
 * @param insert the payload the diagnostic carried.
 * @param fields the members to write, in the order they are written.
 * @returns the text to insert, or null when the payload no longer fits the file.
 */
export const requiredFieldInsertText = (
    text: string,
    insert: RequiredFieldInsert,
    fields: ReadonlyArray<{ name: string; text: string }>
): string | null => {
    if (fields.length === 0) return null;
    // The offset comes from the validation pass, which can be a version behind the buffer the fix runs
    // on, so the group's closing brace is checked before anything is written.
    if (insert.offset <= 0 || insert.offset >= insert.groupEnd || insert.groupEnd > text.length) return null;
    if (text[insert.groupEnd - 1] !== '}') return null;

    const indent = memberIndentAt(text, insert.offset);
    const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
    // A scaffold is one line today, and the split keeps the indent right for a multi-line one.
    const lines = fields.flatMap((field) => field.text.split('\n')).map((line) => `${indent}${line}`);
    return ['', ...lines].join(lineEnding);
};
