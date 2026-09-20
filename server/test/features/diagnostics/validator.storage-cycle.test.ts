import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { validateStorageCycles } from '../../../src/features/diagnostics/validator.storage-cycle';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);

/** A part carrying the given components, with the findings its storage graph produces. */
const messages = async (...components: string[]): Promise<string[]> => {
    const uri = filePathToUri(workspaceFile('parts/probe/probe.rules'));
    const body = [
        'Part',
        '{',
        `${TAB}ID = probe.part`,
        `${TAB}Size = [2, 2]`,
        `${TAB}Components`,
        `${TAB}{`,
        ...components,
        `${TAB}}`,
        '}',
        '',
    ].join(NEWLINE);
    return (await validateStorageCycles(parseText(body, uri), token)).map((error) => error.message);
};

/** One component group written at the indentation the part body uses. */
const component = (name: string, ...members: string[]): string =>
    [
        `${TAB}${TAB}${name}`,
        `${TAB}${TAB}{`,
        ...members.map((member) => `${TAB}${TAB}${TAB}${member}`),
        `${TAB}${TAB}}`,
    ].join(NEWLINE);

// Both components reach their own getter while the part is being built, and neither resolution
// carries a visited set, so a ring is a stack overflow the runtime cannot catch.
describe('validateStorageCycles', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('accepts a multi storage that sums two plain storages', async () => {
        const found = await messages(
            component('BatteryA', 'Type = ResourceStorage', 'ResourceType = battery', 'MaxResources = 10'),
            component('BatteryB', 'Type = ResourceStorage', 'ResourceType = battery', 'MaxResources = 10'),
            component('Total', 'Type = MultiResourceStorage', 'ResourceStorages = [BatteryA, BatteryB]')
        );
        expect(found).toEqual([]);
    });

    it('flags a multi storage that names itself', async () => {
        const found = await messages(component('Total', 'Type = MultiResourceStorage', 'ResourceStorages = [Total]'));
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('its own contents');
    });

    it('flags a ring through two multi storages', async () => {
        const found = await messages(
            component('First', 'Type = MultiResourceStorage', 'ResourceStorages = [Second]'),
            component('Second', 'Type = MultiResourceStorage', 'ResourceStorages = [First]')
        );
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('reads back through it');
    });

    it('flags a ring that runs through an inline converter', async () => {
        const found = await messages(
            component('Total', 'Type = MultiResourceStorage', 'ResourceStorages = [Converted]'),
            component('Converted', 'Type = InlineResourceConverter', 'FromStorage = Total')
        );
        expect(found).toHaveLength(1);
    });

    it('flags a converter that converts from itself', async () => {
        const found = await messages(
            component('Converted', 'Type = InlineResourceConverter', 'FromStorage = Converted')
        );
        expect(found).toHaveLength(1);
    });

    // A plain storage answers from its own state and asks nobody, so a chain cannot continue
    // through one and a diamond over two of them is not a ring.
    it('accepts a diamond whose arms both end at plain storages', async () => {
        const found = await messages(
            component('Leaf', 'Type = ResourceStorage', 'ResourceType = battery', 'MaxResources = 10'),
            component('Left', 'Type = MultiResourceStorage', 'ResourceStorages = [Leaf]'),
            component('Right', 'Type = MultiResourceStorage', 'ResourceStorages = [Leaf]'),
            component('Top', 'Type = MultiResourceStorage', 'ResourceStorages = [Left, Right]')
        );
        expect(found).toEqual([]);
    });

    it('says nothing about a name the part does not declare', async () => {
        const found = await messages(component('Total', 'Type = MultiResourceStorage', 'ResourceStorages = [Absent]'));
        expect(found).toEqual([]);
    });

    // The vanilla idiom a first-pass scanner mistakes for a self-loop: the name after the colon is
    // the base the group inherits, not the group's own id.
    it('accepts a storage naming the sibling it also inherits from', async () => {
        const found = await messages(
            component('BatteryStorage', 'Type = ResourceStorage', 'ResourceType = battery', 'MaxResources = 10'),
            [
                `${TAB}${TAB}Overclock_BatteryProviderStorage : BatteryStorage`,
                `${TAB}${TAB}{`,
                `${TAB}${TAB}${TAB}Type = MultiResourceStorage`,
                `${TAB}${TAB}${TAB}ResourceStorages = [BatteryStorage]`,
                `${TAB}${TAB}}`,
            ].join(NEWLINE)
        );
        expect(found).toEqual([]);
    });
});

// The check is default-on, so its false-positive surface is the whole game. Vanilla must be silent.
const VANILLA = 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';

const rulesUnder = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) rulesUnder(full, out);
        else if (entry.toLowerCase().endsWith('.rules')) out.push(full);
    }
    return out;
};

describe.skipIf(!existsSync(VANILLA))('validateStorageCycles over the whole vanilla tree', () => {
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
            for (const error of await validateStorageCycles(parseText(text, filePathToUri(file)), token)) {
                findings.push(`${file}: ${error.message}`);
            }
        }
        expect(findings).toEqual([]);
    }, 300_000);
});
