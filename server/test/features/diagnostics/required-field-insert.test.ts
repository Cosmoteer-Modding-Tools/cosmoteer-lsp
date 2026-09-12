import { describe, expect, it } from 'vitest';
import { requiredFieldInsertText } from '../../../src/features/diagnostics/required-field-insert';

const insertFor = (text: string, fields: Array<{ name: string; text: string }>) => {
    const offset = text.lastIndexOf('\n', text.indexOf('}') - 1);
    return { offset, groupEnd: text.indexOf('}') + 1, fields, fieldIndex: 0 };
};

// The fix writes literal text, so it has to place and indent the lines itself. It also has to refuse
// when the payload no longer matches the buffer, since the offsets come from a validation pass that
// can be a version behind.
describe('requiredFieldInsertText', () => {
    const SOURCE = 'Part\n{\n\tType = Thruster\n}\n';
    const FIELDS = [
        { name: 'Force', text: 'Force = 0' },
        { name: 'Mass', text: 'Mass = 0' },
    ];

    it('opens a new line and matches the indentation of the members already there', () => {
        const insert = insertFor(SOURCE, FIELDS);
        expect(requiredFieldInsertText(SOURCE, insert, [FIELDS[0]])?.newText).toBe('\n\tForce = 0');
    });

    it('writes several fields as several lines', () => {
        const insert = insertFor(SOURCE, FIELDS);
        expect(requiredFieldInsertText(SOURCE, insert, FIELDS)?.newText).toBe('\n\tForce = 0\n\tMass = 0');
    });

    it('keeps the line ending the file already uses', () => {
        const crlf = 'Part\r\n{\r\n\tType = Thruster\r\n}\r\n';
        const insert = { ...insertFor(crlf, FIELDS), offset: crlf.indexOf('Thruster') + 'Thruster'.length };
        expect(requiredFieldInsertText(crlf, insert, [FIELDS[0]])?.newText).toBe('\r\n\tForce = 0');
    });

    it('writes the scaffold after the separator the last member carries', () => {
        const text = 'Part\n{\n\tType = Thruster ;\n}\n';
        const offset = text.indexOf('Thruster') + 'Thruster'.length;
        const insert = { offset, groupEnd: text.indexOf('}') + 1, fields: FIELDS, fieldIndex: 0 };
        const written = requiredFieldInsertText(text, insert, [FIELDS[0]])!;
        expect(text.slice(0, written.offset) + written.newText).toBe('Part\n{\n\tType = Thruster ;\n\tForce = 0');
    });

    it('writes the scaffold after a trailing block comment', () => {
        const text = 'Part\n{\n\tType = Thruster /* the only kind */\n}\n';
        const offset = text.indexOf('Thruster') + 'Thruster'.length;
        const insert = { offset, groupEnd: text.indexOf('}') + 1, fields: FIELDS, fieldIndex: 0 };
        const written = requiredFieldInsertText(text, insert, [FIELDS[0]])!;
        expect(written.offset).toBe(text.indexOf('*/') + '*/'.length);
    });

    it('writes the scaffold after a trailing line comment', () => {
        const text = 'Part\n{\n\tType = Thruster // the only kind\n}\n';
        const offset = text.indexOf('Thruster') + 'Thruster'.length;
        const insert = { offset, groupEnd: text.indexOf('}') + 1, fields: FIELDS, fieldIndex: 0 };
        const written = requiredFieldInsertText(text, insert, [FIELDS[0]])!;
        expect(written.offset).toBe(text.indexOf('kind') + 'kind'.length);
    });

    it('keeps a one-line group on its line and separates the members', () => {
        const text = 'Part { Type = Thruster }\n';
        const offset = text.indexOf('Thruster') + 'Thruster'.length;
        const insert = { offset, groupEnd: text.indexOf('}') + 1, fields: FIELDS, fieldIndex: 0 };
        const written = requiredFieldInsertText(text, insert, FIELDS)!;
        expect(text.slice(0, written.offset) + written.newText + text.slice(written.offset)).toBe(
            'Part { Type = Thruster, Force = 0, Mass = 0 }\n'
        );
    });

    it('writes a space-indented group with its own indentation', () => {
        const text = 'Part\n{\n    Type = Thruster\n}\n';
        const offset = text.indexOf('Thruster') + 'Thruster'.length;
        const insert = { offset, groupEnd: text.indexOf('}') + 1, fields: FIELDS, fieldIndex: 0 };
        expect(requiredFieldInsertText(text, insert, [FIELDS[0]])?.newText).toBe('\n    Force = 0');
    });

    it('refuses when the group no longer closes where the payload says', () => {
        const insert = insertFor(SOURCE, FIELDS);
        // The buffer moved on and the brace is gone from that offset.
        expect(requiredFieldInsertText('Part\n{\n\tType = Thruster\n', insert, [FIELDS[0]])).toBeNull();
    });

    it('refuses a payload reaching past the end of the file', () => {
        const insert = { ...insertFor(SOURCE, FIELDS), groupEnd: 9999 };
        expect(requiredFieldInsertText(SOURCE, insert, [FIELDS[0]])).toBeNull();
    });

    it('refuses when there is nothing to write', () => {
        expect(requiredFieldInsertText(SOURCE, insertFor(SOURCE, FIELDS), [])).toBeNull();
    });
});
