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

// The game renders the key path itself when the language in play does not declare the key, and a
// placeholder slot a translation dropped takes the number the sentence was about off the screen
// with it. Both are only a mod author's to fix inside their own mod, which is the whole scope.
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
        writeFileSync(join(stringsDir, 'en.rules'), '__Name = "English"\n\nMisc\n{\n\tOkay = "Okay"\n\tBack = "Back"\n}\n');
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
