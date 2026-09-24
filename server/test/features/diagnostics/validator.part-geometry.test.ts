import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { validatePartGeometry } from '../../../src/features/diagnostics/validator.part-geometry';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);

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
        expect(
            await messages(
                '\tSize = [2, 2]\n\tAllowedDoorLocations\n\t[\n\t\t[-1, 0]\n\t\t[0, -1]\n\t\t[2, 1]\n\t\t[1, 2]\n\t]'
            )
        ).toEqual([]);
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

    // A cell outside the part is what the field is for, and a cell inside it is past none of the
    // four boundary tests the engine turns it into a door location with.
    const doorToggle = (size: string, cell: string): string =>
        [
            TAB + 'Size = ' + size,
            TAB + 'Components',
            TAB + '{',
            TAB + TAB + 'DoorLeft',
            TAB + TAB + '{',
            TAB + TAB + TAB + 'Type = DoorPresenceToggle',
            TAB + TAB + TAB + 'AdjacentCell = ' + cell,
            TAB + TAB + '}',
            TAB + '}',
        ].join(NEWLINE);

    it('accepts a door presence toggle beside the part', async () => {
        expect(await messages(doorToggle('[1, 2]', '[-1, 0]'))).toEqual([]);
    });

    it('flags a door presence toggle whose cell is inside the part', async () => {
        const found = await messages(doorToggle('[2, 2]', '[1, 1]'));
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('inside the part');
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

    // The mistake that writes this value is reading the last two numbers as an edge rather than a
    // size, so the sentence has to say which two are the size and which two are the corner.
    it('says what the four numbers of a refused PhysicalRect mean', async () => {
        const [found] = await check('\tSize = [5, 5]\n\tPhysicalRect = [0, 2, 3, 4]');
        expect(found.message).toContain('is a 3 by 4 rect at column 0, row 2');
        expect(found.message).toContain('reaches past a 5 by 5 part');
    });

    it('leaves a rect that fits alone', async () => {
        expect(await messages('\tSize = [5, 5]\n\tPhysicalRect = [0, 1, 3, 4]')).toEqual([]);
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

/** A part carrying one component, written in the shape vanilla parts use. */
const withComponent = (size: string, name: string, ...members: string[]): string =>
    [
        `${TAB}Size = ${size}`,
        `${TAB}Components`,
        `${TAB}{`,
        `${TAB}${TAB}${name}`,
        `${TAB}${TAB}{`,
        ...members.map((member) => `${TAB}${TAB}${TAB}${member}`),
        `${TAB}${TAB}}`,
        `${TAB}}`,
    ].join(NEWLINE);

// The game adds these onto the part's own cell without clamping and then floors the result, so the
// cell the point lands in is what crew walk to and what the resource search starts from.
describe('a storage access point outside the part', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('accepts a fractional point the part still contains', async () => {
        const body = withComponent(
            '[2, 3]',
            'CarbonStorage',
            'Type = ResourceStorage',
            'DeliveryLocation = [1, 2.2]',
            'PickUpLocation = [1, 2.2]'
        );
        expect(await messages(body)).toEqual([]);
    });

    it('flags a point written in pixels rather than tiles', async () => {
        const body = withComponent('[2, 3]', 'CarbonStorage', 'Type = ResourceStorage', 'DeliveryLocation = [64, 53]');
        const found = await messages(body);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('DeliveryLocation');
        expect(found[0]).toContain('[64, 53]');
        expect(found[0]).toContain('index error');
    });

    it('flags a point one cell past the right edge', async () => {
        const body = withComponent('[2, 3]', 'CarbonStorage', 'Type = ResourceStorage', 'PickUpLocation = [2, 0]');
        expect(await messages(body)).toHaveLength(1);
    });

    it('accepts a point the reader cannot resolve to two numbers', async () => {
        const body = withComponent('[2, 3]', 'CarbonStorage', 'Type = ResourceStorage', 'DeliveryLocation = &SOME_REF');
        expect(await messages(body)).toEqual([]);
    });
});

describe('a resource grid that reaches past its part', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('accepts a grid rect the part contains', async () => {
        const body = withComponent('[2, 3]', 'DiamondStorage', 'Type = TypedResourceGrid', 'GridRect = [0, 2, 2, 1]');
        expect(await messages(body)).toEqual([]);
    });

    it('flags a grid rect that leaves the part', async () => {
        const body = withComponent('[2, 3]', 'DiamondStorage', 'Type = TypedResourceGrid', 'GridRect = [0, 2, 4, 1]');
        const found = await messages(body);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('GridRect');
    });

    it('flags a flex grid the same way', async () => {
        const body = withComponent('[2, 2]', 'FlexStorage', 'Type = FlexResourceGrid', 'GridRect = [3, 3, 1, 1]');
        expect(await messages(body)).toHaveLength(1);
    });

    // Containment compares only the sums, so a negative extent passes it. The game's own fill loops
    // never enter on one, which is the thing worth saying.
    it('flags a grid rect with no extent, which containment alone lets through', async () => {
        const body = withComponent('[2, 2]', 'DiamondStorage', 'Type = TypedResourceGrid', 'GridRect = [1, 1, -1, -1]');
        const found = await messages(body);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('positive width and height');
    });

    it('flags a grid rect of zero width', async () => {
        const body = withComponent('[2, 2]', 'DiamondStorage', 'Type = TypedResourceGrid', 'GridRect = [0, 0, 0, 2]');
        expect(await messages(body)).toHaveLength(1);
    });
});

// A part crew cannot walk through never grows the path grid the resource search runs in, yet the
// search still starts from its own cells.
describe('a resource sink on an impassable part', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('flags a consumer on a part whose crew speed is zero', async () => {
        const body = [
            `${TAB}CrewSpeedFactor = 0`,
            withComponent('[2, 2]', 'CarbonConsumer', 'Type = ResourceConsumer', 'Storage = CarbonStorage'),
        ].join(NEWLINE);
        const found = await messages(body);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('CrewSpeedFactor');
    });

    it('accepts the same consumer on a part crew can walk through', async () => {
        const body = [
            `${TAB}CrewSpeedFactor = 1`,
            withComponent('[2, 2]', 'CarbonConsumer', 'Type = ResourceConsumer', 'Storage = CarbonStorage'),
        ].join(NEWLINE);
        expect(await messages(body)).toEqual([]);
    });

    it('accepts an impassable part that takes no resources', async () => {
        const body = [
            `${TAB}CrewSpeedFactor = 0`,
            withComponent('[2, 2]', 'HeatStorage', 'Type = ResourceStorage', 'ResourceType = heat'),
        ].join(NEWLINE);
        expect(await messages(body)).toEqual([]);
    });

    it('reports a part once however many sinks it carries', async () => {
        const body = [
            `${TAB}CrewSpeedFactor = 0`,
            `${TAB}Size = [2, 2]`,
            `${TAB}Components`,
            `${TAB}{`,
            `${TAB}${TAB}CarbonConsumer`,
            `${TAB}${TAB}{`,
            `${TAB}${TAB}${TAB}Type = ResourceConsumer`,
            `${TAB}${TAB}${TAB}Storage = CarbonStorage`,
            `${TAB}${TAB}}`,
            `${TAB}${TAB}PowerConsumer`,
            `${TAB}${TAB}{`,
            `${TAB}${TAB}${TAB}Type = ResourceConsumer`,
            `${TAB}${TAB}${TAB}Storage = PowerStorage`,
            `${TAB}${TAB}}`,
            `${TAB}}`,
        ].join(NEWLINE);
        expect(await messages(body)).toHaveLength(1);
    });

    // All four members are optional to the reader, and the engine's own constructor throws on a
    // group that mixes a zero direction with a non-zero one, so whichever one is written answers.
    it('reads the zero out of a group form that omits Left', async () => {
        const body = [
            `${TAB}CrewSpeedFactor`,
            `${TAB}{`,
            `${TAB}${TAB}Right = 0`,
            `${TAB}${TAB}Up = 0`,
            `${TAB}${TAB}Down = 0`,
            `${TAB}}`,
            withComponent('[2, 2]', 'CarbonConsumer', 'Type = ResourceConsumer', 'Storage = CarbonStorage'),
        ].join(NEWLINE);
        expect(await messages(body)).toHaveLength(1);
    });

    it('reads the zero out of the group form as well', async () => {
        const body = [
            `${TAB}CrewSpeedFactor`,
            `${TAB}{`,
            `${TAB}${TAB}Left = 0`,
            `${TAB}${TAB}Right = 0`,
            `${TAB}${TAB}Up = 0`,
            `${TAB}${TAB}Down = 0`,
            `${TAB}}`,
            withComponent('[2, 2]', 'CarbonConsumer', 'Type = ResourceConsumer', 'Storage = CarbonStorage'),
        ].join(NEWLINE);
        expect(await messages(body)).toHaveLength(1);
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

// The shorthands add one keep-out rect per category the part prohibits, so with no category named
// they add nothing at all. Parts inherit `Prohibits = [default]`, so only a part that clears the
// inherited list can reach this.
describe('a prohibit shorthand on a part that prohibits nothing', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('says the keep-out distance adds nothing', async () => {
        const body = [`${TAB}Size = [2, 2]`, `${TAB}Prohibits`, `${TAB}[`, `${TAB}]`, `${TAB}ProhibitLeft = 2`].join(
            NEWLINE
        );
        expect(await messages(body)).toEqual([
            'This part prohibits no category, so this keep-out distance adds nothing. The shorthands add one rect per category in `Prohibits`, which is empty here.',
        ]);
    });

    it('says nothing where the part prohibits a category', async () => {
        const body = [
            `${TAB}Size = [2, 2]`,
            `${TAB}Prohibits`,
            `${TAB}[`,
            `${TAB}${TAB}default`,
            `${TAB}]`,
            `${TAB}ProhibitLeft = 2`,
        ].join(NEWLINE);
        expect(await messages(body)).toEqual([]);
    });

    it('says nothing where no shorthand is written', async () => {
        const body = [`${TAB}Size = [2, 2]`, `${TAB}Prohibits`, `${TAB}[`, `${TAB}]`].join(NEWLINE);
        expect(await messages(body)).toEqual([]);
    });
});

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
