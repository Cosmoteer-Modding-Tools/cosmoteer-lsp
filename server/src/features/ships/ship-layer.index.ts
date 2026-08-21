import { resolve } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { ActionSource } from '../../mod/action';
import { parseModActions } from '../../mod/action-parser';
import { normalizeTargetPath } from '../../mod/action-target-resolver';
import { effectiveMember } from '../../semantics/effective-member';
import { namedMembersOf } from '../../utils/ast.utils';
import { foldPathCase } from '../../workspace/fs-cache';
import { dirOf, locationOf, readRulesFile, resolveBasePath } from '../refactor/shared-base/base-index';
import {
    ShipClassEntry,
    collectShipClasses,
    manifestsIn,
    modRootsUnder,
    partsListRegisters,
    referenceTextsOf,
    shipEntryKey,
    shipPartsListOf,
} from '../refactor/register-part/ship-registry';

/**
 * Which render layers a part may name, answered per ship class rather than project-wide.
 *
 * The game resolves a sprite's `Layer` in `ShipRenderer.GetLayerQuads`, which indexes the map the
 * ship the part sits on declares: `Ship.Rules.RenderLayers[layerID]`. That lookup is an indexer
 * inside a `try`, so a layer the ship does not declare throws when the part is first drawn, logged
 * as `Layer ID: <id>` and rethrown, rather than drawing nothing. The layers are therefore not one
 * pool: the game's own three ship classes declare 19 (terran), 2 (asteroid) and 1 (megaroid), and
 * naming an asteroid layer on a terran part is exactly as broken as inventing one.
 *
 * A ship is reached the same way a registration is (see `ship-registry.ts`): the game root's `Ships`
 * list plus every manifest action that adds one. Its layers come from its own `RenderLayers`, from
 * the chain it inherits (a mod ship deriving from terran keeps terran's layers), and from every
 * manifest action that adds entries to that ship's map, which is how a mod's own layers arrive.
 *
 * The part is matched to its ships through the ships' `Parts` lists, again including the ones a
 * manifest action appends. A part no ship registers has no scope, and both the popup and the check
 * then fall back to the union of every ship, since the file alone cannot say which ship will draw
 * it.
 */

/** The ship member holding the layer map, matched case-insensitively like the game's node lookup. */
const RENDER_LAYERS_MEMBER = 'RenderLayers';

/** The ship member holding the part list, matched the same way. */
const PARTS_MEMBER = 'Parts';

/** The verbs that can put new entries into a ship's `RenderLayers` map or its `Parts` list. */
const ADDING_VERBS = new Set(['Add', 'AddMany', 'Replace', 'Override', 'Overrides']);

/** One ship class and the layer ids a part drawn on it may name. */
export interface ShipLayerScope {
    /** The ship's identity, `fsPath|groupName` folded, as {@link shipEntryKey} builds it. */
    key: string;
    /** The ship group's name, for a message that can say which ship refused the layer. */
    shipName: string;
    /** The layer ids the ship declares, lower-cased: the game matches ids without regard to case. */
    layers: Set<string>;
}

/** The whole answer for one part: the ships that draw it, and the union of what they accept. */
export interface PartLayerScope {
    /** The ships whose `Parts` list registers the part, empty when nothing registers it. */
    ships: ShipLayerScope[];
    /** Every layer id of every ship in the project, the fallback pool when no ship claims the part. */
    allLayers: Set<string>;
}

/** The inputs a scope is built from, injected so the caller owns the workspace lookups. */
export interface ShipLayerContext {
    /** The game's own root `cosmoteer.rules`, parsed, which holds the ship registry. */
    gameRootDocument: AbstractNodeDocument | undefined;
    /** That file's path, which its `Ships` references resolve against. */
    gameRootPath: string | undefined;
    /** The workspace folders whose mods may add ships, layers or parts. */
    folderPaths: readonly string[];
}

