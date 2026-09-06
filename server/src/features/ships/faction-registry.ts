import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { parseModActions } from '../../mod/action-parser';
import { normalizeTargetPath } from '../../mod/action-target-resolver';
import { namedMembersOf } from '../../utils/ast.utils';
import { manifestsIn, referenceTextsOf } from '../refactor/register-part/ship-registry';
import { dirOf, locationOf, readRulesFile, resolveBasePath } from '../refactor/shared-base/base-index';
import { ShipLayerContext } from './ship-layer.index';

/**
 * The factions a ship can belong to: the ones the game's own `factions/factions.rules` lists, and
 * the ones a workspace mod adds to that list from its manifest.
 *
 * Read off the registry rather than off an id index for the reason the ship registry is: a faction
 * reaches the game only through the `Factions` list the game root names, and a mod's faction gets
 * there through an `AddMany` into it, which is exactly what has to be read to know it exists.
 */

/** One faction the game would load. */
export interface FactionEntry {
    /** The faction's id, as written. */
    readonly id: string;
    /** The localization key of its name, absent when the entry writes none. */
    readonly nameKey?: string;
    /** Its military and civilian player indexes, absent when the entry writes none. */
    readonly militaryPlayerIndex?: number;
    readonly civilianPlayerIndex?: number;
    /** Whether the game's own files declare it or a workspace mod adds it. */
    readonly source: 'game' | 'mod';
    /** The file the faction group is written in. */
    readonly fsPath: string;
    /** The mod that adds it, only for a `mod` entry. */
    readonly modRoot?: string;
}

/** The game root member naming the faction registry. */
const FACTIONS_MEMBER = 'Factions';

/** The action target the registry is named by, however a manifest spells it. */
const FACTIONS_TARGET_KEY = normalizeTargetPath('<factions/factions.rules>/Factions').toLowerCase();

/** The verbs that put a new faction into the registry. */
const ADDING_VERBS = new Set(['Add', 'AddMany']);

/** The `<…>` span of a reference, whatever member path follows it. */
const REFERENCE_FILE = /^\s*&?\s*<([^<>]+)>(.*)$/;

/**
 * A member of a group, matched ignoring case.
 *
 * @param group the group.
 * @param name the member name.
 * @returns the member's value, or undefined.
 */
const memberOf = (group: GroupNode, name: string): AbstractNode | undefined => {
    const lower = name.toLowerCase();
    for (const [memberName, node] of namedMembersOf(group)) if (memberName.toLowerCase() === lower) return node;
    return undefined;
};

/** The text of a scalar member, or undefined when the group has none of that name. */
const textMember = (group: GroupNode, name: string): string | undefined => {
    const node = memberOf(group, name);
    return node && isValueNode(node) ? String(node.valueType.value).trim() : undefined;
};

/** The number of a scalar member, or undefined when it is not one. */
const numberMember = (group: GroupNode, name: string): number | undefined => {
    const text = textMember(group, name);
    if (text === undefined) return undefined;
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
};

/**
 * The faction a group declares, when it declares an id.
 *
 * @param group the group.
 * @param fsPath the file it is written in.
 * @param source whose file that is.
 * @param modRoot the mod adding it, for a mod entry.
 * @returns the entry, or undefined when the group names no faction.
 */
const factionOf = (
    group: GroupNode,
    fsPath: string,
    source: FactionEntry['source'],
    modRoot?: string
): FactionEntry | undefined => {
    const id = textMember(group, 'ID');
    if (!id) return undefined;
    return {
        id,
        nameKey: textMember(group, 'NameKey'),
        militaryPlayerIndex: numberMember(group, 'MilitaryPlayerIndex'),
        civilianPlayerIndex: numberMember(group, 'CivilianPlayerIndex'),
        source,
        fsPath: fsPath.replace(/\\/g, '/'),
        modRoot,
    };
};

/**
 * The factions a list's elements declare: inline groups as they are, and references by reading the
 * group or list they name.
 *
 * @param elements the list's elements.
 * @param declaringDir the directory the references resolve against.
 * @param source whose files these are.
 * @param modRoot the mod adding them, for mod entries.
 * @param fsPath the file the list is written in.
 * @returns the entries, in written order.
 */
const factionsIn = async (
    elements: readonly AbstractNode[],
    declaringDir: string,
    source: FactionEntry['source'],
    fsPath: string,
    modRoot?: string
): Promise<FactionEntry[]> => {
    const entries: FactionEntry[] = [];
    for (const element of elements) {
        if (isGroupNode(element)) {
            const entry = factionOf(element, fsPath, source, modRoot);
            if (entry) entries.push(entry);
            continue;
        }
        if (!isValueNode(element) || element.valueType.type !== 'Reference') continue;
        entries.push(...(await factionsAt(String(element.valueType.value), declaringDir, source, modRoot)));
    }
    return entries;
};

