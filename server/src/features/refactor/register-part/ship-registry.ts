import { readdirSync } from 'fs';
import { join, resolve } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../../core/ast/ast';
import { isManifestBasename } from '../../../document/document-kind';
import { ActionSource } from '../../../mod/action';
import { parseModActions } from '../../../mod/action-parser';
import { normalizeTargetPath } from '../../../mod/action-target-resolver';
import { namedMembersOf } from '../../../utils/ast.utils';
import { foldPathCase } from '../../../workspace/fs-cache';
import { dirOf, locationOf, readRulesFile } from '../shared-base/base-index';

/** The game root's member holding the registry, matched case-insensitively like the game's lookup. */
const SHIPS_MEMBER = 'Ships';

/** The registry's canonical target path, the one a manifest action has to name to add a ship. */
const SHIPS_TARGET_KEY = normalizeTargetPath(`<cosmoteer.rules>/${SHIPS_MEMBER}`).toLowerCase();

/** The verbs that can put a new element into the game root's `Ships` list. */
const REGISTERING_VERBS = new Set(['Add', 'AddMany', 'Replace']);

/** How deep below a workspace folder a mod's manifest is looked for. */
const MAX_MOD_DEPTH = 4;

/** Directories the mod walk never enters, none of which a mod keeps its manifest in. */
const SKIPPED_DIRS = new Set(['.git', '.hg', '.svn', '.vscode', '.idea', 'node_modules', 'out', 'dist', 'bin', 'obj']);

/** One ship class the game loads, and where its declaration was reached from. */
export interface ShipClassEntry {
    /** The identity both rounds of the exchange name the ship by, stable across a rescan. */
    key: string;
    /** The file the ship group is written in, with forward slashes. */
    fsPath: string;
    /** The group's name inside that file. */
    groupName: string;
    /** Whether the game's own registry lists the ship, or a mod manifest adds it. */
    via: 'gameRoot' | 'modAction';
    /** The manifest that added the ship, only set for a `modAction` entry. */
    manifestFsPath?: string;
}

/** A ship group as its own file writes it, with the pieces a registration needs. */
export interface ShipParts {
    /** The ship file's source text, which the insertion offsets are measured against. */
    text: string;
    /** That text, parsed. */
    document: AbstractNodeDocument;
    /** The ship's own group. */
    group: GroupNode;
    /** The ship's written `ID`, absent when the group declares none locally. */
    id?: string;
    /** The group's own `Parts` list, absent when it declares none locally. */
    partsList?: ListNode;
    /** Whether the group inherits from anywhere, so an absent local `Parts` may come from a base. */
    inherits: boolean;
}

/**
 * The identity of a group inside a file: its path, canonicalized and case-folded the way the
 * filesystem matches it, plus its name folded the way the game's node lookup matches it. Two
 * spellings of one reference (`<../parts/x.rules>/Part` and `<./Data/parts/X.RULES>/part`) come out
 * equal, which is what makes "is this part already registered" answerable.
 *
 * @param fsPath the file's on-disk path, in any spelling.
 * @param groupName the group's name inside it.
 * @returns the comparison key.
 */
export const shipEntryKey = (fsPath: string, groupName: string): string =>
    `${foldPathCase(resolve(fsPath).replace(/\\/g, '/'))}#${groupName.toLowerCase()}`;

/**
 * Every manifest sitting directly in a mod root, in a deterministic order so a mod holding several
 * of them is always read the same way.
 *
 * @param modRoot the mod's root directory.
 * @returns the manifests' on-disk paths, with forward slashes, empty when the root holds none.
 */
export const manifestsIn = (modRoot: string): string[] =>
    safeNames(modRoot)
        .filter(isManifestBasename)
        .sort()
        .map((name) => join(modRoot, name).replace(/\\/g, '/'));

/**
 * The mod roots below a workspace folder: every directory holding a manifest, the folder itself
 * included. A directory that is already a mod root is not descended into, so a mod's own sub-folders
 * never masquerade as separate mods.
 *
 * @param folder the workspace folder to walk.
 * @returns the mod roots, with forward slashes, empty when the folder holds no mod.
 */
