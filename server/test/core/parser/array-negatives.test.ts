import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Range } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { InlayHintService } from '../../../src/features/inlay/inlay-hint.service';
import { AbstractNodeDocument, isListNode, isAssignmentNode, isValueNode } from '../../../src/core/ast/ast';
import { walkAst } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///t.rules').value;

// A comma-separated `[0, -1]` is a coordinate PAIR, not the subtraction `0 - 1`. The comma is the
// boundary; the `-1` after it must read as a negative literal. Regression for a spurious `= -1`
// inlay hint reported on `VirtualInternalCells` entries like `{ExternalCell=[0, -1]; …}`.
describe('negative numbers in lists', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('parses `[0, -1]` as two elements, the second being the number -1', () => {
        const doc = parse('Cell = [0, -1]\n');
        let arr;
        for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === 'Cell') arr = node.right;
        expect(arr && isListNode(arr)).toBe(true);
        const elements = (arr as { elements: typeof arr[] }).elements;
        const numbers = elements.filter(isValueNode).map((v) => (v.valueType as { value: number }).value);
        expect(numbers).toEqual([0, -1]);
    });

    it('does not emit an inlay hint for a coordinate pair', async () => {
        const doc = parse('VirtualInternalCells\n[\n\t{ExternalCell=[0, -1]; InternalCell=[1, 0]}\n]\n');
        const hints = await InlayHintService.instance.getInlayHints(doc, Range.create(0, 0, 100, 0), token);
        expect(hints).toEqual([]);
    });

    it('still hints genuine math sitting next to a negative literal', async () => {
        // `[-1, 2 * 3]`: `-1` is a literal (no hint), `2 * 3` computes to 6.
        const doc = parse('M = [-1, 2 * 3]\n');
        const hints = await InlayHintService.instance.getInlayHints(doc, Range.create(0, 0, 100, 0), token);
        expect(hints.map((h) => h.label)).toEqual(['= 6']);
    });
});
