import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, InlayHint, Range } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { InlayHintService } from '../../../src/features/inlay/inlay-hint.service';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///t.rules').value;

const hintsFor = async (src: string): Promise<InlayHint[]> => {
    const doc = parse(src + '\n');
    return InlayHintService.instance.getInlayHints(doc, Range.create(0, 0, 50, 0), token);
};

const labels = (hints: InlayHint[]): string[] => hints.map((h) => (typeof h.label === 'string' ? h.label : ''));

// A bare percentage literal (`50%`) is a String-typed value, so it never reached the math/reference
// inlay path. We now surface its decimal (÷100) value — the form the game's math actually uses.
describe('inlay hints for percentage literals', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('annotates a standalone percentage with its decimal value', async () => {
        expect(labels(await hintsFor('Chance = 50%'))).toEqual(['= 0.5']);
    });

    it('handles a fractional / spaced percentage', async () => {
        expect(labels(await hintsFor('Rate = 12.5 %'))).toEqual(['= 0.125']);
    });

    it('annotates each percentage entry in a list', async () => {
        expect(labels(await hintsFor('Rates = [50%, 25%]'))).toEqual(['= 0.5', '= 0.25']);
    });

    it('does not annotate a plain number', async () => {
        expect(await hintsFor('Health = 5')).toHaveLength(0);
    });

    it('does not annotate a quoted "percentage" string', async () => {
        expect(await hintsFor('Label = "50%"')).toHaveLength(0);
    });
});
