import { describe, expect, it } from 'vitest';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { prepareRename, rename } from '../../../src/features/navigation/rename.service';

// Renaming a part component, from both ends. The caret can sit on the declaration or on any of the
// `ID<>` slots that name it, and the game resolves such an id part-wide, so both directions have to
// rewrite the same set. The assertions read the resulting document text rather than counting edits,
// because the defect this covers produced exactly one edit and put it on the wrong token.
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
		Graphics
		{
			Type = Graphics
			OperationalToggle = IsOperational
		}
	}
}`;

const parse = (src: string) => parser(lexer(src), 'file:///probe.rules').value;

/**
 * The caret inside a line, found by the text the line carries.
 *
 * @param src the document text.
 * @param lineText the text identifying the line.
 * @param offset how far into that text the caret sits.
 * @returns the caret position.
 */
const caretAt = (src: string, lineText: string, offset: number) => {
    const lines = src.split('\n');
    const line = lines.findIndex((candidate) => candidate.includes(lineText));
    return { line, character: lines[line].indexOf(lineText) + offset };
};

/**
 * The document the edits produce, so a test reads the text the author would be left with.
 *
 * @param src the document text before the rename.
 * @param edits the edits of the rename, which rename always keeps inside one line.
 * @returns the rewritten text.
 */
const applyEdits = (src: string, edits: TextEdit[]): string => {
    const lines = src.split('\n');
    const ordered = [...edits].sort(
        (a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character
    );
    for (const edit of ordered) {
        const line = lines[edit.range.start.line];
        lines[edit.range.start.line] =
            line.slice(0, edit.range.start.character) + edit.newText + line.slice(edit.range.end.character);
    }
    return lines.join('\n');
};

/** The message of a refused rename, or the empty string when the call was not refused. */
const refusal = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
    } catch (error) {
        return (error as Error).message;
    }
    return '';
};

describe('renaming a part component', () => {
    it('rewrites the component an id slot names and leaves the field it is written in alone', async () => {
        const doc = parse(SRC);
        const caret = caretAt(SRC, 'SignificanceToggle = ScorchTog', 'SignificanceToggle = '.length + 2);
        const edit = await rename(doc, caret, 'Scorched', [], token);
        expect(edit).not.toBeNull();

        const text = applyEdits(SRC, Object.values(edit!.changes!).flat());
        expect(text).toBe(SRC.split('ScorchTog').join('Scorched'));
        expect(text).toContain('\tSignificanceToggle = Scorched');
    });

    it('offers the id the edit rewrites, so the box and the edit name one token', async () => {
        const doc = parse(SRC);
        const caret = caretAt(SRC, 'SignificanceToggle = ScorchTog', 'SignificanceToggle = '.length + 2);
        const prepared = await prepareRename(doc, caret, token);
        expect(prepared?.placeholder).toBe('ScorchTog');
        expect(prepared?.range.start.character).toBe(
            SRC.split('\n')[caret.line].indexOf('SignificanceToggle = ') + 'SignificanceToggle = '.length
        );

        const edit = await rename(doc, caret, 'Scorched', [], token);
        const edits = Object.values(edit!.changes!).flat();
        expect(edits.some((candidate) => candidate.range.start.character === prepared!.range.start.character)).toBe(
            true
        );
    });

    it('rewrites the declaration and every use when the caret sits on the declaration', async () => {
        const doc = parse(SRC);
        const caret = caretAt(SRC, 'ScorchTog { Type = UIToggle }', 2);
        const edit = await rename(doc, caret, 'Scorched', [], token);
        expect(edit).not.toBeNull();

        const edits = Object.values(edit!.changes!).flat();
        // The declaration plus the part-level field, the bare list element and the inline `Toggle =`.
        expect(edits).toHaveLength(4);
        expect(applyEdits(SRC, edits)).toBe(SRC.split('ScorchTog').join('Scorched'));
    });

    it('rewrites the same set from a bare list element and from an inline toggle group', async () => {
        const expected = SRC.split('ScorchTog').join('Scorched');
        const listElement = caretAt(SRC, 'Toggles = [ScorchTog, PowerTog]', 'Toggles = ['.length + 2);
        const inlineGroup = caretAt(SRC, '{ Toggle = ScorchTog; Invert = true }', '{ Toggle = '.length + 2);

        for (const caret of [listElement, inlineGroup]) {
            const edit = await rename(parse(SRC), caret, 'Scorched', [], token);
            expect(edit).not.toBeNull();
            expect(applyEdits(SRC, Object.values(edit!.changes!).flat())).toBe(expected);
        }
    });

    it('rewrites a component named from a sibling component together with the declaration', async () => {
        const doc = parse(SRC);
        const caret = caretAt(SRC, 'OperationalToggle = IsOperational', 'OperationalToggle = '.length + 2);
        const edit = await rename(doc, caret, 'Running', [], token);
        expect(applyEdits(SRC, Object.values(edit!.changes!).flat())).toBe(SRC.split('IsOperational').join('Running'));
    });

    // The defect behind this file was a disagreement between the two requests rather than one bad
    // branch, so the guarantee is asserted over every token of the part instead of one caret.
    it('never rewrites this file anywhere but at the span the rename box offered', async () => {
        const lines = SRC.split('\n');
        for (let line = 0; line < lines.length; line++) {
            for (const match of lines[line].matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
                const caret = { line, character: match.index + 1 };
                const doc = parse(SRC);
                const prepared = await prepareRename(doc, caret, token);
                if (!prepared) continue;
                const edit = await rename(doc, caret, 'RenamedToken', [], token).catch(() => null);
                const edits = Object.values(edit?.changes ?? {}).flat();
                if (!edits.length) continue;
                const at = `${line}:${match.index} ${match[0]}`;
                expect([at, applyEdits(SRC, edits) !== SRC]).toEqual([at, true]);
                expect([
                    at,
                    edits.some(
                        (candidate) =>
                            candidate.range.start.line === prepared.range.start.line &&
                            candidate.range.start.character === prepared.range.start.character &&
                            candidate.range.end.character === prepared.range.end.character
                    ),
                ]).toEqual([at, true]);
            }
        }
    });

    it('refuses an id slot naming no component of the part instead of rewriting another name', async () => {
        const src = SRC.replace('SignificanceToggle = ScorchTog', 'SignificanceToggle = NoSuchToggle');
        const doc = parse(src);
        const caret = caretAt(src, 'SignificanceToggle = NoSuchToggle', 'SignificanceToggle = '.length + 2);

        const prepared = await prepareRename(doc, caret, token);
        expect(prepared?.placeholder).toBe('NoSuchToggle');
        expect(await refusal(() => rename(doc, caret, 'Scorched', [], token))).toContain('No component named');
    });
});
