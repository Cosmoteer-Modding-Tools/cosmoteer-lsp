import { describe, expect, it } from 'vitest';
import { Range, WorkspaceEdit } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { guardPreparedRange, RenameCaret } from '../../../src/features/navigation/rename.service';

// The author types a new name into a box drawn around one token. An edit set that rewrites this file
// somewhere else and leaves that token alone renames something they never asked about, which is how
// an id slot once came to replace the field name it was written in. The branches are covered by the
// tests beside this one. These pin the backstop itself, so it cannot quietly stop holding.
const uri = 'file:///c%3A/mod/parts/part.rules';
const document = { uri: 'c:/mod/parts/part.rules' } as AbstractNodeDocument;

const span = (line: number, from: number, to: number): Range => ({
    start: { line, character: from },
    end: { line, character: to },
});

const caretAt = (range: Range): RenameCaret =>
    ({ kind: 'componentId', range, placeholder: 'Scorched', id: 'Scorched' }) as RenameCaret;

const editAt = (...ranges: Range[]): WorkspaceEdit => ({
    changes: { [uri]: ranges.map((range) => ({ range, newText: 'Renamed' })) },
});

describe('the backstop that keeps a rename on the span the box offered', () => {
    const prepared = span(14, 26, 40);

    it('passes an edit that rewrites the prepared span', () => {
        const edit = editAt(prepared);
        expect(guardPreparedRange(edit, caretAt(prepared), document)).toBe(edit);
    });

    it('passes an edit that rewrites the prepared span among others', () => {
        const edit = editAt(span(8, 22, 36), prepared, span(40, 26, 40));
        expect(guardPreparedRange(edit, caretAt(prepared), document)).toBe(edit);
    });

    it('refuses an edit that rewrites this file only somewhere else', () => {
        // The shape of the defect: the box named the id, the edit named the field it is written in.
        expect(guardPreparedRange(editAt(span(14, 4, 25)), caretAt(prepared), document)).toBeNull();
    });

    it('refuses an edit whose span merely overlaps the prepared one', () => {
        expect(guardPreparedRange(editAt(span(14, 26, 39)), caretAt(prepared), document)).toBeNull();
    });

    it('passes an edit that leaves this file alone, since a rename searches other folders too', () => {
        const edit: WorkspaceEdit = {
            changes: { 'file:///c%3A/mod/parts/other.rules': [{ range: prepared, newText: 'Renamed' }] },
        };
        expect(guardPreparedRange(edit, caretAt(prepared), document)).toBe(edit);
    });

    it('passes an edit carrying no changes at all', () => {
        const edit: WorkspaceEdit = { changes: {} };
        expect(guardPreparedRange(edit, caretAt(prepared), document)).toBe(edit);
    });
});
