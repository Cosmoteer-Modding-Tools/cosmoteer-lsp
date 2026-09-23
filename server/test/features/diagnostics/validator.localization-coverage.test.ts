import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateLocalizationCoverage } from '../../../src/features/diagnostics/validator.localization-coverage';
import { buildFillLanguageKeysEdit } from '../../../src/features/diagnostics/localization-key-insert';
import { LocalizationKeyIndex } from '../../../src/features/completion/localization-key.index';
import { findingSpanOf, ValidationError } from '../../../src/features/diagnostics/validator';

const token = CancellationToken.None;

// The game answers a key the language in play is missing out of English, and renders the key path
// only where English is missing it too, and a placeholder slot a translation dropped takes the
// number the sentence was about off the screen with it. Both are only a mod author's to fix inside
// their own mod, which is the whole scope.
describe('one language of a mod against the languages beside it', () => {
    let modDir: string;
    let stringsDir: string;

    const findings = async (file: string): Promise<ValidationError[]> => {
        const path = join(stringsDir, file);
        const document = parser(lexer(readFileSync(path, 'utf8')), pathToFileURL(path).href).value;
        return validateLocalizationCoverage(document, [modDir], token);
    };

    beforeAll(() => {
        modDir = mkdtempSync(join(tmpdir(), 'l10ncoverage-'));
        writeFileSync(join(modDir, 'mod.rules'), 'ID = test.mod\nName = "t"\nActions [ ]\n');
        stringsDir = join(modDir, 'strings');
        mkdirSync(stringsDir, { recursive: true });
        writeFileSync(
            join(stringsDir, 'en.rules'),
            '__Name = "English"\n\nParts\n{\n\tCannon = "Cannon"\n\tShield = "Shield"\n\tCrewFmt = "{0} of {1} crew"\n}\n'
        );
        writeFileSync(
            join(stringsDir, 'de.rules'),
            '__Name = "Deutsch"\n\nParts\n{\n\tCannon = "Kanone"\n\tCrewFmt = "{0} Mann"\n}\n'
        );
    });

    afterAll(() => rmSync(modDir, { recursive: true, force: true }));

    beforeEach(() => LocalizationKeyIndex.instance.reset());

    it('reports the keys the language is behind on', async () => {
        const [coverage] = await findings('de.rules');
        expect(coverage.severity).toBe('hint');
        expect(coverage.message).toContain('Deutsch');
        expect(coverage.message).toContain('1');
        expect(coverage.additionalInfo).toContain('Parts/Shield');
    });

    it('reports a translation that dropped one of the English placeholders', async () => {
        const placeholder = (await findings('de.rules')).find((error) => error.severity === 'warning');
        expect(placeholder?.message).toContain('{0}');
        expect(placeholder?.message).toContain('{1}');
    });

    it('says nothing about the language every key is written from', async () => {
        expect(await findings('en.rules')).toEqual([]);
    });

    it('fills the missing keys in with the English sentence to translate', async () => {
        const path = join(stringsDir, 'de.rules');
        const edit = await buildFillLanguageKeysEdit(pathToFileURL(path).href, [modDir], token);
        const changes = Object.values(edit?.changes ?? {}).flat();
        expect(changes).toHaveLength(1);
        expect(changes[0].newText).toContain('Shield = "Shield"');
    });
});

describe('a strings file outside a mod', () => {
    let gameDir: string;

    beforeAll(() => {
        gameDir = mkdtempSync(join(tmpdir(), 'l10nvanilla-'));
        const stringsDir = join(gameDir, 'strings');
        mkdirSync(stringsDir, { recursive: true });
        writeFileSync(
            join(stringsDir, 'en.rules'),
            '__Name = "English"\n\nMisc\n{\n\tOkay = "Okay"\n\tBack = "Back"\n}\n'
        );
        writeFileSync(join(stringsDir, 'de.rules'), '__Name = "Deutsch"\n\nMisc\n{\n\tOkay = "Okay"\n}\n');
    });

    afterAll(() => rmSync(gameDir, { recursive: true, force: true }));

    beforeEach(() => LocalizationKeyIndex.instance.reset());

    it('is left alone, since its translations are nobody here to complete', async () => {
        const path = join(gameDir, 'strings', 'de.rules');
        const document = parser(lexer(readFileSync(path, 'utf8')), pathToFileURL(path).href).value;
        expect(await validateLocalizationCoverage(document, [gameDir], token)).toEqual([]);
    });
});

