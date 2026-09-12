import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { documentColors, colorPresentations } from '../../../src/features/color/document-color';

const parse = (src: string) => parser(lexer(src), 'file:///c.rules').value;

describe('document colors', () => {
    it('detects a float Rf/Gf/Bf/Af color group and reads its channels', async () => {
        const doc = parse('Colors\n[\n\t{\n\t\tRf = 1\n\t\tGf = 0.5\n\t\tBf = 0\n\t\tAf = 0.25\n\t}\n]');
        const colors = await documentColors(doc);
        expect(colors).toHaveLength(1);
        expect(colors[0].color).toEqual({ red: 1, green: 0.5, blue: 0, alpha: 0.25 });
    });

    it('defaults alpha to 1 when Af is absent and brings an out-of-range channel into view', async () => {
        const doc = parse('C\n{\n\tRf = 1.96\n\tGf = 1\n\tBf = 1\n}');
        expect((await documentColors(doc))[0].color).toEqual({ red: 1, green: 1, blue: 1, alpha: 1 });
    });

    it('detects a byte R/G/B/A color group and normalizes to 0..1', async () => {
        const doc = parse('VertexColor\n{\n\tR = 0\n\tG = 255\n\tB = 51\n\tA = 255\n}');
        expect((await documentColors(doc))[0].color).toEqual({ red: 0, green: 1, blue: 0.2, alpha: 1 });
    });

    it('ignores groups without a color component trio', async () => {
        expect(await documentColors(parse('Size\n{\n\tX = 1\n\tY = 2\n}'))).toHaveLength(0);
    });

    it('anchors a named multi-line color group swatch on its identifier, not the lone brace', async () => {
        // `_centerColor` on line 0, its `{` on line 1. The swatch must sit on the name (line 0) so the
        // editor renders the decorator next to the field, not detached on the brace-only line.
        const doc = parse('_centerColor\n{\n\tRf = 1\n\tGf = 0.5\n\tBf = 0\n}');
        const range = (await documentColors(doc))[0].range;
        expect(range.start.line).toBe(0);
        expect(range.start.character).toBe(0);
    });

    it('anchors an anonymous color group swatch on its opening brace', async () => {
        // A colour as a list element has no identifier, so the brace is the only anchor available.
        const doc = parse('Colors\n[\n\t{\n\t\tRf = 1\n\t\tGf = 0.5\n\t\tBf = 0\n\t}\n]');
        const range = (await documentColors(doc))[0].range;
        expect(range.start.line).toBe(2);
    });

    it('picker rewrites as one contiguous edit whose range equals the color range', async () => {
        // A single textEdit with no additionalTextEdits (microsoft/vscode#136965), and its range must
        // equal the ColorInformation range: VS Code feeds the applied edit's range back as the range of
        // the next change, so if they differed only the first change would land.
        const src = 'Colors\n[\n\t{\n\t\tRf = 1\n\t\tGf = 0.5\n\t\tBf = 0\n\t\tAf = 0.25\n\t}\n]';
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const presentations = await colorPresentations(doc, src, info.range, { red: 0, green: 0.2, blue: 1, alpha: 1 });
        expect(presentations).toHaveLength(1);
        expect(presentations[0].label).toBe('Rf=0 Gf=0.2 Bf=1 Af=1');
        expect(presentations[0].additionalTextEdits ?? []).toHaveLength(0);
        const edit = presentations[0].textEdit!;
        expect(edit.range).toEqual(info.range);
        // The edit spans the anchor (the anonymous group's `{`, line 2) through the last value (line 6),
        // rewriting only the component values and leaving braces/field names intact.
        expect(edit.newText).toBe('{\n\t\tRf = 0\n\t\tGf = 0.2\n\t\tBf = 1\n\t\tAf = 1');
    });

    it('feeding the applied edit range back still resolves the same color (repeat-change fix)', async () => {
        // Simulates VS Code's second change: it passes back the previous edit's range, which shares the
        // color range's start. The provider must still find the group and produce an edit.
        const src = '_c\n{\n\tRf = 1\n\tGf = 0.5\n\tBf = 0\n}';
        const doc = parse(src);
        const first = await colorPresentations(doc, src, (await documentColors(doc))[0].range, {
            red: 0,
            green: 0,
            blue: 0,
            alpha: 1,
        });
        const feedback = first[0].textEdit!.range;
        const second = await colorPresentations(doc, src, feedback, { red: 1, green: 1, blue: 1, alpha: 1 });
        expect(second).toHaveLength(1);
        expect(second[0].textEdit!.newText).toBe('_c\n{\n\tRf = 1\n\tGf = 1\n\tBf = 1');
    });

    it('byte color picker writes 0..255 integers in a single edit', async () => {
        const src = 'VertexColor\n{\n\tR = 0\n\tG = 255\n\tB = 51\n}';
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { red: 1, green: 0, blue: 0.2, alpha: 1 });
        expect(p[0].additionalTextEdits ?? []).toHaveLength(0);
        expect(p[0].textEdit!.range).toEqual(info.range);
        expect(p[0].textEdit!.newText).toBe('VertexColor\n{\n\tR = 255\n\tG = 0\n\tB = 51');
    });
});

