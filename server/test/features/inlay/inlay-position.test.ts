import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Range } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { InlayHintService } from '../../../src/features/inlay/inlay-hint.service';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///t.rules').value;

/** The single hint's character column on its line. */
const hintColumn = async (line: string): Promise<number> => {
    const doc = parse(line + '\n');
    const hints = await InlayHintService.instance.getInlayHints(doc, Range.create(0, 0, 10, 0), token);
    expect(hints).toHaveLength(1);
    return hints[0].position.character;
};

// A ` = N` inlay must sit at the END of the whole expression — AFTER every trailing `)` — not
// after the last inner operand. Regression for hints landing mid-expression / before `)`.
describe('inlay hint position', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('places the hint after a parenthesized group', async () => {
        const line = 'SCALE = (6/1)';
        expect(await hintColumn(line)).toBe(line.length); // just past the final `)`
    });

    it('places the hint after the closing parens of a function call', async () => {
        const line = 'MaxHealth = ceil((10) * (3))';
        expect(await hintColumn(line)).toBe(line.length); // past `))`
    });

    it('keeps column alignment correct after a `number/` split', async () => {
        const line = 'XXL = 1/16 + 2';
        expect(await hintColumn(line)).toBe(line.length);
    });
});
