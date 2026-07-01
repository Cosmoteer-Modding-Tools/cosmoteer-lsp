import { describe, expect, it } from 'vitest';
import { getDocumentKind, isModRules, isShaderDocument } from '../../src/document/document-kind';

describe('getDocumentKind', () => {
    it('classifies a mod.rules manifest as mod-rules', () => {
        expect(getDocumentKind('file:///c%3A/mods/StarWars/mod.rules')).toBe('mod-rules');
        expect(isModRules('file:///c%3A/mods/StarWars/mod.rules')).toBe(true);
    });

    it('classifies a normal .rules file as rules', () => {
        expect(getDocumentKind('file:///c%3A/mods/StarWars/buffs/buffs.rules')).toBe('rules');
        expect(isModRules('file:///c%3A/mods/StarWars/buffs/buffs.rules')).toBe(false);
    });

    it('does not treat mod-prefixed data files (mod-colors.rules) as the manifest', () => {
        expect(getDocumentKind('file:///c%3A/mods/StarWars/common_effects/mod-colors.rules')).toBe('rules');
    });

    it('treats mod_*.rules variants as manifests', () => {
        expect(getDocumentKind('file:///c%3A/mods/StarWars/mod_career.rules')).toBe('mod-rules');
        expect(getDocumentKind('file:///c%3A/mods/StarWars/sub/mod_super_armor.rules')).toBe('mod-rules');
        expect(isModRules('file:///c%3A/mods/StarWars/mod_career.rules')).toBe(true);
    });

    it('only matches the manifest by basename, not substrings of the path', () => {
        // a folder literally named "mod.rules" must not make a child data file a manifest
        expect(getDocumentKind('file:///c%3A/mods/mod.rules/buffs.rules')).toBe('rules');
        expect(getDocumentKind('file:///c%3A/mods/StarWars/somemod.rules')).toBe('rules');
        expect(getDocumentKind('file:///c%3A/mods/StarWars/mod.rules.bak')).toBe('rules');
    });
});

describe('isShaderDocument', () => {
    it('recognizes a .shader file (case-insensitively)', () => {
        expect(isShaderDocument('file:///c%3A/mods/SW/effects/glow.shader')).toBe(true);
        expect(isShaderDocument('file:///c%3A/mods/SW/effects/GLOW.SHADER')).toBe(true);
    });

    it('does not treat a .rules file or a .shader-named folder as a shader', () => {
        expect(isShaderDocument('file:///c%3A/mods/SW/effects/glow.rules')).toBe(false);
        expect(isShaderDocument('file:///c%3A/mods/SW/glow.shader/child.rules')).toBe(false);
    });
});
