import { describe, expect, it } from 'vitest';
import { classByDiscriminator, fieldOf, registryOf } from '../../../src/document/schema/schema';

// The font, cursor and sound-effect chains extracted/curated 2026-07-12. Fonts and cursors are
// group-only values (their deserializers throw on a scalar), previously mis-modeled as scalar
// assets, which left widgets.rules font definitions and every cursor group dark.
describe('font, cursor and sound-effect schema chains', () => {
    it('models the font definition group and its render passes', () => {
        expect(fieldOf('Halfling.Graphics.Text.Font', 'File')?.valueType.kind).toBe('asset');
        expect(fieldOf('Halfling.Graphics.Text.Font', 'Passes')?.valueType.kind).toBe('list');
        expect(fieldOf('Halfling.Graphics.Text.FontRenderPass', 'Effects')?.valueType.kind).toBe('list');
        // A widget font slot is the group, so `DefaultFont { … }` resolves through WidgetRules.
        expect(fieldOf('Cosmoteer.Gui.WidgetRules', 'DefaultFont')?.valueType).toMatchObject({
            kind: 'group',
            ref: 'Halfling.Graphics.Text.Font',
        });
    });

    it('dispatches the font-effect registry (`Type = Blur/Color/OuterStroke`)', () => {
        expect(registryOf('Halfling.Graphics.Text.IFontEffect')?.typeField).toBe('Type');
        expect(classByDiscriminator('Blur')).toBe('Halfling.Graphics.Text.BlurFontEffect');
        expect(fieldOf('Halfling.Graphics.Text.BlurFontEffect', 'BlurAmount')?.valueType.kind).toBe('float');
        expect(fieldOf('Halfling.Graphics.Text.OuterStrokeFontEffect', 'RelativeThickness')).toBeTruthy();
    });

    it('models the cursor group with its bitmap and OS forms', () => {
        expect(fieldOf('Halfling.Windows.Cursor', 'File')?.valueType).toMatchObject({ kind: 'asset', assetKind: 'image' });
        expect(fieldOf('Halfling.Windows.Cursor', 'HotSpot')?.valueType.kind).toBe('group');
        expect(fieldOf('Halfling.Windows.Cursor', 'Scale')?.valueType.kind).toBe('number');
        expect(fieldOf('Halfling.Windows.Cursor', 'OSCursor')?.valueType.kind).toBe('enum');
        expect(fieldOf('Cosmoteer.Simulation.SimGuiRules', 'FocusModeCursor')?.valueType).toMatchObject({
            kind: 'group',
            ref: 'Halfling.Windows.Cursor',
        });
    });

    it('accepts the sound-effect custom-read keys beside the reflective members', () => {
        expect(fieldOf('Halfling.Audio.ISoundEffect', 'Sound')?.valueType).toMatchObject({ kind: 'asset', assetKind: 'sound' });
        expect(fieldOf('Halfling.Audio.ISoundEffect', 'RandomSounds')?.valueType.kind).toBe('list');
        expect(fieldOf('Halfling.Audio.ISoundEffect', 'Db')?.valueType.kind).toBe('range');
    });
});