/** One ship as the index holds it: its layers, and the elements that register parts to it. */
interface ShipRecord {
    scope: ShipLayerScope;
    /** The elements of the ship's own `Parts` list, with the directory they resolve against. */
    registrations: Array<{ elements: readonly AbstractNode[]; declaringDir: string }>;
}

/**
 * The built index, rebuilt when {@link invalidateShipLayers} says the files behind it moved. Every
 * read a query needs is resolved here, at build time: a validation pass runs over thousands of part
 * files and must not re-read a ship file or a manifest for each of them.
 */
interface ShipLayerData {
    /** Every ship class reached, keyed by {@link shipEntryKey}. */
    ships: Map<string, ShipRecord>;
    /** Every layer id any ship declares, lower-cased. */
    allLayers: Set<string>;
    /** The reach of every ship, from its registered parts outward, built on first need. */
    reach?: Promise<ShipReach>;
}

let cached: { key: string; data: Promise<ShipLayerData> } | undefined;

/**
 * Drops the built index, so the next question rebuilds it from disk. Called when a manifest or a
 * ship file changes: everything else the index reads is a part file, which cannot change a ship's
 * layer set.
 */
export const invalidateShipLayers = (): void => {
    cached = undefined;
};

/** The layer ids a `RenderLayers` node declares, in both spellings the deserializer accepts. */
const layerKeysOf = (node: AbstractNode | undefined, into: Set<string>): void => {
    if (!node) return;
    // The named form: `RenderLayers { asteroid_lights_add { … } }`, each member name a layer.
    if (isGroupNode(node)) {
        for (const [name] of namedMembersOf(node)) into.add(name.toLowerCase());
        return;
    }
    // The entry form: `RenderLayers [ { Key = "structure" Value { … } } ]`, which the game's own
    // ship files use, and which a mod action's payload arrives in.
    if (isListNode(node)) {
        for (const element of node.elements) {
            if (!isGroupNode(element)) continue;
            for (const [name, member] of namedMembersOf(element)) {
                if (name.toLowerCase() !== 'key' || !isValueNode(member)) continue;
                into.add(String(member.valueType.value).toLowerCase());
            }
        }
    }
};

