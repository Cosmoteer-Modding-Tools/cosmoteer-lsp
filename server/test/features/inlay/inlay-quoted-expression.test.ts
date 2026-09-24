import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, InlayHint, Range } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { getInlayHints } from '../../../src/features/inlay/inlay-hint.service';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///t.rules').value;

const hintsFor = async (src: string): Promise<InlayHint[]> => {
    const doc = parse(src + '\n');
    return getInlayHints(doc, Range.create(0, 0, 50, 0), token);
};

const labels = (hints: InlayHint[]): string[] => hints.map((h) => (typeof h.label === 'string' ? h.label : ''));

// A bare comma ends a value, so quoting is the only way to write a call that takes more than one
// argument. The game still evaluates what is inside the quotes, and the hint that says what an
// expression works out to used to go blank on exactly that form.
describe('inlay hints for a quoted expression', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('annotates a call whose arguments are separated by a comma', async () => {
        expect(labels(await hintsFor('Fame = "round(3.14159, 2)"'))).toEqual(['= 3.14']);
    });

    it('annotates a quoted expression written without a call', async () => {
        expect(labels(await hintsFor('Sum = "1 + 2"'))).toEqual(['= 3']);
    });

    it('annotates every quoted entry of a list', async () => {
        expect(labels(await hintsFor('Money = ["round(1.5, 0)", "min(4, 5)"]'))).toEqual(['= 2', '= 4']);
    });

    it('puts the hint after the closing quote', async () => {
        const hints = await hintsFor('Fame = "min(4, 5)"');
        expect(hints[0].position).toEqual({ line: 0, character: 18 });
    });

    it('says nothing about a quoted word or sentence', async () => {
        expect(await hintsFor('Label = "hello world"')).toHaveLength(0);
        expect(await hintsFor('Label = "Level 1 - 2 of the tutorial"')).toHaveLength(0);
    });
});
