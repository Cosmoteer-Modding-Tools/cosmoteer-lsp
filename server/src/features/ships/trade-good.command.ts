import { Dirent, existsSync, readdirSync } from 'fs';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { ActionSource } from '../../mod/action';
import { identityOfMod, ModIdentity } from '../../mod/mod-dependencies';
import {
    gameRootListTarget,
    manifestActionMatches,
    manifestForRegistration,
} from '../refactor/new-content/registration.emitter';
import { dirOf, readRulesFile, resolveBasePath } from '../refactor/shared-base/base-index';
import { memberOf } from '../refactor/new-content/registry-ids';
import { actionEntryText } from './builtin-ships.emitter';
import { appendManifestActions, elementTextOf, modRootFor, openManifest, scalarOf } from './mod-wiring';
import {
    TradeGoodApplyResult,
    TradeGoodArgs,
    TradeGoodFailure,
    TradeGoodHost,
    TradeGoodResult,
    TradeGoodScanResult,
    TradeRarity,
    TradeResource,
} from './trade-good.types';

/**
 * The `workspace/executeCommand` id that puts a resource into the career trade. Both clients invoke
 * it twice: without a resource it reports which resources the workspace and the game declare and
 * which of them the mod already trades, with one it writes the two manifest actions that make trade
 * ships carry it and stations stock it.
 *
 * Nothing is created in the mod tree. A resource the game never trades is still buildable and
 * minable, but no trade ship ever carries it and no station ever holds it, so it can neither be
 * bought nor sold. The trade ship template's `ResourcesCarried` and the basic sector's
 * `StationResourceTradeDeltas` are the two lists that decide this, and every trade ship and every
 * sector type inherits them, so one entry in each reaches the whole galaxy.
 */
export const TRADE_GOOD_COMMAND = 'cosmoteer.tradeGood';

/** The game root members naming the resource registry and the career mode. */
const RESOURCES_MEMBER = 'Resources';
const CAREER_MODE_MEMBER = 'CareerMode';

/** The registry the game's own resources sit in, when the game root names none. */
const RESOURCES_FILE = 'resources/resources.rules';
const RESOURCES_LIST = 'Resources';

/** The career file and the list inside it every trade ship draws its cargo from, when the game root names none. */
const CAREER_FILE = 'modes/career/career.rules';
const CARGO_LIST = 'BaseTradeShip/ResourcesCarried';

/** The basic sector every sector type inherits, and the list inside it stations stock from. */
const SECTOR_FILE = 'modes/career/sectors/sector_basic/sector_basic.rules';
const STATIONS_LIST = 'Sector/TradeRoutes/StationResourceTradeDeltas';
const STATIONS_TARGET = `<${SECTOR_FILE}>/${STATIONS_LIST}`;

/** The schema class resources declare, which the host's id index is asked about. */
const RESOURCE_CLASS = 'Cosmoteer.Resources.ResourceRules';

/** The folder name a mod declares its resources under, matched ignoring case. */
const RESOURCES_FOLDER = 'resources';

/** How deep under the mod root the resource sweep looks. */
const SWEEP_DEPTH = 6;

/** The members of a resource file and of a trade entry the command reads. */
const ID_MEMBER = 'ID';
const NAME_KEY_MEMBER = 'NameKey';
const MAX_STACK_MEMBER = 'MaxStackSize';
const RESOURCE_TYPE_MEMBER = 'ResourceType';

/** The share of a station's typed storage the game's own entries all fill. */
const TYPED_BAND = '[80%, 90%]';

/** The figures one rarity writes: the cargo weight and quantity, and the untyped station band for stocking or buying. */
interface RarityFigures {
    readonly weight: number;
    readonly quantity: string;
    /** The share of untyped station storage it fills when stations stock it. */
    readonly stocked: string;
    /** The share stations buy it up to when they buy rather than stock it, a band that stays below zero. */
    readonly bought: string;
}

