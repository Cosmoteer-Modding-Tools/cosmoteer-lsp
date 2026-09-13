import { readFile } from 'fs/promises';
import * as l10n from '@vscode/l10n';
import { CancellationToken, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import {
    AbstractNode,
    GroupNode,
    isAssignmentNode,
    isExpressionNode,
    isFunctionCallNode,
    isGroupNode,
    isListNode,
    isMathExpressionNode,
    isValueNode,
    ListNode,
} from '../../core/ast/ast';
import { basenameOf, isModRules } from '../../document/document-kind';
import { flattenGroup, flattenList } from '../../semantics/effective-group';
import { MemberOrigin } from '../../semantics/effective-group.types';
import { evaluateNumericValue } from '../../semantics/value-evaluator';
import { formatWithUnit, unitForValue } from '../../semantics/value-units';
import { offsetToPosition } from '../../utils/text.utils';
import { foldPathCase } from '../../workspace/fs-cache';
import { filePathToUri } from '../navigation/navigation-strategy';
import { uriToFsPath } from '../navigation/workspace-files';
import { CatalogedPart, PartCatalogScope, catalogParts, partGroupOf } from './part-catalog';
import { ResourcePrices, collectResourcePrices, priceOf } from './resource-prices';
import {
    PartStats,
    PartStatsIndex,
    PartTableCell,
    PartTableColumn,
    PartTableData,
    PartTableEditHooks,
    PartTableEditResult,
    PartTableFilter,
    PartTableRow,
    PartTableUnit,
} from './part-table.types';

/**
 * The table behind the part comparison view: one row per part, one column per member path any part
 * carries, every shown value resolved the way the game resolves it.
 *
 * Nothing here decides which columns are interesting. The walk records what the parts actually hold,
 * merged across their inheritance chains and across the manifest actions a mod applies to them, and
 * the view picks from that. A hand-kept column list would go stale on the first game update and
 * would have nothing to say about a mod's own fields. The one exception is the handful of derived
 * columns, the cost in credits and the damage per second, which no file writes and every modder
 * keeps by hand next to the table.
 *
 * Reaching a value and computing it cost very different amounts, so they are separated. Walking a
 * part to its several thousand member paths is a tree walk over already parsed files. Computing one
 * of those values follows references across files and evaluates arithmetic, which is why only the
 * columns the view is showing are computed. That split is what lets the picker offer every field a
 * part has without the table paying for all of them.
 *
 * The walk is kept between requests and repaired rather than redone. A file edit marks the parts
 * written in it or inheriting from it, and the next build walks only those, so a table open beside
 * the editor follows a balancing edit in the time one part takes rather than the whole project.
 *
 * Values are the game's numbers, not the written text: `ShieldHP` is written as a division of two
 * references elsewhere in the same file, and the figure a reader compares is the result. A value
 * that does not evaluate keeps its written spelling, so a string or an enum is still shown.
 */

/** How deep into a part the walk goes. Four hops reach `Components/ArcShield/Radius/BaseValue`. */
const MAX_DEPTH = 5;

/** How many paths one part contributes before its walk stops, a bound on a deeply nested part. */
const MAX_PATHS_PER_PART = 6000;

/** How many columns the view opens with when the reader has picked none. */
const SUGGESTED_COLUMNS = 12;

/** How many parts are walked at once, enough to keep the disk busy while the others compute. */
const WALK_CONCURRENCY = 8;

/** How long after the last file change the view is told, so a run of keystrokes is one rebuild. */
const CHANGE_NOTICE_DELAY_MS = 400;

/** The member holding the part's category tags, one filter axis of the view. */
const CATEGORIES_MEMBER = 'typecategories';

/** The member holding the part's components, the other filter axis. */
const COMPONENTS_MEMBER = 'components';

/** The member a component names its kind in. */
const TYPE_MEMBER = 'type';

/** The member a part declares its id in. */
const ID_MEMBER = 'id';

/** The member naming the build menu group a part sits in, and the list form a part in several uses. */
const EDITOR_GROUP_MEMBER = 'editorgroup';
const EDITOR_GROUPS_MEMBER = 'editorgroups';

/** The list a part prices itself with, keyed by resource id. */
const RESOURCES_MEMBER = 'Resources';

/** The part's footprint, width and height. */
const SIZE_PATHS = ['Size/0', 'Size/1'] as const;

/** The path of the game's own damage per second stat, and the pieces it is computed from. */
const DPS_PATH = 'StatsByCategory/0/Stats/DamagePerSecond';
const DAMAGE_PER_SHOT_PATH = 'StatsByCategory/0/Stats/DamagePerShot';
const ROF_PATH = 'StatsByCategory/0/Stats/ROF';

/** The last path segment a mod writes its barrel count under, whichever component holds it. */
const BARRELS_SEGMENT = 'barrels';

/** A value the walk reached, before anything is computed from it. */
interface ReachedValue {
    readonly node: AbstractNode;
    readonly origin: MemberOrigin;
    /**
     * True when the value comes from a base rather than from the part's own group, at any depth.
     * The origin says only whether the member was found past its own container, and a container
     * the part inherits whole has members that are its own, so the flag is carried down the walk.
     */
    readonly inherited: boolean;
    /**
     * True when a mod's manifest merged the value in, at any depth, the same way. Such a value is
     * written where the manifest writes it, since the manifest is applied after the part's own file
     * and an override added to the part would be overridden right back.
     */
    readonly injected: boolean;
    /** One number for the declaration, so the column tally counts distinct ones without a string per value. */
    readonly declaration: number;
    /** Whether the value is shaped like a number, judged once here rather than once per build. */
    readonly numeric: boolean;
}

/** What one column accumulated while the rows were walked. */
interface ColumnTally {
    rows: number;
    numeric: number;
    /** The distinct declarations the rows read the column from, which is what says whether it varies. */
    declarations: Set<number>;
    /** How many segments the path has, kept so the sort does not split every path per comparison. */
    depth: number;
}

/**
 * A column with the figures the ranking reads and the wire does not. Tens of thousands of columns
 * cross the wire on a first build, so the view gets only what its picker shows.
 */
interface RankedColumn extends PartTableColumn {
    /** How many of the values are shaped like a number, which is what makes a column comparable. */
    readonly numeric: number;
    /** How many distinct declarations the rows read the column from, which says whether it varies. */
    readonly declarations: number;
}

/** The files the walk has read declarations from, numbered in the order they were first seen. */
const declaringFiles = new Map<string, number>();

/** The widest line and column a declaration key can hold, past which two would share a key. */
const KEY_LINES = 0x100000;
const KEY_COLUMNS = 0x10000;

/**
 * One number standing for one declaration: the file, the line and the column packed together.
 * Vanilla alone tallies close to a million values per build, and building a string for each of
 * them was the larger half of the tally.
 *
 * @param origin where the declaration lives.
 * @returns the key.
 */
const declarationKeyOf = (origin: MemberOrigin): number => {
    let file = declaringFiles.get(origin.uri);
    if (file === undefined) {
        file = declaringFiles.size;
        declaringFiles.set(origin.uri, file);
    }
    const line = Math.min(origin.node.position?.line ?? 0, KEY_LINES - 1);
    const column = Math.min(origin.node.position?.characterStart ?? 0, KEY_COLUMNS - 1);
    return (file * KEY_LINES + line) * KEY_COLUMNS + column;
};

/**
 * The uri a client can open, whichever spelling the parsed document carries.
 *
 * @param uri the document's uri or plain path.
 * @returns the `file://` uri.
 */
const clientUri = (uri: string): string => (uri.startsWith('file://') ? uri : filePathToUri(uri));

/**
 * One spelling of a file for identity, whichever form a uri or a path arrives in.
 *
 * @param uriOrPath the file's uri or path.
 * @returns the folded path.
 */
const fileKey = (uriOrPath: string): string => foldPathCase(uriToFsPath(uriOrPath).replace(/\\/g, '/'));

/**
 * A number written with one of the suffixes the game's evaluator rewrites before the arithmetic
 * runs: a percentage becomes a fraction, `d` and `r` become radians. The lexer hands such a literal
 * over as a string, so a shape test is what separates `90d` from an enum member.
 */
const SUFFIXED_NUMBER = /^-?\d*\.?\d+[%dr]?$/;

/** What a reader may type over a cell: a number, with or without one of the game's suffixes. */
const WRITABLE_NUMBER = /^-?\d*\.?\d+([eE][-+]?\d+)?[%dr]?$/;

/**
 * Whether a value could turn into a number, judged from its written shape alone. Deciding it for
 * real means resolving references across files, which is the cost the column picker exists to avoid
 * paying for every field of every part. A literal, a suffixed literal, a reference and an arithmetic
 * expression can all produce a number, a quoted string never does.
 *
 * @param node the value node.
 * @returns true when the value is worth offering as a comparable column.
 */
const looksNumeric = (node: AbstractNode): boolean => {
    if (isExpressionNode(node) || isMathExpressionNode(node) || isFunctionCallNode(node)) return true;
    if (!isValueNode(node) || node.quoted) return false;
    if (node.valueType.type === 'Number' || node.valueType.type === 'Reference') return true;
    return node.valueType.type === 'String' && SUFFIXED_NUMBER.test(String(node.valueType.value).trim());
};

/**
 * The value a cell shows: the number the game computes, rendered with its unit, falling back to the
 * text as written when the value is not numeric.
 *
 * @param node the member's value node.
 * @param token cancels the evaluation.
 * @returns the display text, the number behind it and the unit it carries.
 */
const cellValue = async (
    node: AbstractNode,
    token: CancellationToken
): Promise<{ text: string; value: number | null; unit?: PartTableUnit }> => {
    const value = looksNumeric(node) ? await evaluateNumericValue(node, token).catch(() => null) : null;
    if (value !== null) {
        const unit = await unitForValue([node], token).catch(() => undefined);
        return { text: formatWithUnit(value, unit), value, unit };
    }
    if (isValueNode(node)) return { text: String(node.valueType.value), value: null };
    return { text: '', value: null };
};

/**
 * Whether a list is a table of key and value pairs, the shape `Resources [ [steel, 40] ]` uses. Such
 * a list is addressed by its keys rather than by index, so `Resources/steel` is a column that means
 * the same thing on every part instead of one that means whatever sits second on this one.
 *
 * @param entries the list's flattened entries.
 * @returns true when every entry is a two-element list starting with a name.
 */
const isKeyedPairList = (entries: readonly { readonly value: AbstractNode }[]): boolean =>
    entries.length > 0 &&
    entries.every((entry) => {
        if (!isListNode(entry.value) || entry.value.elements.length !== 2) return false;
        const key = entry.value.elements[0];
        return isValueNode(key) && key.valueType.type !== 'Number';
    });

/** The state one part's walk carries. */
interface PartWalk {
    readonly values: Map<string, ReachedValue>;
    readonly token: CancellationToken;
}

/**
 * Records one reached value, and recurses into it when it is a container.
 *
 * @param path the column path the value sits at.
 * @param node the value node.
 * @param origin where the winning declaration lives.
 * @param depth how far into the part the walk already is.
 * @param walk the part's walk state.
 * @param inheritedAbove whether a container on the way here came from a base.
 * @param injectedAbove whether a container on the way here was merged in by a manifest.
 */
const reach = async (
    path: string,
    node: AbstractNode | null,
    origin: MemberOrigin,
    depth: number,
    walk: PartWalk,
    inheritedAbove: boolean,
    injectedAbove: boolean
): Promise<void> => {
    if (!node || walk.values.size >= MAX_PATHS_PER_PART || walk.token.isCancellationRequested) return;
    const injected = injectedAbove || !!origin.injected;
    const inherited = inheritedAbove || origin.inherited || injected;
    if (isGroupNode(node) || isListNode(node)) {
        await walkContainer(node, path, depth + 1, walk, inherited, injected);
        return;
    }
    walk.values.set(path, {
        node,
        origin,
        inherited,
        injected,
        declaration: declarationKeyOf(origin),
        numeric: looksNumeric(node),
    });
};

/**
 * Walks a group or a list, recording every value it reaches under its path from the part group.
 *
 * @param container the group or list to walk.
 * @param prefix the path leading to it, empty at the part group itself.
 * @param depth how far into the part this container sits.
 * @param walk the part's walk state.
 * @param inherited whether the container itself came from a base rather than the part's own group.
 * @param injected whether the container itself was merged in by a manifest.
 */
const walkContainer = async (
    container: GroupNode | ListNode,
    prefix: string,
    depth: number,
    walk: PartWalk,
    inherited: boolean,
    injected: boolean
): Promise<void> => {
    if (depth > MAX_DEPTH || walk.values.size >= MAX_PATHS_PER_PART || walk.token.isCancellationRequested) return;
    const at = (segment: string): string => (prefix ? `${prefix}/${segment}` : segment);

    if (isGroupNode(container)) {
        const flattened = await flattenGroup(container, walk.token).catch(() => null);
        for (const member of flattened?.members ?? []) {
            await reach(at(member.name), member.value, member.origin, depth, walk, inherited, injected);
        }
        return;
    }

    const flattened = await flattenList(container, walk.token).catch(() => null);
    if (!flattened) return;
    if (isKeyedPairList(flattened.entries)) {
        for (const entry of flattened.entries) {
            const pair = entry.value as ListNode;
            const key = pair.elements[0];
            if (!isValueNode(key)) continue;
            await reach(
                at(String(key.valueType.value)),
                pair.elements[1],
                entry.origin,
                depth,
                walk,
                inherited,
                injected
            );
        }
        return;
    }
    for (let index = 0; index < flattened.entries.length; index++) {
        const entry = flattened.entries[index];
        await reach(at(String(index)), entry.value, entry.origin, depth, walk, inherited, injected);
    }
};

/**
 * The plain string values of a member holding a list of tags, used for the two filter axes.
 *
 * @param group the part group.
 * @param member the member name, folded.
 * @param token cancels the flattening.
 * @returns the tags in written order.
 */
const tagsOf = async (group: GroupNode, member: string, token: CancellationToken): Promise<string[]> => {
    const flattened = await flattenGroup(group, token).catch(() => null);
    const node = flattened?.members.find((entry) => entry.name.toLowerCase() === member)?.value;
    if (!node || !isListNode(node)) return [];
    const list = await flattenList(node, token).catch(() => null);
    return (list?.entries ?? [])
        .map((entry) => (isValueNode(entry.value) ? String(entry.value.valueType.value).trim() : ''))
        .filter((tag) => tag.length > 0);
};

/**
 * The kinds of the part's components, which is what a reader filters shields or thrusters by.
 *
 * @param group the part group.
 * @param token cancels the flattening.
 * @returns the component types, each once, sorted.
 */
const componentTypesOf = async (group: GroupNode, token: CancellationToken): Promise<string[]> => {
    const flattened = await flattenGroup(group, token).catch(() => null);
    const components = flattened?.members.find((entry) => entry.name.toLowerCase() === COMPONENTS_MEMBER)?.value;
    if (!components || !isGroupNode(components)) return [];
    const inner = await flattenGroup(components, token).catch(() => null);
    const types = new Set<string>();
    for (const member of inner?.members ?? []) {
        if (!member.value || !isGroupNode(member.value)) continue;
        const component = await flattenGroup(member.value, token).catch(() => null);
        const type = component?.members.find((entry) => entry.name.toLowerCase() === TYPE_MEMBER)?.value;
        if (type && isValueNode(type)) types.add(String(type.valueType.value).trim());
    }
    return [...types].filter((type) => type.length > 0).sort();
};

/**
 * A plain string member of the part, read through its inheritance chain.
 *
 * @param group the part group.
 * @param member the member name, folded.
 * @param token cancels the flattening.
 * @returns the written value, or an empty string when the part declares none.
 */
const stringMemberOf = async (group: GroupNode, member: string, token: CancellationToken): Promise<string> => {
    const flattened = await flattenGroup(group, token).catch(() => null);
    const node = flattened?.members.find((entry) => entry.name.toLowerCase() === member)?.value;
    return node && isValueNode(node) ? String(node.valueType.value).trim() : '';
};

/**
 * The build menu groups a part sits in, which is how the game itself sorts parts into kinds. A part
 * names one group or a list of them, and the list form is what a part the menu shows twice uses.
 *
 * @param group the part group.
 * @param token cancels the flattening.
 * @returns the group names in written order, empty when the part names none.
 */
const editorGroupsOf = async (group: GroupNode, token: CancellationToken): Promise<string[]> => {
    const single = await stringMemberOf(group, EDITOR_GROUP_MEMBER, token);
    if (single) return [single];
    return tagsOf(group, EDITOR_GROUPS_MEMBER, token);
};

/**
 * One part as the walk left it: everything about it except the values of the shown columns, which
 * are the only part that has to be recomputed when the reader changes what is on screen.
 */
interface WalkedPart {
    readonly part: CatalogedPart;
    readonly group: GroupNode;
    readonly values: Map<string, ReachedValue>;
    readonly id: string;
    readonly categories: readonly string[];
    readonly components: readonly string[];
    readonly editorGroups: readonly string[];
    readonly source: string;
    /** Every file the walk read this part from, folded, so a change to any of them dirties the part. */
    readonly files: ReadonlySet<string>;
}

/**
 * The walk of the last build, kept so narrowing the table to a category costs a re-tally rather
 * than a second pass over every part file, and so an edit costs a re-walk of the parts it touched
 * rather than of every part. The reader's filters change often and the files behind them do not,
 * and the walk is the whole cost of the request.
 */
let walked:
    | {
          key: string;
          modRoot: string | undefined;
          parts: WalkedPart[];
          truncated: boolean;
          prices: ResourcePrices;
          /** The keys of the parts a file change has made stale since the walk. */
          dirty: Set<string>;
          /** True when a file changed that no walked part was read from, which may be a new part. */
          catalogStale: boolean;
      }
    | undefined;

/**
 * Counts the walks this process has kept, so anything worked out from one walk can tell whether it
 * is still looking at the walk the table holds.
 */
let walkVersion = 0;

/**
 * Tells one process from another in a columns version. The counter starts over with the process,
 * and a view that outlives a server restart would otherwise take the new process's first walk for
 * the one it already holds the columns of.
 */
const PROCESS_STAMP = Math.random().toString(36).slice(2, 8);

/** Drops the kept walk, so the next build reads the parts from disk again. */
export const invalidatePartTable = (): void => {
    walked = undefined;
    walkVersion++;
};

/** Who to tell how far a walk has come, set by the request layer. */
let progressListener: ((done: number, total: number) => void) | undefined;

/** How often at most the walk reports its progress. */
const PROGRESS_INTERVAL_MS = 100;

/**
 * Registers the listener told how many parts a walk has read so far. The first walk of a large mod
 * takes seconds, and a view that says which part it is on is one the reader waits for.
 *
 * @param listener what to call, with the parts read and the parts in all.
 */
export const onPartTableProgress = (listener: (done: number, total: number) => void): void => {
    progressListener = listener;
};

/** Who to tell that the table would read differently now, set by the request layer. */
let changeListener: (() => void) | undefined;

/** The pending change notice, so a run of edits becomes one. */
let changeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Registers the listener told when a file change has made the last table stale. There is one
 * consumer, the connection, which forwards it to the view.
 *
 * @param listener what to call, after a short quiet period.
 */
export const onPartTableChange = (listener: () => void): void => {
    changeListener = listener;
};

/** Schedules the change notice, restarting the quiet period on every further change. */
const noteChange = (): void => {
    if (!changeListener) return;
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
        changeTimer = undefined;
        changeListener?.();
    }, CHANGE_NOTICE_DELAY_MS);
};

