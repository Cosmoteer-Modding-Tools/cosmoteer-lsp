import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ValidationForFunctionCall } from '../../../src/features/diagnostics/validator.functioncall';
import { AbstractNode, AstPosition, FunctionCallNode, ValueNode } from '../../../src/core/ast/ast';

const token = CancellationToken.None;
const pos = (): AstPosition => ({ line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 });

type ArgOpts = { parenthesized?: boolean; delimiter?: ValueNode['delimiter'] };
const ref = (v: string, o: ArgOpts = {}): ValueNode => ({
    type: 'Value',
    valueType: { type: 'Reference', value: v },
    parenthesized: o.parenthesized,
    delimiter: o.delimiter,
    position: pos(),
});
const num = (v: number): ValueNode => ({ type: 'Value', valueType: { type: 'Number', value: v }, position: pos() });
const str = (v: string): ValueNode => ({ type: 'Value', valueType: { type: 'String', value: v }, position: pos() });
// `max` is variadic, so the arity check never fires — these tests isolate the per-argument rules.
const call = (...args: AbstractNode[]): FunctionCallNode => ({ type: 'FunctionCall', name: 'max', arguments: args as FunctionCallNode['arguments'], position: pos() });

const run = (c: FunctionCallNode) => ValidationForFunctionCall.callback(c, token);

describe('function-call argument diagnostics', () => {
    it('flags a reference argument that is missing its ampersand', async () => {
        const error = await run(call(ref('Foo')));
        expect(error?.message).toBe('Reference in function calls needs to start with an ampersand');
        expect(error?.additionalInfo).toContain('&Foo');
    });

    it('flags an unparenthesized reference when there are multiple arguments', async () => {
        const error = await run(call(ref('&A'), ref('&B')));
        expect(error?.message).toBe('Reference in function calls needs to be parenthesized');
        expect(error?.additionalInfo).toContain('(&A)');
    });

    it('flags a non-number, non-reference argument with its concrete type', async () => {
        const error = await run(call(str('foo')));
        expect(error?.message).toBe('Invalid argument type, expected Reference(&) or Number. Got String');
        expect(error?.additionalInfo).toContain('String');
    });

    it('accepts a number plus a parenthesized reference', async () => {
        expect(await run(call(num(1), ref('&A', { parenthesized: true })))).toBeUndefined();
    });

    it('accepts a single unparenthesized reference (no sibling to separate from)', async () => {
        expect(await run(call(ref('&A')))).toBeUndefined();
    });
});