/** The game's own calibration: staples weigh 20 with a full hold, precious goods weigh 5 and half a hold. */
const RARITIES: Record<TradeRarity, RarityFigures> = {
    common: { weight: 20, quantity: '[75%, 100%]', stocked: '[0%, 10%]', bought: '[-10%, 0%]' },
    uncommon: { weight: 10, quantity: '[75%, 100%]', stocked: '[0%, 5%]', bought: '[-5%, 0%]' },
    rare: { weight: 5, quantity: '[50%, 100%]', stocked: '[-0.5%, 0.5%]', bought: '[-0.5%, 0%]' },
};

/** A scan result carrying nothing but the reason there is nothing to report. */
const scanFailed = (failure: TradeGoodFailure): TradeGoodScanResult => ({
    kind: 'scan',
    modRoot: '',
    modId: '',
    resources: [],
    failure,
});

/** An apply result carrying nothing but the reason nothing was written. */
const applyFailed = (resource: string, failure: TradeGoodFailure): TradeGoodApplyResult => ({
    kind: 'apply',
    resource,
    manifest: '',
    wiring: { cargo: 'noTarget', stations: 'noTarget' },
    changedFiles: [],
    failure,
});

/** A resource as its file declares it. */
interface DeclaredResource {
    readonly id: string;
    readonly nameKey?: string;
    /** Whether `MaxStackSize` is above zero. A file declaring none is read as stackable, since the game's default is. */
    readonly stackable: boolean;
}

/**
 * The resource a file declares at its top level.
 *
 * @param document the parsed file.
 * @returns the resource, or undefined when the file declares no id.
 */
const declaredResourceOf = (document: AbstractNodeDocument): DeclaredResource | undefined => {
    const id = scalarOf(document, ID_MEMBER);
    if (!id) return undefined;
    const stack = scalarOf(document, MAX_STACK_MEMBER);
    const stackable = stack === undefined || !Number.isFinite(Number(stack)) || Number(stack) > 0;
    const nameKey = scalarOf(document, NAME_KEY_MEMBER);
    return { id, stackable, ...(nameKey ? { nameKey } : {}) };
};

/**
 * The file and the member path a `<file>/Member/Path` target or reference names.
 *
 * @param text the target or reference text, sigil or not.
 * @param declaringDir the directory it is written in.
 * @returns the file's path and the member segments, or undefined when the text names no file.
 */
const locationOf = (text: string, declaringDir: string): { file: string; members: string[] } | undefined => {
    const match = /^\s*&?\s*<([^<>]+)>\/?(.*)$/.exec(text);
    if (!match) return undefined;
    const file = resolveBasePath(match[1], declaringDir)?.replace(/\\/g, '/');
    if (!file) return undefined;
    return { file, members: match[2].split('/').filter((segment) => segment.length > 0) };
};

/**
 * The node a member path reaches inside a parsed file, descending by name and, in a list, by index.
 *
 * @param document the parsed file.
 * @param members the segments.
 * @returns the node, or undefined when a segment names nothing.
 */
const descend = (document: AbstractNodeDocument, members: readonly string[]): AbstractNode | undefined => {
    let scope: { elements: AbstractNode[] } | undefined = document;
    let node: AbstractNode | undefined;
    for (const segment of members) {
        if (!scope) return undefined;
        node = isListNode(node) && /^\d+$/.test(segment) ? node.elements[Number(segment)] : memberOf(scope, segment);
        if (!node) return undefined;
        scope = isGroupNode(node) || isListNode(node) ? node : undefined;
    }
    return node;
};

/**
 * The game's own resources, in the order the registry the game root names lists them.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @returns the resources, or undefined when the registry cannot be read.
 */