/**
 * Marks what a file change makes stale in the kept walk. A part written in the file, or reading any
 * of its values from it, is walked again at the next build. A manifest change can rewire every
 * part, so it drops the walk outright. Any change at all is worth telling the view about: a value
 * a part reads through a reference is computed live, so the rows can differ even when no part is
 * walked again.
 *
 * @param uri the uri of the file whose content changed.
 */
export const invalidatePartTableFor = (uri: string): void => {
    if (!walked) return;
    const base = basenameOf(uri).toLowerCase();
    if (isModRules(uri) || base === 'cosmoteer.rules') {
        walked = undefined;
        noteChange();
        return;
    }
    const key = fileKey(uri);
    let ownFile = false;
    for (const part of walked.parts) {
        if (!part.files.has(key)) continue;
        walked.dirty.add(part.part.key);
        if (fileKey(part.part.fsPath) === key) ownFile = true;
    }
    // A file no walked part was read from may be a part being written right now, which only a new
    // catalog finds. A file outside the mod cannot bring a new part, since the game's own registry
    // is what it is.
    if (!ownFile && walked.modRoot && key.startsWith(fileKey(walked.modRoot))) walked.catalogStale = true;
    noteChange();
};

/**
 * Walks one part: every value it holds under its path, plus the axes and the identity the view
 * shows it by.
 *
 * @param part the catalog entry.
 * @param scope the scope, for the open-buffer reads.
 * @param token cancels the reads.
 * @returns the walked part, or null when its group can no longer be read.
 */
