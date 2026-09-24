import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';

// Nothing in the suite used to take a finding the game reported and put it in a file, which is the
// only thing this feature does. These tests build a mod and a log of a run that failed on it, then
// read back the range the import landed on and the text under it.

/** The folder standing in for the user's save folder, which the mod walk is pointed at. */
const home = vi.hoisted(() => {
    // Hoisted above the imports, so the two modules it needs are asked for by hand.
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cosmoteer-log-'));
});

vi.mock('../../../src/workspace/workshop-dir', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/workspace/workshop-dir')>()),
    localModDirs: () => [join(home, 'Mods')],
}));

const { importGameLog } = await import('../../../src/features/game-log/import-game-log.command');
const { filePathToUri } = await import('../../../src/document/reference-path');

const token = CancellationToken.None;
const MOD = join(home, 'Mods', 'probe_mod');
const LOGS = join(home, 'Logs');
const PART = join(MOD, 'parts', 'thing.rules');

/** A part file whose fourth line carries the text every caret below is checked against. */
const PART_TEXT = ['Part', '{', '\tMass = 1', '\tCost = 100', '}', ''].join('\n');

mkdirSync(join(MOD, 'parts'), { recursive: true });
mkdirSync(LOGS, { recursive: true });
writeFileSync(join(MOD, 'mod.rules'), 'ID = "probe.mod"\nName = "Probe"\nVersion = "1.0.0"\n');
writeFileSync(PART, PART_TEXT);

/**
 * The timestamp to write into a log so the run reads as newer than the files it describes.
 *
 * @returns the stamp in the invariant format the logger writes.
 */
const stampAhead = (): string => {
    const when = new Date(Date.now() + 600_000);
    const two = (value: number): string => String(value).padStart(2, '0');
    return `${two(when.getMonth() + 1)}/${two(when.getDate())}/${when.getFullYear()} ${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}`;
};

/**
 * Write one log of a run that had the mod enabled.
 *
 * @param lines the lines of the run after its roster, without their timestamps.
 * @returns once the log is on disk.
 */
