import { resolve } from 'path';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../../core/ast/ast';
import { ActionSource } from '../../../mod/action';
import { parseModActions } from '../../../mod/action-parser';
import { normalizeTargetPath } from '../../../mod/action-target-resolver';
import { namedMembersOf } from '../../../utils/ast.utils';
import { manifestsIn } from '../register-part/ship-registry';
import { dirOf, readRulesFile } from '../shared-base/base-index';

/**
 * The ids a game registry already holds, read off the game's own file and off what the mod's
 * manifests add to it.
 *
 * The registries this serves (toolbar categories, stat lines, toggles, techs) are not indexed by
 * schema class the way parts and resources are, and each is reached from the game root only through
 * nested references, so the file is named outright and read directly. The mod's own entries are
 * found the way the game finds them: through the manifest actions naming the registry, whether the
 * entry is written inline in the action or referenced from a file of the mod.
 */

/** What one registry is and how its entries are identified. */
export interface RegistrySpec {
    /** The game file holding the registry, relative to the `Data` folder, forward slashes. */
    readonly vanillaFile: string;
    /** The member holding the entries, absent when the file's own top-level members are the entries. */
    readonly vanillaMember?: string;
    /**
     * The action targets a manifest names to reach the registry, in every spelling the corpus uses.
     * The game's target walker dereferences intermediate references, so a registry can be named
     * through the file that holds it or through the reference pointing at that file.
     */
    readonly targets: readonly string[];
    /**
     * Whether the entries are named members, so an `Add` action's `Name` is the id and the entry's
     * body carries none. A list-shaped registry identifies each entry by a field inside it instead.
     */
    readonly named?: boolean;
    /** The ids one entry group declares, for a list-shaped registry. */
    readonly idsOfGroup: (group: GroupNode) => string[];
}

/** The `<file>` and member path of a reference, sigil or not. */
const REFERENCE = /^\s*&?\s*<([^<>]+)>(.*)$/;

/**
 * The text of a member holding a plain value, whether it was written bare, quoted or as a reference.
 *
 * @param node the group or document the member sits in.
 * @param name the member's name, matched ignoring case.
 * @returns the value's text, or undefined when the member is absent or not a plain value.
 */
export const memberTextOf = (node: { elements: AbstractNode[] }, name: string): string | undefined => {
    const lower = name.toLowerCase();
    const member = namedMembersOf(node).find(([memberName]) => memberName.toLowerCase() === lower)?.[1];
    if (!isValueNode(member)) return undefined;
    const { type, value } = member.valueType;
    return type === 'String' || type === 'Reference' ? String(value).trim() : undefined;
};

/**
 * The member of a group or document, matched ignoring case.
 *
 * @param node the group or document.
 * @param name the member's name.
 * @returns the member node, or undefined when there is none.
 */
export const memberOf = (node: { elements: AbstractNode[] }, name: string): AbstractNode | undefined => {
    const lower = name.toLowerCase();
    return namedMembersOf(node).find(([memberName]) => memberName.toLowerCase() === lower)?.[1];
};

/** The ids of a `ChoiceID`-bearing list, which a toggle's `Choices` is. */
const choiceIdsOf = (group: GroupNode): string[] => {
    const choices = memberOf(group, 'Choices');
    if (!isListNode(choices)) return [];
    return choices.elements
        .filter(isGroupNode)
        .map((choice) => memberTextOf(choice, 'ChoiceID'))
        .filter((id): id is string => !!id);
};

/** The build toolbar categories, named members of one file. */
export const EDITOR_GROUP_REGISTRY: RegistrySpec = {
    vanillaFile: 'gui/game/designer/editor_groups.rules',
    targets: ['<gui/game/designer/editor_groups.rules>', '<gui/game/designer/build_gui.rules>/EditorGroups'],
    named: true,
    idsOfGroup: () => [],
};

/**
 * The buffs, named members of one file the game root reaches as `Buffs = &<buffs/buffs.rules>`.
 * A mod merges its own in with an `Overrides`, and a member named like a vanilla buff replaces it
 * without a word from the game, which is why a new buff's name is checked here first.
 */
export const BUFF_REGISTRY: RegistrySpec = {
    vanillaFile: 'buffs/buffs.rules',
    targets: ['<buffs/buffs.rules>', '<cosmoteer.rules>/Buffs'],
    named: true,
    idsOfGroup: () => [],
};