const walkPart = async (
    part: CatalogedPart,
    scope: PartCatalogScope,
    token: CancellationToken
): Promise<WalkedPart | null> => {
    const group = await partGroupOf(part, scope.openDocument).catch(() => null);
    if (!group) return null;
    const walk: PartWalk = { values: new Map(), token };
    await walkContainer(group, '', 0, walk, false, false);
    // The values name a handful of files thousands of times over, so each uri is folded once.
    const files = new Set<string>([fileKey(part.fsPath)]);
    const folded = new Map<string, string>();
    for (const value of walk.values.values()) {
        const uri = value.origin.uri;
        let key = folded.get(uri);
        if (key === undefined) {
            key = fileKey(uri);
            folded.set(uri, key);
        }
        files.add(key);
    }
    return {
        part,
        group,
        values: walk.values,
        id: (await stringMemberOf(group, ID_MEMBER, token)) || part.groupName,
        categories: await tagsOf(group, CATEGORIES_MEMBER, token),
        components: await componentTypesOf(group, token),
        editorGroups: await editorGroupsOf(group, token),
        source: part.modRoot ? basenameOf(part.modRoot) || part.modRoot : 'Cosmoteer',
        files,
    };
};

/**
 * The walked parts of a scope, from the kept walk where it is the same scope, repairing the parts
 * a file change has dirtied.
 *
 * @param scope the game context and the mod the table is scoped to.
 * @param token cancels the reads.
 * @returns the walked parts with the flag that says whether the cap cut them short.
 */
