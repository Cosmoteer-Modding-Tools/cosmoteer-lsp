import { stat } from 'fs/promises';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { parseModActions } from '../../mod/action-parser';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { effectiveMember } from '../../semantics/effective-member';
import { cachedParseFilePath, foldPathCase } from '../../workspace/fs-cache';
import { PART_RULES_CLASS } from '../part-editor/part-fields';
import { dirOf, locationOf, readRulesFile } from '../refactor/shared-base/base-index';
import {
    collectShipClasses,
    manifestsIn,
    modRootsUnder,
    shipEntryKey,
    shipPartsListOf,
} from '../refactor/register-part/ship-registry';
import { rulesFilesUnder } from '../refactor/shared-base/mod-scan';
import { ShipLayerContext, sourceNodesOf, targetsMember } from '../ships/ship-layer.index';

/**
 * Which parts the table has rows for.
 *
 * A part is what a ship's `Parts` list names. That list is the whole registration in the game: a
 * group no list reaches is a file on disk the game never builds a part from, so the ships are what
 * the catalog walks, the game's own ones and the ones a mod manifest adds alike. A mod registers its
 * parts by appending to a ship's list from its manifest, which is the second source here.
 *
 * A part being authored right now is not registered yet, and leaving it out of the table would hide
 * exactly the part its author is working on. The mod being edited is therefore also read file by
 * file, and any top-level group the schema resolves to `PartRules` joins the catalog.
 */

/** The ship member holding the part list, matched case-insensitively like the game's node lookup. */
const PARTS_MEMBER = 'Parts';

/** The verbs that can put new entries into a ship's `Parts` list. */
const ADDING_VERBS = new Set(['Add', 'AddMany', 'Replace', 'Override', 'Overrides']);

/** How many part files the catalog reads before it stops and reports itself truncated. */
const MAX_PARTS = 2000;

/**
 * How many mod files are read at once while the mod is searched for parts. One at a time left the
 * process idle for most of the search, waiting on the disk between one small file and the next.
 */
const READ_CONCURRENCY = 16;

/** How many files the search remembers before it starts over, well past any one mod. */
const MAX_MEMO_ENTRIES = 50_000;

/** How long a modification time stays too young to prove a file unchanged, as the parse cache has it. */
const MTIME_SETTLE_MS = 2_000;

/** What one mod file was last found to hold, with the stamps that say whether that still holds. */
interface ModPartFileMemo {
    readonly size: number;
    readonly mtimeMs: number;
    /** The top-level groups the schema resolved to a part, by name, empty for most files. */
    readonly groups: readonly string[];
}

/**
 * The part groups every mod file was last found to hold, by folded path. A mod of several thousand
 * files holds its parts in a few dozen of them, and reading all of them again on every change to
 * any one of them is what made the table slow to follow an edit. A file whose size and timestamp
 * still match answers from here with one `stat`, so a repeat search over an unchanged mod costs a
 * sweep of stats rather than a parse per file.
 */
const modPartFiles = new Map<string, ModPartFileMemo>();

/**
 * Runs a task over every item, at most `limit` at a time, keeping the input order in the result.
 *
 * @param items the items to run over.
 * @param limit how many tasks run at once.
 * @param task the task for one item.
 * @returns the results, in the order of the items.
 */
const mapLimit = async <T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await task(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
    return results;
};

/** One part the table can hold a row for. */
export interface CatalogedPart {
    /** The part's identity, `path#group` folded, as {@link shipEntryKey} builds it. */
    readonly key: string;
    /** The file the part group is written in. */
    readonly fsPath: string;
    /** The group's name inside that file. */
    readonly groupName: string;
    /** The mod root the file sits under, absent for a part the game ships. */
    readonly modRoot?: string;
    /** The ship classes whose `Parts` list registers the part, empty for one no ship reaches yet. */
    readonly ships: string[];
}

/** What the catalog is built against and which parts it keeps. */
export interface PartCatalogScope {
    /** The game root and the workspace folders, the same context the ship index is built from. */
    readonly context: ShipLayerContext;
    /** The mod the table is scoped to, absent when the command was invoked outside one. */
    readonly modRoot?: string;
    /**
     * The editor's own parse of a file, so a part being edited is read as the reader sees it rather
     * than as the disk last had it. Answers undefined for a file no editor holds.
     */
    readonly openDocument?: (fsPath: string) => AbstractNodeDocument | undefined;
}

/** The catalog with the flag that says whether it is the whole answer. */
export interface PartCatalog {
    readonly parts: readonly CatalogedPart[];
    /** True when the part cap stopped the walk. */
    readonly truncated: boolean;
}

