import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../src/settings';
import { GAME_DATA_RULES, RULES, ruleById, ruleIdFor, UNTAGGED_RULE_ID } from '../../src/cli/rule-ids';

// A rule id becomes a public contract the moment a report is uploaded to a code scanning service,
// which keys its alerts on it. These tests pin the set, so an id cannot drift by accident.

/** The diagnostics settings that switch one validation pass on or off. */
const passSettingKeys = Object.entries(defaultSettings.diagnostics)
    .filter(([key, value]) => typeof value === 'boolean' && key !== 'validateWholeWorkspace')
    .map(([key]) => key)
    .sort();

describe('the rule table', () => {
    it('has no duplicate ids', () => {
        const ids = RULES.map((rule) => rule.id);
        expect(ids.length).toBe(new Set(ids).size);
    });

    it('gives every rule a title and a description that says what it reports', () => {
        for (const rule of RULES) {
            expect(rule.title.length, rule.id).toBeGreaterThan(0);
            expect(rule.description.length, rule.id).toBeGreaterThan(20);
            expect(rule.description.endsWith('.'), rule.id).toBe(true);
        }
    });

    it('names the setting of every rule that has one as its own id', () => {
        for (const rule of RULES) {
            if (!rule.setting) continue;
            expect(rule.id, 'a gated rule is identified by the setting that gates it').toBe(rule.setting);
        }
    });

    it('carries one rule for every diagnostics setting the server has', () => {
        const settingsWithRules = RULES.filter((rule) => rule.setting).map((rule) => rule.setting!);
        expect(
            passSettingKeys.filter((key) => !settingsWithRules.includes(key as never)),
            'a diagnostics setting without a rule leaves its findings reported under no name. Add an entry to server/src/cli/rule-ids.ts.'
        ).toEqual([]);
    });

    it('marks only the passes that need the game index as needing it', () => {
        expect(GAME_DATA_RULES.map((rule) => rule.id)).toEqual([
            'validateComponentReferences',
            'validateCrossFileReferences',
            'validateUndeclaredDependencies',
            'validateLocalizationKeys',
            'validateRenderLayers',
            'validateDuplicateIds',
            'validateUnreceivableBuffs',
        ]);
    });

    it('carries the fixed ids of the passes no setting can turn off', () => {
        const ungated = RULES.filter((rule) => !rule.setting && rule.id !== UNTAGGED_RULE_ID).map((rule) => rule.id);
        expect(ungated).toEqual([
            'parse-error',
            'syntax-and-references',
            'document-duplicate',
            'inheritance-cycle',
            'anonymous-block',
            'schema',
            'missing-separator',
            'unbracketed-value-list',
            'orphan-comment-terminator',
            'unterminated-comment',
            'mod-action',
            'manifest-version',
        ]);
    });
});

describe('resolving a rule from a diagnostic', () => {
    it('finds the rule a code names', () => {
        expect(ruleById('validateDefaultValues')?.title).toBe('Default values');
        expect(ruleIdFor('validateDefaultValues')).toBe('validateDefaultValues');
    });

    it('falls back for a code no rule carries, and for a diagnostic that carries none', () => {
        expect(ruleIdFor(undefined)).toBe(UNTAGGED_RULE_ID);
        expect(ruleIdFor('somethingElse')).toBe(UNTAGGED_RULE_ID);
        expect(ruleIdFor(42)).toBe(UNTAGGED_RULE_ID);
    });

    it('has a rule for the fallback itself, so every report can describe it', () => {
        expect(ruleById(UNTAGGED_RULE_ID)).toBeDefined();
    });
});