const walkScope = async (
    scope: PartCatalogScope,
    token: CancellationToken
): Promise<{ parts: WalkedPart[]; truncated: boolean; prices: ResourcePrices }> => {
    const key = `${scope.context.gameRootPath ?? ''}|${scope.modRoot ?? ''}`;
    const kept = walked?.key === key ? walked : undefined;
    if (kept && kept.dirty.size === 0 && !kept.catalogStale) return kept;

    const catalog =
        !kept || kept.catalogStale
            ? await catalogParts(scope, token)
            : { parts: kept.parts.map((entry) => entry.part), truncated: kept.truncated };
    const prices = !kept || kept.catalogStale ? await collectResourcePrices(scope.context, token) : kept.prices;
    const reusable = new Map<string, WalkedPart>();
    if (kept) for (const entry of kept.parts) if (!kept.dirty.has(entry.part.key)) reusable.set(entry.part.key, entry);

    // The parts are walked a few at a time. Reading a part's files is where the walk waits on the
    // disk, and one part at a time left the process idle for a good part of the first build.
    const walkedParts: Array<WalkedPart | null> = new Array<WalkedPart | null>(catalog.parts.length).fill(null);
    let next = 0;
    let done = 0;
    let rewalked = 0;
    let reportedAt = 0;
    const report = (final: boolean): void => {
        if (!progressListener) return;
        const now = Date.now();
        if (!final && now - reportedAt < PROGRESS_INTERVAL_MS) return;
        reportedAt = now;
        progressListener(done, catalog.parts.length);
    };
    const worker = async (): Promise<void> => {
        for (;;) {
            if (token.isCancellationRequested) return;
            const index = next++;
            if (index >= catalog.parts.length) return;
            const part = catalog.parts[index];
            // A reused walk takes the catalog's fresh entry with it, since which ships register the
            // part is the catalog's to say and may be what changed.
            const reused = reusable.get(part.key);
            if (reused) walkedParts[index] = { ...reused, part };
            else {
                walkedParts[index] = await walkPart(part, scope, token);
                rewalked++;
            }
            done++;
            report(false);
        }
    };
    await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, catalog.parts.length || 1) }, worker));
    report(true);
    const parts = walkedParts.filter((entry): entry is WalkedPart => entry !== null);
    const result = { parts, truncated: catalog.truncated, prices };
    // A cancelled walk is a partial one. Keeping it would serve half the project as the whole of it.
    if (!token.isCancellationRequested) {
        // A repair that walked nothing and found the same parts left every value where it was, and
        // the columns worked out from the old walk still hold. Which ships register a part is not
        // one of those values, so a catalog that only rewired ships keeps the version too.
        const unchanged =
            kept !== undefined &&
            rewalked === 0 &&
            parts.length === kept.parts.length &&
            parts.every((entry, index) => entry.part.key === kept.parts[index].part.key);
        walked = { key, modRoot: scope.modRoot, ...result, dirty: new Set(), catalogStale: false };
        if (!unchanged) walkVersion++;
    }
    return result;
};

/**
 * Whether a part passes the reader's filter. An axis the filter leaves empty narrows nothing.
 *
 * @param part the walked part.
 * @param filter the filter, absent for all parts.
 * @returns true when the part belongs in the table.
 */
const passes = (part: WalkedPart, filter: PartTableFilter | undefined): boolean => {
    if (!filter) return true;
    const { categories, components, sources, editorGroups } = filter;
    if (categories?.length && !categories.some((tag) => part.categories.includes(tag))) return false;
    if (components?.length && !components.some((type) => part.components.includes(type))) return false;
    if (sources?.length && !sources.includes(part.source)) return false;
    if (editorGroups?.length && !editorGroups.some((name) => part.editorGroups.includes(name))) return false;
    return true;
};

/**
 * The values a part holds under a list member, keyed by the list's keys. `Resources/steel` is one.
 *
 * @param entry the walked part.
 * @param member the list member.
 * @returns the reached values by key.
 */
const keyedValuesOf = (entry: WalkedPart, member: string): Array<{ key: string; reached: ReachedValue }> => {
    const prefix = `${member}/`.toLowerCase();
    const found: Array<{ key: string; reached: ReachedValue }> = [];
    for (const [path, reached] of entry.values) {
        if (!path.toLowerCase().startsWith(prefix)) continue;
        const key = path.slice(prefix.length);
        if (!key.includes('/')) found.push({ key, reached });
    }
    return found;
};

/**
 * The value a part holds at a path, matched without regard to case.
 *
 * @param entry the walked part.
 * @param path the column path.
 * @returns the reached value, or undefined when the part holds none there.
 */
const reachedAt = (entry: WalkedPart, path: string): ReachedValue | undefined => {
    const direct = entry.values.get(path);
    if (direct) return direct;
    const lower = path.toLowerCase();
    for (const [key, value] of entry.values) if (key.toLowerCase() === lower) return value;
    return undefined;
};

/**
 * The paths a part holds under a list member, `StatsByCategory/0/Stats/DamagePerSecond/0` and its
 * siblings for a stat written as a range.
 *
 * @param entry the walked part.
 * @param path the list's path.
 * @returns the element paths, in index order.
 */
const elementPathsOf = (entry: WalkedPart, path: string): string[] => {
    const prefix = `${path}/`.toLowerCase();
    return [...entry.values.keys()]
        .filter((key) => key.toLowerCase().startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length)))
        .sort();
};

/**
 * The path of the first value of a part whose last segment is the barrel count, wherever a mod's
 * turret keeps it. The game itself has no such stat, so no fixed path can name it.
 *
 * @param entry the walked part.
 * @returns the path, or undefined when the part has no barrel count.
 */
const barrelsPathOf = (entry: WalkedPart): string | undefined => {
    for (const [path, reached] of entry.values) {
        const cut = path.lastIndexOf('/');
        if (path.slice(cut + 1).toLowerCase() === BARRELS_SEGMENT && looksNumeric(reached.node)) return path;
    }
    return undefined;
};

/** What a row build hands a derived column: the part, the prices, and a memoized evaluator. */
interface DerivedContext {
    readonly entry: WalkedPart;
    readonly prices: ResourcePrices;
    /** The number at a path, computed once per row however many columns read it. */
    readonly numberAt: (path: string) => Promise<number | null>;
}

/** A column the table computes rather than reads. */
interface DerivedColumn {
    readonly path: string;
    readonly label: string;
    readonly description: string;
    readonly unit?: PartTableUnit;
    /** Whether the part holds what the column needs, judged from the paths alone. */
    readonly applies: (entry: WalkedPart) => boolean;
    readonly compute: (context: DerivedContext) => Promise<number | null>;
}

/**
 * The derived columns, in the order the picker lists them. Each is a figure a modder keeps by hand
 * beside the table, and each is computed from values the walk already reached.
 */
const DERIVED: readonly DerivedColumn[] = [
    {
        path: '@Cost',
        label: 'Cost',
        description: 'What the part costs in credits: every resource it takes, at the price the game buys it for.',
        unit: 'credits',
        applies: (entry) => keyedValuesOf(entry, RESOURCES_MEMBER).length > 0,
        compute: async ({ entry, prices, numberAt }) => {
            const resources = keyedValuesOf(entry, RESOURCES_MEMBER);
            if (resources.length === 0) return null;
            let total = 0;
            for (const { key } of resources) {
                const price = priceOf(prices, key);
                const amount = await numberAt(`${RESOURCES_MEMBER}/${key}`);
                // A resource nothing prices leaves the cost unknowable rather than quietly cheaper.
                if (price === undefined || amount === null) return null;
                total += price * amount;
            }
            return total;
        },
    },
    {
        path: '@Tiles',
        label: 'Tiles',
        description: 'How many cells the part covers, its width times its height.',
        applies: (entry) => SIZE_PATHS.every((path) => reachedAt(entry, path) !== undefined),
        compute: async ({ numberAt }) => {
            const width = await numberAt(SIZE_PATHS[0]);
            const height = await numberAt(SIZE_PATHS[1]);
            return width === null || height === null ? null : width * height;
        },
    },
    {
        path: '@DPS',
        label: 'DPS',
        description:
            "Damage per second: the game's own stat where the part declares one, otherwise damage per shot times rate of fire, times the barrels where the part counts them.",
        applies: (entry) =>
            reachedAt(entry, DPS_PATH) !== undefined ||
            elementPathsOf(entry, DPS_PATH).length > 0 ||
            (reachedAt(entry, DAMAGE_PER_SHOT_PATH) !== undefined && reachedAt(entry, ROF_PATH) !== undefined),
        compute: async ({ entry, numberAt }) => {
            let dps: number | null = null;
            if (reachedAt(entry, DPS_PATH)) dps = await numberAt(DPS_PATH);
            else {
                // A stat written as a range, the way a ramping weapon writes its damage, is read at
                // its top: the sustained rate is what the weapon is balanced by.
                const range = elementPathsOf(entry, DPS_PATH);
                if (range.length > 0) {
                    const values = await Promise.all(range.map((path) => numberAt(path)));
                    const known = values.filter((value): value is number => value !== null);
                    dps = known.length > 0 ? Math.max(...known) : null;
                }
            }
            if (dps === null) {
                const perShot = await numberAt(DAMAGE_PER_SHOT_PATH);
                const rate = await numberAt(ROF_PATH);
                if (perShot !== null && rate !== null) dps = perShot * rate;
            }
            if (dps === null) return null;
            const barrels = barrelsPathOf(entry);
            if (!barrels) return dps;
            const count = await numberAt(barrels);
            return count !== null && count > 0 ? dps * count : dps;
        },
    },
];

