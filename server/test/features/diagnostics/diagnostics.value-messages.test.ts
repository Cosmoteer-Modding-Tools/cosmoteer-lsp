import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AstPosition, ValueNode } from '../../../src/core/ast/ast';
import { findReferenceNode } from '../../helpers';

const token = CancellationToken.None;
const pos = (): AstPosition => ({ line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 });
const run = (node: ValueNode) => ValidationForValue.callback(node, token);

describe('value diagnostics — parentheses and assets (node-level)', () => {
    it('flags a parenthesized plain value', async () => {
        const node: ValueNode = { type: 'Value', valueType: { type: 'String', value: 'x' }, parenthesized: true, position: pos() };
        const error = await run(node);
        expect(error?.message).toBe('Value should not be parenthesized');
        expect(error?.additionalInfo).toBe('References in function calls need to be parenthesized or math expressions');
    });

    it('does not flag a parenthesized number (valid math grouping)', async () => {
        const node: ValueNode = { type: 'Value', valueType: { type: 'Number', value: 1 }, parenthesized: true, position: pos() };
        expect(await run(node)).toBeUndefined();
    });

    it('flags an unquoted asset path that contains whitespace, as a warning', async () => {
        // The game loads simple unquoted paths fine; only a path with whitespace is genuinely
        // ambiguous unquoted, so only that is flagged — and as a warning, not a hard error.
        const node: ValueNode = { type: 'Value', valueType: { type: 'Sprite', value: 'foo bar.png' }, quoted: false, position: pos() };
        const error = await run(node);
        expect(error?.message).toBe('Asset paths should be quoted');
        expect(error?.additionalInfo).toBe('Assets should be quoted with ""');
        expect(error?.severity).toBe('warning');
        expect(error?.data?.quickFix?.newText).toBe('"foo bar.png"');
    });

    it('does NOT flag a simple unquoted asset path (the game accepts it)', async () => {
        // `File = foo.png` (no whitespace) is valid unquoted — it must not be a quoting error.
        const node: ValueNode = { type: 'Value', valueType: { type: 'Sprite', value: 'foo.png' }, quoted: false, position: pos() };
        const error = await run(node);
        expect(error?.message).not.toBe('Asset paths should be quoted');
    });
});

describe('value diagnostics — references (parsed)', () => {
    const validate = async (src: string, reference: string) => {
        const doc = parser(lexer(src), 'file:///refs.rules').value;
        return run(findReferenceNode(doc, reference));
    };

    it('flags a syntactically invalid reference', async () => {
        const error = await validate('Bad = &~has~tilde\n', '&~has~tilde');
        expect(error?.message).toBe('Reference is not valid');
        expect(error?.additionalInfo).toContain('<>, ..');
    });

    it('flags a reference whose name resolves to nothing, as a warning (game tolerates it)', async () => {
        const error = await validate('Root = 1\nBad = &DoesNotExist\n', '&DoesNotExist');
        expect(error?.message).toBe('Reference name is not known');
        expect(error?.additionalInfo).toContain('an identifier that is not in scope');
        expect(error?.severity).toBe('warning');
    });

    it('does not flag a reference that resolves in the same file', async () => {
        const error = await validate('Root = 1\nGood = &Root\n', '&Root');
        expect(error).toBeUndefined();
    });
});