/**
 * Whether a path sits inside a directory, compared the way the filesystem matches it.
 *
 * @param path the file's path.
 * @param dir the directory to test against.
 * @returns true when the file is that directory or sits under it.
 */
const isUnder = (path: string, dir: string): boolean => {
    const file = foldPathCase(path.replace(/\\/g, '/'));
    const root = foldPathCase(dir.replace(/\\/g, '/').replace(/\/+$/, ''));
    return file === root || file.startsWith(`${root}/`);
};

/**
 * The part groups a list of `Parts` entries names, resolved against the directory the list is
 * written in.
 *
 * @param elements the list's elements.
 * @param declaringDir the directory those references resolve against.
 * @param ship the ship class whose list this is, recorded on every part it names.
 * @param into the catalog being built, keyed so a part two ships register lands once, with both
 *        ships on it.
 */
const collectListedParts = (
    elements: readonly AbstractNode[],
    declaringDir: string,
    ship: string,
    into: Map<string, CatalogedPart>
): void => {
    for (const element of elements) {
        if (!isValueNode(element) || element.valueType.type !== 'Reference') continue;
        const location = locationOf(String(element.valueType.value), declaringDir);
        if (!location || location.groupPath.length === 0) continue;
        const groupName = location.groupPath[0];
        const key = shipEntryKey(location.fsPath, groupName);
        const known = into.get(key);
        if (known) {
            if (!known.ships.includes(ship)) known.ships.push(ship);
            continue;
        }
        into.set(key, { key, fsPath: location.fsPath, groupName, ships: [ship] });
    }
};

/**
 * Every part the ships of the project register, the game's own list and every manifest that appends
 * to one.
 *
 * @param context the game root and workspace folders the ships are read from.
 * @param token cancels the file reads.
 * @param into the catalog being built.
 */
const collectRegisteredParts = async (
    context: ShipLayerContext,
    token: CancellationToken,
    into: Map<string, CatalogedPart>
): Promise<void> => {
    const modRoots = new Set<string>();
    for (const folder of context.folderPaths) for (const modRoot of modRootsUnder(folder)) modRoots.add(modRoot);
    const ships = await collectShipClasses(context.gameRootDocument, context.gameRootPath, [...modRoots], token).catch(
        () => []
    );

    for (const ship of ships) {
        if (token.isCancellationRequested || into.size >= MAX_PARTS) return;
        const parts = await shipPartsListOf(ship.fsPath, ship.groupName).catch(() => undefined);
        if (!parts) continue;
        if (parts.partsList) collectListedParts(parts.partsList.elements, dirOf(ship.fsPath), ship.groupName, into);
        // A ship deriving from another one takes the base's whole list with it, so a mod ship that
        // adds nothing of its own still registers every part the base registers.
        else {
            const inherited = await effectiveMember(parts.group, PARTS_MEMBER, token).catch(() => null);
            if (inherited && isListNode(inherited.node)) {
                collectListedParts(inherited.node.elements, dirOf(ship.fsPath), ship.groupName, into);
            }
        }
    }

    for (const modRoot of modRoots) {
        if (token.isCancellationRequested || into.size >= MAX_PARTS) return;
        for (const manifestFsPath of manifestsIn(modRoot)) {
            const file = await readRulesFile(manifestFsPath);
            if (!file) continue;
            const declaringDir = dirOf(manifestFsPath);
            for (const action of parseModActions(file.document)) {
                if (!ADDING_VERBS.has(action.type)) continue;
                const targets = action.targets.map((target) => String(target.valueType.value));
                for (const ship of ships) {
                    if (!targets.some((target) => targetsMember(target, ship.fsPath, ship.groupName, PARTS_MEMBER))) {
                        continue;
                    }
                    for (const { node, dir } of await sourceNodesOf(action.sources, declaringDir)) {
                        collectListedParts(isListNode(node) ? node.elements : [node], dir, ship.groupName, into);
                    }
                }
            }
        }
    }
};

/**
 * The parts a mod declares that no ship list reaches yet, so a part still being written shows up in
 * the table beside the ones it is meant to compete with.
 *
 * @param modRoot the mod being edited.
 * @param token cancels the walk.
 * @param into the catalog being built.
 * @param openDocument the editor's own parse of a file, for a part being written right now.
 */