/** The derived column at a path, when the path names one. */
const derivedAt = (path: string): DerivedColumn | undefined =>
    DERIVED.find((column) => column.path.toLowerCase() === path.toLowerCase());

/** The last path segment a crew-housing component keeps its capacity under. */
const CREW_SEGMENT = 'crew';

/** The component type that houses crew, which is the one whose `Crew` is a capacity. */
const CREW_SOURCE_TYPE = 'crewsource';

/** The member holding a part's alternative ids, which a saved ship may name it by. */
const OTHER_IDS_MEMBER = 'otherids';

/**
 * A memoized number reader over one walked part, the evaluator every derived column shares.
 *
 * @param entry the walked part.
 * @param token cancels the evaluations.
 * @returns the reader.
 */
const numberReader = (entry: WalkedPart, token: CancellationToken): ((path: string) => Promise<number | null>) => {
    const computed = new Map<string, Promise<number | null>>();
    return (path) => {
        const reached = reachedAt(entry, path);
        if (!reached) return Promise.resolve(null);
        let pending = computed.get(path);
        if (!pending) {
            pending = cellValue(reached.node, token).then((cell) => cell.value);
            computed.set(path, pending);
        }
        return pending;
    };
};

/**
 * How many crew a part houses: the `Crew` of every component whose type is a crew source. The
 * `Crew` of any other component is the number that operate it, which is a demand and not a supply.
 *
 * @param entry the walked part.
 * @param numberAt the part's number reader.
 * @returns the capacity, zero for a part that houses nobody.
 */
const crewCapacityOf = async (
    entry: WalkedPart,
    numberAt: (path: string) => Promise<number | null>
): Promise<number> => {
    let capacity = 0;
    for (const path of entry.values.keys()) {
        const segments = path.split('/');
        if (segments.length !== 3 || segments[0].toLowerCase() !== COMPONENTS_MEMBER) continue;
        if (segments[2].toLowerCase() !== CREW_SEGMENT) continue;
        const type = reachedAt(entry, `${segments[0]}/${segments[1]}/Type`);
        if (!type || !isValueNode(type.node)) continue;
        if (String(type.node.valueType.value).trim().toLowerCase() !== CREW_SOURCE_TYPE) continue;
        capacity += (await numberAt(path)) ?? 0;
    }
    return capacity;
};

/**
 * The figures every part of a scope is judged by, keyed by every id it answers to. Built on the
 * same walk the table uses, so a table open beside the editor and a ship being registered read one
 * set of part files.
 *
 * @param scope the game context and the mod the parts come from.
 * @param token cancels the walk.
 * @returns the index.
 */
/**
 * The part's footprint, read from its `Size`.
 *
 * @param numberAt the part's number reader.
 * @returns width and height in cells, or null when either is unreadable.
 */
const sizeOf = async (
    numberAt: (path: string) => Promise<number | null>
): Promise<readonly [number, number] | null> => {
    const width = await numberAt(SIZE_PATHS[0]);
    const height = await numberAt(SIZE_PATHS[1]);
    return width !== null && height !== null ? [width, height] : null;
};

export const partStatsIndex = async (scope: PartCatalogScope, token: CancellationToken): Promise<PartStatsIndex> => {
    const byId = new Map<string, PartStats>();
    if (!scope.context.gameRootPath) return { byId, truncated: false };
    const all = await walkScope(scope, token);
    for (const entry of all.parts) {
        if (token.isCancellationRequested) break;
        const numberAt = numberReader(entry, token);
        const context: DerivedContext = { entry, prices: all.prices, numberAt };
        const derived = async (path: string): Promise<number | null> => {
            const column = derivedAt(path);
            return column && column.applies(entry) ? await column.compute(context) : null;
        };
        const stats: PartStats = {
            id: entry.id,
            otherIds: await tagsOf(entry.group, OTHER_IDS_MEMBER, token),
            categories: entry.categories,
            cost: await derived('@Cost'),
            dps: await derived('@DPS'),
            maxHealth: await numberAt('MaxHealth'),
            crewCapacity: await crewCapacityOf(entry, numberAt),
            tiles: await derived('@Tiles'),
            size: await sizeOf(numberAt),
            fsPath: entry.part.fsPath,
        };
        // The part's own id wins over an alias another part keeps, which is what the game's own
        // lookup does: a primary id is registered before any alternative id is.
        const own = stats.id.toLowerCase();
        if (own && !byId.has(own)) byId.set(own, stats);
        for (const alias of stats.otherIds) {
            const key = alias.toLowerCase();
            if (key && !byId.has(key)) byId.set(key, stats);
        }
    }
    return { byId, truncated: all.truncated };
};

/**
 * A segment that marks a column as presentation rather than balance: where a sprite sits, how big
 * an icon is, which layer something draws on. Such columns stay in the picker, but the opening set
 * is for the numbers a part is balanced by, and the ranking alone cannot tell an icon's size from
 * a shield's radius since every part draws its own icon.
 */
const PRESENTATION_SEGMENTS = new Set(
    [
        'SelectionPriority',
        'EditorIcon',
        'Blueprints',
        'Graphics',
        'Sprite',
        'Sprites',
        'Sound',
        'Sounds',
        'Location',
        'Offset',
        'Layer',
        'Color',
        'Texture',
        'Icon',
        'Scale',
        'Rotation',
        'Flags',
        'Priority',
        'Particles',
        'Light',
        'Lights',
    ].map((segment) => segment.toLowerCase())
);

/** What a presentation segment ends in when it is named after what it holds, `DestroyedEffects`. */
const PRESENTATION_SUFFIXES = ['effect', 'effects', 'sprite', 'sprites', 'sound', 'sounds', 'icon', 'animation'];

/**
 * Whether a column is about how a part looks rather than what it does.
 *
 * @param path the column path.
 * @returns true when any segment of the path is a presentation segment.
 */
const isPresentation = (path: string): boolean =>
    path.split('/').some((segment) => {
        const lower = segment.toLowerCase();
        return PRESENTATION_SEGMENTS.has(lower) || PRESENTATION_SUFFIXES.some((suffix) => lower.endsWith(suffix));
    });

/**
 * The columns the walked parts turned out to carry, ranked the way the picker offers them, with the
 * derived columns in front.
 *
 * The ranking is by how many distinct declarations the rows read the column from, not by how many
 * rows carry it. Nearly every part inherits the same base, so counting rows puts the fields the base
 * writes once at the very top: every part has an `AutoDoorMaxPathLength`, and every one of them is
 * the same number in the same file. A column read from one place says nothing about the parts. A
 * column read from a hundred places is the one a reader opened the table to compare.
 *
 * @param parts the walked parts.
 * @returns the columns, most varied first, then widest coverage, then shallowest, then by path.
 */