// The game opens `<id>.rules` in a strings folder and reads nothing else there, so a copy the
// author keeps beside the translation is not a language and its keys are nobody's to be short of.
describe('a strings folder holding a backup copy and a readme', () => {
    let modDir: string;
    let stringsDir: string;

    const findings = async (file: string): Promise<ValidationError[]> => {
        const path = join(stringsDir, file);
        const document = parser(lexer(readFileSync(path, 'utf8')), pathToFileURL(path).href).value;
        return validateLocalizationCoverage(document, [modDir], token);
    };

    beforeAll(() => {
        modDir = mkdtempSync(join(tmpdir(), 'l10nbackup-'));
        writeFileSync(join(modDir, 'mod.rules'), 'ID = test.backup\nName = "t"\nActions [ ]\n');
        stringsDir = join(modDir, 'strings');
        mkdirSync(stringsDir, { recursive: true });
        writeFileSync(
            join(stringsDir, 'en.rules'),
            '__Name = "English"\n__DebugOnly = false\n\nParts\n{\n\tCannon = "Cannon"\n\tShield = "Shield"\n}\n'
        );
        writeFileSync(
            join(stringsDir, 'de.rules'),
            '__Name = "Deutsch"\n__DebugOnly = false\n\nParts\n{\n\tCannon = "Kanone"\n}\n'
        );
        writeFileSync(
            join(stringsDir, 'en - Copy.rules'),
            'Parts\n{\n\tCannon = "Cannon"\n\tRetired = "Retired"\n}\n'
        );
        writeFileSync(join(stringsDir, 'README.rules'), 'Note = "how to translate this mod"\n');
    });

    afterAll(() => rmSync(modDir, { recursive: true, force: true }));

    beforeEach(() => LocalizationKeyIndex.instance.reset());

    it('measures a language against the languages the game would load, and nothing else', async () => {
        const [coverage] = await findings('de.rules');
        expect(coverage.additionalInfo).toContain('Parts/Shield');
        expect(coverage.additionalInfo).not.toContain('Parts/Retired');
        expect(coverage.message).toContain('1');
    });

    it('says nothing about the copy or the readme beside them', async () => {
        expect(await findings('en - Copy.rules')).toEqual([]);
        expect(await findings('README.rules')).toEqual([]);
    });

    it('offers no fill for a file the game loads under no language', async () => {
        const path = join(stringsDir, 'en - Copy.rules');
        expect(await buildFillLanguageKeysEdit(pathToFileURL(path).href, [modDir], token)).toBeNull();
    });
});

// A mod's `en.rules` is merged over the base game's, so every key it leaves out is still answered
// from there. Judging it against a full copy of that table is how a complete file came to be told
// it was thousands of keys short.
describe('a mod language sitting on the one the game ships', () => {
    let gameDir: string;
    let modDir: string;
    let stringsDir: string;

    beforeAll(() => {
        gameDir = mkdtempSync(join(tmpdir(), 'l10ngame-'));
        const gameStrings = join(gameDir, 'strings');
        mkdirSync(gameStrings, { recursive: true });
        writeFileSync(
            join(gameStrings, 'en.rules'),
            '__Name = "English"\n__DebugOnly = false\n\nMisc\n{\n\tOkay = "Okay"\n\tBack = "Back"\n}\n'
        );

        modDir = mkdtempSync(join(tmpdir(), 'l10ninherit-'));
        writeFileSync(join(modDir, 'mod.rules'), 'ID = test.inherit\nName = "t"\nActions [ ]\n');
        stringsDir = join(modDir, 'strings');
        mkdirSync(stringsDir, { recursive: true });
        writeFileSync(join(stringsDir, 'en.rules'), 'Parts\n{\n\tCannon = "Cannon"\n}\n');
        writeFileSync(
            join(stringsDir, 'de.rules'),
            'Misc\n{\n\tOkay = "Ok"\n\tBack = "Zurück"\n}\nParts\n{\n\tCannon = "Kanone"\n}\n'
        );
    });

    afterAll(() => {
        rmSync(gameDir, { recursive: true, force: true });
        rmSync(modDir, { recursive: true, force: true });
    });

    beforeEach(() => LocalizationKeyIndex.instance.reset());

    it('counts what the base game already renders for that language as declared', async () => {
        const path = join(stringsDir, 'en.rules');
        const document = parser(lexer(readFileSync(path, 'utf8')), pathToFileURL(path).href).value;
        expect(await validateLocalizationCoverage(document, [modDir, gameDir], token)).toEqual([]);
        // The negative control: without the game's own file in reach, the same two keys are named.
        LocalizationKeyIndex.instance.reset();
        const [alone] = await validateLocalizationCoverage(document, [modDir], token);
        expect(alone.additionalInfo).toContain('Misc/Okay');
    });

    it('has nothing to fill into it', async () => {
        const path = join(stringsDir, 'en.rules');
        expect(await buildFillLanguageKeysEdit(pathToFileURL(path).href, [modDir, gameDir], token)).toBeNull();
    });
});

