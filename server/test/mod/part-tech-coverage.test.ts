import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { aliasRootIndex } from '../../src/document/schema/alias-root';
import { invalidateSchemaContextCache } from '../../src/document/schema/schema-context';
import { ensureAliasRootIndex } from '../../src/features/navigation/alias-root-builder';
import { ReverseIncludeIndex } from '../../src/features/navigation/reverse-include.index';
import { SchemaIdIndex } from '../../src/features/completion/schema-id.index';
import { ActionRootingIndex } from '../../src/mod/action-rooting.index';
import { PART_RULES_CLASS } from '../../src/features/part-editor/part-fields';
import { clearModRootCache } from '../../src/mod/mod-root';
import { invalidateModContext } from '../../src/mod/mod-context';
import { generateModOverview } from '../../src/mod/mod-overview';
import { partTechCoverage } from '../../src/mod/part-tech-coverage';
import { globalSettings } from '../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../workspace-helper';
import { FIXTURES_DIR } from '../helpers';

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'part-wiring-mod');
const FOLDERS = [WORKSPACE_DATA_DIR, MOD_DIR];
const UNLOCK_MOD_DIR = join(FIXTURES_DIR, 'part-unlock-mod');
const UNLOCK_FOLDERS = [WORKSPACE_DATA_DIR, UNLOCK_MOD_DIR];
const NOTECH_MOD_DIR = join(FIXTURES_DIR, 'part-unlock-notech-mod');

/**
 * Points the workspace at the fixture game tree and rebuilds every index the sweep reads, over the
 * folders one block covers.
 *
 * @param folders the project folders to index.
 */
const buildIndexes = async (folders: string[]): Promise<void> => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    clearModRootCache();
    invalidateModContext();
    aliasRootIndex.invalidate();
    ReverseIncludeIndex.instance.reset();
    SchemaIdIndex.instance.reset();
    ActionRootingIndex.instance.reset();
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
    invalidateSchemaContextCache();
};

// A part no tech names is buildable from the start of a career rather than broken, so this answers a
// question a modder cannot answer from their own files rather than reporting a fault.
describe('part tech coverage', () => {
    beforeAll(() => buildIndexes(FOLDERS));

    afterAll(resetIndexes);

    it('names the part no tech unlocks and leaves the unlocked one alone', async () => {
        const coverage = await partTechCoverage(MOD_DIR, new Set(), FOLDERS, token);
        expect(coverage?.judged).toBe(true);
        const ids = coverage!.uncovered.map((part) => part.id);
        expect(ids).toContain('test.unlocked_by_nothing');
        expect(ids).not.toContain('test.wired');
    });

    it('counts a part once rather than again for the other name it answers to', async () => {
        // `wired_part.rules` writes `OtherIDs = [test.wired_alias]`, a second name the game accepts
        // for the same part, so the mod's four parts are four parts to judge rather than five.
        const coverage = await partTechCoverage(MOD_DIR, new Set(), FOLDERS, token);
        expect(coverage!.total).toBe(4);
        expect(coverage!.uncovered.map((part) => part.id)).not.toContain('test.wired_alias');
    });

    it('leaves a part in a file nothing reaches out of the judged count', async () => {
        // The game never loads a file no include or action reaches, and such a file is already
        // reported as unreachable, so calling its part ungated would say the same thing twice.
        const reachable = new Set([join(MOD_DIR, 'unlocked_by_nothing.rules'), join(MOD_DIR, 'wired_part.rules')]);
        const coverage = await partTechCoverage(MOD_DIR, reachable, FOLDERS, token);
        expect(coverage!.total).toBe(2);
        expect(coverage!.unreachable).toBe(2);
        expect(coverage!.uncovered.map((part) => part.id)).toEqual(['test.unlocked_by_nothing']);
    });

    it('judges nothing while the game loads none of the part files', async () => {
        // With every declaration sitting in a file the game never reads, there is no loaded part to
        // ask the question about.
        const coverage = await partTechCoverage(MOD_DIR, new Set([join(MOD_DIR, 'mod.rules')]), FOLDERS, token);
        expect(coverage?.judged).toBe(false);
        expect(coverage!.total).toBe(0);
        expect(coverage!.unreachable).toBe(4);
        expect(coverage!.uncovered).toEqual([]);
    });

    it('renders the section in the mod overview', async () => {
        const uri = pathToFileURL(join(MOD_DIR, 'mod.rules')).href;
        const markdown = (await generateModOverview(uri, FOLDERS, token))!;
        expect(markdown).toContain('## Part unlocks');
        expect(markdown).toContain('`test.unlocked_by_nothing`');
        expect(markdown).toContain('are named by no tech');
        expect(markdown).not.toContain('`test.wired`');
    });
});

// The three spellings a mode file can name a part in, in one mod: a reference to the part file, a
// toggle choice's own `PartID`, and the build battle's `PartsWhitelist`, which the game reads to
// pick what a battle offers rather than to decide what research unlocks.
describe('part tech coverage across the spellings a mode file names a part in', () => {
    beforeAll(() => buildIndexes(UNLOCK_FOLDERS));

    afterAll(resetIndexes);

    it('counts a part a tech names only by pointing at its file', async () => {
        // The game's own tech tree writes `PartsUnlocked = [&<…>/Part/ID]`, so the part is gated
        // even though its id is written in no tech.
        const coverage = await partTechCoverage(UNLOCK_MOD_DIR, new Set(), UNLOCK_FOLDERS, token);
        expect(coverage?.judged).toBe(true);
        expect(coverage!.uncovered.map((part) => part.id)).not.toContain('test.fileref_only');
    });

    it('counts a part a tech names only through a toggle choice', async () => {
        // Buying the tech makes the choice selectable, which is the same gate `PartsUnlocked` is.
        const coverage = await partTechCoverage(UNLOCK_MOD_DIR, new Set(), UNLOCK_FOLDERS, token);
        expect(coverage!.uncovered.map((part) => part.id)).not.toContain('test.toggled');
    });

    it('reports a part only the build battle whitelist names', async () => {
        // `PartsWhitelist` picks what a build battle offers. It gates nothing behind research, so a
        // part it names is still buildable from the start of a career and still worth reporting.
        const coverage = await partTechCoverage(UNLOCK_MOD_DIR, new Set(), UNLOCK_FOLDERS, token);
        expect(coverage!.total).toBe(3);
        expect(coverage!.uncovered.map((part) => part.id)).toEqual(['test.whitelisted']);
    });
});

// A project holding no tech at all cannot say what gates anything, and every part in it would read
// as ungated, so the sweep answers with nothing judged instead.
describe('part tech coverage with no tech in the project', () => {
    beforeAll(() => buildIndexes([NOTECH_MOD_DIR]));

    afterAll(resetIndexes);

    it('judges nothing while no file in the project declares a tech', async () => {
        const coverage = await partTechCoverage(NOTECH_MOD_DIR, new Set(), [NOTECH_MOD_DIR], token);
        expect(coverage?.judged).toBe(false);
        expect(coverage!.total).toBe(1);
        expect(coverage!.uncovered).toEqual([]);
    });

    it('says so in the mod overview rather than listing every part', async () => {
        const uri = pathToFileURL(join(NOTECH_MOD_DIR, 'mod.rules')).href;
        const markdown = (await generateModOverview(uri, [NOTECH_MOD_DIR], token))!;
        expect(markdown).toContain('## Part unlocks');
        expect(markdown).toContain('No file in the project declares a tech');
        expect(markdown).not.toContain('test.solo');
        expect(markdown).not.toContain('are named by no tech');
    });
});
