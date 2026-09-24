import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, InsertReplaceEdit, Range, TextEdit } from 'vscode-languageserver';
import { AbstractNodeDocument, ValueNode } from '../../../src/core/ast/ast';
import { AutoCompletionReference } from '../../../src/features/completion/autocompletion.reference';
import { toCompletionItem } from '../../../src/features/completion/completion-item';
import {
    insertRangeWithin,
    writtenValueRange,
} from '../../../src/features/completion/completion-range';
import { Completion, CompletionSuggestion } from '../../../src/features/completion/autocompletion.service.types';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

// A completion whose replace range stops at the caret writes the suggestion in front of the tail the
// author already typed, so clicking into the middle of a value and accepting turns
// `Parts/LaserBlaster` into `Parts/LaserBlasterBlaster`. The value the server itself then reports as
// unresolved is one the completion wrote. These assert the resulting line, because every one of
// these defects passes a test that only compares ranges.
const token = CancellationToken.None;
const reference = new AutoCompletionReference();

/** A value node laid out on one line, as the lexer places it, with the quotes outside the value. */
const valueNode = (
    value: string,
    parent: AbstractNodeDocument,
    { line = 0, characterStart = 10, quoted = false } = {}
): ValueNode =>
    ({
        type: 'Value',
        valueType: { type: 'String', value },
        quoted,
        position: {
            line,
            characterStart,
            characterEnd: characterStart + value.length + (quoted ? 2 : 0),
            start: characterStart,
            end: characterStart + value.length + (quoted ? 2 : 0),
        },
        parent,
    }) as unknown as ValueNode;

/**
 * Writes an edit into a line the way an editor would, so the assertion is on the text the author is
 * left with rather than on the numbers the server produced.
 *
 * @param line the line before the edit.
 * @param edit the edit the completion item carries.
 * @param mode which range of an insert/replace pair to honour.
 * @returns the line after the edit.
 */
const applyTo = (line: string, edit: TextEdit | InsertReplaceEdit, mode: 'replace' | 'insert' = 'replace'): string => {
    const range: Range = 'range' in edit ? edit.range : mode === 'replace' ? edit.replace : edit.insert;
    return line.slice(0, range.start.character) + edit.newText + line.slice(range.end.character);
};

/** The edit a suggestion ships to a client, with insert/replace support on or off. */
const editOf = (suggestion: CompletionSuggestion, insertReplaceSupported: boolean): TextEdit | InsertReplaceEdit => {
    const item = toCompletionItem(suggestion, false, insertReplaceSupported);
    if (!item.textEdit) throw new Error(`no text edit on ${suggestion.label}`);
    return item.textEdit;
};

describe('accepting a completion with the caret inside a written value', () => {
    // `NameKey = "Parts/LaserBlaster"`, caret between `Laser` and `Blaster`.
    const line = '    NameKey = "Parts/LaserBlaster"';
    const openQuote = line.indexOf('"');
    const caret = { line: 0, character: line.indexOf('Blaster') };

    const suggestionFor = (parent: AbstractNodeDocument): CompletionSuggestion => {
        const node = valueNode('Parts/LaserBlaster', parent, { characterStart: openQuote, quoted: true });
        const replace = writtenValueRange(node);
        expect(replace).toBeDefined();
        return {
            label: 'Parts/LaserBlaster',
            range: replace,
            insertRange: insertRangeWithin(replace!, caret),
        };
    };

    let doc: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        doc = await parseFilePath(workspaceFile('a.rules'));
    });

    it('replaces the whole value for a client that takes only a plain edit', () => {
        const written = applyTo(line, editOf(suggestionFor(doc), false));
        expect(written).toBe('    NameKey = "Parts/LaserBlaster"');
        expect(written).not.toContain('BlasterBlaster');
    });

    it('replaces the whole value for a client whose insert mode is replace', () => {
        const edit = editOf(suggestionFor(doc), true);
        expect('insert' in edit).toBe(true);
        expect(applyTo(line, edit, 'replace')).toBe('    NameKey = "Parts/LaserBlaster"');
    });

    it('keeps the tail for a client whose insert mode is insert, which is what that mode means', () => {
        const edit = editOf(suggestionFor(doc), true);
        expect(applyTo(line, edit, 'insert')).toBe('    NameKey = "Parts/LaserBlasterBlaster"');
    });

    it('leaves a value it cannot measure to the caret-bounded fallback', () => {
        // A value written across a `\` continuation occupies more characters than its text, so the
        // node cannot say where it ends on this line and nothing may be replaced past the caret.
        const node = valueNode('first second', doc, { characterStart: 10, quoted: true });
        node.position!.characterEnd += 4;
        expect(writtenValueRange(node)).toBeUndefined();
    });

    it('offers no insert range once the caret sits at the end of the value', () => {
        const node = valueNode('Parts/LaserBlaster', doc, { characterStart: openQuote, quoted: true });
        const replace = writtenValueRange(node)!;
        expect(insertRangeWithin(replace, { line: 0, character: replace.end.character })).toBeUndefined();
    });
});

describe('accepting a path segment with the caret inside it', () => {
    let doc: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        doc = await parseFilePath(workspaceFile('a.rules'));
    });

    // The counter-example a verifier raised against the first proposed fix: a segment completer's
    // label is one segment, so a replace range run to the end of the value swallows the file name
    // and leaves a path that names nothing.
    it('replaces the segment and leaves the rest of the path standing', async () => {
        const value = '&<./Data/a.ru';
        const node: ValueNode = {
            type: 'Value',
            valueType: { type: 'Reference', value },
            position: {
                line: 2,
                characterStart: 10,
                characterEnd: 10 + value.length,
                start: 10,
                end: 10 + value.length,
            },
            parent: doc,
        } as unknown as ValueNode;
        const completions = await reference.getCompletions(node, token, 10 + value.length);
        expect(completions.length).toBeGreaterThan(0);
        for (const completion of completions as Completion[]) {
            if (typeof completion === 'string') continue;
            expect(completion.range).toBeDefined();
            // The replaced span is the typed segment, never the whole reference.
            expect(completion.range!.start.character).toBeGreaterThanOrEqual(10 + '&<./Data/'.length);
            expect(completion.range!.end.character).toBeLessThanOrEqual(10 + value.length);
        }
    });
});