const collectModParts = async (
    modRoot: string,
    token: CancellationToken,
    into: Map<string, CatalogedPart>,
    openDocument: PartCatalogScope['openDocument']
): Promise<void> => {
    const files = await rulesFilesUnder(modRoot, token).catch(() => []);
    const found = await mapLimit(files, READ_CONCURRENCY, async (fsPath) =>
        token.isCancellationRequested ? [] : partGroupNamesOf(fsPath, openDocument, token)
    );
    for (let index = 0; index < files.length; index++) {
        for (const groupName of found[index]) {
            if (into.size >= MAX_PARTS) return;
            const key = shipEntryKey(files[index], groupName);
            if (into.has(key)) continue;
            into.set(key, { key, fsPath: files[index], groupName, ships: [] });
        }
    }
};

/**
 * The names of the top-level groups of a document the schema resolves to a part.
 *
 * @param document the parsed file.
 * @returns the group names, in written order.
 */
const partGroupsIn = (document: AbstractNodeDocument): string[] => {
    const names: string[] = [];
    for (const element of document.elements) {
        if (!isGroupNode(element) || !element.identifier) continue;
        if (resolveGroupClass(element) === PART_RULES_CLASS) names.push(element.identifier.name);
    }
    return names;
};

/**
 * The part groups one mod file holds, from the editor's buffer when the file is open, from the
 * memo when the file on disk is the one the memo was taken from, and from a parse otherwise.
 *
 * @param fsPath the file's path.
 * @param openDocument the editor's own parse of a file, absent to read disk alone.
 * @param token cancels the read.
 * @returns the part group names, empty for a file holding none or one that cannot be read.
 */
const partGroupNamesOf = async (
    fsPath: string,
    openDocument: PartCatalogScope['openDocument'],
    token: CancellationToken
): Promise<readonly string[]> => {
    const open = openDocument?.(fsPath);
    if (open) return partGroupsIn(open);
    const key = foldPathCase(fsPath);
    try {
        const stats = await stat(fsPath);
        const memo = modPartFiles.get(key);
        if (memo && memo.size === stats.size && memo.mtimeMs === stats.mtimeMs) return memo.groups;
        const groups = partGroupsIn(await cachedParseFilePath(fsPath, token));
        // A file written within the last moment may be written again inside the same timestamp
        // tick, which the stamps could not tell apart, so it is read again next time rather than
        // remembered.
        if (Date.now() - stats.mtimeMs >= MTIME_SETTLE_MS) {
            if (modPartFiles.size >= MAX_MEMO_ENTRIES) modPartFiles.clear();
            modPartFiles.set(key, { size: stats.size, mtimeMs: stats.mtimeMs, groups });
        }
        return groups;
    } catch {
        return [];
    }
};

/**
 * The parts the table has rows for: everything the project's ships register, plus the parts of the
 * mod being edited, narrowed to the game's own data and that one mod.
 *
 * @param scope the context to read from and the mod to scope to.
 * @param token cancels the reads.
 * @returns the catalog, with the flag that says whether the cap cut it short.
 */
export const catalogParts = async (scope: PartCatalogScope, token: CancellationToken): Promise<PartCatalog> => {
    const found = new Map<string, CatalogedPart>();
    await collectRegisteredParts(scope.context, token, found);
    if (scope.modRoot) await collectModParts(scope.modRoot, token, found, scope.openDocument);

    const dataRoot = scope.context.gameRootPath ? dirOf(scope.context.gameRootPath) : undefined;
    const parts: CatalogedPart[] = [];
    for (const part of found.values()) {
        const inMod = scope.modRoot && isUnder(part.fsPath, scope.modRoot);
        const inGame = dataRoot && isUnder(part.fsPath, dataRoot);
        // With no mod in scope the table is the game's own parts, which is what an editor opened on
        // a game file is asking about.
        if (!inMod && !inGame) continue;
        parts.push(inMod ? { ...part, modRoot: scope.modRoot } : part);
    }
    return { parts, truncated: found.size >= MAX_PARTS };
};

/**
 * The part group a catalog entry names, read from the editor's buffer when the file is open and off
 * disk otherwise.
 *
 * @param part the catalog entry.
 * @param openDocument the editor's own parse of a file, absent to read disk alone.
 * @returns the group, or null when the file no longer holds a top-level group of that name.
 */
export const partGroupOf = async (
    part: CatalogedPart,
    openDocument?: PartCatalogScope['openDocument']
): Promise<GroupNode | null> => {
    // The shared parse cache, so the part's file is the same parse the references out of it
    // resolve through, rather than a second copy in a cache of this feature's own.
    const document = openDocument?.(part.fsPath) ?? (await cachedParseFilePath(part.fsPath).catch(() => undefined));
    if (!document) return null;
    const lower = part.groupName.toLowerCase();
    const group = document.elements.find(
        (element) => isGroupNode(element) && element.identifier?.name.toLowerCase() === lower
    );
    return group && isGroupNode(group) ? group : null;
};