// The index keeps a string's escapes as the file wrote them, because the game unescapes them only
// when it renders the text. Escaping them a second time reaches the player as a backslash.
describe('filling a language with keys whose text carries escapes', () => {
    let modDir: string;
    let stringsDir: string;

    beforeAll(() => {
        modDir = mkdtempSync(join(tmpdir(), 'l10nescape-'));
        writeFileSync(join(modDir, 'mod.rules'), 'ID = test.escape\nName = "t"\nActions [ ]\n');
        stringsDir = join(modDir, 'strings');
        mkdirSync(stringsDir, { recursive: true });
        writeFileSync(
            join(stringsDir, 'en.rules'),
            `__Name = "English"\n__DebugOnly = false\n\n${String.raw`Warn = "back\\slash quote\" break\nend"`}\nOkay = "Okay"\n`
        );
        writeFileSync(join(stringsDir, 'de.rules'), '__Name = "Deutsch"\n__DebugOnly = false\n\nOkay = "Ok"\n');
    });

    afterAll(() => rmSync(modDir, { recursive: true, force: true }));

    beforeEach(() => LocalizationKeyIndex.instance.reset());

    it('writes the value with the escapes the source line carries', async () => {
        const path = join(stringsDir, 'de.rules');
        const edit = await buildFillLanguageKeysEdit(pathToFileURL(path).href, [modDir], token);
        const changes = Object.values(edit?.changes ?? {}).flat();
        expect(changes).toHaveLength(1);
        expect(changes[0].newText).toContain(String.raw`Warn = "back\\slash quote\" break\nend"`);
    });
});

// The whole-file finding has to land on a node the editor can underline. A strings file is free to
// declare no `__Name`, and then it opens with an ordinary key, which is an assignment: the one node
// the parser gives no span of its own. Publishing a finding anchored on one used to end the whole
// workspace pass with a TypeError.
describe('a language file that declares no __Name', () => {
    let modDir: string;
    let stringsDir: string;

    beforeAll(() => {
        modDir = mkdtempSync(join(tmpdir(), 'l10nanchor-'));
        writeFileSync(join(modDir, 'mod.rules'), 'ID = test.anchor\nName = "t"\nActions [ ]\n');
        stringsDir = join(modDir, 'strings');
        mkdirSync(stringsDir, { recursive: true });
        writeFileSync(join(stringsDir, 'en.rules'), 'Greeting = "Hello"\nFarewell = "Bye"\n');
        writeFileSync(join(stringsDir, 'de.rules'), 'Greeting = "Hallo"\n');
    });

    afterAll(() => rmSync(modDir, { recursive: true, force: true }));

    beforeEach(() => LocalizationKeyIndex.instance.reset());

    it('anchors the finding on the first key rather than on the member itself', async () => {
        const path = join(stringsDir, 'de.rules');
        const document = parser(lexer(readFileSync(path, 'utf8')), pathToFileURL(path).href).value;
        const [coverage] = await validateLocalizationCoverage(document, [modDir], token);
        expect(coverage).toBeDefined();
        expect(coverage.node.type).toBe('Identifier');
        expect(coverage.node.position).toBeDefined();
        expect(findingSpanOf(coverage)).not.toBeNull();
    });
});

// `Strings.GetText` asks the language in play first and the loaded English files second, so what a
// missing key costs depends on which file is short of it.
describe('what the hint says a missing key costs the reader', () => {
    let modDir: string;
    let stringsDir: string;

    const hintFor = async (file: string): Promise<string> => {
        const path = join(stringsDir, file);
        const document = parser(lexer(readFileSync(path, 'utf8')), pathToFileURL(path).href).value;
        const findings = await validateLocalizationCoverage(document, [modDir], token);
        return findings.find((error) => error.severity === 'hint')?.message ?? '';
    };

    beforeAll(() => {
        modDir = mkdtempSync(join(tmpdir(), 'l10nfallback-'));
        writeFileSync(join(modDir, 'mod.rules'), 'ID = test.mod\nName = "t"\nActions [ ]\n');
        stringsDir = join(modDir, 'strings');
        mkdirSync(stringsDir, { recursive: true });
        writeFileSync(join(stringsDir, 'en.rules'), '__Name = "English"\n\nParts { Cannon = "Cannon" }\n');
        writeFileSync(
            join(stringsDir, 'de.rules'),
            '__Name = "Deutsch"\n\nParts { Cannon = "Kanone"\nShield = "Schild" }\n'
        );
        writeFileSync(
            join(stringsDir, 'fr.rules'),
            '__Name = "Français"\n\nParts { Cannon = "Canon"\nShield = "Bouclier"\nLore = "Histoire" }\n'
        );
    });

    afterAll(() => rmSync(modDir, { recursive: true, force: true }));

    beforeEach(() => LocalizationKeyIndex.instance.reset());

    it('tells a translation its missing keys come out in English', async () => {
        const hint = await hintFor('de.rules');
        expect(hint).toContain('Deutsch');
        expect(hint).toContain('English text');
        expect(hint).not.toContain('Nothing falls back');
    });

    it('tells the English file there is nothing behind it', async () => {
        const hint = await hintFor('en.rules');
        expect(hint).toContain('English');
        expect(hint).toContain('Nothing falls back');
        expect(hint).toContain('key path');
    });
});

