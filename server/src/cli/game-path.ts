import { stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCosmoteerDataPath, steamInstallPaths } from '../workspace/steam-library';
import { toDataRoot } from '../workspace/data-root';

// Where the game's own `Data` tree came from decides how much of the run means anything, so the CLI
// resolves it itself instead of leaving the server to auto-detect quietly. A run that only found
// half its inputs has to be able to say so, and it cannot say so about a decision it did not make.

/** Where a game path came from, which the report names so a surprising result can be traced. */
export type GamePathSource = 'option' | 'environment' | 'auto-detect';

/** The outcome of looking for the game's `Data` tree. */
export type GameDataResolution =
    | { kind: 'found'; dataRoot: string; source: GamePathSource }
    | { kind: 'unusable'; given: string; source: GamePathSource; reason: string }
    | { kind: 'not-found' };

/** The environment variables a path may be given in, in the order they are consulted. */
const ENVIRONMENT_KEYS = ['COSMOTEER_GAME', 'COSMOTEER_DATA_DIR'] as const;

// The server reads the setting through the same rule, so a path the CLI accepts is one it accepts.
export { toDataRoot };

/**
 * Whether a path is a directory that can be read.
 *
 * @param path the path to probe.
 * @returns true when it exists and is a directory.
 */
const isDirectory = async (path: string): Promise<boolean> =>
    stat(path)
        .then((stats) => stats.isDirectory())
        .catch(() => false);

/**
 * Turn one candidate path into a resolution, saying precisely why it cannot be used when it cannot.
 *
 * @param given the path as it was given.
 * @param source where it came from.
 * @returns the resolution for this candidate.
 */
const resolveGiven = async (given: string, source: GamePathSource): Promise<GameDataResolution> => {
    const dataRoot = toDataRoot(given);
    if (!dataRoot) {
        return {
            kind: 'unusable',
            given,
            source,
            reason: 'the path has to name the Cosmoteer folder or its Data folder.',
        };
    }
    if (!(await isDirectory(dataRoot))) {
        return { kind: 'unusable', given, source, reason: `there is no folder at "${dataRoot}".` };
    }
    return { kind: 'found', dataRoot, source };
};

/**
 * Find the game's `Data` tree: the path given on the command line first, then the environment, then
 * the Steam libraries. Auto-detection is the same one the editor uses, so a machine the editor works
 * on is a machine the CLI works on.
 *
 * @param given the path from the command line, when one was given.
 * @param environment the environment to read the fallback variables from.
 * @returns what was found, or why nothing could be used.
 */
export const resolveGameData = async (
    given: string | undefined,
    environment: NodeJS.ProcessEnv = process.env
): Promise<GameDataResolution> => {
    if (given) return resolveGiven(given, 'option');
    for (const key of ENVIRONMENT_KEYS) {
        const value = environment[key];
        if (value) return resolveGiven(value, 'environment');
    }
    for (const steamPath of await steamInstallPaths().catch(() => [])) {
        const detected = await findCosmoteerDataPath(steamPath).catch(() => undefined);
        if (detected) return { kind: 'found', dataRoot: detected, source: 'auto-detect' };
    }
    return { kind: 'not-found' };
};

/**
 * The path a run without game data configures instead of an empty one.
 *
 * An empty path is the server's signal to search the Steam libraries itself, which would give a
 * run started with --no-game the very tree it was told not to read, and would leave the report
 * saying one thing while the checks did another. A path that ends in `Data` and is not on disk
 * takes the same route as a wrong path in the settings: the server reports it cannot be read and
 * leaves every game-data check off, which is exactly the state the run asked for.
 *
 * @returns the placeholder path, which is never created.
 */
export const withoutGameDataPath = (): string => join(tmpdir(), 'cosmoteer-lint-without-game-data', 'Data');

/**
 * The path to hand the server as `cosmoteerPath`. The server normalizes it again itself, and it
 * accepts the `Data` directory, so the resolved root goes across unchanged.
 *
 * @param resolution the resolution to read the path out of.
 * @returns the configured path, or the placeholder when there is no usable game tree.
 */
export const configuredGamePath = (resolution: GameDataResolution): string =>
    resolution.kind === 'found' ? resolution.dataRoot : withoutGameDataPath();