const columnsOf = (parts: readonly WalkedPart[]): RankedColumn[] => {
    const tally = new Map<string, ColumnTally>();
    for (const entry of parts) {
        for (const [path, value] of entry.values) {
            let column = tally.get(path);
            if (!column) {
                column = { rows: 0, numeric: 0, declarations: new Set<number>(), depth: path.split('/').length };
                tally.set(path, column);
            }
            column.rows++;
            if (value.numeric) column.numeric++;
            column.declarations.add(value.declaration);
        }
    }
    const ranked: Array<{ column: RankedColumn; depth: number }> = [];
    for (const [path, entry] of tally) {
        ranked.push({
            column: { path, rows: entry.rows, numeric: entry.numeric, declarations: entry.declarations.size },
            depth: entry.depth,
        });
    }
    ranked.sort(
        (left, right) =>
            right.column.declarations - left.column.declarations ||
            right.column.rows - left.column.rows ||
            left.depth - right.depth ||
            left.column.path.localeCompare(right.column.path)
    );
    const derived: RankedColumn[] = [];
    for (const column of DERIVED) {
        const rows = parts.filter((entry) => column.applies(entry)).length;
        if (rows === 0) continue;
        derived.push({
            path: column.path,
            rows,
            numeric: rows,
            declarations: rows,
            derived: true,
            description: column.description,
        });
    }
    return [...derived, ...ranked.map((entry) => entry.column)];
};

/**
 * The columns and the opening set of the last build, with what they were worked out from. A change
 * of shown columns walks nothing and reads the same parts, so the tally, which is the larger part
 * of a warm build, is answered from here while the walk and the filter are the ones it was made
 * for.
 */
let columnsMemo:
    | {
          version: number;
          filterKey: string;
          ranked: RankedColumn[];
          /** The columns as they cross the wire, without the figures only the ranking reads. */
          columns: PartTableColumn[];
          suggested: string[];
          columnsVersion: string;
      }
    | undefined;

/**
 * One spelling of a filter, so two filters narrowing to the same parts share the memo.
 *
 * @param filter the filter, absent for all parts.
 * @returns the key, empty for no narrowing.
 */
const filterKeyOf = (filter: PartTableFilter | undefined): string => {
    if (!filter) return '';
    const axes: string[] = [];
    for (const axis of ['categories', 'components', 'sources', 'editorGroups'] as const) {
        const values = filter[axis];
        if (values?.length) axes.push(`${axis}=${[...values].sort().join('')}`);
    }
    return axes.join('');
};

/**
 * A short, stable name for a set of columns, which the view hands back to say it already holds
 * them.
 *
 * @param filterKey the filter's spelling.
 * @returns the version.
 */
const columnsVersionOf = (filterKey: string): string => {
    let hash = 0;
    for (let index = 0; index < filterKey.length; index++) hash = (hash * 31 + filterKey.charCodeAt(index)) | 0;
    return `${PROCESS_STAMP}-${walkVersion}-${(hash >>> 0).toString(36)}`;
};

/**
 * The columns the parts carry and the opening set, from the memo where the walk and the filter are
 * the ones it was made for.
 *
 * @param parts the walked parts the filter leaves.
 * @param filter the filter that left them.
 * @returns the columns, the opening set, and the version naming both.
 */
const columnsFor = (
    parts: readonly WalkedPart[],
    filter: PartTableFilter | undefined
): { columns: PartTableColumn[]; suggested: string[]; columnsVersion: string } => {
    const filterKey = filterKeyOf(filter);
    if (columnsMemo && columnsMemo.version === walkVersion && columnsMemo.filterKey === filterKey) return columnsMemo;
    const ranked = columnsOf(parts);
    const suggested = suggestedColumns(ranked, parts.length);
    const columns = ranked.map(({ numeric: _numeric, declarations: _declarations, ...column }) => column);
    columnsMemo = {
        version: walkVersion,
        filterKey,
        ranked,
        columns,
        suggested,
        columnsVersion: columnsVersionOf(filterKey),
    };
    return columnsMemo;
};

/**
 * The columns the view opens with: the figures a part is balanced by, in the order a modder's own
 * sheet has them, then the numeric columns most parts write themselves.
 *
 * The first block is fixed on purpose. The ranking knows which columns vary, not which ones matter,
 * and it put the size of the editor icon ahead of the cost. Health, cost, footprint, resources, the
 * game's own stats and the crew are what every hand-kept sheet starts with, so the table does too,
 * and the ranking fills the rest.
 *
 * @param columns the discovered columns, already ranked.
 * @param rowCount how many rows the table holds.
 * @returns the paths to show first.
 */
const suggestedColumns = (columns: readonly RankedColumn[], rowCount: number): string[] => {
    const enough = Math.max(2, rowCount / 2);
    const known = new Map(columns.map((column) => [column.path.toLowerCase(), column]));
    const chosen: string[] = [];
    const take = (path: string): void => {
        const column = known.get(path.toLowerCase());
        if (column && column.numeric > 0 && !chosen.includes(column.path)) chosen.push(column.path);
    };
    const takeUnder = (prefix: string, limit: number): void => {
        const lower = `${prefix}/`.toLowerCase();
        columns
            .filter(
                (column) =>
                    column.path.toLowerCase().startsWith(lower) &&
                    !column.path.slice(lower.length).includes('/') &&
                    column.numeric > 0 &&
                    column.rows >= enough
            )
            .slice(0, limit)
            .forEach((column) => take(column.path));
    };

    take('MaxHealth');
    take('@Cost');
    take('@Tiles');
    takeUnder(RESOURCES_MEMBER, 4);
    for (const path of SIZE_PATHS) take(path);
    takeUnder('StatsByCategory/0/Stats', 4);
    take('@DPS');
    take('Components/PartCrew/Crew');

    // Variety over depth for the rest. Variety alone puts an icon's size ahead of the health, since
    // every part does draw its own icon, and depth alone puts a field almost every part inherits
    // ahead of the size. Dividing by the depth keeps a part's own fields in front without burying
    // the nested ones that really do differ from part to part.
    const score = (column: RankedColumn): number => column.declarations / column.path.split('/').length;
    const filler = columns
        .filter(
            (column) =>
                !column.derived &&
                column.numeric > 0 &&
                column.rows >= enough &&
                column.declarations > 1 &&
                !isPresentation(column.path)
        )
        .slice()
        .sort((left, right) => score(right) - score(left) || left.path.localeCompare(right.path));
    for (const column of filler) {
        if (chosen.length >= SUGGESTED_COLUMNS) break;
        if (!chosen.includes(column.path)) chosen.push(column.path);
    }
    return chosen;
};

/**
 * Computes the shown columns of one walked part.
 *
 * @param entry the walked part.
 * @param shown the column paths to compute.
 * @param prices the resource prices the cost column reads.
 * @param token cancels the evaluation.
 * @returns the row.
 */
const rowOf = async (
    entry: WalkedPart,
    shown: readonly string[],
    prices: ResourcePrices,
    token: CancellationToken
): Promise<PartTableRow> => {
    const cells: Record<string, PartTableCell> = {};
    const computed = new Map<string, Promise<{ text: string; value: number | null; unit?: PartTableUnit }>>();
    const evaluated = (path: string) => {
        const reached = reachedAt(entry, path);
        if (!reached) return undefined;
        let pending = computed.get(path);
        if (!pending) {
            pending = cellValue(reached.node, token);
            computed.set(path, pending);
        }
        return { reached, pending };
    };
    const { part, group } = entry;
    const anchor = group.identifier ?? group;
    const context: DerivedContext = {
        entry,
        prices,
        numberAt: async (path) => (await evaluated(path)?.pending)?.value ?? null,
    };

    // The footprint always rides along: the view divides by it when the reader asks for a per-tile
    // figure, whether or not the column itself is on screen.
    const wanted = new Set(shown);
    wanted.add('@Tiles');
    for (const path of wanted) {
        if (token.isCancellationRequested) break;
        const derived = derivedAt(path);
        if (derived) {
            if (!derived.applies(entry)) continue;
            const value = await derived.compute(context);
            if (value === null) continue;
            cells[derived.path] = {
                text:
                    derived.unit === 'credits' ? formatWithUnit(value, undefined) : formatWithUnit(value, derived.unit),
                value,
                unit: derived.unit,
                uri: clientUri(part.fsPath),
                line: anchor.position.line,
                character: anchor.position.characterStart,
                inherited: false,
            };
            continue;
        }
        const found = evaluated(path);
        if (!found) continue;
        const { text, value, unit } = await found.pending;
        const declaration = found.reached.origin.node;
        cells[path] = {
            text,
            value,
            unit,
            uri: clientUri(found.reached.origin.uri),
            line: declaration.position.line,
            character: declaration.position.characterStart,
            inherited: found.reached.inherited,
        };
    }
    return {
        key: part.key,
        id: entry.id,
        name: part.groupName,
        file: basenameOf(part.fsPath),
        uri: clientUri(part.fsPath),
        line: anchor.position.line,
        character: anchor.position.characterStart,
        origin: part.modRoot ? 'mod' : 'game',
        source: entry.source,
        categories: entry.categories,
        components: entry.components,
        editorGroup: entry.editorGroups[0] ?? '',
        editorGroups: entry.editorGroups,
        ships: [...entry.part.ships].sort(),
        cells,
    };
};

