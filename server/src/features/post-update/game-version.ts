import { readFile, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { OPCODES, isTokenOpcode, readAssembly } from '../mod-schema/dotnet-assembly';
import { listEntries, listMember } from '../../mod/mod-dependencies';
import { currentGameVersionsLiteral } from '../diagnostics/validator.manifest-version';

/**
 * What the installed game says about versions, read out of the game's own assembly.
 *
 * Two facts live in `Cosmoteer.Versions`: the constant `GameVersion`, which is the version the
 * installed build reports, and the static array `ModCompatibleGameVersions`, which is the set of
 * older versions whose mods this build still accepts. Both decide whether a mod survives a game
 * update, so both are read from the install rather than from a string kept in this repository,
 * which would rot on the next release.
 *
 * The game uses them in two places. `ModInfo.IsCompatibleWithGameVersion` answers true when the
 * mod's `CompatibleGameVersions` names the installed version or any member of the accepted set.
 * `Assets.ApplyPreLoadMods` only runs the sweep that acts on that answer when the auto-disable
 * setting is on and the version last played is neither the installed one nor a member of the
 * accepted set. Both facts come from the shipped IL, so the report states the game's rule rather
 * than a guess about it.
 */

/** The type in the game assembly that carries both version facts. */
const VERSIONS_TYPE = 'Cosmoteer.Versions';

/** The static field holding the older versions the build still accepts a mod for. */
const ACCEPTED_FIELD = 'ModCompatibleGameVersions';

/** The constant field holding the installed build's own version. */
const INSTALLED_FIELD = 'GameVersion';

/** Where the version facts came from, so the report can say how sure it is. */
type GameVersionSource = 'assembly' | 'manifest' | 'none';

/** The version facts of one install. */
export interface GameVersionInfo {
    /** The version the installed build reports, empty when it could not be read. */
    readonly installed: string;
    /**
     * Every version this build accepts a mod for, oldest first, with {@link GameVersionInfo.installed}
     * last. Empty when neither the assembly nor the shipped manifests could be read.
     */
    readonly accepted: readonly string[];
    /** How the facts were obtained. */
    readonly source: GameVersionSource;
    /** The assembly the facts were read from, so the report can name the file. */
    readonly assemblyPath?: string;
}

/** The empty answer, used when there is no install to read. */
const NO_INFO: GameVersionInfo = { installed: '', accepted: [], source: 'none' };

/** Memoized reads, keyed by the assembly's path, size and modification time. */
const infoMemo = new Map<string, GameVersionInfo>();

/**
 * The game assembly that belongs to a `Data` root.
 *
 * @param dataRoot the game `Data` root.
 * @returns the path of `Bin/Cosmoteer.dll` beside it.
 */
export const gameAssemblyPathFor = (dataRoot: string): string => join(dirname(dataRoot), 'Bin', 'Cosmoteer.dll');

/**
 * Read the version facts of the installed game.
 *
 * The assembly is read once per build of the game: the memo is keyed on the file's size and
 * modification time, so an update to the install is picked up without a restart. A failure to read
 * it falls back to the `CompatibleGameVersions` the shipped Standard Mods declare, which the
 * developers keep at the current version, and that fallback yields the installed version alone,
 * never an accepted set. The report says which of the two it got.
 *
 * @param dataRoot the game `Data` root, or undefined when no install is configured.
 * @returns the version facts, with an empty installed version when nothing could be read.
 */
export const readGameVersionInfo = async (dataRoot: string | undefined): Promise<GameVersionInfo> => {
    if (!dataRoot) return NO_INFO;
    const assemblyPath = gameAssemblyPathFor(dataRoot);
    const stamp = await stat(assemblyPath).catch(() => undefined);
    const key = stamp ? `${assemblyPath}|${stamp.size}|${Math.round(stamp.mtimeMs)}` : '';
    const memoized = key ? infoMemo.get(key) : undefined;
    if (memoized) return memoized;
    const fromAssembly = stamp ? await readFromAssembly(assemblyPath) : undefined;
    const info = fromAssembly ?? (await readFromStandardMods());
    if (key) infoMemo.set(key, info);
    return info;
};

/** Drop the memoized reads, which a test and a changed install path both need. */
export const clearGameVersionInfoCache = (): void => {
    infoMemo.clear();
};

/**
 * Read both version facts out of the game assembly.
 *
 * The accepted set is built in the type's static constructor as a plain array of string literals,
 * so the literals loaded before the store into the field are the set, in the order the game holds
 * them. Anything else that constructor builds (the copyright line) is loaded after the store and
 * stays out.
 *
 * @param assemblyPath the assembly to read.
 * @returns the facts, or undefined when the file carries no readable metadata or lacks the type.
 */
const readFromAssembly = async (assemblyPath: string): Promise<GameVersionInfo | undefined> => {
    const buffer = await readFile(assemblyPath).catch(() => undefined);
    if (!buffer) return undefined;
    const assembly = tryReadAssembly(assemblyPath, buffer);
    const versions = assembly?.typeByFullName.get(VERSIONS_TYPE);
    if (!assembly || !versions) return undefined;
    const installedConstant = versions.fields.find((field) => field.name === INSTALLED_FIELD)?.constant;
    const installed = typeof installedConstant === 'string' ? installedConstant : '';
    const older: string[] = [];
    for (const method of versions.methods) {
        if (method.name !== '.cctor') continue;
        const pending: string[] = [];
        for (const instruction of method.body()) {
            if (instruction.opcode === OPCODES.ldstr && typeof instruction.operand === 'string') {
                pending.push(instruction.operand);
                continue;
            }
            if (typeof instruction.operand !== 'number' || !isTokenOpcode(instruction.opcode)) continue;
            if (assembly.fieldNameOfToken(instruction.operand) !== ACCEPTED_FIELD) continue;
            older.push(...pending);
            break;
        }
        break;
    }
    if (!installed && older.length === 0) return undefined;
    return { installed, accepted: orderedAccepted(older, installed), source: 'assembly', assemblyPath };
};

/**
 * Read one assembly without letting a malformed file reach the caller as an exception.
 *
 * @param assemblyPath the file the bytes came from.
 * @param buffer the assembly's bytes.
 * @returns the parsed assembly, or undefined when it cannot be read.
 */
const tryReadAssembly = (assemblyPath: string, buffer: Buffer): ReturnType<typeof readAssembly> => {
    try {
        return readAssembly(assemblyPath, buffer);
    } catch {
        return undefined;
    }
};

/**
 * The fallback read: the version the shipped Standard Mods declare compatibility with.
 *
 * It yields the installed version only. The set of older versions the build still accepts exists
 * nowhere but the assembly, so a report built on this fallback must not claim a mod is going to be
 * disabled.
 *
 * @returns the facts, or the empty answer when the manifests are unreadable too.
 */
const readFromStandardMods = async (): Promise<GameVersionInfo> => {
    const literal = await currentGameVersionsLiteral().catch(() => undefined);
    const installed = literal?.match(/"([^"]+)"/)?.[1] ?? literal?.match(/\[\s*([^\],\s]+)/)?.[1] ?? '';
    if (!installed) return NO_INFO;
    return { installed, accepted: [installed], source: 'manifest' };
};

