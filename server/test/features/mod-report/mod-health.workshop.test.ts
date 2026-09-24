import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { computeModReachability } from '../../../src/mod/mod-reachability';
import { HealthRow, modHealthRows } from '../../../src/features/mod-report/mod-health';
import { healthSection } from '../../../src/features/mod-report/mod-overview';

// A mod opened inside the Steam workshop tree is somebody else's installed copy. Two of the health
// rows are fed by passes that are switched off there: the conflict sweep skips it, and the
// shared-base analysis only runs where the base file it would generate may be written. Those rows
// used to print the wording of a pass, telling the reader that a check they never got had come back
// clean. A Steam layout of its own, so nothing of the user's is read or written.
const token = CancellationToken.None;
let root = '';
let installedMod = '';
let ownMod = '';

/** The files that make a folder a mod the reachability walk can answer about. */
const writeMod = (modRoot: string): void => {
    mkdirSync(join(modRoot, 'parts'), { recursive: true });
    writeFileSync(
        join(modRoot, 'mod.rules'),
        [
            'ID = Test.WorkshopRows',
            'Name = "t"',
            'Version = 1.0',
            '',
            'Actions',
            '[',
            '\t{',
            '\t\tAction = AddMany',
            '\t\tAddTo = "<ships/partship.rules>/PartShip/Parts"',
            '\t\tManyToAdd',
            '\t\t[',
            '\t\t\t&<parts/hull.rules>/Part',
            '\t\t]',
            '\t}',
            ']',
            '',
        ].join('\n')
    );
    writeFileSync(join(modRoot, 'parts', 'hull.rules'), 'Part\n{\n\tID = hull\n\tMaxHealth = 100\n}\n');
};

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cosmoteer-health-workshop-'));
    const dataRoot = join(root, 'steamapps', 'common', 'Cosmoteer', 'Data');
    mkdirSync(join(dataRoot, 'ships'), { recursive: true });
    writeFileSync(join(dataRoot, 'ships', 'armor.rules'), 'Part\n{\n\tSize = [1, 1]\n}\n');

    installedMod = join(root, 'steamapps', 'workshop', 'content', '799600', '1234');
    ownMod = join(root, 'work', 'mod');
    writeMod(installedMod);
    writeMod(ownMod);

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

/** The health rows of one mod folder, keyed by the check each answers. */
const rowsOf = async (modRoot: string): Promise<Map<string, HealthRow>> => {
    const reachability = (await computeModReachability(modRoot, token))!;
    const rows = await modHealthRows(reachability, { total: 1, broken: 0 }, [modRoot], token);
    return new Map(rows.map((row) => [row.check, row]));
};

describe('the health rows of a mod installed from the workshop', () => {
    const NOT_CHECKED = 'Not checked. This mod is an installed copy in the Steam workshop folder';

    it('says the repeated-field-set check did not run', async () => {
        const row = (await rowsOf(installedMod)).get('Repeated field sets')!;
        expect(row.unchecked).toBe(true);
        expect(row.finding).toContain(NOT_CHECKED);
        expect(row.finding).not.toContain('No group repeats');
    });

    it('says the installed-mods check did not run', async () => {
        const row = (await rowsOf(installedMod)).get('Installed mods')!;
        expect(row.unchecked).toBe(true);
        expect(row.finding).toContain(NOT_CHECKED);
        expect(row.finding).not.toContain('No mod on this machine');
    });

    it('marks the row as neither passed nor flagged in the rendered table', async () => {
        const row = (await rowsOf(installedMod)).get('Installed mods')!;
        const rendered = healthSection(installedMod, [row]).find((line) => line.includes('Installed mods'))!;
        expect(rendered.startsWith('| ○ ')).toBe(true);
    });

    it('still answers both checks for a mod the author is writing', async () => {
        const rows = await rowsOf(ownMod);
        expect(rows.get('Repeated field sets')!.unchecked).toBeUndefined();
        expect(rows.get('Repeated field sets')!.finding).toContain('No group repeats');
        expect(rows.get('Installed mods')!.unchecked).toBeUndefined();
        expect(rows.get('Installed mods')!.finding).toContain('No mod on this machine');
    });
});
