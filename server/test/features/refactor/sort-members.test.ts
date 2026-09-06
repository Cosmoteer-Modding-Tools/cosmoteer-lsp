import { beforeAll, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { sortMembersCodeAction } from '../../../src/features/refactor/sort-members';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { parseText } from '../../../src/utils/ast.utils';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);

/** The text a part file becomes after the refactoring, or null when it is not offered. */
const sorted = (body: string[]): string | null => {
    const uri = filePathToUri(workspaceFile('parts/probe/probe.rules'));
    const text = ['Part', '{', ...body.map((line) => TAB + line), '}', ''].join(NEWLINE);
    const document = TextDocument.create(uri, 'rules', 0, text);
    // The caret sits inside the group, which is where a code action is asked for.
    const action = sortMembersCodeAction(parseText(text, uri), document, text.indexOf(body[0]), uri);
    if (!action) return null;
    const edits = action.edit?.changes?.[uri] ?? [];
    // Applied back to front so an earlier edit cannot move a later one's offsets.
    let result = text;
    for (const edit of [...edits].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start))) {
        result =
            result.slice(0, document.offsetAt(edit.range.start)) +
            edit.newText +
            result.slice(document.offsetAt(edit.range.end));
    }
    return result;
};

describe('sorting members into schema order', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('writes an inherited field where the class it comes from declares it', () => {
        // `MaxHealth` is declared far below `ID` on the part class, so the two swap back.
        const result = sorted(['MaxHealth = 10', 'ID = probe.part']);
        expect(result).not.toBeNull();
        expect(result!.indexOf('ID = probe.part')).toBeLessThan(result!.indexOf('MaxHealth = 10'));
    });

    it('is not offered when the members are already in order', () => {
        expect(sorted(['ID = probe.part', 'MaxHealth = 10'])).toBeNull();
    });

    it('refuses a group holding a member the schema does not know', () => {
        // A constant the file declares itself has no place in the class's order, so nothing can be
        // said about where it belongs.
        expect(sorted(['MaxHealth = 10', 'MY_CONSTANT = 3', 'ID = probe.part'])).toBeNull();
    });

    it('refuses a group with a comment between its members', () => {
        expect(sorted(['MaxHealth = 10', '// why this part is tough', 'ID = probe.part'])).toBeNull();
    });

    it('refuses a group writing one name twice', () => {
        expect(sorted(['MaxHealth = 10', 'ID = probe.part', 'MaxHealth = 20'])).toBeNull();
    });

    it('refuses two members sharing a line', () => {
        expect(sorted(['MaxHealth = 10; ID = probe.part'])).toBeNull();
    });

    it('keeps every token the file had', () => {
        const result = sorted(['MaxHealth = 10', 'ID = probe.part']);
        expect(result).toContain('MaxHealth = 10');
        expect(result).toContain('ID = probe.part');
        // The group keeps its shape: the two lines of the header, one per member, the closer and the
        // file's own trailing newline.
        expect(result!.split(NEWLINE).length).toBe(6);
    });
});
