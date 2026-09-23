import { describe, expect, it } from 'vitest';
import { CancellationToken, Location, Range } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { getDefinition } from '../../../src/features/navigation/definition.service';
import { findReferences } from '../../../src/features/navigation/reference-index';
import { documentHighlightsAt } from '../../../src/features/navigation/document-highlight';
import { getHover } from '../../../src/features/hover/hover.service';
import { componentDeclarationAt } from '../../../src/features/navigation/rename-component-id';
import { findNodeAtPosition } from '../../../src/utils/ast.utils';

// A component id names a component of the whole part, from whichever slot it is written in. Only the
// slot written directly on a component group used to resolve, so clicking one from the part itself,
// from inside a `[ ]` list or from a group written as a list element answered nothing at all. The
// assertions read the text the answered range covers, because a range that lands on a plausible but
// wrong token is worse than no answer.
const token = CancellationToken.None;

const SRC = `Part
{
	ID = audit.probe
	SignificanceToggle = ScorchTog
	Components
	{
		ScorchTog { Type = UIToggle }
		PowerTog { Type = UIToggle }
		IsOperational
		{
			Type = MultiToggle
			Toggles = [ScorchTog, PowerTog]
			Mode = All
		}
		Inverted
		{
			Type = MultiToggle
			Toggles = [ { Toggle = ScorchTog; Invert = true } ]
			Mode = All
		}
	}
}`;

const LINES = SRC.split('\n');

const parse = () => parser(lexer(SRC), 'file:///probe.rules').value;

/**
 * The caret inside a line, found by the text the line carries.
 *
 * @param lineText the text identifying the line.
 * @param offset how far into that text the caret sits.
 * @returns the caret position.
 */
const caretAt = (lineText: string, offset: number) => {
    const line = LINES.findIndex((candidate) => candidate.includes(lineText));
    return { line, character: LINES[line].indexOf(lineText) + offset };
};

/**
 * The document text a range covers, so a test says which token an answer landed on.
 *
 * @param range the answered range.
 * @returns the text under it.
 */
const covered = (range: Range): string =>
    LINES[range.start.line].slice(range.start.character, range.end.character);

const DECLARATION = caretAt('\t\tScorchTog { Type', 2);
const USES = [
    caretAt('SignificanceToggle = ScorchTog', 'SignificanceToggle = '.length),
    caretAt('Toggles = [ScorchTog, PowerTog]', 'Toggles = ['.length),
    caretAt('{ Toggle = ScorchTog;', '{ Toggle = '.length),
];

/** Every answered site as `line:character "text"`, which is what makes a wrong landing readable. */
const sites = (locations: Location[]): string[] =>
    locations
        .map((location) => `${location.range.start.line}:${location.range.start.character} ${covered(location.range)}`)
        .sort();

describe('a component id written outside the component that declares it', () => {
    it.each([
        ['a field of the part itself', 0],
        ['a bare element of a list', 1],
        ['a group written as a list element', 2],
    ])('jumps from %s to the component declaration', async (_label, index) => {
        const definition = await getDefinition(parse(), USES[index], token, []);
        expect(definition).not.toBeNull();
        const location = definition as Location;
        expect(location.range.start).toEqual(DECLARATION);
        expect(covered(location.range)).toBe('ScorchTog');
    });

    it('hovers with what the id resolves to rather than nothing', async () => {
        const hover = await getHover(parse(), USES[1], token, []);
        expect(hover?.contents).toMatchObject({ value: expect.stringContaining('ScorchTog') });
    });

    it('lists the declaration and every slot naming it, from a use and from the declaration', async () => {
        const expected = ['11:14 ScorchTog', '17:26 ScorchTog', '3:22 ScorchTog', '6:2 ScorchTog'];
        for (const caret of [USES[0], USES[1], USES[2], DECLARATION]) {
            expect(sites(await findReferences(parse(), caret, true, [], token))).toEqual(expected);
        }
    });

    it('highlights the declaration from a use and the uses from the declaration', async () => {
        for (const caret of [USES[1], DECLARATION]) {
            const highlights = (await documentHighlightsAt(parse(), caret, true, undefined, token)) ?? [];
            expect(sites(highlights.map((highlight) => ({ uri: '', range: highlight.range })))).toEqual([
                '11:14 ScorchTog',
                '17:26 ScorchTog',
                '3:22 ScorchTog',
                '6:2 ScorchTog',
            ]);
        }
    });

    it('answers nothing for a slot the engine reads against another part', () => {
        // `ChainFireToggleComponent` names a component of the part the beam chains into, so the
        // same-named component of this part is the wrong node to point a reader at.
        const src = SRC.replace('Mode = All\n\t\t}\n\t\tInverted', 'ChainFireToggleComponent = ScorchTog\n\t\t}\n\t\tInverted');
        const document = parser(lexer(src), 'file:///probe.rules').value;
        const line = src.split('\n').findIndex((candidate) => candidate.includes('ChainFireToggleComponent'));
        const character = src.split('\n')[line].indexOf('ScorchTog');
        expect(componentDeclarationAt(findNodeAtPosition(document, { line, character }))).toBeUndefined();
    });
});
