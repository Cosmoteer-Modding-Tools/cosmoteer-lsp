import { isAbsolute, relative } from 'path';

/**
 * References and asset paths that name a file inside the game's own install.
 *
 * The counterpart of `relativeRulesReference`, which expresses a target relative to the directory
 * the reference is written in. That spelling is right for a target inside the same mod and wrong for
 * one inside the install: written from a mod it comes out as `<../../../../Data/ships/…>`, the bare
 * relative escape `workshop-escape.ts` exists to flag, whose meaning changes the moment the file
 * moves a folder deeper. The game reads a path beginning with `./` from the install root instead, so
 * `<./Data/ships/terran/base_part_terran.rules>/Part` names the same file from any file at any
 * depth. It is also the spelling the game's own example mod writes.
 */

/** The prefix the game reads from the install root rather than from the declaring file. */
const GAME_ROOT_PREFIX = './Data/';

/**
 * A path the game reads from the install root, built from a path relative to the `Data` folder.
 *
 * @param relativeToDataRoot the file's path below the game's `Data` folder, forward slashes.
 * @returns the install-root path.
 */
export const gameRootPathOf = (relativeToDataRoot: string): string =>
    `${GAME_ROOT_PREFIX}${relativeToDataRoot.replace(/^[./]+/, '')}`;

/**
 * A reference naming a group inside a file of the game install, built from a path relative to the
 * `Data` folder.
 *
 * @param relativeToDataRoot the file's path below the game's `Data` folder, forward slashes.
 * @param member the name of the group inside that file, omitted to reference the file itself.
 * @returns the reference text, with no leading sigil.
 */
export const gameRootReferenceOf = (relativeToDataRoot: string, member?: string): string =>
    `<${gameRootPathOf(relativeToDataRoot)}>${member ? `/${member}` : ''}`;

/**
 * The path of a file inside the game install, in the form the game reads from the install root.
 *
 * @param dataRoot the game's `Data` directory.
 * @param toFile the on-disk path of the file being named.
 * @returns the path, forward slashes on every platform, or undefined when the file is not inside
 * the install and so cannot be named this way.
 */
export const gameRootPath = (dataRoot: string, toFile: string): string | undefined => {
    const rel = relative(dataRoot, toFile).replace(/\\/g, '/');
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return gameRootPathOf(rel);
};

/**
 * An inheritance reference naming a group inside a file of the game install.
 *
 * @param dataRoot the game's `Data` directory.
 * @param toFile the on-disk path of the file being referenced.
 * @param member the name of the group inside that file, omitted to reference the file itself.
 * @returns the reference text with no leading sigil, or undefined when the file is not inside the
 * install.
 */
export const gameRootReference = (dataRoot: string, toFile: string, member?: string): string | undefined => {
    const path = gameRootPath(dataRoot, toFile);
    return path === undefined ? undefined : `<${path}>${member ? `/${member}` : ''}`;
};