const writeLog = (...lines: string[]): void => {
    const stamp = stampAhead();
    const body = [
        'Cosmoteer version 0.30.4c build 0.30.4c_steam',
        'Enabled mods:',
        '\t[User Folder] - probe.mod (1.0.0)',
        ...lines,
        'Loaded game data in 12,0 seconds.',
    ]
        .map((line) => `${stamp}  |  ${line}`)
        .join('\r\n');
    writeFileSync(join(LOGS, 'log 2026-01-01 00_00_00.txt'), body);
};

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('putting what the game said back into the file it said it about', () => {
    it('lands on the line and the column the game reported', async () => {
        writeLog(
            `Halfling.ObjectText.OTParseException: Unable to parse file "${PART}".`,
            ` ---> Halfling.ObjectText.OTParseException: Unexpected "\\"Cost\\"" at position Line=4,Char=2.`
        );
        const result = await importGameLog(
            { uri: filePathToUri(join(MOD, 'mod.rules')) },
            { openText: () => undefined },
            token
        );
        expect(result.kind).toBe('imported');
        expect(result.diagnostics).toHaveLength(1);
        const { uri, diagnostic } = result.diagnostics[0];
        expect(uri).toBe(filePathToUri(PART));
        expect(diagnostic.range.start).toEqual({ line: 3, character: 1 });
        // The mark starts on the tab's own column, which is where the game counted to.
        expect(PART_TEXT.split('\n')[3].slice(1)).toBe('Cost = 100');
        expect(diagnostic.message).toContain('"Cost"');
    });

    it('says the run was clean when the run really was clean', async () => {
        writeLog();
        const result = await importGameLog(
            { uri: filePathToUri(join(MOD, 'mod.rules')) },
            { openText: () => undefined },
            token
        );
        expect(result.kind).toBe('loaded-clean');
        expect(result.diagnostics).toEqual([]);
        expect(result.stale).toBe(0);
    });

    // Windows opens a file under any casing, so the game can log a spelling the editor would read
    // as a different document: the finding would sit in the Problems panel beside the open file and
    // survive the save that fixes it. On a case-sensitive filesystem the mis-cased path names
    // nothing, so there is no case to answer and the check has nothing to run against.
    const SHOUTED = join(MOD, 'PARTS', 'THING.RULES');
    it.skipIf(!existsSync(SHOUTED))('publishes on the file as the disk spells it, not as the log did', async () => {
        writeLog(`Halfling.ObjectText.OTParseException: Unable to parse file "${SHOUTED}".`);
        const result = await importGameLog(
            { uri: filePathToUri(join(MOD, 'mod.rules')) },
            { openText: () => undefined },
            token
        );
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0].uri).toBe(filePathToUri(PART));
    });

    it('does not call the run clean when the file it choked on has since been deleted', async () => {
        // The run said something about a file of this mod. The file is gone, so nothing can be
        // published, but "the run reported nothing about its files" would be an all clear the log
        // does not support. The older log's findings are still the ones the author gets.
        writeLog(`Halfling.ObjectText.OTParseException: Unable to parse file "${join(MOD, 'parts', 'gone.rules')}".`);
        const result = await importGameLog(
            { uri: filePathToUri(join(MOD, 'mod.rules')) },
            { openText: () => undefined },
            token
        );
        expect(result.kind).not.toBe('loaded-clean');
        expect(result.diagnostics).toEqual([]);
    });

    it('counts a line the file no longer has rather than marking one that is there', async () => {
        writeLog(
            `Halfling.ObjectText.OTParseException: Unable to parse file "${PART}".`,
            ' ---> Halfling.ObjectText.OTParseException: Unexpected "x" at position Line=90,Char=1.'
        );
        const result = await importGameLog(
            { uri: filePathToUri(join(MOD, 'mod.rules')) },
            { openText: () => undefined },
            token
        );
        expect(result.diagnostics).toEqual([]);
        expect(result.stale).toBe(1);
    });

    it('counts a finding the author has already typed past, although nothing is saved yet', async () => {
        writeLog(
            `Halfling.ObjectText.OTParseException: Unable to parse file "${PART}".`,
            ' ---> Halfling.ObjectText.OTParseException: Unexpected "\\"Cost\\"" at position Line=4,Char=2.'
        );
        const edited = `// a line the author typed above it\n${PART_TEXT}`;
        const result = await importGameLog(
            { uri: filePathToUri(join(MOD, 'mod.rules')) },
            { openText: (uri) => (uri === filePathToUri(PART) ? edited : undefined) },
            token
        );
        expect(result.diagnostics).toEqual([]);
        expect(result.stale).toBe(1);
    });

    it('lands as it did when the buffer is the file', async () => {
        writeLog(
            `Halfling.ObjectText.OTParseException: Unable to parse file "${PART}".`,
            ' ---> Halfling.ObjectText.OTParseException: Unexpected "\\"Cost\\"" at position Line=4,Char=2.'
        );
        const result = await importGameLog(
            { uri: filePathToUri(join(MOD, 'mod.rules')) },
            { openText: (uri) => (uri === filePathToUri(PART) ? PART_TEXT : undefined) },
            token
        );
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0].diagnostic.range.start.line).toBe(3);
    });

    it('names the mod the run died on rather than calling the run clean', async () => {
        writeLog(
            'System.Exception: Error loading mod: Probe',
            ' ---> Halfling.ObjectText.OTNavigateException: Unable to find node at path "<ships/terran/terran.rules>/Terran/NoSuchMember".'
        );
        const result = await importGameLog(
            { uri: filePathToUri(join(MOD, 'mod.rules')) },
            { openText: () => undefined },
            token
        );
        expect(result.kind).toBe('run-failed');
        expect(result.unplaced?.[0].text).toBe(
            'Error loading mod: Probe. The game found nothing at "<ships/terran/terran.rules>/Terran/NoSuchMember", which something points at.'
        );
    });
});
