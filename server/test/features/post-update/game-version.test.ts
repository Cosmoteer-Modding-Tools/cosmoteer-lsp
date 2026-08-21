import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { FIXTURES_DIR } from '../../helpers';
import { readManifest } from '../../../src/mod/mod-dependencies';
import {
    GameVersionInfo,
    compareGameVersions,
    declaredCompatibleVersions,
    gameAssemblyPathFor,
    modVersionVerdict,
    readGameVersionInfo,
} from '../../../src/features/post-update/game-version';

// The installed game is the only place the accepted-version list exists, so the tests that read it
// self-skip without an install, like the other corpus-backed tests do.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_GAME = existsSync(gameAssemblyPathFor(DATA_DIR));

const MANIFESTS = join(FIXTURES_DIR, 'post-update-manifests');

/** The accepted set of the installed build at the time these tests were written, as an order. */
const ACCEPTED = ['0.30.3', '0.30.3a', '0.30.4', '0.30.4b', '0.30.4c'];

/** An assembly-sourced info object over a fixed accepted set, for the verdict cases. */
const infoOf = (accepted: readonly string[], installed: string): GameVersionInfo => ({
    installed,
    accepted,
    source: 'assembly',
    assemblyPath: 'Cosmoteer.dll',
});

describe('installed game version facts', () => {
    it.runIf(HAVE_GAME)('reads the version and the accepted set out of the game assembly', async () => {
        const info = await readGameVersionInfo(DATA_DIR);
        expect(info.source).toBe('assembly');
        expect(info.installed).toMatch(/^\d+\.\d+\.\d+/);
        // The shipped list held twenty older versions when this was written, and the installed
        // version is appended as the newest entry.
        expect(info.accepted.length).toBeGreaterThanOrEqual(20);
        expect(info.accepted[info.accepted.length - 1]).toBe(info.installed);
        expect(info.accepted).toContain('0.30.0');
        expect(new Set(info.accepted).size).toBe(info.accepted.length);
    });

    it.runIf(HAVE_GAME)('serves the second read from the memo, so the assembly is parsed once', async () => {
        const first = await readGameVersionInfo(DATA_DIR);
        const second = await readGameVersionInfo(DATA_DIR);
        expect(second).toBe(first);
    });

    it('answers with no facts when no install is configured', async () => {
        const info = await readGameVersionInfo(undefined);
        expect(info).toEqual({ installed: '', accepted: [], source: 'none' });
    });
});

describe('game version order', () => {
    it('orders two versions by the release order the accepted list ships in', () => {
        expect(compareGameVersions('0.30.3', '0.30.4', ACCEPTED)).toBeLessThan(0);
        expect(compareGameVersions('0.30.3', '0.30.3a', ACCEPTED)).toBeLessThan(0);
        expect(compareGameVersions('0.30.4c', '0.30.4', ACCEPTED)).toBeGreaterThan(0);
        expect(compareGameVersions('0.30.4c', '0.30.4c', ACCEPTED)).toBe(0);
    });

    it('refuses to order a version the build does not accept rather than guessing', () => {
        expect(compareGameVersions('0.22.0a', '0.30.4', ACCEPTED)).toBeUndefined();
        expect(compareGameVersions('0.30.4', '0.31.5', ACCEPTED)).toBeUndefined();
    });
});

describe('what the game makes of a declared version list', () => {
    it('takes a mod that names the installed version', () => {
        expect(modVersionVerdict(['0.30.4c'], infoOf(ACCEPTED, '0.30.4c'))).toBe('namesInstalled');
    });

    it('takes a mod that names an older version the build still accepts', () => {
        expect(modVersionVerdict(['0.30.3'], infoOf(ACCEPTED, '0.30.4c'))).toBe('namesAccepted');
    });

    it('reports a mod that names only versions the build has dropped', () => {
        expect(modVersionVerdict(['0.22.0a'], infoOf(ACCEPTED, '0.30.4c'))).toBe('namesNone');
    });

    it('reports a manifest that declares no list at all', () => {
        expect(modVersionVerdict(undefined, infoOf(ACCEPTED, '0.30.4c'))).toBe('undeclared');
    });

    it('gives no verdict when the accepted set could not be read', () => {
        const manifestOnly: GameVersionInfo = { installed: '0.30.4c', accepted: ['0.30.4c'], source: 'manifest' };
        expect(modVersionVerdict(['0.30.3'], manifestOnly)).toBe('unknown');
        // The installed version is still decidable from the fallback, so that answer stays.
        expect(modVersionVerdict(['0.30.4c'], manifestOnly)).toBe('namesInstalled');
        expect(modVersionVerdict(['0.30.4c'], { installed: '', accepted: [], source: 'none' })).toBe('unknown');
    });
});

describe('reading CompatibleGameVersions out of a manifest', () => {
    it('reads the live list and not a commented-out one above it', async () => {
        const manifest = await readManifest(join(MANIFESTS, 'commented', 'mod.rules'));
        expect(declaredCompatibleVersions(manifest!)).toEqual(['0.30.4c']);
    });

    it('pins the defect in the text-matching form, which takes the commented line', () => {
        // The regex shipped in run-game.command.ts. Nine of the forty-four installed workshop mods
        // keep a commented-out list above the live one, so this is not a hypothetical shape. The
        // case exists so nobody reintroduces the text match here.
        const text = readFileSync(join(MANIFESTS, 'commented', 'mod.rules'), 'utf8');
        const matched = text.match(/CompatibleGameVersions\s*=\s*\[([^\]\n]*)\]/i)?.[1];
        expect(matched).toContain('0.29.0');
    });

    it('reads a bare list as the written text rather than as a number', async () => {
        const manifest = await readManifest(join(MANIFESTS, 'bare', 'mod.rules'));
        const declared = declaredCompatibleVersions(manifest!);
        expect(declared).toEqual(['0.30.4']);
        expect(typeof declared![0]).toBe('string');
    });

    it('tells a manifest that declares nothing from one that declares an empty list', async () => {
        const undeclared = await readManifest(join(MANIFESTS, 'undeclared', 'mod.rules'));
        expect(declaredCompatibleVersions(undeclared!)).toBeUndefined();
        const legacy = await readManifest(join(MANIFESTS, 'legacy', 'mod.rules'));
        expect(declaredCompatibleVersions(legacy!)).toEqual(['0.22.0a']);
    });
});