const gameResourcesOf = async (
    rootDocument: AbstractNodeDocument,
    rootFsPath: string,
    dataRoot: string
): Promise<DeclaredResource[] | undefined> => {
    const target = gameRootListTarget(rootDocument, rootFsPath, dataRoot, RESOURCES_MEMBER);
    const location = target ? locationOf(target, dirOf(rootFsPath)) : undefined;
    const registry = location ?? {
        file: `${dataRoot.replace(/\\/g, '/')}/${RESOURCES_FILE}`,
        members: [RESOURCES_LIST],
    };
    const read = await readRulesFile(registry.file);
    if (!read) return undefined;
    const list = descend(read.document, registry.members);
    if (!isListNode(list)) return undefined;
    const resources: DeclaredResource[] = [];
    for (const element of list.elements) {
        const text = elementTextOf(element);
        const named = text ? locationOf(text, dirOf(registry.file)) : undefined;
        const file = named ? await readRulesFile(named.file) : undefined;
        const resource = file ? declaredResourceOf(file.document) : undefined;
        if (resource) resources.push(resource);
    }
    return resources;
};

/**
 * The resources a mod declares in its own files: every rules file under a folder named
 * `resources` whose top level declares an id. The manifest is not consulted, since a resource
 * file is worth trading whether or not it is registered yet.
 *
 * @param modRoot the mod.
 * @returns the resources, in path order.
 */
const modResourcesOf = async (modRoot: string): Promise<DeclaredResource[]> => {
    const files: string[] = [];
    const walk = (dir: string, depth: number, inResources: boolean): void => {
        if (depth > SWEEP_DEPTH) return;
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.')) continue;
                walk(path, depth + 1, inResources || entry.name.toLowerCase() === RESOURCES_FOLDER);
            } else if (inResources && entry.isFile() && entry.name.toLowerCase().endsWith('.rules')) {
                files.push(path);
            }
        }
    };
    walk(modRoot, 0, false);
    const resources: DeclaredResource[] = [];
    for (const file of files) {
        const read = await readRulesFile(file);
        const resource = read ? declaredResourceOf(read.document) : undefined;
        if (resource) resources.push(resource);
    }
    return resources;
};

/**
 * Whether a source of a trade action names a resource: an inline entry or list of entries whose
 * `ResourceType` is the id, or a reference to a list in another file whose entries name it.
 *
 * @param source the action's source value.
 * @param declaringDir the manifest's directory, which a reference resolves against.
 * @param resourceId the id looked for.
 * @returns true when one entry names it.
 */
const sourceNamesResource = async (
    source: ActionSource,
    declaringDir: string,
    resourceId: string
): Promise<boolean> => {
    const wanted = resourceId.toLowerCase();
    const entriesName = (entries: readonly AbstractNode[]): boolean =>
        entries.some((entry) => isGroupNode(entry) && scalarOf(entry, RESOURCE_TYPE_MEMBER)?.toLowerCase() === wanted);
    if (isGroupNode(source)) return entriesName([source]);
    if (isListNode(source)) {
        if (entriesName(source.elements)) return true;
        for (const element of source.elements) {
            if (
                isValueNode(element) &&
                element.valueType.type === 'Reference' &&
                (await sourceNamesResource(element, declaringDir, resourceId))
            )
                return true;
        }
        return false;
    }
    if (source.valueType.type !== 'Reference') return false;
    const location = locationOf(String(source.valueType.value), declaringDir);
    const read = location ? await readRulesFile(location.file) : undefined;
    if (!location || !read) return false;
    const node = descend(read.document, location.members);
    if (isListNode(node)) return entriesName(node.elements);
    return isGroupNode(node) ? entriesName([node]) : false;
};

/**
 * Whether the mod's manifests already add a resource to a trade list.
 *
 * @param modRoot the mod.
 * @param target the action target.
 * @param resourceId the id looked for.
 * @returns true when one manifest already carries an entry for it.
 */
const alreadyTraded = async (modRoot: string, target: string, resourceId: string): Promise<boolean> =>
    await manifestActionMatches(modRoot, target, (source, declaringDir) =>
        sourceNamesResource(source, declaringDir, resourceId)
    );

/**
 * The action target of the trade ship template's cargo list, read off the game root the way the
 * ship registry's is: `CareerMode = &<modes/career/career.rules>` names the file, and the list
 * inside it is the one every trade ship draws from. A game root naming no career mode falls back
 * to the game's own path when the file is there.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @returns the target, or undefined when neither names a career file that is on disk.
 */