// `Strings.GetAvailableLanguages` reads the first two lines of every `.rules` in a strings folder
// and lists the language only when line 1 opens with `__Name` and line 2 with `__DebugOnly`.
describe('a language file the picker will never list', () => {
    let gameDir: string;
    let modDir: string;
    let stringsDir: string;

    const findings = async (file: string): Promise<ValidationError[]> => {
        const path = join(stringsDir, file);
        const document = parser(lexer(readFileSync(path, 'utf8')), pathToFileURL(path).href).value;
        return validateLocalizationCoverage(document, [gameDir, modDir], token);
    };

    beforeAll(() => {
        gameDir = mkdtempSync(join(tmpdir(), 'l10ngamestrings-'));
        mkdirSync(join(gameDir, 'strings'), { recursive: true });
        writeFileSync(
            join(gameDir, 'strings', 'en.rules'),
            '__Name = "English"\n__DebugOnly = false\n\nMisc { Okay = "Okay" }\n'
        );
        modDir = mkdtempSync(join(tmpdir(), 'l10nheader-'));
        writeFileSync(join(modDir, 'mod.rules'), 'ID = test.mod\nName = "t"\nActions [ ]\n');
        stringsDir = join(modDir, 'strings');
        mkdirSync(stringsDir, { recursive: true });
        // English is a language the game already lists, so the mod's own file needs no header.
        writeFileSync(join(stringsDir, 'en.rules'), 'Parts { Cannon = "Cannon" }\n');
        writeFileSync(join(stringsDir, 'it.rules'), 'Parts { Cannon = "Cannone" }\n');
        writeFileSync(
            join(stringsDir, 'tr.rules'),
            '// My translation, started 2026\n__Name = "Türkçe"\n__DebugOnly = false\nParts { Cannon = "Top" }\n'
        );
        writeFileSync(
            join(stringsDir, 'ja.rules'),
            '__Name = "日本語"\n__DebugOnly = false\nParts { Cannon = "大砲" }\n'
        );
        writeFileSync(join(stringsDir, 'README.rules'), 'Note = "how to translate this mod"\n');
    });

    afterAll(() => {
        rmSync(modDir, { recursive: true, force: true });
        rmSync(gameDir, { recursive: true, force: true });
    });

    beforeEach(() => LocalizationKeyIndex.instance.reset());

    it('reports a translation no strings file declares the language of', async () => {
        const offered = (await findings('it.rules')).filter((error) => error.severity === 'warning');
        expect(offered).toHaveLength(1);
        expect(offered[0].message).toContain('"it"');
    });

    it('reports a header a comment pushed off the first line', async () => {
        const offered = (await findings('tr.rules')).filter((error) => error.severity === 'warning');
        expect(offered).toHaveLength(1);
        expect(offered[0].message).toContain('"tr"');
    });

    it('says nothing about a file that carries the header, or one overriding a language the game ships', async () => {
        expect((await findings('ja.rules')).filter((error) => error.severity === 'warning')).toEqual([]);
        expect((await findings('en.rules')).filter((error) => error.severity === 'warning')).toEqual([]);
    });

    it('says nothing when the game’s own strings are not in the index to judge against', async () => {
        const path = join(stringsDir, 'it.rules');
        const document = parser(lexer(readFileSync(path, 'utf8')), pathToFileURL(path).href).value;
        const offered = await validateLocalizationCoverage(document, [modDir], token);
        expect(offered.filter((error) => error.severity === 'warning')).toEqual([]);
    });

    it('says nothing about a note whose name is no language id', async () => {
        expect(await findings('README.rules')).toEqual([]);
    });
});
