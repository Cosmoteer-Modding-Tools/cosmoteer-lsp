import { copyFile, lstat, readlink, realpath, rename, stat, symlink, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { foldPathCase } from '../../workspace/fs-cache';
import { localModDirs, workshopContentDir } from '../../workspace/workshop-dir';
import { readFile } from 'fs/promises';
import { declaredCompatibleVersions, modVersionVerdict, readGameVersionInfo } from '../post-update/game-version';
import { manifestPathsIn, readManifest } from '../../mod/mod-dependencies';
import { enableModInSettings, enabledModFolders } from './game-settings-file';
import { findSteamExecutable, gameLiveness, launchGame } from './game-process';
import { loadedModKeyOf, sameLoadedMod } from './mod-identity';

/**
 * Running the open mod in the game: link it into the folder the game loads mods from, switch it on
 * in the game's own settings, and start the game with developer mode on.
 *
 * The three ground truths this is built on, all read out of the game's assemblies rather than
 * guessed. First, `EnabledMods` is a filter over the folders the game already discovered, not a
 * list of places to look, so a workspace anywhere else has to be linked into the user's `Mods`
 * folder before switching it on does anything. Second, the game rewrites the whole settings file
 * when it exits, so nothing may be written while it runs. Third, the loader files every enabled mod
 * under its id and version, so a second enabled copy of the same mod throws before any rules are
 * read (see {@link loadedModKeyOf}).
 *
 * Every unknown is a refusal rather than a guess: this writes into the user's game settings and
 * their mods folder, and a wrong guess there is not something the editor can undo for them.
 */

/** The command the clients invoke. */
export const RUN_IN_COSMOTEER_COMMAND = 'cosmoteer.runInCosmoteer';

/** Why the command did nothing. Each one is reported to the user as its own sentence. */
type RunGameRefusal =
    | 'unsupported-platform'
    | 'no-install'
    | 'no-executable'
    | 'no-mod'
    | 'no-user-data'
    | 'no-settings-file'
    | 'game-running'
    | 'duplicate-mod-enabled'
    | 'link-name-taken'
    | 'link-failed'
    | 'settings-unparseable'
    | 'settings-no-game-settings'
    | 'settings-no-enabled-mods'
    | 'settings-not-equivalent'
    | 'settings-bad-entry'
    | 'settings-write-failed';

/** What the command did, or the single reason it refused to do it. */
export type RunGameResult =
    | {
          readonly kind: 'started';
          /** The mod folder as the game sees it, which is the link when one was made. */
          readonly modFolder: string;
          /** Whether a link had to be created, so the client can say where it went. */
          readonly linked: boolean;
          /** Whether the settings file had to be changed, or the mod was already enabled. */
          readonly enabled: boolean;
          /** Where the settings file was backed up, when it was written. */
          readonly backup?: string;
          /**
           * False when the mod's manifest names no game version this build accepts, the installed
           * one or one of the older ones it still takes. The game turns such a mod straight back
           * off while loading, so it never appears and nothing says why.
           */
          readonly compatible: boolean;
      }
    | { readonly kind: 'choose-user-data'; readonly candidates: readonly string[] }
    | { readonly kind: 'refused'; readonly reason: RunGameRefusal; readonly detail?: string };

/** What the command needs from the server, kept behind an interface so it can be driven in tests. */
export interface RunGameHost {
    /** The mod root of the file the command was invoked on. */
    modRoot(): string | null;
    /** Reports a launch failure that happens after the command has already answered. */
    reportError(message: string): void;
}

/** Arguments the clients pass. */
export interface RunGameArgs {
    /** The document the command was invoked from, used to find the mod. */
    readonly uri?: string;
    /** The user data folder to use, when the client has already asked which one. */
    readonly userDataFolder?: string;
}

/** Whether `child` is the same folder as `parent` or sits under it, case-folded like the game's compare. */
const isUnder = (child: string, parent: string): boolean => {
    const a = foldPathCase(resolve(child));
    const b = foldPathCase(resolve(parent));
    return a === b || a.startsWith(b.endsWith('/') || b.endsWith('\\') ? b : `${b}/`) || a.startsWith(`${b}\\`);
};

/**
 * Whether the game already discovers this folder, in which case nothing is linked.
 *
 * The game enumerates the direct children of three roots only: its own `Standard Mods`, the user's
 * `Mods` folder, and the subscribed workshop items. A mod living anywhere else is invisible to it
 * however the settings name it, and a mod living inside one of them must not be linked a second
 * time, since the same mod id loaded twice is a load error.
 *
 * @param modRoot the mod folder in question.
 * @param installRoot the game install root.
 * @param modsDirs the user's mods folders.
 * @returns true when the game already finds it where it is.
 */
export const gameAlreadyDiscovers = (modRoot: string, installRoot: string, modsDirs: readonly string[]): boolean => {
    const workshop = workshopContentDir();
    const roots = [...modsDirs, join(installRoot, 'Standard Mods'), ...(workshop ? [workshop] : [])];
    // Only a direct child of one of those roots is enumerated, so a file deeper inside a mod does
    // not count and neither does the root itself.
    return roots.some((root) => isUnder(modRoot, root) && foldPathCase(resolve(modRoot)) !== foldPathCase(resolve(root)));
};

/** The folder a path really names, following links, or the path itself when it cannot be resolved. */
const realFolder = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path));

