import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, InlayHint, Range } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { InlayHintService } from '../../../src/features/inlay/inlay-hint.service';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { globalSettings } from '../../../src/settings';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;
const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///t.rules').value;

const hintsFor = async (src: string): Promise<InlayHint[]> => {
    const doc = parse(src + '\n');
    return InlayHintService.instance.getInlayHints(doc, Range.create(0, 0, 50, 0), token);
};

const labels = (hints: InlayHint[]): string[] => hints.map((h) => (typeof h.label === 'string' ? h.label : ''));

// A reference to a group in the game's ModifiableValue shape (`Arc { BaseValue = 160d }`) shows
// the group's BaseValue as an inlay hint, since that is the number the reference supplies.
describe('inlay hints for referenced BaseValue groups', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    afterEach(() => {
        globalSettings.inlayHints.showBaseValue = true;
        globalSettings.inlayHints.showTargetValue = true;
    });

    it('annotates a reference to a group carrying a BaseValue', async () => {
        const src = ['ArcShield', '{', '\tArc', '\t{', '\t\tBaseValue = 160d', '\t}', '}', 'Ref = &ArcShield/Arc'].join(
            '\n'
        );
        // The `160d` literal keeps its own radians hint; the reference gets the new BaseValue one.
        expect(labels(await hintsFor(src))).toEqual(['= 2.792527 rad (160°)', '/BaseValue = 160d']);
    });

    it('shows a plain numeric BaseValue as written', async () => {
        const src = ['Shield', '{', '\tBaseValue = 1200', '}', 'Ref = &Shield'].join('\n');
        expect(labels(await hintsFor(src))).toEqual(['/BaseValue = 1200']);
    });

    it('evaluates a computed BaseValue to its number', async () => {
        const src = ['Shield', '{', '\tBaseValue = 2 * 300', '}', 'Ref = &Shield'].join('\n');
        const hints = labels(await hintsFor(src));
        // The math assignment itself also gets its own `= 600` hint.
        expect(hints).toContain('/BaseValue = 600');
    });

    it('finds a BaseValue supplied by an inherited base group', async () => {
        const src = ['BaseArc', '{', '\tBaseValue = 90d', '}', 'Arc : BaseArc', '{', '}', 'Ref = &Arc'].join('\n');
        expect(labels(await hintsFor(src))).toEqual(['= 1.570796 rad (90°)', '/BaseValue = 90d']);
    });

    it('previews a group without a BaseValue by its own fields', async () => {
        const src = ['Shield', '{', '\tRadius = 13', '}', 'Ref = &Shield'].join('\n');
        expect(labels(await hintsFor(src))).toEqual(['= {Radius = 13}']);
    });

    it('previews a list target by its entries', async () => {
        const src = ['Rect', '[', '\t0, 1, 2, 1', ']', 'Ref = &Rect'].join('\n');
        expect(labels(await hintsFor(src))).toEqual(['= [0, 1, 2, 1]']);
    });

    it('previews a written value a reference stands for', async () => {
        const src = ['ICON = ui/icon.png', 'Ref = &ICON'].join('\n');
        expect(labels(await hintsFor(src))).toEqual(['= ui/icon.png']);
    });

    it('keeps the numeric hint for a reference that resolves to a number', async () => {
        const src = ['Damage = 50', 'Ref = &Damage'].join('\n');
        expect(labels(await hintsFor(src))).toEqual(['= 50']);
    });

    it('emits nothing when the BaseValue setting is off', async () => {
        // The shape decides which hint belongs on the line, so turning this one off clears the slot
        // rather than handing it to the generic preview.
        globalSettings.inlayHints.showBaseValue = false;
        const src = ['Shield', '{', '\tBaseValue = 1200', '}', 'Ref = &Shield'].join('\n');
        expect(await hintsFor(src)).toHaveLength(0);
    });

    it('keeps the closing bracket on a preview it has to cut', async () => {
        // The label sits inside the line of code, so a long list is cut. Cutting the bracket off with
        // it would leave the reader looking at a line that reads as unfinished rather than shortened.
        const entries = Array.from({ length: 40 }, (_, index) => index).join(', ');
        const src = ['Rect', '[', entries, ']', 'Ref = &Rect'].join('\n');
        const label = labels(await hintsFor(src))[0];
        expect(label.endsWith('…]')).toBe(true);
    });

    it('emits no preview when the target-value setting is off', async () => {
        globalSettings.inlayHints.showTargetValue = false;
        const src = ['Shield', '{', '\tRadius = 13', '}', 'Ref = &Shield'].join('\n');
        expect(await hintsFor(src)).toHaveLength(0);
    });
});
