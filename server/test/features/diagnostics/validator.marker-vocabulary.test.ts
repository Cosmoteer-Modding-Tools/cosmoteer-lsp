import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    isTypoShape,
    validateMarkerVocabulary,
} from '../../../src/features/diagnostics/validator.marker-vocabulary';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { globalSettings } from '../../../src/settings';

const token = CancellationToken.None;

// A part category exists because a file writes it, so the only thing that separates a misspelling
// from a new category is the rest of the project: the vocabulary the other files agreed on, and
// the shape of the difference.
describe('the shape a slip leaves behind', () => {
    it('accepts a substituted character inside the word', () => {
        expect(isTypoShape('lazer', 'laser')).toBe(true);
    });

    it('accepts two adjacent characters swapped', () => {
        expect(isTypoShape('weapno', 'weapon')).toBe(true);
    });

    it('accepts a letter dropped inside the word', () => {
        expect(isTypoShape('provides_pwer', 'provides_power')).toBe(true);
    });

    it('rejects a trailing character swapped, which is how a variant is named', () => {
        expect(isTypoShape('carrier2', 'carrier3')).toBe(false);
    });

    it('rejects a digit swapped anywhere, which numbers a family of variants', () => {
        expect(isTypoShape('dpm1missile_type', 'dpmmmissile_type')).toBe(false);
    });

    it('rejects a plural, and any other extension of the name', () => {
        expect(isTypoShape('weapons', 'weapon')).toBe(false);
        expect(isTypoShape('armor_heavy', 'armor')).toBe(false);
    });

    it('rejects a digit pushed into the middle of the name', () => {
        expect(isTypoShape('bounty2tag', 'bountytag')).toBe(false);
    });

    it('rejects a doubled letter, which reads as a deliberate prefix', () => {
        expect(isTypoShape('dpmmion_beam', 'dpmion_beam')).toBe(false);
    });

    it('rejects a letter inserted against an underscore, a token boundary', () => {
        expect(isTypoShape('uses_apower', 'uses_power')).toBe(false);
    });

    it('rejects two names that are simply different', () => {
        expect(isTypoShape('shield', 'armor')).toBe(false);
    });
});

describe('a category name nothing else in the project writes', () => {
    let tmpRoot: string;
    let projectDir: string;

    const parse = (source: string) => parser(lexer(source), 'file:///parts/candidate.rules').value;

    const findings = async (source: string): Promise<string[]> =>
        (await validateMarkerVocabulary(parse(source), [projectDir], token)).map((error) => error.message);

    beforeAll(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), 'markervocab-'));
        projectDir = join(tmpRoot, 'Data');
        mkdirSync(projectDir, { recursive: true });
        // Three parts agreeing on a vocabulary, so `weapon` and `is_crewed` are names the project
        // writes rather than names one file invented.
        for (const name of ['cannon', 'laser', 'railgun']) {
            writeFileSync(
                join(projectDir, `${name}.rules`),
                `Part\n{\n\tID = test.${name}\n\tTypeCategories = [weapon, is_crewed]\n}\n`
            );
        }
        globalSettings.cosmoteerPath = projectDir;
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        return service.initialize(projectDir, noop);
    });

    afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

    beforeEach(() => SchemaIdIndex.instance.reset());

    it('is reported when it is one slip from a name the project writes', async () => {
        const messages = await findings('Part\n{\n\tID = test.new\n\tTypeCategories = [waepon]\n}\n');
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("'waepon'");
        expect(messages[0]).toContain("'weapon'");
    });

    it('carries the established name as a quick fix', async () => {
        const [error] = await validateMarkerVocabulary(
            parse('Part\n{\n\tID = test.new\n\tTypeCategories = [waepon]\n}\n'),
            [projectDir],
            token
        );
        expect(error?.severity).toBe('hint');
        expect(error?.data?.quickFix?.newText).toBe('weapon');
    });

    it('is left alone when it is nothing like an established name', async () => {
        expect(await findings('Part\n{\n\tID = test.new\n\tTypeCategories = [tractor_beam]\n}\n')).toEqual([]);
    });

    it('is left alone when it reads as a variant rather than a slip', async () => {
        expect(await findings('Part\n{\n\tID = test.new\n\tTypeCategories = [weapons]\n}\n')).toEqual([]);
    });

    it('is left alone when the project writes it elsewhere too', async () => {
        expect(await findings('Part\n{\n\tID = test.new\n\tTypeCategories = [weapon]\n}\n')).toEqual([]);
    });

    it('is reported once however often the file repeats it', async () => {
        const messages = await findings(
            'Part\n{\n\tID = test.new\n\tTypeCategories = [waepon]\n\tEditorParentCategories = [waepon]\n}\n'
        );
        expect(messages).toHaveLength(1);
    });
});
