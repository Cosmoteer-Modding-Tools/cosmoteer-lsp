import { AbstractNodeDocument, isListNode, ListNode } from '../../core/ast/ast';
import { namedMembersOf } from '../../utils/ast.utils';
import { closerOffset, openerOffset } from '../refactor/register-part/manifest-action.emitter';
import { relativeRulesReference } from '../refactor/shared-base/base-file.emitter';
import {
    FactionPaths,
    Insertion,
    LineEnding,
    RoleLayout,
    RolePaths,
    ShipEntry,
    TradeShipEntry,
} from './builtin-ships.types';
import { spawnTierForRole } from './ship-assessment';
import { ShipRole } from './ship-assessment.types';

/**
 * The text a ship registration is written as, in the shape the game's own `builtin_ships` tree uses.
 *
 * The layout is the vanilla one on purpose: one folder per faction, one folder and one rules file
 * per role under it, the role file carrying the faction, the tags and the id prefix every ship in
 * it inherits through `:~`, and one file per faction concatenating the role files into a single
 * `Ships` list. The server roots any file under a `builtin_ships` folder as the database the game
 * reads it as, so a ship registered this way is validated the way the game's own are, and the
 * manifest needs one action per faction rather than one per ship.
 */

/** The layout of every role, copied from the vanilla tree. */
export const ROLE_LAYOUTS: Readonly<Record<ShipRole, RoleLayout>> = {
    combat: {
        folder: 'Combat',
        fileSuffix: 'combat',
        fileTag: 'combat',
        entryTags: [],
        faction: true,
        prefix: undefined,
        tiered: true,
        difficulty: true,
        tradeShip: false,
    },
    trade: {
        folder: 'Civilian',
        fileSuffix: 'civilian',
        fileTag: 'civilian',
        entryTags: ['trade', 'empty_storage'],
        faction: true,
        prefix: undefined,
        tiered: true,
        difficulty: false,
        tradeShip: true,
    },
    crew_transport: {
        folder: 'Civilian',
        fileSuffix: 'civilian',
        fileTag: 'civilian',
        entryTags: ['crew_transport'],
        faction: true,
        prefix: undefined,
        tiered: true,
        difficulty: false,
        tradeShip: true,
    },
    defense: {
        folder: 'Defense',
        fileSuffix: 'defense',
        fileTag: 'defense',
        entryTags: [],
        faction: true,
        prefix: 'faction',
        tiered: true,
        difficulty: true,
        tradeShip: false,
    },
    trade_station: {
        folder: 'Stations',
        fileSuffix: 'stations',
        fileTag: 'station',
        entryTags: ['trade_station', 'empty_storage'],
        faction: true,
        prefix: undefined,
        tiered: true,
        difficulty: false,
        tradeShip: false,
    },
    military_station: {
        folder: 'Stations',
        fileSuffix: 'stations',
        fileTag: 'station',
        entryTags: ['military_station', 'empty_storage'],
        faction: true,
        prefix: undefined,
        tiered: true,
        difficulty: false,
        tradeShip: false,
    },
    // A derelict the game scatters through debris fields. The vanilla file names no faction, so the
    // wreck belongs to nobody, and prefixes every id with Wreckage so it can share a name with a
    // living ship.
    wreckage: {
        folder: 'Wreckage',
        fileSuffix: 'wreckage',
        fileTag: 'wreckage',
        entryTags: [],
        faction: false,
        prefix: 'wreckage',
        tiered: false,
        difficulty: false,
        tradeShip: false,
    },
    // A ship the player can begin a career with. The built-in entry only names it; the career mode's
    // own StarterShips list, written from the manifest, is what offers it.
    starter: {
        folder: 'Starter',
        fileSuffix: 'starter',
        fileTag: 'starter',
        entryTags: [],
        faction: false,
        prefix: undefined,
        tiered: false,
        difficulty: false,
        tradeShip: false,
    },
    // A storage pod the game drops beside a wreck or hands out as loot. The vanilla file tags each
    // entry on its own and names no faction, since the pods belong to nobody.
    storage_pod: {
        folder: 'Misc',
        fileSuffix: 'misc',
        fileTag: undefined,
        entryTags: ['storage_pod'],
        faction: false,
        prefix: undefined,
        tiered: false,
        difficulty: false,
        tradeShip: false,
    },
};

/**
 * A localization key label made from an id or a name: every word capitalized and run together, the
 * way the game's own keys are spelled (`Factions/Monolith`, `StarterShips/ModelL`).
 *
 * @param text the id or name.
 * @returns the label.
 */
export const keyLabelOf = (text: string): string =>
    text
        .split(/[^A-Za-z0-9]+/)
        .filter((word) => word.length > 0)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join('');

