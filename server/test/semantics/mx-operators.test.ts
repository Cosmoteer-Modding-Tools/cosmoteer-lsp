import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { AssignmentNode, isAssignmentNode } from '../../src/core/ast/ast';
import { evaluateNumericValue } from '../../src/semantics/value-evaluator';
import { valueOf } from '../helpers';
import { ORACLE } from './mx-oracle';

const token = CancellationToken.None;

/**
 * The value of `X = <source>`, the assignment each oracle expression is parsed as.
 *
 * @param source the expression to parse as X's value.
 * @returns the assignment's value node.
 */
const rhsOf = (source: string) => {
    const doc = parser(lexer(`X = ${source}\n`), 'file:///mx.rules').value;
    const assignment = doc.elements.find((node) => isAssignmentNode(node)) as AssignmentNode;
    expect(assignment, `no assignment parsed from: ${source}`).toBeDefined();
    return valueOf(assignment);
};

describe('mXparser 4.4.2 operators (oracle-verified against the shipped DLL)', () => {
    for (const [source, expected] of ORACLE) {
        it(`${source} = ${expected}`, async () => {
            const right = rhsOf(source);
            expect(right.type, `${source} did not parse as math`).toBe('MathExpression');
            expect(await evaluateNumericValue(right, token)).toBe(expected);
        });
    }

    it('leaves flat text with operator characters as a plain string value', () => {
        // `a --> b` is absent: a `-` after a bare word already opened a math chain before this
        // change (pre-existing behavior), and its string operand evaluates to null anyway.
        for (const text of ['Guns & Roses', 'A | B', '5 < 3']) {
            const right = rhsOf(text);
            expect(right.type, `"${text}" must stay text`).toBe('Value');
        }
    });
});
