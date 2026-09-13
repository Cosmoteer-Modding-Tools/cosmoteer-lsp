import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { evaluateNumericValue } from '../../semantics/value-evaluator';
import { namedMembersOf } from '../../utils/ast.utils';
import { collectShipClasses, ShipClassEntry } from '../refactor/register-part/ship-registry';
import { dirOf, readRulesFile, resolveBasePath } from '../refactor/shared-base/base-index';
import { priceOf, ResourcePrices } from '../part-table/resource-prices';
import { ShipLayerContext } from './ship-layer.index';

/**
 * The numbers the game rates a ship by, read out of its own files.
 *
 * A career ship's tier is not authored from taste: `CareerGameModeManager.GetEstimatedTier` walks
 * `TierValueMaximums` and answers the first tier whose maximum the ship's value fits under, and that
 * value is `Ship.DifficultyValue`, the price of every part and door plus the crew at `CostPerCrew`
 * each. Every one of those figures lives in a rules file a mod can change, so they are read rather
 * than copied, and the vanilla figures below stand in only when the game path is unset.
 */

/** The game root member naming the file the tier tables live in. */
const TIER_TABLES_MEMBER = 'TIER_TABLES';

/** The list of value cutoffs, one per tier, inside that file. */
const TIER_VALUE_MAXIMUMS_MEMBER = 'TierValueMaximums';

/** The game root member naming the crew rules file. */
const CREW_MEMBER = 'Crew';

/** The price of one crew member, inside that file. */
const COST_PER_CREW_MEMBER = 'CostPerCrew';

/** The ship-class member listing the door files the class builds with. */
const DOORS_MEMBER = 'Doors';

/** A door file's resource list, priced the way a part's is. */
const RESOURCES_MEMBER = 'Resources';

/** The tier cutoffs the game ships, for a server that has no game path to read them from. */
export const VANILLA_TIER_VALUE_MAXIMUMS: readonly number[] = [
    60000, 75000, 90000, 110000, 140000, 180000, 230000, 300000, 400000, 500000, 650000, 800000, 1000000, 1300000,
    1600000, 2000000, 2500000, 3000000, 4000000, 5000000,
];

/** The price of one crew member the game ships. */
export const VANILLA_COST_PER_CREW = 500;

/** What the game rates a ship by. */
export interface CareerBalance {
    /** The value a ship may reach and still be of tier `index + 1`. */
    readonly tierValueMaximums: readonly number[];
    /** The price of one crew member. */
    readonly costPerCrew: number;
    /** The price of one door, per ship class id folded to lower case. */
    readonly doorCostByShipClass: ReadonlyMap<string, number>;
    /** True when the figures are the shipped vanilla ones rather than read from the game. */
    readonly fallback: boolean;
}

/** The `<…>` span of a reference, whatever member path follows it. */
const REFERENCE_FILE = /^\s*&?\s*<([^<>]+)>(.*)$/;

/**
 * The file a game-root reference names, resolved against the root's own directory.
 *
 * @param node the member's value.
 * @param declaringDir the directory of the file the reference is written in.
 * @returns the file's path with forward slashes, or undefined when the member is not a reference.
 */
const referencedFile = (node: AbstractNode | undefined, declaringDir: string): string | undefined => {
    if (!node || !isValueNode(node) || node.valueType.type !== 'Reference') return undefined;
    const match = REFERENCE_FILE.exec(String(node.valueType.value));
    if (!match) return undefined;
    const fsPath = resolveBasePath(match[1], declaringDir);
    return fsPath ? fsPath.replace(/\\/g, '/') : undefined;
};

/**
 * A top-level member of a parsed file, matched ignoring case the way the game binds names.
 *
 * @param document the parsed file.
 * @param name the member name.
 * @returns the member's value, or undefined when the file declares none.
 */
const topLevel = (document: AbstractNodeDocument, name: string): AbstractNode | undefined => {
    const lower = name.toLowerCase();
    for (const [memberName, node] of namedMembersOf(document)) {
        if (memberName.toLowerCase() === lower) return node;
    }
    return undefined;
};

/**
 * The numbers a list holds, in order, skipping any element that is not one.
 *
 * @param node the list.
 * @param token cancels the evaluation.
 * @returns the numbers.
 */
const numbersOf = async (node: AbstractNode | undefined, token: CancellationToken): Promise<number[]> => {
    if (!node || !isListNode(node)) return [];
    const numbers: number[] = [];
    for (const element of node.elements) {
        const value = await evaluateNumericValue(element, token).catch(() => null);
        if (value !== null && Number.isFinite(value)) numbers.push(value);
    }
    return numbers;
};

/**
 * The price of a door: its resources at the prices the game buys them for, the way
 * `DoorRules` sums its own cost.
 *
 * @param doorFsPath the door file.
 * @param prices the resource prices.
 * @param token cancels the evaluation.
 * @returns the price, or undefined when a resource has no known price.
 */
