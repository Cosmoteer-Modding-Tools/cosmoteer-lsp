import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CancellationToken } from 'vscode-languageserver';
import { projectDocuments } from '../../src/features/navigation/workspace-files';
import { saveTextGate, tryLoadTextGate } from '../../src/workspace/index-cache';
import { FIXTURES_DIR } from '../helpers';

// The persisted text gate: the files an index ruled out from their raw text, remembered with the
// identity they were rejected under, so the next build does not read them again. The walk's
// `skipFile` hook is the half that turns a remembered rejection into a skipped read.

const CACHE_HOME = mkdtempSync(join(tmpdir(), 'cosmo-text-gate-'));
const previousLocalAppData = process.env.LOCALAPPDATA;
const DATA_ROOT = 'C:/pretend/Cosmoteer/Data';

beforeAll(() => {
    process.env.LOCALAPPDATA = CACHE_HOME;
});

afterAll(() => {
    process.env.LOCALAPPDATA = previousLocalAppData;
    rmSync(CACHE_HOME, { recursive: true, force: true });
});

describe('text gate cache', () => {
    it('answers nothing for a gate that was never saved', async () => {
        expect(await tryLoadTextGate(DATA_ROOT, 'never-saved')).toEqual([]);
    });

    it('gives back the rejections it was handed, for its own data root only', async () => {
        const entries: Array<[string, number, number]> = [
            ['C:/mod/parts/a.rules', 120, 1725000000000.5],
            ['C:/mod/parts/b.rules', 340, 1725000001000],
        ];
        await saveTextGate(DATA_ROOT, 'roundtrip', entries);
        expect(await tryLoadTextGate(DATA_ROOT, 'roundtrip')).toEqual(entries);
        expect(await tryLoadTextGate('C:/another/Data', 'roundtrip')).toEqual([]);
    });
});

describe('project walk skip hook', () => {
    const folder = join(FIXTURES_DIR, 'reachability-mod');

    it('does not read a file the consumer rules out beforehand, and reads the rest', async () => {
        const skipped: string[] = [];
        const seen: string[] = [];
        for await (const document of projectDocuments([folder], CancellationToken.None, {
            diskOnly: true,
            skipFile: (file) => {
                const skip = file.replace(/\\/g, '/').endsWith('orphan/dead.rules');
                if (skip) skipped.push(file);
                return skip;
            },
        })) {
            seen.push(document.uri);
        }
        expect(skipped).toHaveLength(1);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.some((uri) => uri.toLowerCase().endsWith('orphan/dead.rules'))).toBe(false);
    });
});