/**
 * The accepted set in game order: the older versions as the assembly holds them, then the installed
 * one, which the game checks separately and which is therefore the newest entry.
 *
 * @param older the older versions read from the assembly.
 * @param installed the installed version, empty when it could not be read.
 * @returns the ordered set without duplicates.
 */
const orderedAccepted = (older: readonly string[], installed: string): string[] => {
    const ordered = older.filter((version) => version !== installed);
    if (installed) ordered.push(installed);
    return ordered;
};

/**
 * Order two game versions against each other.
 *
 * The only total order over Cosmoteer version names that is not guesswork is the accepted list
 * itself, which the game ships in release order. A version outside that list, an old one the build
 * has stopped accepting or a future one a mod names as forward-proofing, is not ordered at all
 * rather than being ordered by a made-up rule.
 *
 * @param a the first version.
 * @param b the second version.
 * @param accepted the ordered accepted set, oldest first.
 * @returns a negative number when a is older, zero when the two are equal, a positive number when a
 *          is newer, and undefined when either version is not in the accepted set.
 */
export const compareGameVersions = (a: string, b: string, accepted: readonly string[]): number | undefined => {
    if (a === b) return 0;
    const left = accepted.indexOf(a);
    const right = accepted.indexOf(b);
    if (left < 0 || right < 0) return undefined;
    return left - right;
};

/** What the game would make of a mod, given what its manifest declares. */
export type ModVersionVerdict =
    /** The manifest names the installed version. */
    | 'namesInstalled'
    /** The manifest names no installed version but one the build still accepts. */
    | 'namesAccepted'
    /** The manifest declares versions, none of which this build accepts. */
    | 'namesNone'
    /** The manifest declares no `CompatibleGameVersions` at all. */
    | 'undeclared'
    /** The accepted set could not be read, so there is no verdict to give. */
    | 'unknown';

/**
 * What the installed game makes of a manifest's declared versions.
 *
 * This mirrors `ModInfo.IsCompatibleWithGameVersion`: the mod is compatible when its declared list
 * contains the installed version or any member of the accepted set. A manifest that declares
 * nothing is reported separately, because the game reads a missing list as no match at all while
 * still loading the mod whenever it is not running the auto-disable sweep.
 *
 * @param declared the versions the manifest declares, or undefined when it declares no list.
 * @param info the installed game's version facts.
 * @returns the verdict.
 */
export const modVersionVerdict = (declared: readonly string[] | undefined, info: GameVersionInfo): ModVersionVerdict => {
    if (info.source === 'none' || info.accepted.length === 0) return 'unknown';
    if (declared === undefined) return 'undeclared';
    if (info.installed && declared.includes(info.installed)) return 'namesInstalled';
    // The manifest fallback knows the installed version alone, so it cannot tell "names an older
    // accepted version" from "names none", and either answer would be a guess.
    if (info.source !== 'assembly') return 'unknown';
    return declared.some((version) => info.accepted.includes(version)) ? 'namesAccepted' : 'namesNone';
};

/**
 * The `CompatibleGameVersions` a manifest declares, read from its syntax tree.
 *
 * Read through the parsed manifest rather than by matching the raw text, because a mod that keeps a
 * commented-out list above the live one is common in the installed corpus and a text match takes
 * the commented line.
 *
 * @param manifest the parsed manifest.
 * @returns the declared versions, or undefined when the manifest declares no list.
 */
export const declaredCompatibleVersions = (manifest: AbstractNodeDocument): string[] | undefined =>
    listMember(manifest, 'CompatibleGameVersions') ? listEntries(manifest, 'CompatibleGameVersions') : undefined;