const cargoTarget = (rootDocument: AbstractNodeDocument, rootFsPath: string, dataRoot: string): string | undefined => {
    const named = gameRootListTarget(rootDocument, rootFsPath, dataRoot, CAREER_MODE_MEMBER);
    const location = named ? locationOf(named, dirOf(rootFsPath)) : undefined;
    if (named && location && existsSync(location.file)) return `${named.replace(/>.*$/, '>')}/${CARGO_LIST}`;
    return existsSync(`${dataRoot.replace(/\\/g, '/')}/${CAREER_FILE}`) ? `<${CAREER_FILE}>/${CARGO_LIST}` : undefined;
};

/** The two trade targets, each absent when the install has no such file. */
interface TradeTargets {
    readonly cargo: string | undefined;
    readonly stations: string | undefined;
}

/**
 * The two lists the trade reads, as action targets.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @returns the targets.
 */
const tradeTargetsOf = (rootDocument: AbstractNodeDocument, rootFsPath: string, dataRoot: string): TradeTargets => ({
    cargo: cargoTarget(rootDocument, rootFsPath, dataRoot),
    stations: existsSync(`${dataRoot.replace(/\\/g, '/')}/${SECTOR_FILE}`) ? STATIONS_TARGET : undefined,
});

/**
 * Every resource the trade could carry: the mod's own, the game's, and the ids the workspace index
 * knows that neither file sweep reached, each with whether the mod already trades it.
 *
 * @param modRoot the mod.
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @param host the server facilities.
 * @param cancellationToken cancels the lookups.
 * @returns the resources, or undefined when the game's registry cannot be read.
 */
const resourcesOf = async (
    modRoot: string,
    rootDocument: AbstractNodeDocument,
    rootFsPath: string,
    dataRoot: string,
    host: TradeGoodHost,
    cancellationToken: CancellationToken
): Promise<TradeResource[] | undefined> => {
    const game = await gameResourcesOf(rootDocument, rootFsPath, dataRoot);
    if (!game) return undefined;
    const mod = await modResourcesOf(modRoot);
    const targets = tradeTargetsOf(rootDocument, rootFsPath, dataRoot);
    const seen = new Set<string>();
    const resources: TradeResource[] = [];
    const add = async (declared: DeclaredResource, source: TradeResource['source']): Promise<void> => {
        const key = declared.id.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        const name =
            declared.nameKey && host.localizedName
                ? await host.localizedName(declared.nameKey, cancellationToken).catch(() => undefined)
                : undefined;
        resources.push({
            id: declared.id,
            ...(name ? { name } : {}),
            source,
            stackable: declared.stackable,
            alreadyCarried: targets.cargo ? await alreadyTraded(modRoot, targets.cargo, declared.id) : false,
            alreadyStocked: targets.stations ? await alreadyTraded(modRoot, targets.stations, declared.id) : false,
        });
    };
    for (const declared of mod) await add(declared, 'mod');
    for (const declared of game) await add(declared, 'game');
    // An id the index knows from a file the sweep did not reach (another workspace mod, or a
    // resource declared outside a resources folder) is offered as well, read as stackable since
    // nothing says otherwise.
    const indexed = await host
        .existingIds?.(RESOURCE_CLASS, cancellationToken)
        .catch((): ReadonlySet<string> => new Set());
    for (const id of [...(indexed ?? [])].sort()) await add({ id, stackable: true }, 'mod');
    return resources;
};

/**
 * Wire the resource into both trade lists.
 *
 * @param args the client's arguments.
 * @param modRoot the mod whose manifest is written.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what was wired.
 */
