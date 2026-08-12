import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Range } from 'vscode-languageserver';
import { AbstractNodeDocument, ValueNode } from '../../../src/core/ast/ast';
import { AutoCompletionReference } from '../../../src/features/completion/autocompletion.reference';
import { Completion } from '../../../src/features/completion/autocompletion.service';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

// A reference completes one path segment at a time and its labels are leaf segments (`a.rules>`,
// `ToB`). The client would measure the replaced text with its own word pattern, which breaks at `.`,
// so accepting `a.rules>` over a typed `a.ru` would write `a.a.rules>`. The completer therefore says
// which characters it means to replace.
const token = CancellationToken.None;
const reference = new AutoCompletionReference();

/** A reference value node laid out on one line, as the lexer would place it. */
const refNode = (value: string, parent: AbstractNodeDocument, line = 2, characterStart = 10): ValueNode => ({
    type: 'Value',
    valueType: { type: 'Reference', value },
    position: { line, characterStart, characterEnd: characterStart + value.length, start: 10, end: 10 + value.length },
    parent,
});

const rangesOf = (completions: Completion[]): Array<Range | undefined> =>
    completions.map((completion) => (typeof completion === 'string' ? undefined : completion.range));

describe('reference completions carry the segment they replace', () => {
    let doc: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        doc = await parseFilePath(workspaceFile('a.rules'));
    });

    it('replaces only the segment under the cursor', async () => {
        const value = '&<./Data/a.ru';
        const node = refNode(value, doc);
        const completions = await reference.getCompletions(node, token, 10 + value.length);
        expect(completions.length).toBeGreaterThan(0);
        // `a.ru` is four characters, ending at the cursor. The path before it is untouched.
        for (const range of rangesOf(completions)) {
            expect(range).toEqual({ start: { line: 2, character: 19 }, end: { line: 2, character: 23 } });
        }
    });

    it('covers the typed & for the reference-start prefixes, whose labels spell it out', async () => {
        const node: ValueNode = {
            type: 'Value',
            valueType: { type: 'String', value: '&' },
            position: { line: 2, characterStart: 10, characterEnd: 11, start: 10, end: 11 },
            parent: doc,
        };
        const completions = await reference.getCompletions(node, token, 11);
        expect(completions.length).toBeGreaterThan(0);
        for (const range of rangesOf(completions)) {
            expect(range).toEqual({ start: { line: 2, character: 10 }, end: { line: 2, character: 11 } });
        }
    });

    it('leaves the client its own measurement when no cursor offset is given', async () => {
        const completions = await reference.getCompletions(refNode('&<./Data/a.ru', doc), token);
        expect(completions.every((completion) => typeof completion === 'string')).toBe(true);
    });
});
