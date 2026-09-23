import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { ModConflict, modConflicts } from '../../../src/features/mod-report/mod-conflicts';
import { conflictSection } from '../../../src/features/mod-report/mod-overview';

// The conflicts table names a node the author is meant to find in their own manifest. The key the
// two mods are compared by is not that node: it is folded to lower case and rewritten to the game
// root, so `<parts/Cannon.rules>/Cannon/MaxBorders/Left` reached the table as
// `<./data/parts/cannon.rules>/cannon/maxborders/left`, which appears in no file anywhere.
//
// A Steam layout of its own, so the comparison reads a planted installed mod instead of whatever is
// subscribed on this machine, and nothing of the user's is written.
const token = CancellationToken.None;
let root = '';
let ownMod = '';

/**
 * A manifest that claims one node twice over: an override, which claims the member it writes, and a
 * replace, which claims the whole node it names.
 */
const manifest = (id: string): string =>
    [
        `ID = ${id}`,
        `Name = "${id}"`,
        'Version = 1.0',
        '',
        'Actions',
        '[',
        '\t{',
        '\t\tAction = Overrides',
        '\t\tOverrideIn = "<parts/Cannon.rules>/Cannon"',
        '\t\tOverrides',
        '\t\t{',
        '\t\t\tMaxBorders',
        '\t\t\t{',
        '\t\t\t\tLeft = -500',
        '\t\t\t}',
        '\t\t}',
        '\t}',
        '\t{',
        '\t\tAction = Replace',
        '\t\tReplace = "<parts/Cannon.rules>/Cannon/MaxHealth"',
        '\t\tWith = 5',
        '\t}',
        ']',
        '',
    ].join('\n');

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cosmoteer-conflicts-'));
    const dataRoot = join(root, 'steamapps', 'common', 'Cosmoteer', 'Data');
    mkdirSync(join(dataRoot, 'parts'), { recursive: true });
    writeFileSync(join(dataRoot, 'parts', 'Cannon.rules'), 'Cannon\n{\n\tMaxBorders\n\t{\n\t\tLeft = 0\n\t}\n}\n');

    const installed = join(root, 'steamapps', 'workshop', 'content', '799600', '1234');
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'mod.rules'), manifest('Someone.Else'));

    ownMod = join(root, 'work', 'MyMod');
    mkdirSync(ownMod, { recursive: true });
    writeFileSync(join(ownMod, 'mod.rules'), manifest('Zz.Mine'));

    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    globalSettings.cosmoteerPath = dataRoot;
    await service.initialize(dataRoot, noop);
    clearModRootCache();
}, 120_000);

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

/** The collisions with the planted installed mod, which are the only ones this layout produces. */
const planted = async (): Promise<ModConflict[]> => {
    const found = (await modConflicts(ownMod, token)).filter((conflict) => conflict.modId === 'Someone.Else');
    expect(found, 'the planted installed mod was not compared').toHaveLength(2);
    return found;
};

describe('a node two mods both claim', () => {
    it('carries the target and the member as the manifest writes them', async () => {
        const [override] = await planted();
        expect(override.target).toBe('<parts/Cannon.rules>/Cannon');
        expect(override.member).toBe('MaxBorders/Left');
    });

    it('carries no member for a verb that takes the whole node', async () => {
        const [, replace] = await planted();
        expect(replace.target).toBe('<parts/Cannon.rules>/Cannon/MaxHealth');
        expect(replace.member).toBeUndefined();
    });

    it('reaches the table in that spelling rather than the folded one', async () => {
        const rendered = conflictSection(ownMod, await planted()).join('\n');
        expect(rendered).toContain('`<parts/Cannon.rules>/Cannon/MaxBorders/Left`');
        expect(rendered).toContain('`<parts/Cannon.rules>/Cannon/MaxHealth`');
        expect(rendered).not.toContain('./data/');
        expect(rendered).not.toContain('maxborders');
    });
});
