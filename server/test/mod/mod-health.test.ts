import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { aliasRootIndex } from '../../src/document/schema/alias-root';
import { invalidateSchemaContextCache } from '../../src/document/schema/schema-context';
import { ensureAliasRootIndex } from '../../src/features/navigation/alias-root-builder';
import { ReverseIncludeIndex } from '../../src/features/navigation/reverse-include.index';
import { LocalizationKeyIndex } from '../../src/features/completion/localization-key.index';
import { SchemaIdIndex } from '../../src/features/completion/schema-id.index';
import { PART_RULES_CLASS } from '../../src/features/part-editor/part-fields';
import { ActionRootingIndex } from '../../src/mod/action-rooting.index';
import { invalidateDuplicateIdCache } from '../../src/features/diagnostics/validator.duplicate-id';
import { clearModRootCache } from '../../src/mod/mod-root';
import { invalidateModContext } from '../../src/mod/mod-context';
import { generateModOverview } from '../../src/mod/mod-overview';
import { globalSettings } from '../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../workspace-helper';
import { FIXTURES_DIR } from '../helpers';

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'mod-health-mod');
const CLEAN_MOD_DIR = join(FIXTURES_DIR, 'mod-health-clean-mod');

/**
 * Points the workspace at the fixture game tree and rebuilds every index the health rows read, over
 * the folders one block covers.
 *
 * @param folders the project folders to index.
 */
const buildIndexes = async (folders: string[]): Promise<void> => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    clearModRootCache();
    invalidateModContext();
    invalidateDuplicateIdCache();
    aliasRootIndex.invalidate();
    ReverseIncludeIndex.instance.reset();
    SchemaIdIndex.instance.reset();
    ActionRootingIndex.instance.reset();
    LocalizationKeyIndex.instance.reset();
    await ensureAliasRootIndex(token);
    await ReverseIncludeIndex.instance.ensureBuilt(folders, token);
    await SchemaIdIndex.instance.idsForClass(PART_RULES_CLASS, folders, token);
    await ActionRootingIndex.instance.ensureBuilt(folders, token);
    invalidateSchemaContextCache();
};

/** Drops the shared index state, so the next block starts from folders of its own. */
const resetIndexes = (): void => {
    aliasRootIndex.invalidate();
    ReverseIncludeIndex.instance.reset();
    SchemaIdIndex.instance.reset();
    ActionRootingIndex.instance.reset();
    LocalizationKeyIndex.instance.reset();
    invalidateSchemaContextCache();
};

/** The health table's rows, as raw markdown lines. */
const healthRows = (markdown: string): string[] =>
    markdown
        .split('\n')
        .filter((line) => line.startsWith('| ✓ ') || line.startsWith('| ⚠ '));

/** The one health row whose check cell names `check`. */
const rowFor = (markdown: string, check: string): string => {
    const row = healthRows(markdown).find((line) => line.includes(`| ${check} |`) || line.includes(` ${check} |`));
    expect(row, `no health row for ${check}`).toBeDefined();
    return row!;
};

// Every row is a pass that already ships, counted over the files the manifest reaches. The fixture
// mod breaks one thing per row on purpose, so a row that stops firing is a row that stopped reading
// its pass.
describe('mod health rows', () => {
    let markdown: string;

    beforeAll(async () => {
        await buildIndexes([WORKSPACE_DATA_DIR, MOD_DIR]);
        const uri = pathToFileURL(join(MOD_DIR, 'mod.rules')).href;
        markdown = (await generateModOverview(uri, [WORKSPACE_DATA_DIR, MOD_DIR], token))!;
        expect(markdown).toBeDefined();
    });

    afterAll(resetIndexes);

    it('renders the section above the actions it summarizes', () => {
        expect(markdown).toContain('## Mod health');
        expect(markdown.indexOf('## Mod health')).toBeLessThan(markdown.indexOf('## Actions'));
        expect(markdown).toContain('| Check | Finding | Where |');
    });

    it('counts the files the manifest never reaches', () => {
        expect(rowFor(markdown, 'Files the game loads')).toContain('The game never opens the rest');
        expect(rowFor(markdown, 'Files the game loads')).toContain('unreached.rules');
    });

    it('counts an id two files of the mod register', () => {
        expect(rowFor(markdown, 'Ids registered twice')).toContain(
            '2 declarations register an id another file of this mod registers too'
        );
    });

    it('counts a part-grid value the part encloses', () => {
        const row = rowFor(markdown, 'Part grid geometry');
        expect(row).toContain('One part-grid value sits where the part that writes it cannot reach');
        expect(row).toContain('parts/door_part.rules:');
    });

    it('counts a field the game never reads', () => {
        expect(rowFor(markdown, 'Fields the game never reads')).toContain(
            'One field is written that the game never reads'
        );
    });

    it('counts the field set three files repeat and names the command that extracts it', () => {
        const row = rowFor(markdown, 'Repeated field sets');
        expect(row).toContain('repeat a field set other files write word for word');
        expect(row).toContain('Cosmoteer: Extract Shared Base Files');
    });

    it('counts a field that restates a value its base already sets', () => {
        expect(rowFor(markdown, 'Overrides that change nothing')).toContain(
            'restates a value its group already inherits'
        );
    });

    it('names the language that is behind and how far', () => {
        expect(rowFor(markdown, 'Language coverage')).toContain(
            'English declares 2 keys. Missing elsewhere, with the count each language is short:'
        );
        expect(rowFor(markdown, 'Language coverage')).toContain('(1)');
    });

    it('escapes a value carrying a pipe so it cannot shift the row', () => {
        // The German file's `__Name` carries a `|`, which would otherwise open a fourth cell and
        // push the finding under the "Where" heading.
        const row = rowFor(markdown, 'Language coverage');
        expect(row).toContain('Deutsch \\| German');
        expect(row.split(' | ')).toHaveLength(3);
    });

    it('links a place to the line the finding sits on', () => {
        expect(rowFor(markdown, 'Part grid geometry')).toMatch(/\]\(vscode:\/\/file\/[^)]+\.rules:\d+\)/);
    });
});

// A mod with nothing wrong still gets every row it can be asked, each saying so in one clause, and
// no row at all for the check its files cannot answer.
describe('mod health rows with nothing to report', () => {
    let markdown: string;

    beforeAll(async () => {
        await buildIndexes([WORKSPACE_DATA_DIR, CLEAN_MOD_DIR]);
        const uri = pathToFileURL(join(CLEAN_MOD_DIR, 'mod.rules')).href;
        markdown = (await generateModOverview(uri, [WORKSPACE_DATA_DIR, CLEAN_MOD_DIR], token))!;
        expect(markdown).toBeDefined();
    });

    afterAll(resetIndexes);

    it('says a clear check is clear rather than leaving it out', () => {
        expect(rowFor(markdown, 'Part grid geometry')).toContain(
            'Every part-grid value sits inside the part that writes it'
        );
        expect(rowFor(markdown, 'Overrides that change nothing')).toContain(
            'No field restates a value its group already inherits'
        );
        expect(rowFor(markdown, 'Files the game loads')).toContain('The manifest reaches every `.rules` file');
    });

    it('leaves the places of a clear row empty rather than linking a file with nothing wrong in it', () => {
        expect(rowFor(markdown, 'Part grid geometry')).toMatch(/\|\s*$/);
    });

    it('leaves out the language row while the mod ships one language', () => {
        expect(markdown).toContain('## Mod health');
        expect(markdown).not.toContain('Language coverage');
    });
});