/** The prefix the vanilla wreckage file gives its ids. */
const WRECKAGE_ID_PREFIX = 'Wreckage';

/**
 * The prefix a role file gives its ships' ids, when it gives one.
 *
 * @param role the role.
 * @param factionLabel the faction's name, or its id when the language files name none, for a role
 * prefixed with it.
 * @returns the prefix, or undefined for a role that writes none.
 */
export const idPrefixForRole = (role: ShipRole, factionLabel: string): string | undefined => {
    const prefix = ROLE_LAYOUTS[role].prefix;
    if (prefix === 'faction') return idPrefixOf(factionLabel);
    if (prefix === 'wreckage') return WRECKAGE_ID_PREFIX;
    return undefined;
};

/** The folder every faction's ships go under, mirroring the game's own tree. */
export const BUILTIN_SHIPS_FOLDER = 'builtin_ships';

/** The list member every builtin-ships file writes, which is what roots it as the database. */
export const SHIPS_MEMBER = 'Ships';

/** The group a trade-route file writes its entries in. */
export const TRADE_SHIPS_MEMBER = 'TradeShips';

/** The indentation the game's own files use. */
const INDENT = '\t';

/**
 * A faction id as a file-name segment: lower case, with anything but letters, digits and
 * underscores replaced, so the folder is the same on every filesystem.
 *
 * @param factionId the faction's id.
 * @returns the segment.
 */
export const factionSegment = (factionId: string): string =>
    factionId
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'faction';

/**
 * The prefix a faction's platforms carry in their ids, the way `IDPrefix = "Cabal"` does: the
 * faction's name as the language files write it, with its first letter raised. The game's own
 * prefixes are the faction names, and a name of more than one word reads as one in an id (`Probe
 * Raiders Small Laser Platform`) where the id would not (`Probe_raiders Small Laser Platform`).
 *
 * @param factionLabel the faction's name, or its id when the language files name none.
 * @returns the prefix.
 */