const applyRound = async (
    args: TradeGoodArgs,
    modRoot: string,
    host: TradeGoodHost,
    cancellationToken: CancellationToken
): Promise<TradeGoodApplyResult> => {
    const resourceId = (args.resource ?? '').trim();
    const dataRoot = host.dataRoot();
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
    if (!dataRoot || !root?.path || !rootDocument) return applyFailed(resourceId, 'noGameRoot');
    const resources = await resourcesOf(modRoot, rootDocument, root.path, dataRoot, host, cancellationToken);
    if (!resources) return applyFailed(resourceId, 'noGameRoot');
    const resource = resources.find((candidate) => candidate.id.toLowerCase() === resourceId.toLowerCase());
    if (!resource) return applyFailed(resourceId, 'unknownResource');
    if (!resource.stackable) return applyFailed(resource.id, 'notStackable');

    const rarity: TradeRarity = args.rarity && args.rarity in RARITIES ? args.rarity : 'uncommon';
    const figures = RARITIES[rarity];
    const untyped = args.stationsBuy === true ? figures.bought : figures.stocked;
    const targets = tradeTargetsOf(rootDocument, root.path, dataRoot);
    const wiring: TradeGoodApplyResult['wiring'] = { cargo: 'noTarget', stations: 'noTarget' };
    const changed: string[] = [];
    let manifestPath = '';
    let manifests: string[] | undefined;

    const choice = manifestForRegistration(modRoot);
    if (choice.kind === 'ambiguous') {
        wiring.cargo = 'ambiguousManifest';
        wiring.stations = 'ambiguousManifest';
        manifests = choice.manifests;
    } else if (choice.kind === 'manifest') {
        manifestPath = choice.fsPath;
        const manifest = await openManifest(choice.fsPath, host);
        const { insert, lineEnding } = manifest;
        const entries: string[] = [];
        const written: (keyof typeof wiring)[] = [];
        const plans: { key: keyof typeof wiring; target: string | undefined; entry: string }[] = [
            {
                key: 'cargo',
                target: targets.cargo,
                entry: `{ ${RESOURCE_TYPE_MEMBER}=${resource.id}; RandomWeight=${figures.weight}; RandomQuantity=${figures.quantity}; }`,
            },
            {
                key: 'stations',
                target: targets.stations,
                entry: `{ ${RESOURCE_TYPE_MEMBER}=${resource.id}; PercentOfTypedTiles=${TYPED_BAND}; PercentOfUntypedTiles=${untyped}; }`,
            },
        ];
        for (const plan of plans) {
            if (!plan.target) continue;
            if (await alreadyTraded(modRoot, plan.target, resource.id)) {
                wiring[plan.key] = 'present';
                continue;
            }
            if (insert.kind === 'unusable') {
                wiring[plan.key] = 'manifestUnusable';
                continue;
            }
            entries.push(
                actionEntryText(
                    ['Action = AddMany', `AddTo = "${plan.target}"`, 'ManyToAdd', '[', `\t${plan.entry}`, ']'],
                    insert.indent,
                    lineEnding
                )
            );
            wiring[plan.key] = 'written';
            written.push(plan.key);
        }
        if (entries.length > 0) {
            if (await appendManifestActions(manifest, entries, host)) changed.push(choice.fsPath);
            else for (const key of written) wiring[key] = 'editRejected';
        }
    }

    return { kind: 'apply', resource: resource.id, manifest: manifestPath, wiring, manifests, changedFiles: changed };
};

/**
 * The command entry point: report which resources could be traded when the client named none, and
 * wire one in otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what could be traded, or what was wired.
 */
export const tradeGood = async (
    args: TradeGoodArgs,
    host: TradeGoodHost,
    cancellationToken: CancellationToken
): Promise<TradeGoodResult> => {
    const scanning = args.resource === undefined;
    const located = modRootFor(args.uri, host.dataRoot());
    if ('failure' in located)
        return scanning ? scanFailed(located.failure) : applyFailed(args.resource ?? '', located.failure);
    if (!scanning) return await applyRound(args, located.modRoot, host, cancellationToken);

    const identity = await identityOfMod(located.modRoot).catch((): ModIdentity => ({ root: located.modRoot }));
    const dataRoot = host.dataRoot();
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
    if (!dataRoot || !root?.path || !rootDocument) return scanFailed('noGameRoot');
    const resources = await resourcesOf(located.modRoot, rootDocument, root.path, dataRoot, host, cancellationToken);
    if (!resources) return scanFailed('noGameRoot');
    return { kind: 'scan', modRoot: located.modRoot, modId: identity.manifestId ?? '', resources };
};