describe('overbright channels', () => {
    // The engine clamps nothing, so `Af = 1.9607843` and `[500, 0, 0]` are deliberate: they drive an
    // additive effect past white. A channel the picker hands back untouched keeps its own bytes.
    it('keeps an overbright alpha literal when the pick leaves the color alone', async () => {
        const src = '{\n\tRf = 1\n\tGf = 1\n\tBf = 1\n\tAf = 1.9607843\n}';
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, info.color);
        expect(p[0].textEdit!.newText).toBe('{\n\tRf = 1\n\tGf = 1\n\tBf = 1\n\tAf = 1.9607843');
    });

    it('keeps the untouched channels and rewrites only the one the pick moved', async () => {
        const src = '{\n\tRf = 1\n\tGf = 1.5686275\n\tBf = 1.9607843\n\tAf = 0.39215687\n}';
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { ...info.color, alpha: 1 });
        expect(p[0].textEdit!.newText).toBe('{\n\tRf = 1\n\tGf = 1.5686275\n\tBf = 1.9607843\n\tAf = 1');
    });

    it('keeps an overbright list entry when the pick leaves it alone', async () => {
        const src = sprite('\t\t\t\tVertexColor = [500, 0, 0]');
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, info.color);
        expect(p[0].textEdit!.newText).toBe('[500, 0, 0');
    });

    it('writes a moved channel as a plain byte even next to an overbright one', async () => {
        const src = sprite('\t\t\t\tVertexColor = [300, 300, 300, 255]');
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { red: 0, green: 1, blue: 1, alpha: 1 });
        expect(p[0].textEdit!.newText).toBe('[0, 300, 300, 255');
    });
});

describe('mixed component forms', () => {
    it('reads the alpha off Af while the channels come from the byte names', async () => {
        const doc = parse('C\n{\n\tR = 231\n\tG = 255\n\tB = 2\n\tAf = 0.49\n}');
        const color = (await documentColors(doc))[0].color;
        expect(color.red).toBeCloseTo(231 / 255, 6);
        expect(color.alpha).toBeCloseTo(0.49, 6);
    });

    it('prefers the byte R over the float Rf, the way the engine reads them', async () => {
        const doc = parse('C\n{\n\tR = 0\n\tRf = 1\n\tG = 0\n\tGf = 1\n\tB = 0\n\tBf = 1\n}');
        expect((await documentColors(doc))[0].color).toEqual({ red: 0, green: 0, blue: 0, alpha: 1 });
    });

    it('picker updates the written alpha component instead of adding a second one', async () => {
        const src = 'C\n{\n\tR = 231\n\tG = 255\n\tB = 2\n\tAf = 0.49\n}';
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { ...info.color, alpha: 0.25 });
        expect(p[0].textEdit!.newText).toBe('C\n{\n\tR = 231\n\tG = 255\n\tB = 2\n\tAf = 0.25');
    });
});

describe('hue/saturation/value groups', () => {
    it('reads an H/S/V group the way Color.FromHSV does', async () => {
        const doc = parse('DefaultBaseColor\n{\n\tH = 120\n\tS = 1\n\tV = 1\n\tA = 255\n}');
        const color = (await documentColors(doc))[0].color;
        expect(color.red).toBeCloseTo(0, 6);
        expect(color.green).toBeCloseTo(1, 6);
        expect(color.blue).toBeCloseTo(0, 6);
        expect(color.alpha).toBe(1);
    });

    it('writes a pick back as hue, saturation and value, keeping the shape', async () => {
        const src = 'DefaultBaseColor\n{\n\tH = 120\n\tS = 1\n\tV = 1\n\tA = 255\n}';
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { red: 0, green: 0, blue: 1, alpha: 1 });
        expect(p[0].textEdit!.newText).toBe('DefaultBaseColor\n{\n\tH = 240\n\tS = 1\n\tV = 1\n\tA = 255');
    });

    it('leaves a numeric lookalike that writes other members alone', async () => {
        expect(await documentColors(parse('Keys\n{\n\tH = 1\n\tS = 2\n\tV = 3\n\tX = 4\n}'))).toHaveLength(0);
    });
});