/**
 * Builds the table for a scope, narrowed to the filter, computing only the columns it is asked to
 * show.
 *
 * The columns are the ones the filtered parts really carry. Narrowing to the shields and still
 * being offered every field a thruster has would leave the picker as long as it is for the whole
 * project while nearly all of it is blank, which is the opposite of what narrowing is for.
 *
 * The columns are the larger part of the answer, several megabytes for a large mod, and a view
 * asking for other columns or following an edit already holds them. A view that names the
 * version it holds is answered without them where that version is still the current one.
 *
 * @param scope the game context and the mod the table is scoped to.
 * @param shown the column paths to compute, absent to let the ranking choose them.
 * @param filter which parts to narrow to, absent for all of them.
 * @param token cancels the reads.
 * @param knownColumns the columns version the view already holds, absent to send the columns.
 * @returns the rows, the columns they carry and the filter axes the view offers.
 */
export const buildPartTable = async (
    scope: PartCatalogScope,
    shown: readonly string[] | undefined,
    filter: PartTableFilter | undefined,
    token: CancellationToken,
    knownColumns?: string
): Promise<PartTableData> => {
    const empty = {
        rows: [],
        columns: [],
        columnsVersion: '',
        total: 0,
        categories: [],
        componentTypes: [],
        sources: [],
        editorGroups: [],
        ships: [],
        mod: '',
        suggested: [],
        truncated: false,
    };
    if (!scope.context.gameRootPath) return { ...empty, emptyReason: 'noGamePath' as const };

    const all = await walkScope(scope, token);
    const matching = all.parts.filter((entry) => passes(entry, filter));

    const { columns, suggested, columnsVersion } = columnsFor(matching, filter);
    const known = new Map(columns.map((column) => [column.path.toLowerCase(), column.path]));
    const chosen = shown
        ? shown.map((path) => known.get(path.toLowerCase())).filter((path): path is string => path !== undefined)
        : suggested;

    const rows: PartTableRow[] = [];
    for (const entry of matching) {
        if (token.isCancellationRequested) break;
        rows.push(await rowOf(entry, chosen, all.prices, token));
    }
    rows.sort((left, right) => left.source.localeCompare(right.source) || left.id.localeCompare(right.id));

    // The filter axes stay the whole scope's, so narrowing to one category never takes the other
    // categories out of the dropdown that would let the reader leave it again.
    const categories = new Set<string>();
    const componentTypes = new Set<string>();
    const sources = new Set<string>();
    const editorGroups = new Set<string>();
    const ships = new Set<string>();
    for (const entry of all.parts) {
        for (const category of entry.categories) categories.add(category);
        for (const component of entry.components) componentTypes.add(component);
        sources.add(entry.source);
        for (const name of entry.editorGroups) editorGroups.add(name);
        for (const ship of entry.part.ships) ships.add(ship);
    }
    return {
        rows,
        columns: knownColumns !== undefined && knownColumns === columnsVersion ? undefined : columns,
        columnsVersion,
        total: all.parts.length,
        categories: [...categories].sort(),
        componentTypes: [...componentTypes].sort(),
        sources: [...sources].sort(),
        editorGroups: [...editorGroups].sort(),
        ships: [...ships].sort(),
        mod: scope.modRoot ? basenameOf(scope.modRoot) || scope.modRoot : '',
        suggested,
        truncated: all.truncated,
        emptyReason: all.parts.length === 0 ? 'noParts' : undefined,
    };
};

/**
 * The direct member of a group by name, in either `Name = value` or `Name { }` form, matched the way
 * the game matches names.
 *
 * @param container the group to look in.
 * @param name the member name.
 * @returns the member's value node, or null when the group writes no such member itself.
 */
const ownMember = (container: GroupNode, name: string): AbstractNode | null => {
    const lower = name.toLowerCase();
    for (const element of container.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === lower && element.right) {
            return element.right;
        }
        if ((isGroupNode(element) || isListNode(element)) && element.identifier?.name.toLowerCase() === lower) {
            return element;
        }
    }
    return null;
};

/**
 * The current text of a file an edit may land in: the editor's buffer when it is open, the file on
 * disk otherwise.
 *
 * @param uri the file's uri or path.
 * @param hooks the request layer's hooks.
 * @returns the text, or null when the file could not be read.
 */
const textOf = async (uri: string, hooks: PartTableEditHooks): Promise<string | null> => {
    const open = hooks.openText(clientUri(uri));
    if (open !== undefined) return open;
    return readFile(uriToFsPath(uri), { encoding: 'utf-8' }).catch(() => null);
};

/**
 * Whether a file is one of the game's own, which a mod cannot edit.
 *
 * @param uri the file's uri or path.
 * @param hooks the request layer's hooks, carrying the game's root.
 * @returns true when the file sits under the game's data root.
 */
const isGameFile = (uri: string, hooks: PartTableEditHooks): boolean => {
    if (!hooks.dataRootPath) return false;
    const root = fileKey(hooks.dataRootPath).replace(/\/+$/, '');
    const file = fileKey(uri);
    return file === root || file.startsWith(`${root}/`);
};

/**
 * The byte span a group member occupies in its file. An assignment carries no span of its own,
 * only its name and its value do, so the member runs from the one to the other.
 *
 * @param element the member.
 * @returns the start and end offsets, or null when the member has no measurable span.
 */
const memberSpan = (element: AbstractNode): { start: number; end: number } | null => {
    if (isAssignmentNode(element)) {
        const end = element.right?.position.end ?? element.left.position.end;
        return { start: element.left.position.start, end };
    }
    return element.position ? { start: element.position.start, end: element.position.end } : null;
};

/**
 * The edit that appends one member to a group, on a line of its own after the last member, with
 * the indentation that member has. An empty group takes the member on the line after its brace,
 * one tab deeper than the brace's own line.
 *
 * @param text the file's current text.
 * @param group the group to append to.
 * @param memberText the member as it should be written.
 * @returns the insertion, or null when the group's braces are not where the parse recorded them.
 */
const appendMemberEdit = (text: string, group: GroupNode, memberText: string): TextEdit | null => {
    if (text[group.position.end - 1] !== '}') return null;
    const spans = group.elements.map(memberSpan).filter((span): span is { start: number; end: number } => !!span);
    const last = spans[spans.length - 1];
    const lineStartOf = (offset: number): number => text.lastIndexOf('\n', offset - 1) + 1;
    let at: number;
    let indent: string;
    if (last) {
        at = last.end;
        const prefix = text.slice(lineStartOf(last.start), last.start);
        indent = /^\s*$/.test(prefix) ? prefix : '\t';
    } else {
        const opener = group.identifier ? text.indexOf('{', group.identifier.position.end) : group.position.start;
        if (opener < 0) return null;
        at = opener + 1;
        const prefix = text.slice(lineStartOf(opener), opener);
        indent = `${/^\s*$/.test(prefix) ? prefix : ''}\t`;
    }
    const position = offsetToPosition(text, at);
    return { range: { start: position, end: position }, newText: `\n${indent}${memberText}` };
};

/**
 * Whether a node's recorded span still holds the text it was parsed from. The kept walk holds
 * nodes from the parse of the moment, and a buffer that has moved on since would take the edit
 * somewhere else in the file.
 *
 * @param text the file's current text.
 * @param node the node to check.
 * @returns true when the span reads as a value still.
 */
