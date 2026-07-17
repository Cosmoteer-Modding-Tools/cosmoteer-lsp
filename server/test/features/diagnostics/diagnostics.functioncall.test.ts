import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ValidationForFunctionCall } from '../../../src/features/diagnostics/validator.functioncall';
import { AbstractNode, AstPosition, FunctionCallNode, isFunctionCallNode, ValueNode } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { walkAst } from '../../helpers';

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
// `max` is variadic, so the arity check never fires. These tests isolate the per-argument rules.
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

    // Vanilla `missile_launcher_thermal.rules` has `ceil("(&~/…/MaxResources) / (&…)")`. The game
    // reads the value flat, so the quoted text is evaluated as an expression, not a bad argument.
    it('accepts a quoted string argument (embedded expression)', async () => {
        const quoted: ValueNode = { ...str('(&~/BASE/HeatStorage/MaxResources) / (&X)'), quoted: true };
        expect(await run(call(quoted))).toBeUndefined();
    });

    // A parser artifact like a call "named" `&` is operator text the game reads flat, never a
    // typo'd math function, so no function-call rule applies.
    it('skips calls whose name is not identifier-like', async () => {
        const amp: FunctionCallNode = { ...call(ref('&TickInterval')), name: '&' };
        expect(await ValidationForFunctionCall.callback(amp, token)).toBeUndefined();
    });

    // Vanilla `strings/pt-br.rules` has `HeaderDesired = Desejado(s)`, which is localization text.
    // Function-call validation must not run in language-strings files.
    it('skips function-call validation inside a strings file', async () => {
        const doc = parser(lexer('HeaderDesired = Desejado(s)\n'), 'file:///Data/strings/pt-br.rules').value;
        const node = [...walkAst(doc)].find(isFunctionCallNode) as FunctionCallNode;
        expect(node).toBeDefined();
        expect(await ValidationForFunctionCall.callback(node, token)).toBeUndefined();
    });

    it('still flags an unknown function outside strings files', async () => {
        const doc = parser(lexer('HeaderDesired = Desejado(s)\n'), 'file:///Data/parts/foo.rules').value;
        const node = [...walkAst(doc)].find(isFunctionCallNode) as FunctionCallNode;
        const error = await ValidationForFunctionCall.callback(node, token);
        expect(error?.message).toBe('Unknown function "Desejado"');
    });
});