describe('alpha on three-channel shapes', () => {
    it('adds Af under a multi-line float group when the pick is translucent', async () => {
        const src = 'C\n{\n\tRf = 1\n\tGf = 0\n\tBf = 0\n}';
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { red: 1, green: 0, blue: 0, alpha: 0.25 });
        expect(p[0].textEdit!.newText).toBe('C\n{\n\tRf = 1\n\tGf = 0\n\tBf = 0\n\tAf = 0.25');
        expect(p[0].label).toBe('Rf=1 Gf=0 Bf=0 Af=0.25');
    });

    it('adds A behind a single-line byte group', async () => {
        const src = 'C { R = 255; G = 0; B = 0 }';
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { red: 1, green: 0, blue: 0, alpha: 0.5 });
        expect(p[0].textEdit!.newText).toBe('C { R = 255; G = 0; B = 0; A = 128');
    });

    it('adds a fourth list entry when the pick is translucent', async () => {
        const src = sprite('\t\t\t\tVertexColor = [255, 0, 0]');
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { red: 1, green: 0, blue: 0, alpha: 0.25 });
        expect(p[0].textEdit!.newText).toBe('[255, 0, 0, 64');
        expect(p[0].label).toBe('[255, 0, 0, 64]');
    });

    it('leaves a three-channel shape alone when the pick is opaque', async () => {
        const src = 'C\n{\n\tRf = 1\n\tGf = 0\n\tBf = 0\n}';
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { red: 1, green: 0, blue: 0, alpha: 1 });
        expect(p[0].textEdit!.newText).toBe('C\n{\n\tRf = 1\n\tGf = 0\n\tBf = 0');
    });
});

// The list form the game's own writer emits (`VertexColor = [255, 255, 255, 217]`, channels
// 0-255, alpha optional). Detection is schema-typed through the slot, so it needs a context
// that resolves: a Sprite field on a turret component.
const sprite = (body: string) =>
    `Part\n{\n\tComponents\n\t{\n\t\tT\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\tBlueprintArcSprite\n\t\t\t{\n${body}\n\t\t\t}\n\t\t}\n\t}\n}`;

describe('positional color lists', () => {
    it('detects a Color slot written as a byte list and normalizes to 0..1', async () => {
        const doc = parse(sprite('\t\t\t\tVertexColor = [255, 255, 255, 217]'));
        const colors = await documentColors(doc);
        expect(colors).toHaveLength(1);
        expect(colors[0].color.red).toBe(1);
        expect(colors[0].color.alpha).toBeCloseTo(217 / 255, 5);
    });

    it('defaults alpha to opaque for a 3-element color list', async () => {
        const doc = parse(sprite('\t\t\t\tVertexColor = [255, 0, 0]'));
        expect((await documentColors(doc))[0].color).toEqual({ red: 1, green: 0, blue: 0, alpha: 1 });
    });

    it('gives no swatch to a list whose slot is not a Color', async () => {
        // UVRect is a Rect: four numbers, same shape, different type.
        expect(await documentColors(parse(sprite('\t\t\t\tUVRect = [0, 0, 1, 1]')))).toHaveLength(0);
    });

    it('picker rewrites the list values as bytes in a single edit whose range equals the swatch', async () => {
        const src = sprite('\t\t\t\tVertexColor = [255, 255, 255, 217]');
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { red: 0, green: 0.2, blue: 1, alpha: 1 });
        expect(p).toHaveLength(1);
        expect(p[0].additionalTextEdits ?? []).toHaveLength(0);
        expect(p[0].textEdit!.range).toEqual(info.range);
        expect(p[0].textEdit!.newText).toBe('[0, 51, 255, 255');
        expect(p[0].label).toBe('[0, 51, 255, 255]');
    });
});

describe('named single colors', () => {
    // `Color.ReadContentFrom` reads a single value through `Color.NamedColors`, case-insensitively.
    // Hex is not a colour name in a rules file, only in text markup.
    const roleColor = (value: string) => sprite(`\t\t\t\tVertexColor = ${value}`);

    it('gives a named color in a Color slot a swatch anchored on the field name', async () => {
        const colors = await documentColors(parse(roleColor('Red')));
        expect(colors).toHaveLength(1);
        expect(colors[0].color).toEqual({ red: 1, green: 0, blue: 0, alpha: 1 });
        expect(colors[0].range.start).toEqual({ line: 9, character: 4 });
    });

    it('matches a name whatever its case', async () => {
        expect(await documentColors(parse(roleColor('orange')))).toHaveLength(1);
    });

    it('gives no swatch to a value that names no color', async () => {
        expect(await documentColors(parse(roleColor('ff0000')))).toHaveLength(0);
    });

    it('gives no swatch to a color name written in a slot that is no color', async () => {
        // BlendMode is an enum on the same sprite, so the slot resolves and is not a colour.
        expect(await documentColors(parse(sprite('\t\t\t\tBlendMode = Red')))).toHaveLength(0);
    });

    it('keeps the name as written when the pick lands back on it', async () => {
        const src = roleColor('red');
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, info.color);
        expect(p[0].textEdit!.newText).toBe('VertexColor = red');
    });

    it('writes the name of the color the pick landed on', async () => {
        const src = roleColor('Red');
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { red: 0, green: 0, blue: 1, alpha: 1 });
        expect(p[0].textEdit!.newText).toBe('VertexColor = Blue');
    });

    it('writes the channel list the same slot reads when the pick names no color', async () => {
        const src = roleColor('Red');
        const doc = parse(src);
        const info = (await documentColors(doc))[0];
        const p = await colorPresentations(doc, src, info.range, { red: 1, green: 0.5, blue: 0.25, alpha: 0.5 });
        expect(p[0].textEdit!.newText).toBe('VertexColor = [255, 128, 64, 128]');
    });
});
