import { afterEach, describe, expect, it, vi } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isValueNode, ValueNode } from '../../../src/core/ast/ast';
import { keyDeclarationsOf } from '../../../src/features/completion/localization-key.index';
import { validateTextMarkup } from '../../../src/features/diagnostics/validator.text-markup';
import { markupTextOf } from '../../../src/features/text-markup/text-markup';
import { useMarkupSourceReader } from '../../../src/features/text-markup/markup-source';

vi.mock('../../../src/mod/mod-root', () => ({
    findModRoot: () => 'mod',
}));

const STRINGS = 'file:///c%3A/mod/strings/en.rules';
const token = CancellationToken.None;

/**
 * Parses a language file and hands its text to the markup layer, the way an open buffer does.
 *
 * @param source the whole file.
 * @returns the parsed document.
 */
const openFile = (source: string) => {
    useMarkupSourceReader((uri) => (uri === STRINGS ? source : undefined));
    return parser(lexer(source), STRINGS).value;
};

/**
 * What the markup validator squiggles, as the characters of the file each finding covers.
 *
 * @param source the whole file.
 * @returns the covered text of every finding, in order.
 */
const squiggled = async (source: string): Promise<string[]> =>
    (await validateTextMarkup(openFile(source), [], token)).map((error) =>
        source.slice(error.range!.start, error.range!.end)
    );

/**
 * The quoted value a one-key language file declares.
 *
 * @param source the whole file.
 * @returns the value node the key was written with.
 */
const valueOf = (source: string): ValueNode | undefined => {
    for (const declaration of keyDeclarationsOf(parser(lexer(source), STRINGS).value)) {
        if (isValueNode(declaration.node) && declaration.node.quoted) return declaration.node;
    }
    return undefined;
};

// Every offset the markup layer reports is an offset of the file, so what the file actually holds
// at that offset is what the tests read.
describe('markup offsets in a value that spans lines', () => {
    afterEach(() => useMarkupSourceReader(undefined));

    it('squiggles the tag name and nothing else in a value carried on by a backslash', async () => {
        const source = [
            '__Name = English',
            `Parts/Thing = "first line with "\\`,
            `\t"<colr value='1'>red</colr>"`,
            '',
        ].join('\n');
        expect(await squiggled(source)).toEqual(['colr']);
    });

    it('squiggles the tag name and nothing else where the tag sits before the join', async () => {
        const source = ['__Name = English', `Parts/Thing = "<colr value='1'>red</colr> "\\`, `\t"tail"`, ''].join('\n');
        expect(await squiggled(source)).toEqual(['colr']);
    });

    it('squiggles the tag name and nothing else in a value written on one line', async () => {
        const source = ['__Name = English', `Parts/Thing = "<colr value='1'>red</colr>"`, ''].join('\n');
        expect(await squiggled(source)).toEqual(['colr']);
    });

    it('squiggles the tag name and nothing else in a verbatim string that runs over several lines', async () => {
        const source = ['__Name = English', 'Parts/Thing = @"head', `<colr value='1'>red</colr>"`, ''].join('\n');
        expect(await squiggled(source)).toEqual(['colr']);
    });

    it("cuts the span out of the file, so its offsets are the file's own", () => {
        const source = [
            '__Name = English',
            `Parts/Thing = "first line with "\\`,
            `\t"<color hex='FF0000'>red</color>"`,
            '',
        ].join('\n');
        useMarkupSourceReader((uri) => (uri === STRINGS ? source : undefined));
        const span = markupTextOf(valueOf(source)!)!;
        expect(source.slice(span.offset, span.offset + span.text.length)).toBe(span.text);
        expect(span.text).toBe(`"first line with "\\\n\t"<color hex='FF0000'>red</color>"`);
    });

    it('says nothing about a value whose file nothing holds, where the written form is not derivable', () => {
        const source = [
            '__Name = English',
            `Parts/Thing = "first line with "\\`,
            `\t"<color hex='FF0000'>red</color>"`,
            '',
        ].join('\n');
        useMarkupSourceReader(() => undefined);
        expect(markupTextOf(valueOf(source)!)).toBeUndefined();
    });

    it('measures a single-segment value without the file, since the lexer kept it as written', () => {
        const source = ['__Name = English', `Parts/Thing = "<color hex='FF0000'>red</color>"`, ''].join('\n');
        useMarkupSourceReader(() => undefined);
        const span = markupTextOf(valueOf(source)!)!;
        expect(source.slice(span.offset, span.offset + span.text.length)).toBe(span.text);
    });
});
