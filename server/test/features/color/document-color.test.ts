import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { documentColors, colorPresentations } from '../../../src/features/color/document-color';

const parse = (src: string) => parser(lexer(src), 'file:///c.rules').value;

describe('document colors', () => {
    it('detects a float Rf/Gf/Bf/Af color group and reads its channels', () => {
        const doc = parse('Colors\n[\n\t{\n\t\tRf = 1\n\t\tGf = 0.5\n\t\tBf = 0\n\t\tAf = 0.25\n\t}\n]');
        const colors = documentColors(doc);
        expect(colors).toHaveLength(1);
        expect(colors[0].color).toEqual({ red: 1, green: 0.5, blue: 0, alpha: 0.25 });
    });

    it('defaults alpha to 1 when Af is absent and clamps out-of-range channels', () => {
        const doc = parse('C\n{\n\tRf = 1.96\n\tGf = 1\n\tBf = 1\n}');
        expect(documentColors(doc)[0].color).toEqual({ red: 1, green: 1, blue: 1, alpha: 1 });
    });

    it('detects a byte R/G/B/A color group and normalizes to 0..1', () => {
        const doc = parse('VertexColor\n{\n\tR = 0\n\tG = 255\n\tB = 51\n\tA = 255\n}');
        expect(documentColors(doc)[0].color).toEqual({ red: 0, green: 1, blue: 0.2, alpha: 1 });
    });

    it('ignores groups without a color component trio', () => {
        expect(documentColors(parse('Size\n{\n\tX = 1\n\tY = 2\n}'))).toHaveLength(0);
    });

    it('anchors a named multi-line color group swatch on its identifier, not the lone brace', () => {
        // `_centerColor` on line 0, its `{` on line 1 — the swatch must sit on the name (line 0) so the
        // editor renders the decorator next to the field, not detached on the brace-only line.
        const doc = parse('_centerColor\n{\n\tRf = 1\n\tGf = 0.5\n\tBf = 0\n}');
        const range = documentColors(doc)[0].range;
        expect(range.start.line).toBe(0);
        expect(range.start.character).toBe(0);
    });

    it('anchors an anonymous color group swatch on its opening brace', () => {
        // A colour as a list element has no identifier, so the brace is the only anchor available.
        const doc = parse('Colors\n[\n\t{\n\t\tRf = 1\n\t\tGf = 0.5\n\t\tBf = 0\n\t}\n]');
        const range = documentColors(doc)[0].range;
        expect(range.start.line).toBe(2);
    });

    it('picker rewrites as one contiguous edit whose range equals the color range', () => {
        // A single textEdit with no additionalTextEdits (microsoft/vscode#136965), and its range must
        // equal the ColorInformation range: VS Code feeds the applied edit's range back as the range of
        // the next change, so if they differed only the first change would land.
        const src = 'Colors\n[\n\t{\n\t\tRf = 1\n\t\tGf = 0.5\n\t\tBf = 0\n\t\tAf = 0.25\n\t}\n]';
        const doc = parse(src);
        const info = documentColors(doc)[0];
        const presentations = colorPresentations(doc, src, info.range, { red: 0, green: 0.2, blue: 1, alpha: 1 });
        expect(presentations).toHaveLength(1);
        expect(presentations[0].label).toBe('Rf=0 Gf=0.2 Bf=1 Af=1');
        expect(presentations[0].additionalTextEdits ?? []).toHaveLength(0);
        const edit = presentations[0].textEdit!;
        expect(edit.range).toEqual(info.range);
        // The edit spans the anchor (the anonymous group's `{`, line 2) through the last value (line 6),
        // rewriting only the component values and leaving braces/field names intact.
        expect(edit.newText).toBe('{\n\t\tRf = 0\n\t\tGf = 0.2\n\t\tBf = 1\n\t\tAf = 1');
    });

    it('feeding the applied edit range back still resolves the same color (repeat-change fix)', () => {
        // Simulates VS Code's second change: it passes back the previous edit's range, which shares the
        // color range's start. The provider must still find the group and produce an edit.
        const src = '_c\n{\n\tRf = 1\n\tGf = 0.5\n\tBf = 0\n}';
        const doc = parse(src);
        const first = colorPresentations(doc, src, documentColors(doc)[0].range, { red: 0, green: 0, blue: 0, alpha: 1 });
        const feedback = first[0].textEdit!.range;
        const second = colorPresentations(doc, src, feedback, { red: 1, green: 1, blue: 1, alpha: 1 });
        expect(second).toHaveLength(1);
        expect(second[0].textEdit!.newText).toBe('_c\n{\n\tRf = 1\n\tGf = 1\n\tBf = 1');
    });

    it('byte color picker writes 0..255 integers in a single edit', () => {
        const src = 'VertexColor\n{\n\tR = 0\n\tG = 255\n\tB = 51\n}';
        const doc = parse(src);
        const info = documentColors(doc)[0];
        const p = colorPresentations(doc, src, info.range, { red: 1, green: 0, blue: 0.2, alpha: 1 });
        expect(p[0].additionalTextEdits ?? []).toHaveLength(0);
        expect(p[0].textEdit!.range).toEqual(info.range);
        expect(p[0].textEdit!.newText).toBe('VertexColor\n{\n\tR = 255\n\tG = 0\n\tB = 51');
    });
});