const doorCostOf = async (
    doorFsPath: string,
    prices: ResourcePrices,
    token: CancellationToken
): Promise<number | undefined> => {
    const file = await readRulesFile(doorFsPath);
    if (!file) return undefined;
    const resources = topLevel(file.document, RESOURCES_MEMBER);
    if (!resources || !isListNode(resources)) return undefined;
    let total = 0;
    for (const pair of resources.elements) {
        if (!isListNode(pair) || pair.elements.length < 2 || !isValueNode(pair.elements[0])) continue;
        const price = priceOf(prices, String(pair.elements[0].valueType.value));
        const amount = await evaluateNumericValue(pair.elements[1], token).catch(() => null);
        if (price === undefined || amount === null) return undefined;
        total += price * amount;
    }
    return total;
};

/**
 * The price of the first door a ship class lists, which is the one the blueprint's doors are built
 * as, keyed by the class's id.
 *
 * @param entry the ship class.
 * @param prices the resource prices.
 * @param token cancels the reads.
 * @returns the class id and the price, or undefined when either is unreadable.
 */
const shipClassDoorCost = async (
    entry: ShipClassEntry,
    prices: ResourcePrices,
    token: CancellationToken
): Promise<{ id: string; cost: number } | undefined> => {
    const file = await readRulesFile(entry.fsPath);
    if (!file) return undefined;
    const group = topLevel(file.document, entry.groupName);
    if (!group || !isGroupNode(group)) return undefined;
    const members = namedMembersOf(group);
    const idNode = members.find(([name]) => name.toLowerCase() === 'id')?.[1];
    const doors = members.find(([name]) => name.toLowerCase() === DOORS_MEMBER.toLowerCase())?.[1];
    if (!idNode || !isValueNode(idNode) || !doors || !isListNode(doors)) return undefined;
    const doorFsPath = referencedFile(doors.elements[0], dirOf(entry.fsPath));
    if (!doorFsPath) return undefined;
    const cost = await doorCostOf(doorFsPath, prices, token);
    return cost === undefined ? undefined : { id: String(idNode.valueType.value).trim(), cost };
};

/**
 * Reads what the game rates a ship by.
 *
 * @param context the game root and the workspace folders.
 * @param prices the resource prices, which the door prices are summed from.
 * @param token cancels the reads.
 * @returns the figures, vanilla ones when the game path is unset.
 */
export const readCareerBalance = async (
    context: ShipLayerContext,
    prices: ResourcePrices,
    token: CancellationToken
): Promise<CareerBalance> => {
    const fallback: CareerBalance = {
        tierValueMaximums: VANILLA_TIER_VALUE_MAXIMUMS,
        costPerCrew: VANILLA_COST_PER_CREW,
        doorCostByShipClass: new Map(),
        fallback: true,
    };
    const root = context.gameRootDocument;
    const rootFsPath = context.gameRootPath;
    if (!root || !rootFsPath) return fallback;
    const declaringDir = dirOf(rootFsPath);

    let tierValueMaximums: readonly number[] = VANILLA_TIER_VALUE_MAXIMUMS;
    const tablesFsPath = referencedFile(topLevel(root, TIER_TABLES_MEMBER), declaringDir);
    const tables = tablesFsPath ? await readRulesFile(tablesFsPath) : undefined;
    if (tables) {
        const read = await numbersOf(topLevel(tables.document, TIER_VALUE_MAXIMUMS_MEMBER), token);
        if (read.length > 0) tierValueMaximums = read;
    }

    let costPerCrew = VANILLA_COST_PER_CREW;
    const crewFsPath = referencedFile(topLevel(root, CREW_MEMBER), declaringDir);
    const crew = crewFsPath ? await readRulesFile(crewFsPath) : undefined;
    const costNode = crew ? topLevel(crew.document, COST_PER_CREW_MEMBER) : undefined;
    if (costNode) {
        const read = await evaluateNumericValue(costNode, token).catch(() => null);
        if (read !== null && Number.isFinite(read)) costPerCrew = read;
    }

    const doorCostByShipClass = new Map<string, number>();
    const classes = await collectShipClasses(root, rootFsPath, [], token).catch((): ShipClassEntry[] => []);
    for (const entry of classes) {
        if (token.isCancellationRequested) break;
        const door = await shipClassDoorCost(entry, prices, token);
        if (door) doorCostByShipClass.set(door.id.toLowerCase(), door.cost);
    }

    return { tierValueMaximums, costPerCrew, doorCostByShipClass, fallback: false };
};

/**
 * The tier a ship of the given value spawns at, exactly as the game works it out: the first tier
 * whose maximum the value fits under, and one past the table when it fits under none.
 *
 * @param value the ship's difficulty value.
 * @param tierValueMaximums the cutoffs, one per tier.
 * @returns the tier, counted from one.
 */
export const estimatedTier = (value: number, tierValueMaximums: readonly number[]): number => {
    for (let index = 0; index < tierValueMaximums.length; index++) {
        if (value <= tierValueMaximums[index]) return index + 1;
    }
    return tierValueMaximums.length + 1;
};
