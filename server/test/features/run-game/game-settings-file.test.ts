import { describe, expect, it } from 'vitest';
import {
    enableModInSettings,
    resolveSettingsEntry,
    settingsEntryFor,
} from '../../../src/features/run-game/game-settings-file';

const SETTINGS_DIR = 'C:/Users/x/Saved Games/Cosmoteer/76561198104661155';
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.rules`;
const INSTALL_ROOT = 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer';
const MOD = `${SETTINGS_DIR}/Mods/My Weapons Pack`;

/** The shape the game writes: a GameSettings group with the list among many other members. */
const settings = (enabledMods: string): string =>
    [
        'GameSettings',
        '{',
        '\tLastGameVersion = 0.30.4c',
        '\tLanguage = de',
        ...enabledMods.split('\n'),
        '\tAutoDisableMods = true',
        '\tDeleteFileOnStartup',
        '}',
        'DebugMode = None',
        '',
    ].join('\n');

const enable = (text: string, modFolder = MOD) =>
    enableModInSettings(text, SETTINGS_PATH, INSTALL_ROOT, SETTINGS_DIR, modFolder);

// The game owns this file and rewrites all of it on exit, so the edit is a splice that is checked
// to have changed exactly one token. Everything else about the user's settings must survive.
describe('enabling a mod in settings.rules', () => {
    it('writes the path the game reads back, relative to the settings file', () => {
        expect(settingsEntryFor(SETTINGS_DIR, MOD)).toBe('Mods/My Weapons Pack');
    });

    it('writes an absolute path when the mod is not under the settings folder', () => {
        expect(settingsEntryFor(SETTINGS_DIR, 'D:/dev/MyMod')).toBe('D:/dev/MyMod');
    });

    it('reads an entry the way the game does', () => {
        expect(resolveSettingsEntry(SETTINGS_DIR, INSTALL_ROOT, 'Mods/My Weapons Pack')).toBe(
            MOD.replace(/\//g, process.platform === 'win32' ? '\\' : '/')
        );
        // Only a `./` path is read against the game's working directory.
        expect(resolveSettingsEntry(SETTINGS_DIR, INSTALL_ROOT, './Standard Mods/example_mod')).toContain('Cosmoteer');
    });

    it('appends to a list that already has entries, keeping its indentation', () => {
        const text = settings('\tEnabledMods\n\t[\n\t\t"../../../../../Steam/workshop/3119349707"\n\t]');
        const result = enable(text);
        expect(result.kind).toBe('enabled');
        if (result.kind !== 'enabled') return;
        expect(result.text).toContain('\t\t"../../../../../Steam/workshop/3119349707"\n\t\t"Mods/My Weapons Pack"');
        // Nothing else moved.
        expect(result.text).toContain('\tAutoDisableMods = true');
        expect(result.text).toContain('\tDeleteFileOnStartup');
        expect(result.text).toContain('DebugMode = None');
    });

    it('fills an empty list', () => {
        const text = settings('\tEnabledMods\n\t[\n\t]');
        const result = enable(text);
        expect(result.kind).toBe('enabled');
        if (result.kind !== 'enabled') return;
        expect(result.text).toContain('\tEnabledMods\n\t[\n\t\t"Mods/My Weapons Pack"\n\t]');
    });

    it('fills a list written on one line', () => {
        const text = settings('\tEnabledMods []');
        const result = enable(text);
        expect(result.kind).toBe('enabled');
        if (result.kind !== 'enabled') return;
        expect(result.text).toContain('"Mods/My Weapons Pack"');
    });

    it('gives a bare member a list', () => {
        const text = settings('\tEnabledMods');
        const result = enable(text);
        expect(result.kind).toBe('enabled');
        if (result.kind !== 'enabled') return;
        expect(result.text).toContain('\tEnabledMods\n\t[\n\t\t"Mods/My Weapons Pack"\n\t]');
    });

    it('does nothing when the mod is already enabled, however it is written', () => {
        const relativeForm = settings('\tEnabledMods\n\t[\n\t\t"Mods/My Weapons Pack"\n\t]');
        expect(enable(relativeForm).kind).toBe('already-enabled');
        const absoluteForm = settings(`\tEnabledMods\n\t[\n\t\t"${MOD}"\n\t]`);
        expect(enable(absoluteForm).kind).toBe('already-enabled');
        // Case-folded, since the game compares paths ignoring case on Windows.
        const casedForm = settings('\tEnabledMods\n\t[\n\t\t"mods/my weapons pack"\n\t]');
        expect(enable(casedForm).kind).toBe(process.platform === 'win32' ? 'already-enabled' : 'enabled');
    });

    it('keeps the file line endings', () => {
        const text = settings('\tEnabledMods\n\t[\n\t\t"Mods/Other"\n\t]').replace(/\n/g, '\r\n');
        const result = enable(text);
        expect(result.kind).toBe('enabled');
        if (result.kind !== 'enabled') return;
        expect(result.text).toContain('\r\n\t\t"Mods/My Weapons Pack"');
        expect(result.text).not.toMatch(/[^\r]\n/);
    });

    it('refuses a file that is not the one the game writes', () => {
        expect(enable('Window\n{\n\tWidth = 1920\n}\n')).toEqual({ kind: 'refused', reason: 'no-game-settings' });
        expect(enable(settings('\tAutoDisable = false'))).toEqual({ kind: 'refused', reason: 'no-enabled-mods' });
    });

    it('never writes a backslash or a trailing separator', () => {
        const text = settings('\tEnabledMods\n\t[\n\t]');
        const result = enable(text, 'D:\\dev\\MyMod\\');
        expect(result.kind).toBe('enabled');
        if (result.kind !== 'enabled') return;
        expect(result.text).toContain('"D:/dev/MyMod"');
    });
});