/**
 * Another enabled mod folder the game would load under the same key as this mod.
 *
 * The loader keys every enabled mod by its id and version, so a mod the user has both subscribed to
 * and checked out locally is not two mods to it: the second one throws
 * `An item with the same key has already been added` while pre-load mods are applied, and the game
 * dies on the loading screen with nothing said about which mod did it. A folder that resolves to
 * the same place as this mod is skipped, which is what the link from a previous run is.
 *
 * @param modRoot the mod about to be enabled.
 * @param enabled the folders `EnabledMods` already names.
 * @returns the conflicting folder, or null when this mod's key is unreadable or nothing collides.
 */
export const duplicateEnabledMod = async (modRoot: string, enabled: readonly string[]): Promise<string | null> => {
    const key = await loadedModKeyOf(modRoot);
    if (!key) return null;
    const ours = foldPathCase(await realFolder(modRoot));
    for (const folder of enabled) {
        if (foldPathCase(await realFolder(folder)) === ours) continue;
        const other = await loadedModKeyOf(folder);
        if (other && sameLoadedMod(other, key)) return folder;
    }
    return null;
};

/** Whether an existing path is a link that already points at the mod. */
const linkPointsAt = async (linkPath: string, modRoot: string): Promise<boolean> => {
    const target = await readlink(linkPath).catch(() => null);
    if (target === null) return false;
    const resolved = await realpath(linkPath).catch(() => resolve(dirname(linkPath), target));
    return foldPathCase(resolved) === foldPathCase(await realpath(modRoot).catch(() => resolve(modRoot)));
};

/**
 * Makes the mod discoverable by the game, by linking it into the user's mods folder.
 *
 * A junction is used on Windows, which needs no elevation and no developer mode, and which the
 * game's own directory walk follows. An existing folder of the same name is never replaced: it is
 * somebody's content, and the failure to link is recoverable while deleting it is not.
 *
 * @param modRoot the mod to link.
 * @param modsDir the user's mods folder.
 * @returns the linked path, or the reason it could not be linked.
 */
const linkMod = async (
    modRoot: string,
    modsDir: string
): Promise<{ readonly path: string } | { readonly refusal: RunGameRefusal; readonly detail?: string }> => {
    const linkPath = join(modsDir, basename(modRoot));
    const existing = await lstat(linkPath).catch(() => null);
    if (existing) {
        if (existing.isSymbolicLink() && (await linkPointsAt(linkPath, modRoot))) return { path: linkPath };
        return { refusal: 'link-name-taken', detail: linkPath };
    }
    try {
        await symlink(modRoot, linkPath, 'junction');
    } catch (error) {
        return { refusal: 'link-failed', detail: (error as Error).message };
    }
    return { path: linkPath };
};

/**
 * Whether the installed game would read the mod as compatible with itself.
 *
 * This is the game's own rule, `ModInfo.IsCompatibleWithGameVersion`: a mod is compatible when its
 * `CompatibleGameVersions` names the installed version or any member of
 * `Cosmoteer.Versions.ModCompatibleGameVersions`, the roughly twenty older versions the build still
 * accepts. A manifest that declares no list at all is incompatible to the game, since the field is
 * optional and stays null, and null is the first thing that rule turns away. With the game's own
 * `AutoDisableMods` on, a mod it reads as incompatible is removed from the enabled set while the
 * game loads, so it silently never appears however carefully it was enabled here.
 *
 * The manifests are read through the parser. A good part of the workshop corpus keeps a
 * commented-out version list above the live one, and reading a manifest as text takes the commented
 * line and judges the mod by versions its author retired years ago.
 *
 * Every manifest of the mod is read as one list, rather than only the one the game would select.
 * The union can only make the answer more generous, and being generous here costs the user a
 * warning they did not need while being strict costs them a warning that is wrong.
 *
 * @param modRoot the mod to check.
 * @param dataRoot the game `Data` root, whose assembly states which versions the build accepts.
 * @returns false only when a manifest could be read and the game's rule turns it down, so an
 *  unreadable manifest and an unreadable assembly both leave the answer at true rather than raising
 *  a false alarm.
 */