/** The tooltip stat lines, a list identified by `ID`. */
export const PART_STAT_REGISTRY: RegistrySpec = {
    vanillaFile: 'gui/game/parts/part_stats.rules',
    vanillaMember: 'PartStats',
    targets: ['<gui/game/parts/part_stats.rules>/PartStats', '<gui/game/game_gui.rules>/PartStats'],
    idsOfGroup: (group) => [memberTextOf(group, 'ID')].filter((id): id is string => !!id),
};

/**
 * The part toggles, a list identified by `ToggleID`, whose choice ids count as taken as well: every
 * choice of every toggle gets a hotkey entry of its own, and a duplicate there throws just as a
 * duplicate toggle does.
 */
export const PART_TOGGLE_REGISTRY: RegistrySpec = {
    vanillaFile: 'gui/game/parts/part_toggles.rules',
    vanillaMember: 'PartToggles',
    targets: ['<gui/game/parts/part_toggles.rules>/PartToggles', '<gui/game/game_gui.rules>/PartToggles'],
    idsOfGroup: (group) => [memberTextOf(group, 'ToggleID'), ...choiceIdsOf(group)].filter((id): id is string => !!id),
};

/** The career techs, a list identified by `ID`, with the aliases an entry's `OtherIDs` adds. */
export const TECH_REGISTRY: RegistrySpec = {
    vanillaFile: 'modes/career/techs.rules',
    vanillaMember: 'Techs',
    targets: ['<modes/career/techs.rules>/Techs', '<modes/career/career.rules>/Techs'],
    idsOfGroup: (group) => {
        const ids = [memberTextOf(group, 'ID')].filter((id): id is string => !!id);
        const others = memberOf(group, 'OtherIDs');
        if (isListNode(others)) {
            for (const element of others.elements) {
                if (isValueNode(element)) ids.push(String(element.valueType.value).trim());
            }
        }
        return ids;
    },
};

/**
 * The path a reference names, resolved against the file it is written in, with the game's
 * install-root spelling read against the data folder the way the game reads it.
 *
 * @param path the path between the angle brackets.
 * @param declaringDir the directory of the file the reference is written in.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the absolute path, forward slashes, or undefined when an install path cannot be read.
 */
export const resolveReferencePath = (
    path: string,
    declaringDir: string,
    dataRoot: string | undefined
): string | undefined => {
    const trimmed = path.trim().replace(/\\/g, '/');
    const install = /^\.\/data\//i.exec(trimmed);
    if (!install) return resolve(declaringDir, trimmed).replace(/\\/g, '/');
    return dataRoot
        ? `${dataRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${trimmed.slice(install[0].length)}`
        : undefined;
};

/**
 * The node a member path names inside a document, walked segment by segment the way the game walks
 * one, names matched ignoring case and a digit segment indexing a list.
 *
 * @param document the parsed file.
 * @param memberPath the path after the file, `/A/B`, empty for the file itself.
 * @returns the node, or undefined when the file does not hold it.
 */
export const nodeAtPath = (
    document: AbstractNodeDocument,
    memberPath: string
): AbstractNode | AbstractNodeDocument | undefined => {
    let current: AbstractNode | AbstractNodeDocument | undefined = document;
    for (const segment of memberPath
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)) {
        if (!current) return undefined;
        if (isListNode(current as AbstractNode) && /^\d+$/.test(segment)) {
            current = (current as { elements: AbstractNode[] }).elements[Number(segment)];
            continue;
        }
        if (!('elements' in current)) return undefined;
        current = memberOf(current, segment);
    }
    return current;
};

/**
 * The entry groups a node holds: the group itself, a list's group elements, or a whole file's
 * top-level groups and the groups of its top-level lists.
 *
 * @param node the node a source or a registry member resolved to.
 * @returns the entry groups.
 */
const entryGroupsOf = (node: AbstractNode | AbstractNodeDocument | undefined): GroupNode[] => {
    if (!node) return [];
    if (isGroupNode(node as AbstractNode)) return [node as GroupNode];
    if (isListNode(node as AbstractNode)) return (node as { elements: AbstractNode[] }).elements.filter(isGroupNode);
    if (!('elements' in node)) return [];
    const groups: GroupNode[] = [];
    for (const element of node.elements) {
        if (isGroupNode(element)) groups.push(element);
        else if (isListNode(element)) groups.push(...element.elements.filter(isGroupNode));
    }
    return groups;
};

/**
 * The entry groups the game's own registry holds.
 *
 * @param spec the registry.
 * @param dataRoot the game's `Data` directory.
 * @returns the file's path and its entries, or undefined when the file cannot be read.
 */
export const vanillaRegistryEntries = async (
    spec: RegistrySpec,
    dataRoot: string
): Promise<
    { readonly fsPath: string; readonly document: AbstractNodeDocument; readonly groups: GroupNode[] } | undefined
