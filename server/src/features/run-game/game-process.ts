import { execFile, spawn } from 'child_process';
import { open, stat } from 'fs/promises';
import { join } from 'path';
import { steamInstallPaths } from '../../workspace/steam-library';

/**
 * Starting the game, and telling whether it is already running.
 *
 * Both matter for the same reason: the game rewrites the whole of `settings.rules` from memory when
 * it exits, so anything written into that file while it runs is destroyed without a trace. A probe
 * that cannot answer counts as "running", since refusing to launch is recoverable and silently
 * losing the user's edit is not.
 */

/** Cosmoteer's Steam app id, used to launch it through the Steam client. */
const COSMOTEER_APP_ID = '799600';

/** The game executable's name, which is also the process name under Proton. */
const GAME_EXECUTABLE = 'Cosmoteer.exe';

/** Whether the game is running, or that the probe could not tell. */
export type GameLiveness = 'running' | 'not-running' | 'unknown';

/** Runs a command and answers its stdout, or null when it could not be run. */
const output = (command: string, args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
        execFile(command, args, { timeout: 4000, windowsHide: true }, (error, stdout) => {
            // A non-zero exit is meaningful for pgrep (nothing matched) and is not a failure to run,
            // so the caller sees the empty output rather than a null.
            resolve(error && (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : stdout);
        });
    });

/**
 * Whether Cosmoteer is running right now.
 *
 * Two layers: on Windows the executable image is mapped while the game runs and cannot be opened
 * for writing, which costs one syscall and needs no child process, and then the process list is
 * consulted for an authoritative answer.
 *
 * @param installRoot the game install root.
 * @returns whether the game is running, or unknown when nothing could establish it.
 */
export const gameLiveness = async (installRoot: string): Promise<GameLiveness> => {
    if (process.platform === 'win32') {
        const handle = await open(join(installRoot, 'Bin', GAME_EXECUTABLE), 'r+').catch((error: NodeJS.ErrnoException) =>
            error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES' ? 'busy' : null
        );
        if (handle === 'busy') return 'running';
        if (handle && typeof handle !== 'string') await handle.close().catch(() => undefined);
        const tasks = await output('tasklist', ['/FI', `IMAGENAME eq ${GAME_EXECUTABLE}`, '/NH']);
        if (tasks === null) return 'unknown';
        return tasks.includes(GAME_EXECUTABLE) ? 'running' : 'not-running';
    }
    if (process.platform === 'linux') {
        const found = await output('pgrep', ['-f', GAME_EXECUTABLE]);
        if (found === null) return 'unknown';
        return found.trim() === '' ? 'not-running' : 'running';
    }
    return 'unknown';
};

/** The Steam client executable, which is how the game is launched with extra arguments. */
export const findSteamExecutable = async (installRoot: string): Promise<string | undefined> => {
    const executable = process.platform === 'win32' ? 'steam.exe' : 'steam.sh';
    const candidates = [...(await steamInstallPaths())];
    // The library the game sits in is often the Steam install itself: `<lib>/steamapps/common/<game>`.
    candidates.push(join(installRoot, '..', '..', '..'));
    if (process.platform === 'win32') {
        candidates.push('C:/Program Files (x86)/Steam', 'C:/Program Files/Steam');
    }
    for (const candidate of candidates) {
        const path = join(candidate, executable);
        if (await stat(path).then((entry) => entry.isFile()).catch(() => false)) return path;
    }
    return undefined;
};

/**
 * Starts the game with developer mode on, detached, so it outlives the language server.
 *
 * Preferred route is the Steam client: the game asks Steam to relaunch it when it was started
 * outside Steam, which kills the process we started and loses the arguments with it. Steam sets the
 * app id itself, so the flag survives, and on Linux it applies Proton. Started directly, the same
 * relaunch is suppressed by setting the app id in the environment.
 *
 * @param installRoot the game install root, which is also the working directory the game expects.
 * @param steamExecutable the Steam client executable, when one was found.
 * @param onError called with a human-readable reason when the process could not be started.
 */
export const launchGame = (
    installRoot: string,
    steamExecutable: string | undefined,
    onError: (message: string) => void
): void => {
    const viaSteam = steamExecutable !== undefined;
    const command = steamExecutable ?? join(installRoot, 'Bin', GAME_EXECUTABLE);
    const args = viaSteam ? ['-applaunch', COSMOTEER_APP_ID, '--devmode'] : ['--devmode'];
    const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        cwd: installRoot,
        env: viaSteam ? process.env : { ...process.env, SteamAppId: COSMOTEER_APP_ID },
    });
    child.on('error', (error) => onError(`${command}: ${error.message}`));
    child.unref();
};
