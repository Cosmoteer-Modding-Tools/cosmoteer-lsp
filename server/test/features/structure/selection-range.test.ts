import { describe, expect, it } from 'vitest';
import { Position, SelectionRange } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseText } from '../../../src/utils/ast.utils';
import { computeSelectionRanges } from '../../../src/features/structure/selection-range.service';

const URI = 'file:///t.rules';

/** The chain for one caret, innermost first. */
const chainAt = (source: string, position: Position): SelectionRange[] => {
    const document = TextDocument.create(URI, 'rules', 1, source);
    const [selection] = computeSelectionRanges(document, parseText(source, URI), [position]);
    const chain: SelectionRange[] = [];
    for (let step: SelectionRange | undefined = selection; step; step = step.parent) chain.push(step);
    return chain;
};

/** True when (line, char) is at or before (oLine, oChar). */
const atOrBefore = (line: number, char: number, oLine: number, oChar: number): boolean =>
    line < oLine || (line === oLine && char <= oChar);

/** Every parent must contain its child, the invariant the protocol states and the clients rely on. */
const assertNested = (chain: SelectionRange[]): void => {
    for (let index = 0; index + 1 < chain.length; index++) {
        const inner = chain[index].range;
        const outer = chain[index + 1].range;
        expect(atOrBefore(outer.start.line, outer.start.character, inner.start.line, inner.start.character)).toBe(true);
        expect(atOrBefore(inner.end.line, inner.end.character, outer.end.line, outer.end.character)).toBe(true);
    }
};

const SOURCE = 'Part\n{\n\tType = TurretWeapon\n}\n';

describe('selection ranges', () => {
    it('grows from the value to its field to the group to the file', () => {
        const chain = chainAt(SOURCE, { line: 2, character: 12 });
        assertNested(chain);
        expect(chain[0].range).toEqual({ start: { line: 2, character: 8 }, end: { line: 2, character: 20 } });
        expect(chain[1].range).toEqual({ start: { line: 2, character: 1 }, end: { line: 2, character: 20 } });
        expect(chain[chain.length - 1].range.start).toEqual({ line: 0, character: 0 });
    });

    it('takes the closing brace with the group', () => {
        const chain = chainAt(SOURCE, { line: 2, character: 12 });
        expect(chain.map((step) => step.range)).toContainEqual({
            start: { line: 0, character: 0 },
            end: { line: 3, character: 1 },
        });
    });

    it('steps through a function call and its embedded reference', () => {
        const chain = chainAt('Part\n{\n\tA = ceil((&B) / 2)\n}\n', { line: 2, character: 15 });
        assertNested(chain);
        // Every step widens, so no two consecutive steps select the same text.
        for (let index = 0; index + 1 < chain.length; index++) {
            expect(chain[index].range).not.toEqual(chain[index + 1].range);
        }
    });

    it('answers one chain per requested position', () => {
        const document = TextDocument.create(URI, 'rules', 1, SOURCE);
        const positions = [
            { line: 0, character: 2 },
            { line: 2, character: 3 },
            { line: 3, character: 0 },
        ];
        expect(computeSelectionRanges(document, parseText(SOURCE, URI), positions)).toHaveLength(3);
    });

    it('answers the whole file for a position on no node', () => {
        const chain = chainAt(SOURCE, { line: 4, character: 0 });
        expect(chain).toHaveLength(1);
        expect(chain[0].range).toEqual({ start: { line: 0, character: 0 }, end: { line: 4, character: 0 } });
    });
});