export const gameAcceptsModVersions = async (modRoot: string, dataRoot: string): Promise<boolean> => {
    const info = await readGameVersionInfo(dataRoot).catch(() => undefined);
    if (!info) return true;
    let declared: string[] | undefined;
    let readAnyManifest = false;
    for (const path of manifestPathsIn(modRoot)) {
        const manifest = await readManifest(path);
        if (!manifest) continue;
        readAnyManifest = true;
        const versions = declaredCompatibleVersions(manifest);
        if (versions) declared = [...(declared ?? []), ...versions];
    }
    if (!readAnyManifest) return true;
    const verdict = modVersionVerdict(declared, info);
    return verdict !== 'namesNone' && verdict !== 'undeclared';
};

/** Maps a settings-file refusal onto the command's own reason set. */
const settingsRefusal = (reason: string): RunGameRefusal => {
    switch (reason) {
        case 'unparseable':
            return 'settings-unparseable';
        case 'no-game-settings':
            return 'settings-no-game-settings';
        case 'no-enabled-mods':
            return 'settings-no-enabled-mods';
        case 'bad-entry':
            return 'settings-bad-entry';
        default:
            return 'settings-not-equivalent';
    }
};

/**
 * Links the open mod into the game, switches it on, and launches the game in developer mode.
 *
 * @param args the invoking document, and the chosen user data folder when there was a choice.
 * @param host the server facilities the command needs.
 * @returns what it did, a choice the client has to put to the user, or the reason it refused.
 */
export const runInCosmoteer = async (args: RunGameArgs, host: RunGameHost): Promise<RunGameResult> => {
    // The game ships a Windows executable only. Linux runs it through Proton, which Steam applies, and
    // there is no macOS build at all.
    if (process.platform === 'darwin') return { kind: 'refused', reason: 'unsupported-platform' };

    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return { kind: 'refused', reason: 'no-install' };
    const installRoot = dirname(dataRoot);
    const executable = join(installRoot, 'Bin', 'Cosmoteer.exe');
    if (
        !(await stat(executable)
            .then((entry) => entry.isFile())
            .catch(() => false))
    ) {
        return { kind: 'refused', reason: 'no-executable', detail: executable };
    }

    const modRoot = host.modRoot();
    if (!modRoot) return { kind: 'refused', reason: 'no-mod' };

    const modsDirs = localModDirs();
    if (modsDirs.length === 0) return { kind: 'refused', reason: 'no-user-data' };
    // Which folder the game uses is decided by the Steam account it is signed into, which is not
    // readable from here, so more than one is a question for the user rather than a guess.
    const chosen = args.userDataFolder ?? (modsDirs.length === 1 ? modsDirs[0] : undefined);
    if (!chosen) return { kind: 'choose-user-data', candidates: modsDirs };

    const settingsDir = dirname(chosen);
    const settingsPath = join(settingsDir, 'settings.rules');
    const settingsText = await readFile(settingsPath, 'utf8').catch(() => null);
    // A settings file the game has never written is not one to invent: it holds every setting the
    // user has, and a stub would silently reset all of them.
    if (settingsText === null) return { kind: 'refused', reason: 'no-settings-file', detail: settingsPath };

    // Anything written while the game runs is destroyed when it exits, and a probe that cannot tell
    // counts as running.
    if ((await gameLiveness(installRoot)) !== 'not-running') return { kind: 'refused', reason: 'game-running' };

    // Enabling a mod the user already has enabled from somewhere else does not load it twice, it
    // stops the game from loading at all, so the second copy has to be found before anything is
    // linked or written.
    const enabled = enabledModFolders(settingsText, settingsPath, installRoot, settingsDir);
    const duplicate = await duplicateEnabledMod(modRoot, enabled);
    if (duplicate) return { kind: 'refused', reason: 'duplicate-mod-enabled', detail: duplicate };

    let modFolder = modRoot;
    let linked = false;
    if (!gameAlreadyDiscovers(modRoot, installRoot, modsDirs)) {
        const link = await linkMod(modRoot, join(chosen));
        if ('refusal' in link) return { kind: 'refused', reason: link.refusal, detail: link.detail };
        modFolder = link.path;
        linked = true;
    }

    const result = enableModInSettings(settingsText, settingsPath, installRoot, settingsDir, modFolder);
    if (result.kind === 'refused') return { kind: 'refused', reason: settingsRefusal(result.reason) };

    let backup: string | undefined;
    if (result.kind === 'enabled') {
        backup = `${settingsPath}.bak`;
        try {
            await copyFile(settingsPath, backup);
            // Written beside the file and moved into place, so a failure midway cannot leave the
            // user with half a settings file.
            const temporary = `${settingsPath}.tmp`;
            await writeFile(temporary, result.text, 'utf8');
            await rename(temporary, settingsPath);
        } catch (error) {
            return { kind: 'refused', reason: 'settings-write-failed', detail: (error as Error).message };
        }
    }

    const compatible = await gameAcceptsModVersions(modRoot, dataRoot);
    launchGame(installRoot, await findSteamExecutable(installRoot), host.reportError);
    return { kind: 'started', modFolder, linked, enabled: result.kind === 'enabled', backup, compatible };
};