/** Whether an action target names this ship's `RenderLayers` (or the ship group holding it). */
const targetsMember = (target: string, shipFsPath: string, groupName: string, member: string): boolean => {
    const normalized = normalizeTargetPath(target).toLowerCase();
    const wantedSuffix = `/${groupName.toLowerCase()}/${member.toLowerCase()}`;
    if (!normalized.endsWith(wantedSuffix)) return false;
    // The path names a file, which must be the ship's own file for the entries to land in its map.
    const opening = normalized.indexOf('<');
    const closing = normalized.indexOf('>');
    if (opening === -1 || closing === -1) return false;
    const file = normalized.slice(opening + 1, closing);
    return foldPathCase(shipFsPath).endsWith(foldPathCase(file).replace(/^\.?\//, ''));
};

/**
 * The nodes a manifest action supplies, each with the directory ITS own references resolve against.
 * That directory is the point: an inline payload is written in the manifest, but a payload reached
 * through `ManyToAdd = &<ships/terran/terran.rules>/Terran/Parts` lives in that file, and its entries
 * (`&<Crew/bed.rules>`) are relative to it. Resolving those against the manifest instead silently
 * matches nothing, which is how a mod's whole part list can look unregistered.
 */
const sourceNodesOf = async (
    sources: readonly ActionSource[],
    declaringDir: string
): Promise<Array<{ node: AbstractNode; dir: string }>> => {
    const nodes: Array<{ node: AbstractNode; dir: string }> = [];
    for (const source of sources) {
        if (isGroupNode(source) || isListNode(source)) {
            nodes.push({ node: source, dir: declaringDir });
            continue;
        }
        // A reference source (`ManyToAdd = &<layers.rules>/Layers`) keeps the entries in a file of
        // the mod's own, so the layers only show up once that file is read.
        for (const reference of referenceTextsOf(source)) {
            const location = locationOf(reference, declaringDir);
            if (!location) continue;
            const file = await readRulesFile(location.fsPath);
            if (!file) continue;
            let node: AbstractNode | undefined = file.document.elements.find(
                (element) =>
                    (isGroupNode(element) || isListNode(element)) &&
                    element.identifier?.name.toLowerCase() === location.groupPath[0]?.toLowerCase()
            );
            for (const segment of location.groupPath.slice(1)) {
                if (!node || !isGroupNode(node)) break;
                node = namedMembersOf(node).find(([name]) => name.toLowerCase() === segment.toLowerCase())?.[1];
            }
            if (node) nodes.push({ node, dir: dirOf(location.fsPath) });
        }
    }
    return nodes;
};

/** Builds the per-ship layer sets and the part lists that decide which ship draws a part. */
const build = async (context: ShipLayerContext, cancellationToken: CancellationToken): Promise<ShipLayerData> => {
    const modRoots = new Set<string>();
    for (const folder of context.folderPaths) for (const modRoot of modRootsUnder(folder)) modRoots.add(modRoot);
    const entries = await collectShipClasses(
        context.gameRootDocument,
        context.gameRootPath,
        [...modRoots],
        cancellationToken
    ).catch(() => [] as ShipClassEntry[]);

    const manifestPaths: string[] = [];
    for (const modRoot of modRoots) manifestPaths.push(...manifestsIn(modRoot));

    const ships = new Map<string, ShipRecord>();
    const allLayers = new Set<string>();
    for (const entry of entries) {
        if (cancellationToken.isCancellationRequested) break;
        const parts = await shipPartsListOf(entry.fsPath, entry.groupName).catch(() => undefined);
        const layers = new Set<string>();
        const registrations: ShipRecord['registrations'] = [];
        if (parts?.partsList) {
            registrations.push({ elements: parts.partsList.elements, declaringDir: dirOf(entry.fsPath) });
        }
        if (parts) {
            // Local and inherited alike: the game merges a group into the one it derives from, so a
            // mod ship deriving from terran keeps terran's layers beside the ones it adds.
            layerKeysOf(nodeOfMember(parts.group, RENDER_LAYERS_MEMBER), layers);
            const inherited = await effectiveMember(parts.group, RENDER_LAYERS_MEMBER, cancellationToken).catch(
                () => null
            );
            if (inherited?.inherited) layerKeysOf(inherited.node, layers);
        }
        ships.set(entry.key, { scope: { key: entry.key, shipName: entry.groupName, layers }, registrations });
    }

    // Manifest actions that add entries to a ship's map, which is where a mod's own layers come from.
    for (const manifestFsPath of manifestPaths) {
        if (cancellationToken.isCancellationRequested) break;
        const file = await readRulesFile(manifestFsPath);
        if (!file) continue;
        const declaringDir = dirOf(manifestFsPath);
        for (const action of parseModActions(file.document)) {
            if (!ADDING_VERBS.has(action.type)) continue;
            for (const entry of entries) {
                const record = ships.get(entry.key);
                if (!record) continue;
                const targets = action.targets.map((target) => String(target.valueType.value));
                if (targets.some((target) => targetsMember(target, entry.fsPath, entry.groupName, RENDER_LAYERS_MEMBER))) {
                    for (const { node } of await sourceNodesOf(action.sources, declaringDir)) {
                        layerKeysOf(node, record.scope.layers);
                    }
                }
                // A mod registers its part by appending to the ship's `Parts` list from the manifest,
                // which is the only thing that ties that part to that ship.
                if (targets.some((target) => targetsMember(target, entry.fsPath, entry.groupName, PARTS_MEMBER))) {
                    for (const { node, dir } of await sourceNodesOf(action.sources, declaringDir)) {
                        const elements = isListNode(node) ? (node.elements as AbstractNode[]) : [node];
                        record.registrations.push({ elements, declaringDir: dir });
                    }
                }
            }
        }
    }

    for (const record of ships.values()) for (const layer of record.scope.layers) allLayers.add(layer);
    return { ships, allLayers };
};

/** How far each ship's parts reach: the ids they declare, and the files they pull in. */
interface ShipReach {
    /** Declared part id → the ships registering a part with that id. */
    byId: Map<string, ShipLayerScope[]>;
    /** File path, case-folded → the ships whose parts reach that file. */
    byFile: Map<string, ShipLayerScope[]>;
}

/** How many hops out from a registered part the walk follows a file reference. */
const MAX_REACH_DEPTH = 4;

/**
 * One spelling of a file path, so a path written with backslashes and one written with forward
 * slashes key the same entry. The same canonicalization {@link shipEntryKey} does, without a group.
 *
 * @param fsPath the path in any spelling.
 * @returns the key.
 */
const filePathKey = (fsPath: string): string => foldPathCase(resolve(fsPath).replace(/\\/g, '/'));

/** Every rules file a document's text names, the base it derives from included. */
const FILE_REFERENCES = /<([^<>\n]+\.(?:rules|txt))>/gi;

/**
 * The reach of every ship: the parts it registers, the ids those parts declare, and the files those
 * parts pull in, followed a few hops outward.
 *
 * This is what scopes the files a `Parts` list never names. A part is written across several files:
 * the base it derives from, a blend-sprite fragment, an effect file. Those hold `Layer` too, and the
 * ship that draws them is whichever ship draws the part that pulls them in. Walking out from the
 * registered parts rather than scanning the project keeps it bounded, and a file two ships both
 * reach is attributed to both, so a fragment shared between ship classes accepts either one's layers
 * instead of being reported for whichever ship happened to be found first.
 *
 * @param data the built index whose registrations name the part files.
 * @returns the reach maps, empty when nothing could be read.
 */
const buildShipReach = async (data: ShipLayerData): Promise<ShipReach> => {
    const byId = new Map<string, ShipLayerScope[]>();
    const byFile = new Map<string, ShipLayerScope[]>();
    const attribute = (map: Map<string, ShipLayerScope[]>, key: string, scope: ShipLayerScope): boolean => {
        const scopes = map.get(key) ?? map.set(key, []).get(key)!;
        if (scopes.some((known) => known.key === scope.key)) return false;
        scopes.push(scope);
        return true;
    };

    for (const record of data.ships.values()) {
        const queue: Array<{ fsPath: string; depth: number }> = [];
        for (const registration of record.registrations) {
            for (const element of registration.elements) {
                if (!isValueNode(element) || element.valueType.type !== 'Reference') continue;
                const location = locationOf(String(element.valueType.value), registration.declaringDir);
                if (!location) continue;
                queue.push({ fsPath: location.fsPath, depth: 0 });
                const file = await readRulesFile(location.fsPath);
                const group = file?.document.elements.find(
                    (node): node is GroupNode =>
                        isGroupNode(node) &&
                        !!location.groupPath[0] &&
                        node.identifier?.name.toLowerCase() === location.groupPath[0].toLowerCase()
                );
                const id = group ? nodeOfMember(group, 'ID') : undefined;
                if (id && isValueNode(id)) {
                    const written = String(id.valueType.value).trim().toLowerCase();
                    if (written) attribute(byId, written, record.scope);
                }
            }
        }
        // Breadth-first out from the parts. A file this ship already reaches is not walked twice,
        // which also ends any cycle between two files that name each other.
        while (queue.length > 0) {
            const { fsPath, depth } = queue.shift()!;
            const fresh = attribute(byFile, filePathKey(fsPath), record.scope);
            if (!fresh || depth >= MAX_REACH_DEPTH) continue;
            const file = await readRulesFile(fsPath);
            if (!file) continue;
            const declaringDir = dirOf(fsPath);
            FILE_REFERENCES.lastIndex = 0;
            for (let match = FILE_REFERENCES.exec(file.text); match; match = FILE_REFERENCES.exec(file.text)) {
                // The path alone, without the member path a reference usually carries: what is
                // wanted here is the file, whatever the reference reads inside it.
                const referenced = resolveBasePath(match[1], declaringDir);
                if (referenced) queue.push({ fsPath: referenced, depth: depth + 1 });
            }
        }
    }
    return { byId, byFile };
};

/** A group's own member by name, matched case-insensitively like the game's node lookup. */
const nodeOfMember = (group: GroupNode, name: string): AbstractNode | undefined =>
    namedMembersOf(group).find(([member]) => member.toLowerCase() === name.toLowerCase())?.[1];

/** The built index for this context, from the cache when the files behind it have not moved. */
const dataFor = (context: ShipLayerContext, cancellationToken: CancellationToken): Promise<ShipLayerData> => {
    const key = `${context.gameRootPath ?? ''}|${[...context.folderPaths].sort().join('|')}`;
    if (cached?.key === key) return cached.data;
    const data = build(context, cancellationToken);
    cached = { key, data };
    return data;
};

/**
 * The layer scope a part file falls under.
 *
 * @param partFsPath the part file's on-disk path.
 * @param partGroupName the part group's name inside it.
 * @param context the workspace inputs the index is built from.
 * @param cancellationToken cancels the manifest and ship reads.
 * @returns the ships that register the part and the project-wide layer pool.
 */
export const layerScopeForPart = async (
    partFsPath: string,
    partGroupName: string,
    context: ShipLayerContext,
    cancellationToken: CancellationToken,
    partId?: string
): Promise<PartLayerScope> => {
    const data = await dataFor(context, cancellationToken);
    // The group asked about may be a ship rather than a part: a ship file writes `Layer` on its own
    // `Doors` and `ExternalWalls`, and those are drawn by that very ship.
    const own = data.ships.get(shipEntryKey(partFsPath, partGroupName));
    if (own) return { ships: [own.scope], allLayers: data.allLayers };

    const ships: ShipLayerScope[] = [];
    for (const record of data.ships.values()) {
        const registers = record.registrations.some((registration) =>
            partsListRegisters(registration.elements, registration.declaringDir, partFsPath, partGroupName)
        );
        if (registers) ships.push(record.scope);
    }
    if (ships.length === 0) {
        // No list names this file. Two things still tie it to a ship: the id it declares, which a
        // copy of a game part keeps, and the parts that pull it in, which is how a base file or a
        // sprite fragment is reached.
        data.reach ??= buildShipReach(data);
        const reach = await data.reach.catch(
            () => ({ byId: new Map(), byFile: new Map() }) as ShipReach
        );
        if (partId) ships.push(...(reach.byId.get(partId.trim().toLowerCase()) ?? []));
        if (ships.length === 0) ships.push(...(reach.byFile.get(filePathKey(partFsPath)) ?? []));
    }
    return { ships, allLayers: data.allLayers };
};

/**
 * Whether a layer id is one the given scope accepts.
 *
 * @param scope the part's scope, from {@link layerScopeForPart}.
 * @param layer the layer id written in the file.
 * @returns `accepted` when a ship that draws the part declares it, `foreign` when only another ship
 *          does, and `unknown` when no ship in the project declares it at all.
 */
export const judgeLayer = (scope: PartLayerScope, layer: string): 'accepted' | 'foreign' | 'unknown' => {
    const id = layer.toLowerCase();
    if (scope.ships.length === 0) return scope.allLayers.has(id) ? 'accepted' : 'unknown';
    if (scope.ships.some((ship) => ship.layers.has(id))) return 'accepted';
    return scope.allLayers.has(id) ? 'foreign' : 'unknown';
};
