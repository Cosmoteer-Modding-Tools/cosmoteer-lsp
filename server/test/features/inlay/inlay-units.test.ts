import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, InlayHint, Range } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { InlayHintService } from '../../../src/features/inlay/inlay-hint.service';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///t.rules').value;

const hintsFor = async (src: string): Promise<InlayHint[]> => {
    const doc = parse(src + '\n');
    return InlayHintService.instance.getInlayHints(doc, Range.create(0, 0, 50, 0), token);
};

const labels = (hints: InlayHint[]): string[] => hints.map((h) => (typeof h.label === 'string' ? h.label : ''));

// The evaluator returns the number the game stores, which for a `d`/`r`/`%` literal is not the number
// the author wrote. The hint names the unit so the conversion stops reading as a wrong answer.
describe('inlay hints carry the unit of the value', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('labels a degrees literal with the radians the game stores', async () => {
        expect(labels(await hintsFor('Rotation = -2.5d'))).toEqual(['= -0.043633 rad (-2.5°)']);
    });

    it('labels a radians literal with the degrees it is', async () => {
        expect(labels(await hintsFor('Rotation = 2.5r'))).toEqual(['= 2.5 rad (143.239449°)']);
    });

    it('carries the unit through arithmetic', async () => {
        expect(labels(await hintsFor('Arc = 180d / 2'))).toEqual(['= 1.570796 rad (90°)']);
    });

    it('labels each angle entry of a list', async () => {
        expect(labels(await hintsFor('Arc = [22.5d, 360d]'))).toEqual([
            '= 0.392699 rad (22.5°)',
            '= 6.283185 rad (360°)',
        ]);
    });

    it('does not label the result of a function call that changes the unit', async () => {
        // A sine takes an angle and answers a ratio, so the operand's radians say nothing about it.
        expect(labels(await hintsFor('X = sin(90d)'))).toEqual(['= 1']);
    });

    it('does not label across an operator that does not preserve the unit', async () => {
        expect(labels(await hintsFor('X = 90d ^ 2'))).toEqual(['= 2.467401']);
    });

    it('leaves a plain number alone', async () => {
        expect(labels(await hintsFor('Health = 5'))).toEqual([]);
    });
});

// The declared type knows the unit even when nothing in the line carries a suffix. An `Angle` holds a
// radians float and its ObjectText constructor parses the written text straight into it, so a value
// written without a `d` is radians, which is what makes the huge degree figure worth showing.
describe('inlay hints take the unit from the declared field type', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('labels an unsuffixed angle field as the radians the game stores', async () => {
        const src = ['Effect', '{', '\tType = Beam', '\tMaxRotationSmoothDelta = 110 * 2', '}'].join('\n');
        expect(labels(await hintsFor(src))).toEqual(['= 220 rad (12605.071493°)']);
    });

    it('labels a modifiable time field in seconds', async () => {
        const src = ['Effect', '{', '\tType = ScreenShake', '\tDuration = 1 * 3', '}'].join('\n');
        expect(labels(await hintsFor(src))).toEqual(['= 3 s']);
    });

    it('leaves an untyped document on the written suffix alone', async () => {
        expect(labels(await hintsFor('Foo = 5 * 2'))).toEqual(['= 10']);
    });
});