export const modRootsUnder = (folder: string): string[] => {
    const roots: string[] = [];
    const walk = (dir: string, depth: number): void => {
        if (manifestsIn(dir).length > 0) {
            roots.push(dir.replace(/\\/g, '/'));
            return;
        }
        if (depth >= MAX_MOD_DEPTH) return;
        for (const name of safeDirNames(dir)) {
            if (SKIPPED_DIRS.has(name.toLowerCase())) continue;
            walk(join(dir, name), depth + 1);
        }
    };
    walk(folder, 0);
    return roots;
};

/** A directory's entry names, empty when it cannot be read. */
const safeNames = (dir: string): string[] => {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
};

/** A directory's sub-directory names, empty when it cannot be read. */
const safeDirNames = (dir: string): string[] => {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        return [];
    }
};

/** The document's top-level member of that name, matched case-insensitively like the game's lookup. */
const topLevelMemberNamed = (document: AbstractNodeDocument, name: string): AbstractNode | undefined => {
    const lower = name.toLowerCase();
    for (const [memberName, node] of namedMembersOf(document)) {
        if (memberName.toLowerCase() === lower) return node;
    }
    return undefined;
};

/**
 * The reference texts an action source supplies: the reference itself when the source is one, every
 * reference element when it is a list. An inline `{}` group names no file, so it contributes nothing.
 *
 * @param source the action's source value.
 * @returns the reference texts, in written order.
 */
export const referenceTextsOf = (source: ActionSource): string[] => {
    if (isValueNode(source)) {
        return source.valueType.type === 'Reference' ? [String(source.valueType.value)] : [];
    }
    if (isListNode(source)) {
        return source.elements
            .filter(isValueNode)
            .filter((element) => element.valueType.type === 'Reference')
            .map((element) => String(element.valueType.value));
    }
    return [];
};

/** Whether an action target names the game root's ship registry, however it spells the path. */
const targetsShipRegistry = (raw: string): boolean => normalizeTargetPath(raw).toLowerCase() === SHIPS_TARGET_KEY;

/**
 * Every ship class the game loads: the ones the game root's own `Ships [ … ]` registry lists, plus
 * the ones a workspace mod's manifest adds to it. Both are read as written, so a ship reached twice
 * (listed in the game root and re-added by a mod) is reported once.
 *
 * The registry is read rather than an id index consulted on purpose: a mod ship only ever reaches the
 * game through an `AddMany` into `<./Data/cosmoteer.rules>/Ships`, which no id index sees, and the
 * declaring file and group name are exactly what the registration needs anyway.
 *
 * @param rootDocument the game root `cosmoteer.rules`, parsed, absent when the game path is unset.
 * @param rootFsPath that file's on-disk path, which its references resolve against.
 * @param modRoots the workspace mod roots whose manifests may add ships.
 * @param cancellationToken cancels the manifest reads.
 * @returns the ship classes in registry order, mod-added ones last.
 */