/**
 * The factions a reference names: a group is one faction, a list is every faction in it, and a whole
 * file is read at its top-level `Factions` list.
 *
 * @param reference the reference's text.
 * @param declaringDir the directory it resolves against.
 * @param source whose file it names.
 * @param modRoot the mod adding them, for mod entries.
 * @returns the entries.
 */
const factionsAt = async (
    reference: string,
    declaringDir: string,
    source: FactionEntry['source'],
    modRoot?: string
): Promise<FactionEntry[]> => {
    const location = locationOf(reference, declaringDir);
    let fsPath: string | undefined;
    let groupPath: string[];
    if (location) {
        fsPath = location.fsPath;
        groupPath = location.groupPath;
    } else {
        const match = REFERENCE_FILE.exec(reference);
        fsPath = match ? resolveBasePath(match[1], declaringDir)?.replace(/\\/g, '/') : undefined;
        groupPath = [FACTIONS_MEMBER];
    }
    if (!fsPath) return [];
    const file = await readRulesFile(fsPath);
    if (!file) return [];
    let node: AbstractNode | AbstractNodeDocument | undefined = file.document;
    for (const segment of groupPath) {
        const container = node as { elements?: AbstractNode[] } | undefined;
        if (!container?.elements) return [];
        const lower = segment.toLowerCase();
        node = namedMembersOf(container as { elements: AbstractNode[] }).find(([name]) => name.toLowerCase() === lower)?.[1];
        if (!node) return [];
    }
    if (isGroupNode(node)) {
        const entry = factionOf(node, fsPath, source, modRoot);
        return entry ? [entry] : [];
    }
    if (isListNode(node)) return await factionsIn(node.elements, dirOf(fsPath), source, fsPath, modRoot);
    return [];
};

/**
 * Every faction the game would load: the game's own, then the ones each workspace mod adds.
 *
 * @param context the game root and the workspace folders.
 * @param modRoots the workspace mod roots whose manifests may add factions.
 * @param token cancels the reads.
 * @returns the factions, the game's own first, each id once.
 */
export const collectFactions = async (
    context: ShipLayerContext,
    modRoots: readonly string[],
    token: CancellationToken
): Promise<FactionEntry[]> => {
    const entries: FactionEntry[] = [];
    const seen = new Set<string>();
    const push = (entry: FactionEntry): void => {
        const key = entry.id.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        entries.push(entry);
    };

    if (context.gameRootDocument && context.gameRootPath) {
        const root = namedMembersOf(context.gameRootDocument).find(
            ([name]) => name.toLowerCase() === FACTIONS_MEMBER.toLowerCase()
        )?.[1];
        const declaringDir = dirOf(context.gameRootPath);
        if (root && isValueNode(root) && root.valueType.type === 'Reference') {
            for (const entry of await factionsAt(String(root.valueType.value), declaringDir, 'game')) push(entry);
        } else if (root && isListNode(root)) {
            for (const entry of await factionsIn(root.elements, declaringDir, 'game', context.gameRootPath)) push(entry);
        }
    }

    for (const modRoot of modRoots) {
        if (token.isCancellationRequested) break;
        for (const manifestFsPath of manifestsIn(modRoot)) {
            const file = await readRulesFile(manifestFsPath);
            if (!file) continue;
            const declaringDir = dirOf(manifestFsPath);
            for (const action of parseModActions(file.document)) {
                if (!ADDING_VERBS.has(action.type)) continue;
                const hits = action.targets.some(
                    (target) => normalizeTargetPath(String(target.valueType.value)).toLowerCase() === FACTIONS_TARGET_KEY
                );
                if (!hits) continue;
                for (const source of action.sources) {
                    if (isGroupNode(source)) {
                        const entry = factionOf(source, manifestFsPath, 'mod', modRoot);
                        if (entry) push(entry);
                        continue;
                    }
                    if (isListNode(source)) {
                        for (const entry of await factionsIn(source.elements, declaringDir, 'mod', manifestFsPath, modRoot)) {
                            push(entry);
                        }
                        continue;
                    }
                    for (const reference of referenceTextsOf(source)) {
                        for (const entry of await factionsAt(reference, declaringDir, 'mod', modRoot)) push(entry);
                    }
                }
            }
        }
    }
    return entries;
};
