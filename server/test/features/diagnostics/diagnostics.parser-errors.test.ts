import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';

type RelatedInfo = { message: string };
type ParserErrorLike = { message: string; additionalInfo?: RelatedInfo[] };

const parseErrors = (src: string): ParserErrorLike[] =>
    parser(lexer(src), 'file:///p.rules').parserErrors as unknown as ParserErrorLike[];
const messages = (src: string): string[] => parseErrors(src).map((e) => e.message);

describe('parser error diagnostics', () => {
    // Each case is [label, source, expected message]. The expected message must appear
    // among the parser errors the source produces.
    it.each([
        ['unclosed group at EOF', 'Foo\n{\n\tX = 1\n', 'Expected right brace to close the group'],
        ['unclosed list at EOF', 'Foo\n[\n\t1\n', 'Expected right bracket to close the list'],
        ['stray closing brace', '}\n', 'Not expected right brace, did you mean to open a group?'],
        ['stray closing bracket', ']\n', 'Not expected bracket, did you mean to open a list?'],
        ['stray comma in a group', 'Foo\n{\n\t,\n}\n', 'Not expected comma'],
        ['assignment with no value', 'X =\n', 'Expected value after equals'],
        ['inheritance colon with no value', 'X :\n', 'Expected value after colon'],
        ['empty parentheses', 'X = ()\n', 'Expected value after left paren'],
        ['non-reference after inheritance value', 'A : 1\nB = 2\n', 'Expected reference value after reference value but found Assignment'],
        ['unknown token', 'X = @\n', 'Unknown token type'],
        // The real OT parser throws `Unexpected "=" at position …` here too (OTGroupNode.Parse),
        // so this is reported as invalid input rather than a possible parser bug.
        ['stray equals after a comma terminator', 'X = &<a.rules>, = &<b.rules>\n', 'Unexpected "="'],
        ['group brace never closed (immediate EOF)', 'Foo {', 'Expected right brace but found end of file'],
        ['list bracket never closed (immediate EOF)', 'Foo [', 'Expected right bracket but found end of file'],
        ['unclosed parenthesized reference', 'X = ceil((&A + 3\n', 'Expected right paren'],
        ['non-value inside a function call', 'X = ceil(1 {})\n', 'Expected value, expression or function call'],
        ['non-value inside a parenthesized math group', 'X = (1 {})\n', 'Expected value or expression in math expression'],
    ])('reports %s', (_label, src, expected) => {
        expect(messages(src)).toContain(expected);
    });

    it('attaches actionable "how to fix" details to a value-less assignment', () => {
        const error = parseErrors('X =\n').find((e) => e.message === 'Expected value after equals');
        const details = (error?.additionalInfo ?? []).map((i) => i.message);
        expect(details).toContain('If you want to assign a value to an identifier, you need to provide a value after the equals sign');
        expect(details).toContain("If you don't want to assign a value to an identifier, you need to remove the equals sign");
    });

    it('explains that an inheritance colon expects references', () => {
        const error = parseErrors('X :').find((e) => e.message === 'Expected value after colon');
        expect((error?.additionalInfo ?? []).map((i) => i.message)).toContain('Those Values should be a References');
    });

    it('asks the user to report an unknown token as a possible bug', () => {
        const error = parseErrors('X = @\n').find((e) => e.message === 'Unknown token type');
        expect((error?.additionalInfo ?? []).map((i) => i.message)).toContain(
            'This could be a bug in the parser or lexer, please report this issue, if you think this is a bug'
        );
    });

    it('treats a stray closing paren as literal value text, not a parser error (cosmoteer strings)', () => {
        // `RightBracket = )` (a keyboard-key glossary in cosmoteer `strings/ja.rules`, `ru.rules`)
        // and values ending in `)` are read by the real OT parser as plain value text. A `)` that
        // reaches the top level is unmatched (paren groups consume their own close), so it must NOT
        // be reported as "Not expected paren" — and it must not swallow the following field.
        const src = 'Keys\n{\n\tRightBracket = )\n\tNext = "x"\n}\n';
        expect(messages(src)).toEqual([]);
    });

    it('produces no errors for a well-formed document', () => {
        expect(messages('Foo\n{\n\tX = 1\n\tY = &X\n}\n')).toEqual([]);
    });
});