const spanIsCurrent = (text: string, node: AbstractNode): boolean => {
    const slice = text.slice(node.position.start, node.position.end).trim();
    if (slice.length === 0) return false;
    if (isValueNode(node)) {
        const written = String(node.valueType.value).trim();
        return slice === written || slice.replace(/^\(|\)$/g, '') === written || Number(slice) === Number(written);
    }
    return true;
};

/**
 * The byte span a written value occupies, with its parentheses balanced. The parser leaves a
 * leading `(` out of a value's span while keeping the trailing `)`, so writing over the recorded
 * span alone would leave `(9500` behind. Every unmatched closing parenthesis inside the span is
 * paid for by taking in the opening one before it, and the other way round.
 *
 * @param text the file's current text.
 * @param node the value node.
 * @returns the start and end offsets of the whole written value.
 */
const valueSpan = (text: string, node: AbstractNode): { start: number; end: number } => {
    let { start, end } = node.position;
    const balance = (): number => {
        let open = 0;
        for (let index = start; index < end; index++) {
            if (text[index] === '(') open++;
            else if (text[index] === ')') open--;
        }
        return open;
    };
    for (let unmatched = balance(); unmatched < 0; unmatched++) {
        const before = text.lastIndexOf('(', start - 1);
        if (before === -1 || text.slice(before + 1, start).trim().length > 0) break;
        start = before;
    }
    for (let unmatched = balance(); unmatched > 0; unmatched--) {
        const after = text.indexOf(')', end);
        if (after === -1 || text.slice(end, after).trim().length > 0) break;
        end = after + 1;
    }
    return { start, end };
};

/** How much of a replaced value the note repeats before it is cut. */
const NOTE_SNIPPET_LENGTH = 40;

/**
 * The edit that writes a number over a value in place, with the note saying what it replaced when
 * that was more than a number. A reference or an expression is what a reader loses by typing over
 * it, and the note is the one place that says so.
 *
 * @param uri the file the value is written in.
 * @param node the value node.
 * @param written the number as the reader typed it.
 * @param hooks the request layer's hooks.
 * @param where what the note says about the file, absent for the plain form.
 * @returns the edit, or the reason none can be made.
 */
const overwriteInPlace = async (
    uri: string,
    node: AbstractNode,
    written: string,
    hooks: PartTableEditHooks,
    where?: string
): Promise<PartTableEditResult> => {
    if (isGameFile(uri, hooks)) {
        return {
            status: 'refused',
            message: l10n.t("{0} is one of the game's own files, which a mod cannot edit.", basenameOf(uri)),
        };
    }
    const current = await textOf(uri, hooks);
    if (current === null || !spanIsCurrent(current, node)) {
        return { status: 'notFound', message: l10n.t('The table has to be read again before it can be edited.') };
    }
    const span = valueSpan(current, node);
    const replaced = current.slice(span.start, span.end).trim();
    const edit: TextEdit = {
        range: { start: offsetToPosition(current, span.start), end: offsetToPosition(current, span.end) },
        newText: written,
    };
    const file = basenameOf(uri);
    const plain = isValueNode(node) && node.valueType.type !== 'Reference';
    const snippet = replaced.length > NOTE_SNIPPET_LENGTH ? `${replaced.slice(0, NOTE_SNIPPET_LENGTH - 1)}…` : replaced;
    let note: string;
    if (where && plain) note = l10n.t('Written into {0}, {1}.', file, where);
    else if (where) note = l10n.t('Written into {0}, {1}, in place of {2}.', file, where, snippet);
    else if (plain) note = l10n.t('Written into {0}.', file);
    else note = l10n.t('Written into {0} in place of {1}.', file, snippet);
    return { status: 'ok', edit: { changes: { [clientUri(uri)]: [edit] } }, note };
};

/**
 * Builds the edit that writes a typed-over value into the file. A value the part writes itself is
 * written over in place, and so is one a mod's manifest merges into the part, in the manifest,
 * since the manifest is applied after the part's own file. A value the part inherits is added to
 * the part's own group as an override, with the groups on the way to it created inline, so the base
 * keeps its value for every other part that reads it. A value inside an inherited list cannot be
 * overridden one element at a time, and the game's own files cannot be written at all, so those are
 * refused with the reason.
 *
 * @param rowKey the row's key.
 * @param path the column path.
 * @param text the value as the reader typed it.
 * @param hooks the request layer's hooks.
 * @returns the edit, or the reason none can be made.
 */
export const buildPartTableEdit = async (
    rowKey: string,
    path: string,
    text: string,
    hooks: PartTableEditHooks
): Promise<PartTableEditResult> => {
    const entry = walked?.parts.find((candidate) => candidate.part.key === rowKey);
    if (!entry)
        return { status: 'notFound', message: l10n.t('The table has to be read again before it can be edited.') };
    const written = text.trim();
    if (!WRITABLE_NUMBER.test(written)) {
        return {
            status: 'refused',
            message: l10n.t('Write a number, with the % d or r suffix the value already has.'),
        };
    }
    if (derivedAt(path)) {
        return {
            status: 'refused',
            message: l10n.t('{0} is worked out from other columns. Edit those instead.', path),
        };
    }
    const reached = reachedAt(entry, path);
    if (!reached) return { status: 'refused', message: l10n.t('The part holds no value at {0}.', path) };

    if (!reached.inherited) return overwriteInPlace(reached.origin.uri, reached.node, written, hooks);

    // A manifest's value is the one the game ends up with whatever the part's file says, so it is
    // written where the manifest writes it. The declaration may sit in a file the manifest reads
    // its overrides from, which is still the mod's own.
    if (reached.injected) {
        return overwriteInPlace(
            reached.origin.uri,
            reached.node,
            written,
            hooks,
            l10n.t('where the mod overrides the part')
        );
    }

    // The value comes from a base. The part gets its own copy, nested as deep as the path goes,
    // inside the deepest group the part already writes on the way there.
    const ownUri = entry.part.fsPath;
    if (isGameFile(ownUri, hooks)) {
        return {
            status: 'refused',
            message: l10n.t("{0} is one of the game's own files, which a mod cannot edit.", basenameOf(ownUri)),
        };
    }
    const segments = path.split('/');
    let container: GroupNode = entry.group;
    let index = 0;
    while (index < segments.length - 1) {
        const next = ownMember(container, segments[index]);
        if (!next) break;
        if (!isGroupNode(next)) {
            return {
                status: 'refused',
                message: l10n.t(
                    '{0} sits inside a list the part inherits, which cannot be overridden one value at a time.',
                    path
                ),
            };
        }
        container = next;
        index++;
    }
    const remaining = segments.slice(index);
    if (remaining.some((segment) => /^\d+$/.test(segment))) {
        return {
            status: 'refused',
            message: l10n.t(
                '{0} sits inside a list the part inherits, which cannot be overridden one value at a time.',
                path
            ),
        };
    }
    const current = await textOf(ownUri, hooks);
    if (current === null) {
        return { status: 'notFound', message: l10n.t('The table has to be read again before it can be edited.') };
    }
    const existing = remaining.length === 1 ? ownMember(container, remaining[0]) : null;
    if (existing && !isGroupNode(existing) && !isListNode(existing)) {
        return overwriteInPlace(ownUri, existing, written, hooks);
    }
    let elementText = `${remaining[remaining.length - 1]} = ${written}`;
    for (let depth = remaining.length - 2; depth >= 0; depth--) elementText = `${remaining[depth]} { ${elementText} }`;
    const edit = appendMemberEdit(current, container, elementText);
    if (!edit)
        return { status: 'notFound', message: l10n.t('The table has to be read again before it can be edited.') };
    const workspaceEdit: WorkspaceEdit = { changes: { [clientUri(ownUri)]: [edit] } };
    return {
        status: 'ok',
        edit: workspaceEdit,
        note: l10n.t('Added to {0} as an override. The base keeps its value.', basenameOf(ownUri)),
    };
};
