import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { defaultSettings, mergeSettings } from '../src/settings';

// A setting reaches the server through the client's answer to `workspace/configuration`, so a key one
// client never sends arrives as `undefined` and reads as "off" at every truthiness gate. That is how
// `validateUnreceivableBuffs` was live in VS Code and dead in JetBrains. Two things keep it closed:
// the merge below, which fills an omitted key with its default, and the parity checks, which make a
// key that only one of the three declaration sites knows about fail here rather than in the field.
const ROOT = join(__dirname, '..', '..');

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
};

const kotlinSettings = readFileSync(
    join(ROOT, 'jetbrains', 'src', 'main', 'kotlin', 'cosmoteer', 'settings', 'CosmoteerSettings.kt'),
    'utf8'
);

const contributedDiagnostics = Object.keys(packageJson.contributes.configuration.properties)
    .filter((key) => key.startsWith('cosmoteerLSPRules.diagnostics.'))
    .map((key) => key.slice('cosmoteerLSPRules.diagnostics.'.length))
    .sort();

/**
 * The diagnostics keys the JetBrains bridge really sends, read out of the map it builds for
 * `workspace/configuration`.
 *
 * @returns the key names, sorted.
 */
const jetbrainsDiagnostics = (): string[] => {
    const block = /"diagnostics" to mapOf\(([\s\S]*?)\n\s*\),/.exec(kotlinSettings);
    expect(block, 'the diagnostics map in CosmoteerSettings.kt').toBeTruthy();
    return [...block![1].matchAll(/"([A-Za-z]+)" to /g)].map((match) => match[1]).sort();
};

describe('settings parity across the clients', () => {
    it('declares every contributed diagnostics setting in the server defaults', () => {
        expect(Object.keys(defaultSettings.diagnostics).sort()).toEqual(contributedDiagnostics);
    });

    it('sends every contributed diagnostics setting from the JetBrains client', () => {
        expect(jetbrainsDiagnostics()).toEqual(contributedDiagnostics);
    });

    it('agrees with package.json on every default', () => {
        const mismatched: string[] = [];
        for (const [key, contributed] of Object.entries(packageJson.contributes.configuration.properties)) {
            const path = key.replace('cosmoteerLSPRules.', '').split('.');
            let value: unknown = defaultSettings;
            for (const segment of path) value = (value as Record<string, unknown>)?.[segment];
            // `associateShaderFiles` is a VS Code client setting, the server never reads it.
            if (value === undefined) continue;
            if (JSON.stringify(value) !== JSON.stringify(contributed.default)) {
                mismatched.push(`${key}: server ${JSON.stringify(value)} vs package.json ${JSON.stringify(contributed.default)}`);
            }
        }
        expect(mismatched).toEqual([]);
    });
});

describe('mergeSettings', () => {
    it('fills a key the client left out with its default', () => {
        const merged = mergeSettings({ diagnostics: { validateWholeWorkspace: false } });
        expect(merged.diagnostics.validateWholeWorkspace).toBe(false);
        expect(merged.diagnostics.validateUnreceivableBuffs).toBe(defaultSettings.diagnostics.validateUnreceivableBuffs);
        expect(merged.maxNumberOfProblems).toBe(defaultSettings.maxNumberOfProblems);
    });

    it('keeps an explicit false rather than treating it as absent', () => {
        expect(mergeSettings({ diagnostics: { validateRequiredFields: false } }).diagnostics.validateRequiredFields).toBe(
            false
        );
    });

    it('replaces a list instead of merging it', () => {
        expect(mergeSettings({ ignorePaths: ['docs'] }).ignorePaths).toEqual(['docs']);
    });

    it('answers the defaults when the client answered nothing', () => {
        expect(mergeSettings(undefined)).toEqual(defaultSettings);
        expect(mergeSettings(null)).toEqual(defaultSettings);
    });
});
