import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ValidationForFunctionCall } from '../../../src/features/diagnostics/validator.functioncall';
import { evaluateNumericValue } from '../../../src/semantics/value-evaluator';
import { AbstractNode, isFunctionCallNode, isAssignmentNode } from '../../../src/core/ast/ast';
import { walkAst } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const parse = (src: string): AbstractNode => parser(lexer(src), 'file:///t.rules').value as AbstractNode;
const valueTexts = (src: string): string[] =>
    lexer(src)
        .filter((t) => t.type === 'VALUE')
        .map((t) => String(t.value));

/** All function-call names parsed from a source. */
const callNames = (src: string): string[] => {
    const names: string[] = [];
    for (const node of walkAst(parse(src))) if (isFunctionCallNode(node)) names.push(node.name);
    return names;
};

/** The first assignment's resolved numeric value, if any. */
const evalFirst = async (src: string): Promise<number | null> => {
    for (const node of walkAst(parse(src))) if (isAssignmentNode(node)) return evaluateNumericValue(node.right, token);
    return null;
};

// A `-` (or `/`) between a number and a `(` is a binary operator, even with spaces before the `(`:
// `2.625- (12/64)`. The lexer used to keep `7-` glued when a space sat between the `-` and the `(`
// (the immediate-`(` guard only checked the very next char), so `7-` was read as a function name and
// the validator wrongly reported: `"7-" is not a known math function`.
describe('dash/slash before a (possibly spaced) paren is an operator, not a function name', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('splits `7- (12/64)` into number, operator, group (no `7-` value token)', () => {
        expect(valueTexts('X = 7- (12/64)\n')).not.toContain('7-');
    });

    it('does not parse `7-` as a function call (the reported bug)', () => {
        expect(callNames('X = 7- (12/64)\n')).not.toContain('7-');
    });

    it('does not flag an unknown function for `7- (12/64)`', async () => {
        for (const node of walkAst(parse('X = 7- (12/64)\n'))) {
            if (isFunctionCallNode(node)) {
                expect(await ValidationForFunctionCall.callback(node, token)).toBeUndefined();
            }
        }
    });

    it('evaluates `7- (12/64)` as subtraction = 6.8125', async () => {
        expect(await evalFirst('X = 7- (12/64)\n')).toBeCloseTo(6.8125, 6);
    });

    it('still handles the no-space form `7-(12/64)`', async () => {
        expect(callNames('X = 7-(12/64)\n')).not.toContain('7-');
        expect(await evalFirst('X = 7-(12/64)\n')).toBeCloseTo(6.8125, 6);
    });

    it('does not split a hyphenated name with no following paren', () => {
        // `foo-bar` is one value (hyphenated identifier), not `foo`,`-`,`bar`.
        expect(valueTexts('X = foo-bar\n')).toContain('foo-bar');
    });

    it('still evaluates a leading negative number', async () => {
        // A leading `-` is always a separate operator token; the parser reconstructs `-7`.
        expect(await evalFirst('X = -7\n')).toBe(-7);
    });
});
