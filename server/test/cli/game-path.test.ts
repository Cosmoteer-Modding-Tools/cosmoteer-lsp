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

    it('ignores a trailing separator, which a shell completion leaves behind', () => {
        expect(toDataRoot(`${join('games', 'Cosmoteer')}/`)).toBe(resolve('games', 'Cosmoteer', 'Data'));
    });

    it('refuses a path that ends in none of them rather than guessing', () => {
        expect(toDataRoot(join('games', 'MyMod'))).toBeUndefined();
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

    it('says why a path cannot be used, and points at the Data folder inside it', async () => {
        const resolution = await resolveGameData(FIXTURE_INSTALL, {});
        expect(resolution.kind).toBe('unusable');
        if (resolution.kind !== 'unusable') return;
        expect(resolution.reason).toContain('has to end with Data, Cosmoteer or common');
        expect(resolution.reason).toContain(FIXTURE_DATA);
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
