import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ensureAliasRootIndex } from '../../../src/features/navigation/alias-root-builder';
import { ReverseIncludeIndex } from '../../../src/mod/reverse-include.index';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { ActionRootingIndex } from '../../../src/mod/action-rooting.index';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { generateModOverview } from '../../../src/features/mod-report/mod-overview';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';
import { FIXTURES_DIR } from '../../helpers';

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'mod-health-mod');
const PLAIN_DIR = join(FIXTURES_DIR, 'no-manifest-folder');
const TXT_MOD_DIR = join(FIXTURES_DIR, 'mod-overview-txt-mod');
const FOLDERS = [WORKSPACE_DATA_DIR, MOD_DIR];

/**
 * The overview the command produces for one file of the project.
 *
 * @param path the file the command is invoked from.
 * @returns the markdown, or undefined when the command declines.
 */
const overviewFrom = (path: string): Promise<string | undefined> =>
    generateModOverview(pathToFileURL(path).href, FOLDERS, token);

beforeAll(async () => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    clearModRootCache();
    invalidateModContext();
    aliasRootIndex.invalidate();
    ReverseIncludeIndex.instance.reset();
    SchemaIdIndex.instance.reset();
    ActionRootingIndex.instance.reset();
    await ensureAliasRootIndex(token);
    await ReverseIncludeIndex.instance.ensureBuilt(FOLDERS, token);
    await ActionRootingIndex.instance.ensureBuilt(FOLDERS, token);
}, 120_000);

afterAll(() => {
    ReverseIncludeIndex.instance.reset();
    SchemaIdIndex.instance.reset();
    ActionRootingIndex.instance.reset();
    aliasRootIndex.invalidate();
    clearModRootCache();
});

// The command is offered from every rules file, so the palette reaches it from the part someone is
// editing. Read as a manifest, a part file declares no action and the report used to announce that
// the game loads nothing from the mod, while its reachability half kept describing the real one.
describe('the mod overview asked from a file that is not the manifest', () => {
    it('reports the actions the mod manifest declares', async () => {
        const markdown = await overviewFrom(join(MOD_DIR, 'parts', 'armor_a.rules'));
        expect(markdown).toContain('## Actions (2)');
        expect(markdown).toContain('Mod health fixture');
        expect(markdown).not.toContain('The manifest declares no action');
    }, 120_000);

    it('answers exactly what the manifest itself answers', async () => {
        const fromPart = await overviewFrom(join(MOD_DIR, 'parts', 'armor_a.rules'));
        const fromManifest = await overviewFrom(join(MOD_DIR, 'mod.rules'));
        expect(fromManifest).toContain('## Actions (2)');
        expect(fromPart).toBe(fromManifest);
    }, 120_000);

    it('still declines for a file that lies in no mod at all', async () => {
        expect(await overviewFrom(join(PLAIN_DIR, 'parts', 'loose.rules'))).toBeUndefined();
    }, 120_000);
});

// The reachability walk counts a `.txt` file as rules content, which is right, since a reference can
// name one and parking a part as `.txt` is how a mod disables it. The caption said `.rules` files,
// so the total disagreed with the extension it named and the dead-content list below it showed
// `.txt` entries the caption had not accounted for.
describe('the reachability caption of the mod overview', () => {
    it('names both extensions it counts', async () => {
        const markdown = await overviewFrom(join(TXT_MOD_DIR, 'mod.rules'));
        expect(markdown).toContain('`.rules` and `.txt` files are reachable from the manifest');
        expect(markdown).not.toMatch(/of \d+ `\.rules` files are reachable/);
    }, 120_000);

    it('counts the parked `.txt` file in the total it prints', async () => {
        const markdown = await overviewFrom(join(TXT_MOD_DIR, 'mod.rules'));
        // The mod holds mod.rules, wired/good.rules and the parked parked.txt.
        expect(markdown).toContain('2 of 3 `.rules` and `.txt` files are reachable');
        expect(markdown).toContain('parked.txt');
    }, 120_000);

    it('says the same thing in the health row that summarizes it', async () => {
        const markdown = await overviewFrom(join(TXT_MOD_DIR, 'mod.rules'));
        expect(markdown).toContain('The manifest reaches 2 of the 3 `.rules` and `.txt` files.');
    }, 120_000);
});