export const idPrefixOf = (factionLabel: string): string => {
    // The prefix is written inside a quoted string, so a quote or a backslash in a name cannot stay.
    const trimmed = factionLabel.replace(/["\\]/g, '').trim();
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
};

/**
 * Where a faction's files sit under a mod.
 *
 * @param modRoot the mod.
 * @param factionId the faction.
 * @returns the paths, with forward slashes.
 */
export const factionPathsOf = (modRoot: string, factionId: string): FactionPaths => {
    const segment = factionSegment(factionId);
    const folder = `${modRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${BUILTIN_SHIPS_FOLDER}/${segment}`;
    return { folder, aggregator: `${folder}/builtins_${segment}.rules` };
};

/**
 * Where a role's files sit under a faction.
 *
 * @param faction the faction's paths.
 * @param factionId the faction.
 * @param role the role.
 * @returns the paths, with forward slashes.
 */
export const rolePathsOf = (faction: FactionPaths, factionId: string, role: ShipRole): RolePaths => {
    const layout = ROLE_LAYOUTS[role];
    const segment = factionSegment(factionId);
    const folder = `${faction.folder}/${layout.folder}`;
    return {
        folder,
        file: `${folder}/builtins_${segment}_${layout.fileSuffix}.rules`,
        tradeShips: layout.tradeShip ? `${folder}/trade_ships_${segment}.rules` : undefined,
    };
};

/**
 * The head of a new role file: the faction, the tags and, for a prefixed role, the id prefix, then
 * an empty `Ships` list for the entries.
 *
 * @param factionId the faction.
 * @param role the role.
 * @param lineEnding the ending to write with.
 * @param factionLabel the faction's name for the id prefix, the id itself when none is known.
 * @returns the file's text.
 */
export const roleFileText = (
    factionId: string,
    role: ShipRole,
    lineEnding: LineEnding,
    factionLabel: string = factionId
): string => {
    const layout = ROLE_LAYOUTS[role];
    const lines: string[] = [];
    if (layout.faction) lines.push(`Faction = ${factionId}`);
    const prefix = idPrefixForRole(role, factionLabel);
    if (prefix !== undefined) lines.push(`IDPrefix = "${prefix}"`);
    if (layout.fileTag !== undefined) lines.push(`Tags = [${layout.fileTag}]`);
    lines.push('', SHIPS_MEMBER, '[', ']', '');
    return lines.join(lineEnding);
};

/**
 * One ship entry, in the one-line shape the game's own files use.
 *
 * @param entry the ship.
 * @returns the line, without indentation or line ending.
 */
export const shipEntryText = (entry: ShipEntry): string => {
    const layout = ROLE_LAYOUTS[entry.role];
    const fields = [`File="${entry.file}"`];
    if (layout.tiered) fields.push(`Tier=${entry.tier}`);
    const spawnTier = spawnTierForRole(entry.role, entry.tier);
    if (spawnTier !== undefined) fields.push(`SpawnTier=${spawnTier}`);
    if (layout.difficulty) fields.push(`Difficulty=${entry.difficulty}`);
    // An entry's tags extend the file's when the file has some, and stand alone otherwise, since a
    // list that inherits from a member the file lacks fails to load.
    if (layout.entryTags.length > 0) {
        const tags = layout.entryTags.join(', ');
        fields.push(layout.fileTag !== undefined ? `Tags : ~/Tags [${tags}]` : `Tags=[${tags}]`);
    }
    if (entry.stasisIcon) fields.push(`StasisIcon="${entry.stasisIcon}"`);
    return `:~{ ${fields.join('; ')}; }`;
};

/**
 * The top-level list of a file, matched ignoring case.
 *
 * @param document the parsed file.
 * @param name the member name.
 * @returns the list, or undefined when the file declares none of that name or it is not a list.
 */
export const topLevelList = (document: AbstractNodeDocument, name: string): ListNode | undefined => {
    const lower = name.toLowerCase();
    for (const [memberName, node] of namedMembersOf(document)) {
        if (memberName.toLowerCase() === lower) return isListNode(node) ? node : undefined;
    }
    return undefined;
};

/**
 * Where a new entry goes at the end of a top-level list, indented one level, with the file's own
 * ending.
 *
 * @param text the file's text.
 * @param list the list.
 * @param entry the entry's text, without indentation.
 * @param lineEnding the file's ending.
 * @returns the insertion, or undefined when the list's brackets cannot be found.
 */
export const appendToList = (
    text: string,
    list: ListNode,
    entry: string,
    lineEnding: LineEnding
): Insertion | undefined => {
    const open = openerOffset(text, list);
    const close = closerOffset(text, list);
    if (open < 0 || close < 0 || close < open) return undefined;
    // The closer's own line is kept: the entry goes on a line of its own before it, and a closer
    // already on its own line stays that way.
    const lineStart = text.lastIndexOf('\n', close - 1) + 1;
    const before = text.slice(lineStart, close);
    const onOwnLine = /^[ \t]*$/.test(before);
    if (onOwnLine) return { offset: lineStart, text: `${INDENT}${entry}${lineEnding}` };
    return { offset: close, text: `${lineEnding}${INDENT}${entry}${lineEnding}` };
};

/**
 * Where a role file's reference goes in a faction's concatenating `Ships` list: right before the
 * list's opening bracket, on a line of its own, the way the game's own aggregators write them.
 *
 * @param text the aggregator's text.
 * @param list its `Ships` list.
 * @param reference the reference text, such as `<Combat/builtins_x_combat.rules>/Ships`.
 * @param lineEnding the file's ending.
 * @returns the insertion, or undefined when the list's bracket cannot be found.
 */
export const addConcatenatedSource = (
    text: string,
    list: ListNode,
    reference: string,
    lineEnding: LineEnding
): Insertion | undefined => {
    const open = openerOffset(text, list);
    if (open < 0) return undefined;
    const lineStart = text.lastIndexOf('\n', open - 1) + 1;
    const before = text.slice(lineStart, open);
    // `Ships : <a>/Ships [` on one line, or `[` on its own: either way the reference gets its own
    // line above the bracket.
    if (/^[ \t]*$/.test(before)) return { offset: lineStart, text: `${INDENT}${reference}${lineEnding}` };
    return { offset: open, text: `${lineEnding}${INDENT}${reference}${lineEnding}` };
};

/**
 * A new faction aggregator: a `Ships` list concatenating the given role files.
 *
 * @param references the role files' references, in order.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
export const aggregatorText = (references: readonly string[], lineEnding: LineEnding): string =>
    [`${SHIPS_MEMBER} :`, ...references.map((reference) => `${INDENT}${reference}`), '[', ']', ''].join(lineEnding);

/**
 * The reference a role file is concatenated by, written from the aggregator's directory.
 *
 * @param aggregatorDir the aggregator's directory.
 * @param roleFile the role file.
 * @returns the reference text.
 */
export const roleFileReference = (aggregatorDir: string, roleFile: string): string =>
    relativeRulesReference(aggregatorDir, roleFile, SHIPS_MEMBER);

/** The tier bands the game's own trade routes use, by the ship's tier. */
const TRADE_TIER_RANGES: ReadonlyArray<{
    readonly upTo: number;
    readonly range: readonly [number, number];
    readonly tradeTime: number;
}> = [
    { upTo: 3, range: [1, 9], tradeTime: 40 },
    { upTo: 5, range: [3, 12], tradeTime: 60 },
    { upTo: 7, range: [6, 18], tradeTime: 80 },
    { upTo: Infinity, range: [12, 18], tradeTime: 100 },
];

/** The same for crew transports, which trade faster and start earlier. */
const CREW_TIER_RANGES: ReadonlyArray<{ readonly upTo: number; readonly range: readonly [number, number] }> = [
    { upTo: 5, range: [1, 12] },
    { upTo: 8, range: [6, 18] },
    { upTo: Infinity, range: [12, 18] },
];

/** How long a crew transport trades for, in the game's own routes. */
const CREW_TRADE_TIME = 20;

/**
 * The speed a trade ship travels at between stations while out of sight, which the game's own
 * routes write per ship from how fast the ship really flies. Nothing here can fly it, so every new
 * route gets the middle of the vanilla spread and the file says so.
 */
export const DEFAULT_STASIS_SPEED = 60;

/**
 * The trade-route entry a civilian ship of a tier gets, on the game's own bands.
 *
 * @param name the entry's name.
 * @param shipId the ship's id.
 * @param factionId the faction.
 * @param role `trade` or `crew_transport`.
 * @param tier the ship's tier.
 * @returns the entry.
 */
export const tradeShipEntryFor = (
    name: string,
    shipId: string,
    factionId: string,
    role: ShipRole,
    tier: number
): TradeShipEntry => {
    if (role === 'crew_transport') {
        const band =
            CREW_TIER_RANGES.find((entry) => tier <= entry.upTo) ?? CREW_TIER_RANGES[CREW_TIER_RANGES.length - 1];
        return {
            name,
            shipId,
            factionId,
            tierRange: band.range,
            stasisSpeed: DEFAULT_STASIS_SPEED,
            stasisTradeTime: CREW_TRADE_TIME,
        };
    }
    const band =
        TRADE_TIER_RANGES.find((entry) => tier <= entry.upTo) ?? TRADE_TIER_RANGES[TRADE_TIER_RANGES.length - 1];
    return {
        name,
        shipId,
        factionId,
        tierRange: band.range,
        stasisSpeed: DEFAULT_STASIS_SPEED,
        stasisTradeTime: band.tradeTime,
    };
};

/**
 * One trade-route entry, inheriting the game's own base route.
 *
 * @param entry the route.
 * @param baseReference the reference to the game's `BaseTradeShip`, written from the file's directory.
 * @returns the line, without indentation or line ending.
 */
export const tradeShipEntryText = (entry: TradeShipEntry, baseReference: string): string =>
    `${entry.name} : ${baseReference} { ShipID="${entry.shipId}"; Faction=${entry.factionId}; ` +
    `TierRange=[${entry.tierRange[0]}, ${entry.tierRange[1]}]; StasisSpeed=${entry.stasisSpeed}; StasisTradeTime=${entry.stasisTradeTime}; }`;

/**
 * A new trade-route file: the explanation of the one figure nothing here can work out, then an
 * empty `TradeShips` group for the entries.
 *
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
export const tradeShipsFileText = (lineEnding: LineEnding): string =>
    [
        '// Trade routes for the civilian ships of this faction, added to the career mode as a base of its',
        "// own TradeShips so the routes load beside the game's own.",
        `// StasisSpeed is how fast the ship travels between stations while out of sight. The game's own`,
        `// routes write each ship's real cruise speed here, and ${DEFAULT_STASIS_SPEED} is the middle of that spread.`,
        '',
        TRADE_SHIPS_MEMBER,
        '{',
        '}',
        '',
    ].join(lineEnding);

/**
 * Where a new entry goes at the end of a top-level group.
 *
 * @param text the file's text.
 * @param groupCloser the byte offset of the group's closing brace.
 * @param entry the entry's text, without indentation.
 * @param lineEnding the file's ending.
 * @returns the insertion.
 */
export const appendToGroup = (text: string, groupCloser: number, entry: string, lineEnding: LineEnding): Insertion => {
    const lineStart = text.lastIndexOf('\n', groupCloser - 1) + 1;
    const before = text.slice(lineStart, groupCloser);
    if (/^[ \t]*$/.test(before)) return { offset: lineStart, text: `${INDENT}${entry}${lineEnding}` };
    return { offset: groupCloser, text: `${lineEnding}${INDENT}${entry}${lineEnding}` };
};

/**
 * A manifest action entry of any verb, in the shape `addManyActionText` writes an `AddMany` in.
 *
 * @param fields the entry's lines, `Action = AddBase` first, without indentation.
 * @param indent the indentation the entry's own lines carry.
 * @param lineEnding the ending the manifest uses.
 * @returns the entry's text, with no trailing line ending.
 */
export const actionEntryText = (fields: readonly string[], indent: string, lineEnding: LineEnding): string =>
    [`${indent}{`, ...fields.map((field) => `${indent}${INDENT}${field}`), `${indent}}`].join(lineEnding);
