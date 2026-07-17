import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { evaluateNumericValue } from '../../../src/semantics/value-evaluator';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode } from '../../../src/core/ast/ast';
import { valueOf, walkAst } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;

/**
 * The value of a named assignment anywhere in a document.
 *
 * @param doc the parsed document to search.
 * @param name the assignment's field name.
 * @returns the assignment's value node.
 */
const rhsOf = (doc: AbstractNodeDocument, name: string): AbstractNode => {
    for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === name) return valueOf(node);
    throw new Error(`assignment ${name} not found`);
};

// `-` and `/` are in the lexer's value charset (negative numbers, hyphenated names, reference
// paths). When preceded by whitespace they are binary operators instead, so spaced subtraction
// and division now compute, without breaking sci-notation, negatives, or `&~/SIZE/0` paths.
describe('spaced subtraction and division', () => {
    let doc: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        doc = parser(
            lexer(
                'C\n{\n\tA = 10\n\tB = 3\n' +
                    '\tSub = 10 - 3\n' +
                    '\tSubRef = (&A) - (&B)\n' +
                    '\tChain = 10 - 3 - 2\n' +
                    '\tMixed = 10 - 3 + 1\n' +
                    '\tDiv = 20 / 4\n' +
                    '\tRefDiv = (&A) / 2\n' +
                    '\tSci = 3.4E+38\n' +
                    '\tNeg = 3 * -7\n' +
                    '}\n'
            ),
            'file:///t.rules'
        ).value;
    });

    /**
     * Evaluate a named assignment of the parsed source.
     *
     * @param name the assignment's field name.
     * @returns the assignment's numeric value, or null when it does not evaluate.
     */
    const eval_ = (name: string) => evaluateNumericValue(rhsOf(doc, name), token);

    it('evaluates spaced subtraction (left-associative, mixed with +)', async () => {
        expect(await eval_('Sub')).toBe(7); // 10 - 3
        expect(await eval_('SubRef')).toBe(7); // (&A) - (&B)
        expect(await eval_('Chain')).toBe(5); // 10 - 3 - 2
        expect(await eval_('Mixed')).toBe(8); // 10 - 3 + 1
    });

    it('evaluates spaced division', async () => {
        expect(await eval_('Div')).toBe(5); // 20 / 4
        expect(await eval_('RefDiv')).toBe(5); // (&A) / 2
    });

    it('still preserves scientific notation and negative numbers', async () => {
        expect(await eval_('Sci')).toBe(3.4e38); // 3.4E+38, the `+`/`-` stays in the value
        expect(await eval_('Neg')).toBe(-21); // 3 * -7
    });
});