> => {
    const fsPath = `${dataRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${spec.vanillaFile}`;
    const file = await readRulesFile(fsPath);
    if (!file) return undefined;
    const holder = spec.vanillaMember ? memberOf(file.document, spec.vanillaMember) : file.document;
    return { fsPath, document: file.document, groups: entryGroupsOf(holder) };
};

/**
 * The ids the game's own registry declares, folded to lower case the way the game matches them.
 *
 * @param spec the registry.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the ids, empty when the file cannot be read.
 */
const vanillaIds = async (spec: RegistrySpec, dataRoot: string | undefined): Promise<string[]> => {
    if (!dataRoot) return [];
    const entries = await vanillaRegistryEntries(spec, dataRoot);
    if (!entries) return [];
    if (spec.named) return namedMembersOf(entries.document).map(([name]) => name);
    return entries.groups.flatMap(spec.idsOfGroup);
};

/**
 * The node an action source stands for: an inline group or list as written, or the node a
 * reference source names, read from the mod's own file or from the install.
 *
 * @param source the action's source.
 * @param declaringDir the directory of the manifest the source is written in.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the node, or undefined when a reference cannot be followed.
 */
const sourceNodeOf = async (
    source: ActionSource,
    declaringDir: string,
    dataRoot: string | undefined
): Promise<AbstractNode | AbstractNodeDocument | undefined> => {
    if (!isValueNode(source)) return source;
    if (source.valueType.type !== 'Reference') return undefined;
    const match = REFERENCE.exec(String(source.valueType.value));
    if (!match) return undefined;
    const fsPath = resolveReferencePath(match[1], declaringDir, dataRoot);
    const referenced = fsPath ? await readRulesFile(fsPath) : undefined;
    return referenced ? nodeAtPath(referenced.document, match[2]) : undefined;
};

/**
 * The member names of a group or a whole file, which are the ids of a named registry.
 *
 * @param node the node a source resolved to.
 * @returns the names, empty for a value or a list.
 */
const memberNamesOf = (node: AbstractNode | AbstractNodeDocument | undefined): string[] => {
    if (!node || isListNode(node as AbstractNode) || !('elements' in node)) return [];
    return namedMembersOf(node).map(([name]) => name);
};

/**
 * The ids the mod's manifests add to a registry, through an inline entry, a list of entries or a
 * reference into one of the mod's own files.
 *
 * A named registry gains members two ways: an `Add` with a `Name` adds that one name, and an
 * `Overrides` merges every member of its source in by name, so the source's member names are the
 * ids it adds, whether the source is written inline or referenced from a file of the mod.
 *
 * @param spec the registry.
 * @param modRoot the mod whose manifests are read.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the ids, in whatever case they are written.
 */
export const modRegisteredIds = async (
    spec: RegistrySpec,
    modRoot: string,
    dataRoot: string | undefined
): Promise<string[]> => {
    const wanted = new Set(spec.targets.map((target) => normalizeTargetPath(target).toLowerCase()));
    const ids: string[] = [];
    for (const manifestFsPath of manifestsIn(modRoot)) {
        const file = await readRulesFile(manifestFsPath);
        if (!file) continue;
        const declaringDir = dirOf(manifestFsPath);
        for (const action of parseModActions(file.document)) {
            const hits = action.targets.some((node) =>
                wanted.has(normalizeTargetPath(String(node.valueType.value)).toLowerCase())
            );
            if (!hits) continue;
            if (spec.named) {
                const name = action.nameNode ? String(action.nameNode.valueType.value).trim() : '';
                if (name) ids.push(name);
                if (action.type !== 'Overrides') continue;
                for (const source of action.sources) {
                    ids.push(...memberNamesOf(await sourceNodeOf(source, declaringDir, dataRoot)));
                }
                continue;
            }
            for (const source of action.sources) {
                ids.push(...entryGroupsOf(await sourceNodeOf(source, declaringDir, dataRoot)).flatMap(spec.idsOfGroup));
            }
        }
    }
    return ids;
};

/**
 * Every id a registry already holds, from the game's own file and from what the mod adds to it,
 * folded to lower case the way the game matches ids.
 *
 * @param spec the registry.
 * @param modRoot the mod being written to.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the ids.
 */
export const registeredIds = async (
    spec: RegistrySpec,
    modRoot: string,
    dataRoot: string | undefined
): Promise<Set<string>> => {
    const ids = [...(await vanillaIds(spec, dataRoot)), ...(await modRegisteredIds(spec, modRoot, dataRoot))];
    return new Set(ids.map((id) => id.toLowerCase()));
};