export const collectShipClasses = async (
    rootDocument: AbstractNodeDocument | undefined,
    rootFsPath: string | undefined,
    modRoots: readonly string[],
    cancellationToken: CancellationToken
): Promise<ShipClassEntry[]> => {
    const entries: ShipClassEntry[] = [];
    const seen = new Set<string>();
    const push = (
        reference: string,
        declaringDir: string,
        via: ShipClassEntry['via'],
        manifestFsPath?: string
    ): void => {
        const location = locationOf(reference, declaringDir);
        if (!location || location.groupPath.length === 0) return;
        const groupName = location.groupPath[0];
        const key = shipEntryKey(location.fsPath, groupName);
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({ key, fsPath: location.fsPath, groupName, via, manifestFsPath });
    };

    if (rootDocument && rootFsPath) {
        const ships = topLevelMemberNamed(rootDocument, SHIPS_MEMBER);
        if (isListNode(ships)) {
            const declaringDir = dirOf(rootFsPath);
            for (const element of ships.elements) {
                // An inline group in the registry declares a ship with no file of its own, which
                // there is nothing to write a reference to, so it is passed over rather than guessed at.
                if (isValueNode(element) && element.valueType.type === 'Reference') {
                    push(String(element.valueType.value), declaringDir, 'gameRoot');
                }
            }
        }
    }

    for (const modRoot of modRoots) {
        if (cancellationToken.isCancellationRequested) break;
        for (const manifestFsPath of manifestsIn(modRoot)) {
            const file = await readRulesFile(manifestFsPath);
            if (!file) continue;
            const declaringDir = dirOf(manifestFsPath);
            for (const action of parseModActions(file.document)) {
                if (!REGISTERING_VERBS.has(action.type)) continue;
                if (!action.targets.some((target) => targetsShipRegistry(String(target.valueType.value)))) continue;
                // A manifest's source references resolve against the manifest's own directory, never
                // against the game root the target names.
                for (const source of action.sources) {
                    for (const reference of referenceTextsOf(source)) {
                        push(reference, declaringDir, 'modAction', manifestFsPath);
                    }
                }
            }
        }
    }
    return entries;
};

/**
 * A ship group read out of source text the caller already has, so an unsaved buffer is never edited
 * against the bytes on disk.
 *
 * @param text the ship file's source text.
 * @param document that text, parsed.
 * @param groupName the ship group's name.
 * @returns the group with its `ID` and its local `Parts` list, or undefined when the file no longer
 *          holds a top-level group of that name.
 */
export const shipPartsIn = (
    text: string,
    document: AbstractNodeDocument,
    groupName: string
): ShipParts | undefined => {
    const lower = groupName.toLowerCase();
    const group = document.elements.find(
        (element): element is GroupNode => isGroupNode(element) && element.identifier?.name.toLowerCase() === lower
    );
    if (!group) return undefined;
    let id: string | undefined;
    let partsList: ListNode | undefined;
    for (const [name, node] of namedMembersOf(group)) {
        const key = name.toLowerCase();
        if (key === 'id' && isValueNode(node)) id = String(node.valueType.value);
        // Both the `Parts [ … ]` and the `Parts = [ … ]` spellings arrive here as a list node.
        else if (key === 'parts' && isListNode(node)) partsList = node;
    }
    return { text, document, group, id, partsList, inherits: (group.inheritance?.length ?? 0) > 0 };
};

/**
 * A ship group as it stands on disk. Used by the scan round, which only reports what is there and
 * never computes an offset from it.
 *
 * @param shipFsPath the ship file's on-disk path.
 * @param groupName the ship group's name.
 * @returns the group with its `ID` and its local `Parts` list, or undefined when the file cannot be
 *          read or no longer holds that group.
 */
export const shipPartsListOf = async (shipFsPath: string, groupName: string): Promise<ShipParts | undefined> => {
    const file = await readRulesFile(shipFsPath);
    return file ? shipPartsIn(file.text, file.document, groupName) : undefined;
};

/**
 * Whether a set of reference elements already names a part's group. Answers for a ship file's own
 * `Parts` list and for a manifest action's `ManyToAdd`/`ToAdd` sources alike, each with the directory
 * its own references resolve against, so "already registered" is one question with one answer.
 *
 * @param elements the reference elements to look through.
 * @param declaringDir the directory those references are written in.
 * @param partFsPath the part file's on-disk path.
 * @param partGroupName the part group's name inside it.
 * @returns true when one of the elements resolves to that group.
 */
export const partsListRegisters = (
    elements: readonly AbstractNode[],
    declaringDir: string,
    partFsPath: string,
    partGroupName: string
): boolean => {
    const wanted = shipEntryKey(partFsPath, partGroupName);
    for (const element of elements) {
        if (!isValueNode(element) || element.valueType.type !== 'Reference') continue;
        const location = locationOf(String(element.valueType.value), declaringDir);
        if (!location || location.groupPath.length === 0) continue;
        if (shipEntryKey(location.fsPath, location.groupPath[0]) === wanted) return true;
    }
    return false;
};
