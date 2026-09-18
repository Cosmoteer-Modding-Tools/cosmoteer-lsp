import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_PASSES } from '../../src/lsp/document-passes';
import { defaultSettings } from '../../src/settings';
import { RULES } from '../../src/features/diagnostics/rule-ids';

// The same list of validation passes is written out in four places: the pass table, the settings
// interface and its defaults, the `package.json` configuration contributions, and the rule table the
// lint reports key their findings on. Nothing made the four agree, so a pass added in one of them
// and forgotten in another shipped as a rule nobody can turn off, a setting nothing reads, or a
// finding that reaches a report under no rule identity at all. These checks fail on any such gap.

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

interface ConfigurationSection {
    properties?: { [key: string]: unknown };
}

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes: { configuration: ConfigurationSection[] };
};

const SETTING_PREFIX = 'cosmoteerLSPRules.diagnostics.';

/** The diagnostics settings the extension contributes, by their bare key. */
const contributedSettings = manifest.contributes.configuration
    .flatMap((section) => Object.keys(section.properties ?? {}))
    .filter((key) => key.startsWith(SETTING_PREFIX))
    .map((key) => key.slice(SETTING_PREFIX.length));

const settingKeys = Object.keys(defaultSettings.diagnostics);
const passSettings = DOCUMENT_PASSES.flatMap((pass) => (pass.setting ? [pass.setting as string] : []));
const passCodes = DOCUMENT_PASSES.map((pass) => pass.code);
const ruleIds = RULES.map((rule) => rule.id);
const ruleSettings = RULES.flatMap((rule) => (rule.setting ? [rule.setting as string] : []));

// Diagnostics settings that gate something other than a row of the pass table. Each one is read
// somewhere else in the server, so it is a live setting rather than a leftover, and the checks below
// would otherwise report it as an orphan.
const NOT_A_PASS_GATE: readonly string[] = [
    // Decides whether the unopened files of the project are validated at all, so it gates the whole
    // workspace scan rather than any single pass.
    'validateWholeWorkspace',
    // Names which files that scan covers. Not a boolean, and not a gate on a pass.
    'workspaceValidationScope',
    // Gates the `.shader` file diagnostics, which are a flow of their own in validate-document.ts
    // and never run as a pass over a `.rules` document.
    'validateShaderCode',
    // Gates the undeclared-dependency finding inside validator.schema-id-reference, which the
    // node-level validator registry runs, so no row of the pass table reads it.
    'validateUndeclaredDependencies',
];

/**
 * The entries of the first list that the second does not carry.
 *
 * @param entries the list to look through.
 * @param known the list the entries must appear in.
 * @returns the missing entries, in the order they were written.
 */
const missingFrom = (entries: readonly string[], known: readonly string[]): string[] =>
    entries.filter((entry) => !known.includes(entry));

describe('the whole-document pass table', () => {
    it('gates every pass on a setting the defaults declare', () => {
        expect(missingFrom(passSettings, settingKeys)).toEqual([]);
    });

    it('gates every pass on a setting package.json contributes', () => {
        expect(missingFrom(passSettings, contributedSettings)).toEqual([]);
    });

    it('stamps every pass with a code the rule table names', () => {
        expect(missingFrom(passCodes, ruleIds)).toEqual([]);
    });

    it('agrees with the rule table about which pass a setting switches off', () => {
        const mismatched = DOCUMENT_PASSES.filter((pass) => {
            const rule = RULES.find((entry) => entry.id === pass.code);
            return rule !== undefined && (rule.setting as string | undefined) !== (pass.setting as string | undefined);
        }).map((pass) => pass.code);
        expect(mismatched).toEqual([]);
    });

    it('agrees with the rule table about which pass needs the game data tree', () => {
        const mismatched = DOCUMENT_PASSES.filter((pass) => {
            const rule = RULES.find((entry) => entry.id === pass.code);
            return rule !== undefined && rule.needsGameData !== (pass.needsGameIndex ?? false);
        }).map((pass) => pass.code);
        expect(mismatched).toEqual([]);
    });
});

describe('the diagnostics settings', () => {
    it('leaves no setting behind that no pass and no exemption reads', () => {
        const orphans = settingKeys.filter((key) => !passSettings.includes(key) && !NOT_A_PASS_GATE.includes(key));
        expect(orphans).toEqual([]);
    });

    it('exempts only settings that still exist', () => {
        expect(missingFrom(NOT_A_PASS_GATE, settingKeys)).toEqual([]);
    });

    it('contributes every declared setting in package.json', () => {
        expect(missingFrom(settingKeys, contributedSettings)).toEqual([]);
    });

    it('declares every contributed setting in the defaults', () => {
        expect(missingFrom(contributedSettings, settingKeys)).toEqual([]);
    });
});

describe('the lint rule table', () => {
    it('names no setting that no pass and no exemption reads', () => {
        const orphans = ruleSettings.filter(
            (setting) => !passSettings.includes(setting) && !NOT_A_PASS_GATE.includes(setting)
        );
        expect(orphans).toEqual([]);
    });

    it('names only settings the defaults declare', () => {
        expect(missingFrom(ruleSettings, settingKeys)).toEqual([]);
    });
});
