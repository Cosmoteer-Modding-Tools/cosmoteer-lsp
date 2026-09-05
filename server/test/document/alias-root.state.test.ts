import { afterEach, describe, expect, it } from 'vitest';
import { aliasRootIndex, AliasRootState } from '../../src/document/schema/alias-root';

// The alias-root index as plain data: what a start loads instead of walking the game root's
// aliases again. The saved form has to answer every question the walked form answers.

const state: AliasRootState = {
    files: [
        [
            'c:/game/data/parts/base_part.rules',
            [
                ['', { kind: 'group', ref: 'Cosmoteer.Ships.Parts.PartRules', name: 'PartRules' }],
                ['tooltips', { kind: 'list', element: { kind: 'group', ref: 'Cosmoteer.Gui.TooltipRules', name: 'TooltipRules' } }],
            ],
        ],
        [
            'c:/game/data/gui/indicators.rules',
            [['', { kind: 'map', key: { kind: 'string' }, value: { kind: 'group', ref: 'Cosmoteer.Gui.IndicatorRules', name: 'IndicatorRules' } }]],
        ],
    ],
    macros: [['common_effects', 'c:/game/data/common_effects.rules', 'C:\\game\\data\\common_effects.rules']],
};

describe('alias-root index state', () => {
    afterEach(() => aliasRootIndex.invalidate());

    it('answers from a loaded state exactly as it saves it back', () => {
        expect(aliasRootIndex.loadState(state)).toBe(true);
        expect(aliasRootIndex.isReady()).toBe(true);
        expect(aliasRootIndex.rootType('file:///c%3A/game/data/parts/base_part.rules')?.kind).toBe('group');
        expect(aliasRootIndex.memberType('c:/game/data/parts/base_part.rules', 'Tooltips')?.kind).toBe('list');
        expect(aliasRootIndex.urisRootedAsMapOf('Cosmoteer.Gui.IndicatorRules')).toEqual(['c:/game/data/gui/indicators.rules']);
        expect(aliasRootIndex.macroAliasTarget('COMMON_EFFECTS')).toBe('c:/game/data/common_effects.rules');
        expect(aliasRootIndex.macroAliasFsPath('common_effects')).toBe('C:\\game\\data\\common_effects.rules');
        expect(JSON.parse(JSON.stringify(aliasRootIndex.saveState()))).toEqual(state);
    });

    it('refuses a state of another shape and stays unbuilt', () => {
        expect(aliasRootIndex.loadState({ files: 'nope', macros: [] })).toBe(false);
        expect(aliasRootIndex.loadState({ files: [], macros: [['a', 'b']] })).toBe(false);
        expect(aliasRootIndex.isReady()).toBe(false);
    });
});
