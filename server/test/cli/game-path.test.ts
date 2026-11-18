import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { configuredGamePath, resolveGameData, toDataRoot, withoutGameDataPath } from '../../src/cli/game-path';

const FIXTURE_INSTALL = resolve(__dirname, '..', 'fixtures', 'workspace');
const FIXTURE_DATA = join(FIXTURE_INSTALL, 'Data');

describe('normalizing a game path', () => {
    it('accepts the three tails the server accepts', () => {
        expect(toDataRoot(join('games', 'Cosmoteer', 'Data'))).toBe(resolve('games', 'Cosmoteer', 'Data'));
        expect(toDataRoot(join('games', 'Cosmoteer'))).toBe(resolve('games', 'Cosmoteer', 'Data'));
        expect(toDataRoot(join('steamapps', 'common'))).toBe(resolve('steamapps', 'common', 'Cosmoteer', 'Data'));
    });

    it('ignores a trailing separator of either kind, which a shell completion leaves behind', () => {
        expect(toDataRoot(`${join('games', 'Cosmoteer')}/`)).toBe(resolve('games', 'Cosmoteer', 'Data'));
        expect(toDataRoot(`${join('games', 'Cosmoteer')}\\`)).toBe(resolve('games', 'Cosmoteer', 'Data'));
        expect(toDataRoot(`${join('games', 'Cosmoteer', 'Data')}/`)).toBe(resolve('games', 'Cosmoteer', 'Data'));
    });

    it('reads the tails without case', () => {
        expect(toDataRoot(join('games', 'cosmoteer'))).toBe(resolve('games', 'cosmoteer', 'Data'));
        expect(toDataRoot(join('games', 'Cosmoteer', 'data'))).toBe(resolve('games', 'Cosmoteer', 'data'));
    });

    it('takes an install folder under another name when it holds a Data folder', () => {
        expect(toDataRoot(FIXTURE_INSTALL)).toBe(FIXTURE_DATA);
    });

    it('refuses a folder with none of the tails and no Data folder', () => {
        expect(toDataRoot(join('games', 'MyMod'))).toBeUndefined();
        expect(toDataRoot('')).toBeUndefined();
    });
});

describe('finding the game data', () => {
    it('takes the path given on the command line', async () => {
        const resolution = await resolveGameData(FIXTURE_DATA, {});
        expect(resolution).toEqual({ kind: 'found', dataRoot: FIXTURE_DATA, source: 'option' });
    });

    it('reads the environment when the command line says nothing', async () => {
        const resolution = await resolveGameData(undefined, { COSMOTEER_GAME: FIXTURE_DATA });
        expect(resolution).toEqual({ kind: 'found', dataRoot: FIXTURE_DATA, source: 'environment' });
        const alternative = await resolveGameData(undefined, { COSMOTEER_DATA_DIR: FIXTURE_DATA });
        expect(alternative).toEqual({ kind: 'found', dataRoot: FIXTURE_DATA, source: 'environment' });
    });

    it('says why a path cannot be used', async () => {
        const resolution = await resolveGameData(join(FIXTURE_INSTALL, 'nothing-here'), {});
        expect(resolution.kind).toBe('unusable');
        if (resolution.kind !== 'unusable') return;
        expect(resolution.reason).toContain('has to name the Cosmoteer folder or its Data folder');
    });

    it('says when the folder the path names is not there', async () => {
        const missing = join(FIXTURE_INSTALL, 'nothing-here', 'Data');
        const resolution = await resolveGameData(missing, {});
        expect(resolution.kind).toBe('unusable');
        if (resolution.kind !== 'unusable') return;
        expect(resolution.reason).toContain('there is no folder at');
    });
});

describe('running without the game data', () => {
    it('configures a path the server refuses instead of an empty one it would auto-detect from', () => {
        const path = configuredGamePath({ kind: 'not-found' });
        expect(path).toBe(withoutGameDataPath());
        expect(path.endsWith('Data')).toBe(true);
        expect(existsSync(path), 'the placeholder must not exist, or the server would index it').toBe(false);
    });

    it('hands the resolved root across unchanged when there is one', () => {
        expect(configuredGamePath({ kind: 'found', dataRoot: FIXTURE_DATA, source: 'option' })).toBe(FIXTURE_DATA);
    });
});
