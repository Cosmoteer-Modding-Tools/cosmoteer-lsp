import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { validateResourcePickups } from '../../../src/features/diagnostics/validator.resource-pickup';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);

/**
 * A `Data` root of this test's own, which the resource files are written into. The lookup walks
 * whatever folders it is handed, and writing into the shared fixture workspace would race every
 * other test file reading that tree in a parallel worker.
 */
let dataDir: string;

/** Files this test wrote, removed again after each case. */
const written: string[] = [];

/** Writes a resource file into this test's own tree so the id lookup can find it. */
const writeResource = (name: string, body: string): void => {
    const path = join(dataDir, 'resources', name, `${name}.rules`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf8');
    written.push(path);
};

/** A part carrying one storage, with the findings its pickup sizes produce. */
const messages = async (...members: string[]): Promise<string[]> => {
    const uri = filePathToUri(workspaceFile('parts/probe/probe.rules'));
    const body = [
        'Part',
        '{',
        `${TAB}ID = probe.part`,
        `${TAB}Components`,
        `${TAB}{`,
        `${TAB}${TAB}Storage`,
        `${TAB}${TAB}{`,
        `${TAB}${TAB}${TAB}Type = ResourceStorage`,
        ...members.map((member) => `${TAB}${TAB}${TAB}${member}`),
        `${TAB}${TAB}}`,
        `${TAB}}`,
        '}',
        '',
    ].join(NEWLINE);
    return (await validateResourcePickups(parseText(body, uri), [dataDir], token)).map(
        (error) => error.message
    );
};

// The storage hands out its own number and subtracts that same number from itself, while the crew's
// setter clamps what arrives to the resource's stack. Nothing reconciles the two.
describe('validateResourcePickups', () => {
    beforeAll(async () => {
        await initWorkspace();
        dataDir = join(mkdtempSync(join(tmpdir(), 'resource-pickup-')), 'Data');
    });

    afterEach(() => {
        for (const path of written.splice(0)) rmSync(path, { force: true });
    });

    afterAll(() => rmSync(dirname(dataDir), { recursive: true, force: true }));

    it('flags a pickup above the resource stack', async () => {
        writeResource('probe_fuel', `ID = probe_fuel${NEWLINE}MaxPerNugget = 100${NEWLINE}`);
        const found = await messages('ResourceType = probe_fuel', 'MaxResourcesPickUp = 500');
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('at most 100 probe_fuel');
        expect(found[0]).toContain('MaxResourcesPickUp');
    });

    it('flags an init pickup above the stack, which loses the difference every first pickup', async () => {
        writeResource('probe_fuel', `ID = probe_fuel${NEWLINE}MaxPerNugget = 100${NEWLINE}`);
        const found = await messages('ResourceType = probe_fuel', 'InitPickUp = 101');
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('InitPickUp');
    });

    it('accepts a pickup exactly at the stack, which is what the game itself writes', async () => {
        writeResource('probe_fuel', `ID = probe_fuel${NEWLINE}MaxPerNugget = 100${NEWLINE}`);
        expect(await messages('ResourceType = probe_fuel', 'MaxResourcesPickUp = 100')).toEqual([]);
    });

    it('reads a pickup written as arithmetic', async () => {
        writeResource('probe_fuel', `ID = probe_fuel${NEWLINE}MaxPerNugget = 100${NEWLINE}`);
        expect(await messages('ResourceType = probe_fuel', 'MaxResourcesPickUp = 50 * 4')).toHaveLength(1);
    });

    // A resource left at the initialiser is one no crew ever carries, and judging it would report
    // every internal tracking resource a mod declares.
    it('says nothing about a resource that writes no stack at all', async () => {
        writeResource('probe_token', `ID = probe_token${NEWLINE}`);
        expect(await messages('ResourceType = probe_token', 'MaxResourcesPickUp = 500')).toEqual([]);
    });

    // Which of two files declaring one id the game reads is decided by an action on the registry
    // list, whose target is a list index and is deliberately unmodelled.
    it('says nothing when the project declares the id twice', async () => {
        writeResource('probe_fuel', `ID = probe_fuel${NEWLINE}MaxPerNugget = 100${NEWLINE}`);
        writeResource('probe_fuel_big', `ID = probe_fuel${NEWLINE}MaxPerNugget = 9000${NEWLINE}`);
        expect(await messages('ResourceType = probe_fuel', 'MaxResourcesPickUp = 500')).toEqual([]);
    });

    it('says nothing about a resource type it cannot resolve', async () => {
        expect(await messages('ResourceType = probe_absent', 'MaxResourcesPickUp = 500')).toEqual([]);
    });

    it('says nothing where no pickup size is written', async () => {
        writeResource('probe_fuel', `ID = probe_fuel${NEWLINE}MaxPerNugget = 100${NEWLINE}`);
        expect(await messages('ResourceType = probe_fuel', 'MaxResources = 500')).toEqual([]);
    });
});
