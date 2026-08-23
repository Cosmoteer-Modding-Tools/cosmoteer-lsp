import { AbstractNodeDocument } from '../../core/ast/ast';
import { basename } from 'path';
import { manifestPathsIn, readManifest, scalarMember } from '../../mod/mod-dependencies';
import {
    GameVersionInfo,
    declaredCompatibleVersions,
    modVersionVerdict,
    readGameVersionInfo,
} from '../post-update/game-version';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';

/**
 * The key the game files a loaded mod under, and the manifest it reads that key from.
 *
 * `Assets.ApplyPreLoadMods` adds every enabled mod to a dictionary keyed by `Multiplayer.ModData`,
 * whose equality is its `ID` and `Version` compared ordinally. So two enabled folders declaring the
 * same id and version make the game throw "An item with the same key has already been added" before
 * a single rules file is read, whichever folders they are and however they were installed.
 *
 * Which manifest supplies that key is `ModInfo.GetModInfoPath`'s choice, mirrored here.
 */

/** The id and version pair the game keys a loaded mod by, both as written. */
interface ModKey {
    /** The manifest `ID`, in the `author.mod` form the loader requires. */
    readonly id: string;
    /** The manifest `Version`, empty when none is written, the way `ModData` stores it. */
    readonly version: string;
}

/** The manifest basename the game falls back to when a file declares no compatible versions. */
const DEFAULT_MANIFEST = 'mod.rules';

/** The version facts of an install that could not be read, which decides no priority tier. */
const UNREADABLE_VERSIONS: GameVersionInfo = { installed: '', accepted: [], source: 'none' };

/**
 * The selection priority the game gives one manifest, mirroring `ModInfo.GetModInfoPath`.
 *
 * The game scores a manifest that declares versions in three tiers: naming the installed version
 * wins outright, naming one of the older versions the build still accepts comes next, and a file
 * that names neither survives only when it sets `UseThisFileIfNoVersionMatch`. The middle tier
 * needs the build's own `ModCompatibleGameVersions`, which is read out of the game assembly. An
 * install whose assembly cannot be read leaves that tier undecidable, and a file that would have
 * won it is then scored as if it named no accepted version, which is where this stops short of the
 * game.
 *
 * @param manifest the parsed manifest.
 * @param path the manifest's path, whose basename decides the untagged fallback.
 * @param info the installed game's version facts.
 * @returns the priority, or null when the game would not select the file at all.
 */
const manifestPriority = (manifest: AbstractNodeDocument, path: string, info: GameVersionInfo): number | null => {
    if (!scalarMember(manifest, 'ID') || !scalarMember(manifest, 'Name')) return null;
    const declared = declaredCompatibleVersions(manifest);
    if (declared === undefined) return basename(path).toLowerCase() === DEFAULT_MANIFEST ? 0 : null;
    switch (modVersionVerdict(declared, info)) {
        case 'namesInstalled':
            return 3;
        case 'namesAccepted':
            return 2;
        default:
            return scalarMember(manifest, 'UseThisFileIfNoVersionMatch')?.toLowerCase() === 'true' ? 1 : -1;
    }
};

/**
 * The key the game would load a mod folder under.
 *
 * A folder with a single manifest is read from that one whatever it declares, which is what the
 * game does before it scores anything. With several, the highest-priority file wins and ties go to
 * the first, again the game's own rule.
 *
 * @param modFolder the mod folder as the game discovered it.
 * @returns its id and version, or null when no manifest there declares an id.
 */
export const loadedModKeyOf = async (modFolder: string): Promise<ModKey | null> => {
    const paths = manifestPathsIn(modFolder);
    if (paths.length === 0) return null;
    // Only the scoring below needs the version facts, and a single-manifest folder never reaches it.
    const info =
        paths.length === 1
            ? UNREADABLE_VERSIONS
            : await readGameVersionInfo(CosmoteerWorkspaceService.instance.dataRootPath).catch(
                  () => UNREADABLE_VERSIONS
              );

    let chosen: { readonly id: string; readonly version: string; readonly priority: number } | null = null;
    for (const path of paths) {
        const manifest = await readManifest(path);
        if (!manifest) continue;
        const id = scalarMember(manifest, 'ID');
        if (!id) continue;
        const version = scalarMember(manifest, 'Version') ?? '';
        if (paths.length === 1) return { id, version };
        const priority = manifestPriority(manifest, path, info);
        if (priority === null) continue;
        if (!chosen || priority > chosen.priority) chosen = { id, version, priority };
    }
    return chosen ? { id: chosen.id, version: chosen.version } : null;
};

/**
 * Whether the game would file two mods under the same key, and so refuse to load the second.
 *
 * Both halves are compared ordinally, since `ModData.Equals` compares them with `string.Equals`.
 * Two ids differing only in case are two mods to the loader, so they are two mods here as well.
 *
 * @param one the key of one enabled mod.
 * @param other the key of another.
 * @returns true when loading both throws the duplicate-key error.
 */
export const sameLoadedMod = (one: ModKey, other: ModKey): boolean =>
    one.id === other.id && one.version === other.version;
