import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { validatePartGeometry } from '../../../src/features/diagnostics/validator.part-geometry';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;

/** A part file written at the fixture workspace, with the geometry findings it produces. */
const check = async (body: string) => {
    const uri = filePathToUri(workspaceFile('parts/probe/probe.rules'));
    return validatePartGeometry(parseText(`Part\n{\n\tID = probe.part\n${body}\n}\n`, uri), token);
};

const messages = async (body: string) => (await check(body)).map((error) => error.message);

// Every rule here is the game's own reachability, read out of Cosmoteer.dll. A door location is only
// ever matched against the part rect's side neighbours, the per-cell reads only ever ask a part about
// a cell it occupies, and the part reader throws outright on a PhysicalRect that leaves the part.
describe('validatePartGeometry', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('accepts door locations on the part perimeter', async () => {
        expect(await messages('\tSize = [2, 2]\n\tAllowedDoorLocations\n\t[\n\t\t[-1, 0]\n\t\t[0, -1]\n\t\t[2, 1]\n\t\t[1, 2]\n\t]')).toEqual([]);
    });

    it('flags a door location inside the part', async () => {
        const found = await messages('\tSize = [3, 3]\n\tAllowedDoorLocations\n\t[\n\t\t[1, 1]\n\t]');
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('inside');
    });

    it('flags a door location that touches nothing', async () => {
        const found = await messages('\tSize = [2, 2]\n\tAllowedDoorLocations\n\t[\n\t\t[5, 5]\n\t]');
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('does not touch');
    });

    it('flags a diagonal corner, which the engine ring excludes', async () => {
        expect(await messages('\tSize = [2, 2]\n\tAllowedDoorLocations\n\t[\n\t\t[-1, -1]\n\t]')).toHaveLength(1);
    });

    it('flags a blocked travel cell outside the part and accepts one inside', async () => {
        expect(await messages('\tSize = [2, 2]\n\tBlockedTravelCells\n\t[\n\t\t[1, 1]\n\t]')).toEqual([]);
        expect(await messages('\tSize = [2, 2]\n\tBlockedTravelCells\n\t[\n\t\t[2, 0]\n\t]')).toHaveLength(1);
    });

    it('flags a per-cell map key outside the part and accepts one inside', async () => {
        // The entry-list form vanilla writes, e.g. ships/asteroid/rock/rock_1x2_wedge.rules:21.
        const entry = (x: number, y: number) =>
            `\tExternalWallsByCell\n\t[\n\t\t{\n\t\t\tKey = [${x}, ${y}]\n\t\t\tValue = [Top]\n\t\t}\n\t]`;
        expect(await messages(`\tSize = [1, 1]\n${entry(0, 0)}`)).toEqual([]);
        const found = await messages(`\tSize = [1, 1]\n${entry(0, -1)}`);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('ExternalWallsByCell');
    });

    it('reports a PhysicalRect that leaves the part as an error', async () => {
        const found = await check('\tSize = [5, 5]\n\tPhysicalRect = [0, 2, 3, 4]');
        expect(found).toHaveLength(1);
        expect(found[0].severity).toBe('error');
        expect(found[0].message).toContain('refuses to load');
    });

    it('leaves SaveRect alone, since the game reads only its location', async () => {
        expect(await messages('\tSize = [1, 3]\n\tSaveRect = [0, 3, 1, 1]')).toEqual([]);
    });

    it('says nothing about a part that declares no ID of its own', async () => {
        const uri = filePathToUri(workspaceFile('parts/probe/base.rules'));
        const source = 'Part\n{\n\tSize = [2, 2]\n\tAllowedDoorLocations\n\t[\n\t\t[9, 9]\n\t]\n}\n';
        expect(await validatePartGeometry(parseText(source, uri), token)).toEqual([]);
    });

    it('says nothing when the size is not two plain positive integers', async () => {
        expect(await messages('\tSize = &SOME_REF\n\tBlockedTravelCells\n\t[\n\t\t[9, 9]\n\t]')).toEqual([]);
    });
});

// The check is default-on, so its false-positive surface is the whole game. Vanilla must be silent.
const VANILLA = 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';

const rulesUnder = (dir: string, out: string[] = [], depth = 0): string[] => {
    if (depth > 8) return out;
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of entries) {
        const full = join(dir, name);
        let stats;
        try {
            stats = statSync(full);
        } catch {
            continue;
        }
        if (stats.isDirectory()) rulesUnder(full, out, depth + 1);
        else if (name.toLowerCase().endsWith('.rules')) out.push(full);
    }
    return out;
};

describe.skipIf(!existsSync(VANILLA))('validatePartGeometry over the whole vanilla tree', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('reports nothing the game itself ships', async () => {
        const files = rulesUnder(VANILLA);
        expect(files.length).toBeGreaterThan(500);
        const findings: string[] = [];
        for (const file of files) {
            const text = await readFile(file, 'utf-8').catch(() => null);
            if (text === null) continue;
            const errors = await validatePartGeometry(parseText(text, filePathToUri(file)), token);
            for (const error of errors) findings.push(`${file}: ${error.message}`);
        }
        expect(findings).toEqual([]);
    }, 300_000);
});
