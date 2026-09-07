import { constants, existsSync, statSync } from 'fs';
import { copyFile, mkdir, readdir, writeFile } from 'fs/promises';
import { basename, dirname, relative } from 'path';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNodeDocument, isGroupNode, isListNode } from '../../core/ast/ast';
import { ActionSource } from '../../mod/action';
import { identityOfMod, ModIdentity } from '../../mod/mod-dependencies';
import { findModRoot } from '../../mod/mod-root';
import { namedMembersOf, parseText } from '../../utils/ast.utils';
import { isUnder } from '../../utils/relative-path';
import { foldPathCase } from '../../workspace/fs-cache';
import { filePathToUri } from '../navigation/navigation-strategy';
import { normalizeUri } from '../navigation/reference-location';
import { uriToFsPath } from '../navigation/workspace-files';
import { PartStatsIndex } from '../part-table/part-table.types';
import { documentFor, lineEndingOf, openBuffers } from '../refactor/command-host';
import { addManyActionText, manifestActionInsert } from '../refactor/register-part/manifest-action.emitter';
import { writeLocalizationKeys } from '../refactor/new-content/new-content.command';
import { stasisIconPng, IconPart } from './ship-icon';
import { Blueprint } from './ship-blueprint';
import { RegisterPartHost } from '../refactor/register-part/register-part.types';
import { modRootsUnder } from '../refactor/register-part/ship-registry';
import {
    gameRootListTarget,
    manifestActionMatches,
    manifestAlreadyAdds,
    manifestForRegistration,
} from '../refactor/new-content/registration.emitter';
import { relativeRulesReference } from '../refactor/shared-base/base-file.emitter';
import { dirOf, readRulesFile } from '../refactor/shared-base/base-index';
import { editableModRootOf } from '../refactor/shared-base/shared-base.analysis-entry';
import {
    actionEntryText,
    addConcatenatedSource,
    aggregatorText,
    appendToGroup,
    appendToList,
    factionPathsOf,
    idPrefixForRole,
    keyLabelOf,
    roleFileReference,
    roleFileText,
    rolePathsOf,
    shipEntryText,
    SHIPS_MEMBER,
    topLevelList,
    TRADE_SHIPS_MEMBER,
    tradeShipEntryFor,
    tradeShipEntryText,
    tradeShipsFileText,
    factionSegment,
} from './builtin-ships.emitter';
import { Insertion, LineEnding } from './builtin-ships.types';
import { CareerBalance, readCareerBalance } from './career-balance';
import { collectFactions, FactionEntry } from './faction-registry';
import { collectResourcePrices } from '../part-table/resource-prices';
import {
    FactionChoice,
    ManifestFailure,
    RegisteredShip,
    RegisterShipApplyResult,
    RegisterShipArgs,
    RegisterShipFailure,
    RegisterShipResult,
    RegisterShipScanResult,
    ScannedShip,
    ShipChoice,
    ShipRegistrationFailure,
} from './register-ship.types';
import { assessBlueprint, blueprintName, SHIP_ROLES, tierForRole } from './ship-assessment';
import { ShipAssessment, ShipRole } from './ship-assessment.types';
import { readShipBlueprint } from './ship-blueprint';
import { ShipLayerContext } from './ship-layer.index';

/**
 * The `workspace/executeCommand` id that puts saved ships into a faction's spawn pool. Both clients
 * invoke it twice: without choices it reads the blueprints and says what each one is, with them it
 * copies the ships into the mod, writes the registrations and wires the faction into the manifest.
 *
 * Judging and registering are one exchange because the whole point is that nothing has to be typed:
 * the tier is the game's own arithmetic over the parts, the difficulty is read against the game's
 * own ships, the role is read off what the ship carries, and the client only has to confirm.
 */
export const REGISTER_SHIP_COMMAND = 'cosmoteer.registerShip';

/** The file extension a saved ship carries. */
const BLUEPRINT_SUFFIX = '.ship.png';

/** The game root member naming the built-in ships database, the list a mod's ships are added to. */
const BUILTIN_SHIPS_MEMBER = 'BuiltinShips';

/** The game root member naming the career mode, whose `TradeShips` the trade routes are added to. */
const CAREER_MODE_MEMBER = 'CareerMode';

/** The schema class built-in ship ids are declared under, for the collision check. */
const BUILTIN_SHIP_CLASS = 'Cosmoteer.Data.BuiltinShipRules';

/** How many blueprints one round reads, so a whole saved-ships folder still answers in time. */
const MAX_BLUEPRINTS = 200;

/** The name a folder stands in as a file under, so the mod gate judges it as a file inside itself. */
const FOLDER_ANCHOR = 'anchor.rules';

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface RegisterShipHost extends RegisterPartHost {
    /** The game root and the workspace folders, which the part walk and the registries read. */
    layerContext(): Promise<ShipLayerContext>;
    /**
     * The figures of every part the game and a mod declare, keyed by id.
     *
     * @param context the game root and the workspace folders.
     * @param modRoot the mod whose own parts are read as well.
     * @param cancellationToken cancels the walk.
     * @returns the index.
     */
    partStats(context: ShipLayerContext, modRoot: string, cancellationToken: CancellationToken): Promise<PartStatsIndex>;
    /**
     * Every id the project declares for a schema class, so a ship whose name the game already has
     * is refused before anything is written. Optional because the mod's own files are checked
     * either way.
     *
     * @param cls the schema class whose ids are wanted.
     * @param cancellationToken cancels the lookup.
     * @returns the declared ids, in whatever case they are written.
     */
    existingIds?(cls: string, cancellationToken: CancellationToken): Promise<ReadonlySet<string>>;
    /**
     * The display name a localization key resolves to, for the faction picker.
     *
     * @param key the key path.
     * @param cancellationToken cancels the lookup.
     * @returns the text, or undefined when no language file declares the key.
     */
    localizedName?(key: string, cancellationToken: CancellationToken): Promise<string | undefined>;
}

/** A scan result carrying nothing but the reason there is nothing to report. */
const scanFailed = (failure: RegisterShipFailure): RegisterShipScanResult => ({
    kind: 'scan',
    modRoot: '',
    modId: '',
    factions: [],
    ships: [],
    balanceFallback: true,
    partsTruncated: false,
    failure,
});

/** An apply result carrying nothing but the reason nothing was registered. */
const applyFailed = (failure: RegisterShipFailure, faction = ''): RegisterShipApplyResult => ({
    kind: 'apply',
    faction,
    ships: [],
    manifest: '',
    createdFiles: [],
    changedFiles: [],
    failure,
});

/** The comparison key of a path, folded the way the filesystem matches it. */
const pathKey = (fsPath: string): string => foldPathCase(fsPath.replace(/\\/g, '/'));

/** Whether a path names a directory, false for anything that cannot be read. */
const isDirectoryAt = (fsPath: string): boolean => {
    try {
        return statSync(fsPath).isDirectory();
    } catch {
        return false;
    }
};

/**
 * The mod a file or folder belongs to, or why the command may not write beside it.
 *
 * @param uri the uri the client sent.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the mod root, or the refusal.
 */
const modRootFor = (
    uri: string,
    dataRoot: string | undefined
): { readonly modRoot: string } | { readonly failure: RegisterShipFailure } => {
    let fsPath = uriToFsPath(uri).replace(/\\/g, '/').replace(/\/+$/, '');
    if (isDirectoryAt(fsPath)) fsPath = `${fsPath}/${FOLDER_ANCHOR}`;
    const modRoot = editableModRootOf(fsPath);
    if (modRoot) return { modRoot: modRoot.replace(/\\/g, '/') };
    const refused = findModRoot(fsPath) !== null || isUnder(fsPath, dataRoot);
    return { failure: refused ? 'notEditable' : 'noModRoot' };
};

/**
 * The blueprint files the client named, a folder standing for every blueprint directly in it.
 *
 * @param named the paths the client sent.
 * @returns the files, each once, capped.
 */
const blueprintFiles = async (named: readonly string[]): Promise<string[]> => {
    const files: string[] = [];
    const seen = new Set<string>();
    const push = (fsPath: string): void => {
        const normalized = fsPath.replace(/\\/g, '/');
        const key = pathKey(normalized);
        if (seen.has(key) || !normalized.toLowerCase().endsWith(BLUEPRINT_SUFFIX)) return;
        seen.add(key);
        files.push(normalized);
    };
    for (const raw of named) {
        const fsPath = raw.startsWith('file:') ? uriToFsPath(raw) : raw;
        if (!existsSync(fsPath)) continue;
        if (!isDirectoryAt(fsPath)) {
            push(fsPath);
            continue;
        }
        const names = await readdir(fsPath).catch((): string[] => []);
        for (const name of names.sort((a, b) => a.localeCompare(b))) push(`${fsPath.replace(/\\/g, '/')}/${name}`);
    }
    return files.slice(0, MAX_BLUEPRINTS);
};

/**
 * The factions the ships could join, the mod's own first, each with its display name when a
 * language file declares one.
 *
 * @param entries the factions the registries hold.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the name lookups.
 * @returns the choices.
 */
const factionChoices = async (
    entries: readonly FactionEntry[],
    modRoot: string,
    host: RegisterShipHost,
    cancellationToken: CancellationToken
): Promise<FactionChoice[]> => {
    const choices: FactionChoice[] = [];
    for (const entry of entries) {
        const own = !!entry.modRoot && pathKey(entry.modRoot) === pathKey(modRoot);
        const name =
            entry.nameKey && host.localizedName
                ? await host.localizedName(entry.nameKey, cancellationToken).catch(() => undefined)
                : undefined;
        choices.push({ id: entry.id, name, source: entry.source, own });
    }
    return choices.sort((a, b) => Number(b.own) - Number(a.own));
};

/** Everything the scan and the apply rounds both read before judging a blueprint. */
interface Judging {
    readonly context: ShipLayerContext;
    readonly stats: PartStatsIndex;
    readonly balance: CareerBalance;
}

/**
 * Reads what a blueprint is judged against.
 *
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns the figures.
 */
const judging = async (modRoot: string, host: RegisterShipHost, cancellationToken: CancellationToken): Promise<Judging> => {
    const context = await host.layerContext();
    const stats = await host.partStats(context, modRoot, cancellationToken);
    const prices = await collectResourcePrices(context, cancellationToken);
    const balance = await readCareerBalance(context, prices, cancellationToken);
    return { context, stats, balance };
};

/**
 * Judges one blueprint for the scan.
 *
 * @param fsPath the blueprint's file.
 * @param modRoot the mod being written to.
 * @param figures what the blueprint is judged against.
 * @param takenIds the built-in ship ids already in use, folded.
 * @returns the scanned ship.
 */
const scanShip = async (fsPath: string, modRoot: string, figures: Judging, takenIds: ReadonlySet<string>): Promise<ScannedShip> => {
    const insideMod = isUnder(fsPath, modRoot);
    const blueprint = await readShipBlueprint(fsPath);
    if (!blueprint) {
        // Judged as an empty ship, so the client has a row to say "unreadable" on.
        const empty = assessBlueprint(fsPath, { parts: [], decals: 0, doors: 0 }, figures.stats, figures.balance);
        return {
            fsPath,
            name: empty.name,
            insideMod,
            signals: empty.signals,
            value: empty.value,
            valueTier: empty.valueTier,
            tierByRole: tiersByRole(empty.valueTier),
            difficulty: empty.difficulty,
            strength: empty.strength,
            roles: [...empty.roles],
            blocked: 'unreadable',
        };
    }
    const assessment = assessBlueprint(fsPath, blueprint, figures.stats, figures.balance);
    // Judged before the faction is picked, so the name is checked as the game names an unprefixed
    // ship. The apply round checks the id the chosen role really gets, which for a platform
    // carries the faction's prefix.
    const idTaken = takenIds.has(assessment.name.toLowerCase());
    return {
        fsPath,
        name: assessment.name,
        insideMod,
        ...(idTaken ? { blocked: 'idTaken' as const } : {}),
        signals: assessment.signals,
        value: assessment.value,
        valueTier: assessment.valueTier,
        tierByRole: tiersByRole(assessment.valueTier),
        difficulty: assessment.difficulty,
        strength: assessment.strength,
        roles: [...assessment.roles],
    };
};

/** The tier each role would be registered at, for a value tier. */
const tiersByRole = (valueTier: number): Record<ShipRole, number> => {
    const tiers = {} as Record<ShipRole, number>;
    for (const role of SHIP_ROLES) tiers[role] = tierForRole(role, valueTier);
    return tiers;
};

/**
 * The built-in ship ids the game and the workspace already use, folded to lower case.
 *
 * @param host the server facilities.
 * @param cancellationToken cancels the index read.
 * @returns the ids, empty when the host cannot say.
 */
const knownShipIds = async (host: RegisterShipHost, cancellationToken: CancellationToken): Promise<ReadonlySet<string>> => {
    const wide = host.existingIds
        ? await host.existingIds(BUILTIN_SHIP_CLASS, cancellationToken).catch(() => undefined)
        : undefined;
    return new Set([...(wide ?? [])].map((id) => id.toLowerCase()));
};

/**
 * Report what the blueprints are and which factions they could join.
 *
 * @param files the blueprint files.
 * @param modRoot the mod they would be registered in.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns the scan.
 */
const scanRound = async (
    files: readonly string[],
    modRoot: string,
    host: RegisterShipHost,
    cancellationToken: CancellationToken
): Promise<RegisterShipScanResult> => {
    const identity = await identityOfMod(modRoot).catch((): ModIdentity => ({ root: modRoot }));
    const figures = await judging(modRoot, host, cancellationToken);
    const entries = await factionEntriesFor(modRoot, figures.context, host, cancellationToken);
    const takenIds = await knownShipIds(host, cancellationToken);
    const ships: ScannedShip[] = [];
    for (const file of files) {
        if (cancellationToken.isCancellationRequested) break;
        ships.push(await scanShip(file, modRoot, figures, takenIds));
    }
    return {
        kind: 'scan',
        modRoot,
        modId: identity.manifestId ?? '',
        factions: await factionChoices(entries, modRoot, host, cancellationToken),
        ships,
        balanceFallback: figures.balance.fallback,
        partsTruncated: figures.stats.truncated,
    };
};

/** A file the apply round writes to, read once and edited in memory until the end. */
interface EditedFile {
    readonly fsPath: string;
    /** The open buffer, when the editor holds the file, so the change lands in its undo history. */
    readonly buffer?: TextDocument;
    text: string;
    readonly lineEnding: LineEnding;
    /** True when the file did not exist before this round. */
    readonly created: boolean;
    changed: boolean;
}

/** The files the apply round touches, keyed by folded path. */
class Workset {
    private readonly files = new Map<string, EditedFile>();

    public constructor(private readonly open: ReadonlyMap<string, TextDocument>) {}

    /**
     * The file at a path, read from the editor or the disk, or created with the given text when it
     * does not exist.
     *
     * @param fsPath the file.
     * @param initial the text a new file starts with, absent to refuse a missing file.
     * @param lineEnding the ending a new file is written with.
     * @returns the file, or undefined when it does not exist and nothing creates it.
     */
    public async get(fsPath: string, initial?: string, lineEnding: LineEnding = '\n'): Promise<EditedFile | undefined> {
        const key = pathKey(fsPath);
        const known = this.files.get(key);
        if (known) return known;
        const document = await documentFor(fsPath, this.open);
        if (document) {
            const text = document.getText();
            const buffer = this.open.get(normalizeUri(filePathToUri(fsPath)));
            const file: EditedFile = { fsPath, buffer, text, lineEnding: lineEndingOf(text), created: false, changed: false };
            this.files.set(key, file);
            return file;
        }
        if (initial === undefined) return undefined;
        const file: EditedFile = { fsPath, text: initial, lineEnding, created: true, changed: false };
        this.files.set(key, file);
        return file;
    }

    /**
     * Applies an insertion to a file held here.
     *
     * @param file the file.
     * @param insertion where and what.
     */
    public insert(file: EditedFile, insertion: Insertion): void {
        file.text = file.text.slice(0, insertion.offset) + insertion.text + file.text.slice(insertion.offset);
        file.changed = true;
    }

    /**
     * Marks a file as worth writing, for one created with its whole content up front.
     *
     * @param file the file.
     */
    public touch(file: EditedFile): void {
        file.changed = true;
    }

    /** Every file held here. */
    public all(): EditedFile[] {
        return [...this.files.values()];
    }
}

/**
 * The ending a mod's own files use, read from its manifest so new files match.
 *
 * @param modRoot the mod.
 * @returns the ending, `\n` when the manifest cannot be read.
 */
const modLineEnding = async (modRoot: string): Promise<LineEnding> => {
    const choice = manifestForRegistration(modRoot);
    if (choice.kind !== 'manifest') return '\n';
    const file = await readRulesFile(choice.fsPath);
    return file ? lineEndingOf(file.text) : '\n';
};

/**
 * Whether a role file already registers a blueprint, by the file the entries name, resolved against
 * the role file's own directory the way the game resolves `File`.
 *
 * @param document the role file, parsed.
 * @param roleDir the role file's directory.
 * @param shipFile the blueprint's path.
 * @returns true when an entry names it.
 */
const roleFileRegisters = (document: AbstractNodeDocument, roleDir: string, shipFile: string): boolean => {
    const ships = topLevelList(document, SHIPS_MEMBER);
    if (!ships) return false;
    const wanted = pathKey(shipFile);
    for (const element of ships.elements) {
        if (!isGroupNode(element)) continue;
        for (const [name, node] of namedMembersOf(element)) {
            if (name.toLowerCase() !== 'file' || !('valueType' in node)) continue;
            const written = String((node as { valueType: { value: unknown } }).valueType.value).trim();
            if (pathKey(`${roleDir}/${written}`) === wanted) return true;
        }
    }
    return false;
};

/**
 * The id the game gives a ship registered in a role: its name, prefixed the way the role file
 * prefixes its ships.
 *
 * @param name the ship's name.
 * @param role the role.
 * @param factionLabel the faction's name, or its id when none is known.
 * @returns the id.
 */
const builtinShipId = (name: string, role: ShipRole, factionLabel: string): string => {
    const prefix = idPrefixForRole(role, factionLabel);
    return prefix === undefined ? name : `${prefix} ${name}`;
};

/**
 * The factions the game and every workspace mod declare, the mod being written to included.
 *
 * @param modRoot the mod being written to.
 * @param context the ship layer context the registries are read through.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns the entries.
 */
const factionEntriesFor = async (
    modRoot: string,
    context: ShipLayerContext,
    host: RegisterShipHost,
    cancellationToken: CancellationToken
): Promise<FactionEntry[]> => {
    const modRoots = new Set<string>([modRoot]);
    for (const folder of await host.folderPaths().catch((): string[] => [])) {
        for (const root of modRootsUnder(folder)) modRoots.add(root.replace(/\\/g, '/'));
    }
    return collectFactions(context, [...modRoots], cancellationToken);
};

/**
 * The label a faction's platform ids carry: its name the way the language files write it, which is
 * what the game's own role files prefix with, else its id.
 *
 * @param factionId the faction.
 * @param entries the factions declared, from {@link factionEntriesFor}.
 * @param host the server facilities.
 * @param cancellationToken cancels the name lookup.
 * @returns the label.
 */
const factionLabelOf = async (
    factionId: string,
    entries: readonly FactionEntry[],
    host: RegisterShipHost,
    cancellationToken: CancellationToken
): Promise<string> => {
    const entry = entries.find((candidate) => candidate.id.toLowerCase() === factionId.toLowerCase());
    const name =
        entry?.nameKey && host.localizedName
            ? await host.localizedName(entry.nameKey, cancellationToken).catch(() => undefined)
            : undefined;
    return name?.trim() || factionId;
};

/**
 * The name a trade route gets in the `TradeShips` group: the faction and the ship, as one word.
 *
 * @param factionId the faction.
 * @param shipName the ship's name.
 * @returns the name.
 */
const tradeRouteName = (factionId: string, shipName: string): string =>
    `${factionSegment(factionId)}_${shipName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')}`;

/** What registering one ship into the workset needs. */
interface Registration {
    readonly choice: ShipChoice;
    readonly assessment: ShipAssessment | undefined;
    readonly blueprint: Blueprint | undefined;
    readonly name: string;
}

/** The roles whose entries carry a stasis icon, the picture the map shows while the ship is out of sight. */
const ICON_ROLES: ReadonlySet<ShipRole> = new Set(['trade_station', 'military_station']);

/**
 * Draws the station's stasis icon the way the game's own icon generator does, from the footprints
 * of its parts, and writes it beside the ship file unless one is already there.
 *
 * @param blueprint the saved ship.
 * @param stats the parts, for their sizes.
 * @param shipFile the ship file the icon sits beside.
 * @returns the icon's path, or undefined when nothing could be drawn or written.
 */
const writeStasisIcon = async (blueprint: Blueprint, stats: PartStatsIndex, shipFile: string): Promise<string | undefined> => {
    const parts: IconPart[] = [];
    for (const part of blueprint.parts) {
        const size = stats.byId.get(part.id.toLowerCase())?.size;
        if (!size) continue;
        parts.push({ x: part.x, y: part.y, rotation: part.rotation, width: size[0], height: size[1] });
    }
    const png = stasisIconPng(parts);
    if (!png) return undefined;
    const iconFile = shipFile.replace(/\.ship\.png$/i, '.png');
    if (!existsSync(iconFile)) {
        try {
            await writeFile(iconFile, png, { flag: 'wx' });
        } catch {
            return undefined;
        }
    }
    return iconFile;
};

/**
 * Registers one ship: copies the blueprint into the role folder unless it already sits inside the
 * mod, appends the entry to the role file, and appends a trade route for a civilian ship.
 *
 * @param registration the ship and what to register it as.
 * @param factionId the faction.
 * @param factionLabel the faction's name for the id prefix, its id when none is known.
 * @param modRoot the mod.
 * @param workset the files being edited.
 * @param lineEnding the ending new files get.
 * @param takenIds every built-in ship id the project already declares, folded.
 * @param baseTradeShipReference the reference to the game's own base route, from the role folder.
 * @returns what happened.
 */
const registerOne = async (
    registration: Registration,
    factionId: string,
    factionLabel: string,
    modRoot: string,
    workset: Workset,
    lineEnding: LineEnding,
    takenIds: Set<string>,
    baseTradeShipReference: string | undefined,
    stats: PartStatsIndex
): Promise<RegisteredShip> => {
    const { choice, name } = registration;
    const role = choice.role;
    const failed = (failure: ShipRegistrationFailure): RegisteredShip => ({
        fsPath: choice.fsPath,
        name,
        role,
        tier: choice.tier,
        shipFile: choice.fsPath,
        registeredIn: '',
        failure,
    });
    if (!registration.assessment) return failed('unreadable');
    if (!SHIP_ROLES.includes(role)) return failed('unknownRole');

    const faction = factionPathsOf(modRoot, factionId);
    const paths = rolePathsOf(faction, factionId, role);

    // A blueprint already inside the mod is referenced where it is: the author put it there, and a
    // second copy would be two files to keep in step.
    const inside = isUnder(choice.fsPath, modRoot);
    const shipFile = inside ? choice.fsPath : `${paths.folder}/${basename(choice.fsPath)}`;

    const roleFile = await workset.get(paths.file, roleFileText(factionId, role, lineEnding, factionLabel), lineEnding);
    if (!roleFile) return failed('writeFailed');
    const roleDocument = parseText(roleFile.text, paths.file);
    if (roleFileRegisters(roleDocument, paths.folder, shipFile)) return failed('alreadyRegistered');

    const id = builtinShipId(name, role, factionLabel);
    if (takenIds.has(id.toLowerCase())) return failed('idTaken');
    const ships = topLevelList(roleDocument, SHIPS_MEMBER);
    if (!ships) return failed('writeFailed');

    if (!inside) {
        try {
            await mkdir(paths.folder, { recursive: true });
            await copyFile(choice.fsPath, shipFile, constants.COPYFILE_EXCL);
        } catch {
            // The copy already being there is a ship copied in earlier and never registered, which
            // the entry below now does; anything else is a failed copy.
            if (!existsSync(shipFile)) return failed('copyFailed');
        }
    }
    takenIds.add(id.toLowerCase());
    const entryFile = relative(paths.folder, shipFile).replace(/\\/g, '/');
    // The icon sits beside the ship, and the game reads its path from the role file, so a ship
    // referenced where it is gets the same walk up to the icon as the File entry has to the ship.
    const iconFile =
        ICON_ROLES.has(role) && registration.blueprint ? await writeStasisIcon(registration.blueprint, stats, shipFile) : undefined;
    const stasisIcon = iconFile ? relative(paths.folder, iconFile).replace(/\\/g, '/') : undefined;
    const insertion = appendToList(
        roleFile.text,
        ships,
        shipEntryText({ file: entryFile, tier: choice.tier, difficulty: choice.difficulty, role, stasisIcon }),
        roleFile.lineEnding
    );
    if (!insertion) return failed('writeFailed');
    workset.insert(roleFile, insertion);

    let tradeRouteIn: string | undefined;
    if (paths.tradeShips && baseTradeShipReference) {
        const routes = await workset.get(paths.tradeShips, tradeShipsFileText(lineEnding), lineEnding);
        if (routes) {
            const document = parseText(routes.text, paths.tradeShips);
            const group = namedMembersOf(document).find(
                ([memberName]) => memberName.toLowerCase() === TRADE_SHIPS_MEMBER.toLowerCase()
            )?.[1];
            if (group && isGroupNode(group) && routes.text[group.position.end - 1] === '}') {
                const routeName = tradeRouteName(factionId, name);
                const declared = namedMembersOf(group).some(([memberName]) => memberName.toLowerCase() === routeName);
                if (!declared) {
                    const entry = tradeShipEntryFor(routeName, id, factionId, role, choice.tier);
                    workset.insert(
                        routes,
                        appendToGroup(routes.text, group.position.end - 1, tradeShipEntryText(entry, baseTradeShipReference), routes.lineEnding)
                    );
                }
                tradeRouteIn = paths.tradeShips;
            }
        }
    }

    return {
        fsPath: choice.fsPath,
        name,
        role,
        tier: choice.tier,
        shipFile,
        registeredIn: paths.file,
        tradeRouteIn,
        ...(iconFile ? { stasisIcon: iconFile } : {}),
    };
};

/**
 * Makes sure the faction's aggregator concatenates every role file that now exists.
 *
 * @param factionId the faction.
 * @param modRoot the mod.
 * @param roles the roles that were written this round.
 * @param workset the files being edited.
 * @param lineEnding the ending new files get.
 */
const ensureAggregator = async (
    factionId: string,
    modRoot: string,
    roles: ReadonlySet<ShipRole>,
    workset: Workset,
    lineEnding: LineEnding
): Promise<void> => {
    const faction = factionPathsOf(modRoot, factionId);
    const aggregatorDir = dirname(faction.aggregator).replace(/\\/g, '/');
    const wanted = new Map<string, string>();
    for (const role of roles) {
        const paths = rolePathsOf(faction, factionId, role);
        wanted.set(pathKey(paths.file), roleFileReference(aggregatorDir, paths.file));
    }
    const existing = await workset.get(faction.aggregator);
    if (!existing) {
        const created = await workset.get(faction.aggregator, aggregatorText([...wanted.values()], lineEnding), lineEnding);
        if (created) workset.touch(created);
        return;
    }
    const document = parseText(existing.text, faction.aggregator);
    const ships = topLevelList(document, SHIPS_MEMBER);
    if (!ships) return;
    const concatenated = new Set<string>();
    for (const base of ships.inheritance ?? []) {
        const text = String(base.valueType.value).trim();
        const match = /^<([^<>]+)>/.exec(text.replace(/^&\s*/, ''));
        if (match) concatenated.add(pathKey(`${aggregatorDir}/${match[1]}`));
    }
    for (const [key, reference] of wanted) {
        if (concatenated.has(key)) continue;
        // Each insertion re-parses, since the list's bracket moves with every line added above it.
        const current = parseText(existing.text, faction.aggregator);
        const list = topLevelList(current, SHIPS_MEMBER);
        if (!list) return;
        const insertion = addConcatenatedSource(existing.text, list, reference, existing.lineEnding);
        if (insertion) workset.insert(existing, insertion);
    }
};

/**
 * Makes sure the manifest adds the faction's aggregator to the game's built-in ships, and the trade
 * routes to the career mode, with one action each.
 *
 * @param factionId the faction.
 * @param modRoot the mod.
 * @param needsTradeRoutes whether a trade-route file exists for the faction now.
 * @param host the server facilities.
 * @param workset the files being edited.
 * @returns the manifest written into, or why none was.
 */
const ensureManifest = async (
    factionId: string,
    modRoot: string,
    needsTradeRoutes: boolean,
    starters: readonly StarterShip[],
    host: RegisterShipHost,
    workset: Workset
): Promise<{ manifest: string; failure?: ManifestFailure; manifests?: string[] }> => {
    const dataRoot = host.dataRoot();
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
    if (!dataRoot || !root?.path || !rootDocument) return { manifest: '', failure: 'noGameRoot' };
    const shipsTarget = gameRootListTarget(rootDocument, root.path, dataRoot, BUILTIN_SHIPS_MEMBER);
    if (!shipsTarget) return { manifest: '', failure: 'noGameRoot' };

    const choice = manifestForRegistration(modRoot);
    if (choice.kind === 'none') return { manifest: '', failure: 'noGameRoot' };
    if (choice.kind === 'ambiguous') return { manifest: '', failure: 'ambiguousManifest', manifests: choice.manifests };
    const manifest = await workset.get(choice.fsPath);
    if (!manifest) return { manifest: '', failure: 'editRejected' };
    const manifestDir = dirOf(choice.fsPath);
    const faction = factionPathsOf(modRoot, factionId);

    const entries: string[] = [];
    if (!(await manifestAlreadyAdds(modRoot, shipsTarget, faction.aggregator))) {
        entries.push(`&${relativeRulesReference(manifestDir, faction.aggregator, SHIPS_MEMBER)}`);
    }
    let tradeEntry: string[] | undefined;
    if (needsTradeRoutes) {
        const routesFile = rolePathsOf(faction, factionId, 'trade').tradeShips;
        const careerTarget = careerTradeShipsTarget(rootDocument, root.path, dataRoot);
        if (routesFile && careerTarget) {
            const already = await manifestActionMatches(
                modRoot,
                careerTarget,
                (source, declaringDir) => {
                    const text = 'valueType' in source ? String((source as { valueType: { value: unknown } }).valueType.value) : '';
                    const match = /^\s*&?\s*<([^<>]+)>/.exec(text);
                    return !!match && pathKey(`${declaringDir}/${match[1]}`) === pathKey(routesFile);
                },
                'AddBase'
            );
            if (!already) {
                tradeEntry = [
                    'Action = AddBase',
                    `AddBaseTo = "${careerTarget}"`,
                    `BaseToAdd = &${relativeRulesReference(manifestDir, routesFile, TRADE_SHIPS_MEMBER)}`,
                ];
            }
        }
    }
    // A starter ship is offered by the career mode's own list, one inline entry per ship naming the
    // file from the manifest and the key its description is read under.
    const starterTarget = starters.length > 0 ? careerStarterShipsTarget(rootDocument, root.path, dataRoot) : undefined;
    const starterEntries: string[] = [];
    if (starterTarget) {
        for (const starter of starters) {
            const already = await manifestActionMatches(
                modRoot,
                starterTarget,
                (source, declaringDir) => starterEntryNames(source, declaringDir, starter.shipFile),
                'AddMany'
            );
            if (already) continue;
            const shipPath = relative(manifestDir, starter.shipFile).replace(/\\/g, '/');
            starterEntries.push(`{ Ship = "${shipPath}"; DescriptionKey = "${starter.descriptionKey}" }`);
        }
    }
    if (entries.length === 0 && !tradeEntry && starterEntries.length === 0) return { manifest: choice.fsPath };

    const insert = manifestActionInsert(manifest.text, parseText(manifest.text, choice.fsPath), manifest.lineEnding);
    if (insert.kind === 'unusable') return { manifest: '', failure: 'manifestUnusable' };
    const pieces: string[] = [];
    for (const entry of entries) pieces.push(addManyActionText(shipsTarget, entry, insert.indent, manifest.lineEnding, true));
    if (tradeEntry) pieces.push(actionEntryText(tradeEntry, insert.indent, manifest.lineEnding));
    if (starterTarget && starterEntries.length > 0) {
        pieces.push(
            actionEntryText(
                ['Action = AddMany', `AddTo = "${starterTarget}"`, 'ManyToAdd', '[', ...starterEntries.map((entry) => `\t${entry}`), ']'],
                insert.indent,
                manifest.lineEnding
            )
        );
    }
    workset.insert(manifest, {
        offset: insert.offset,
        text: `${insert.before}${pieces.join(manifest.lineEnding)}${insert.after}`,
    });
    return { manifest: choice.fsPath };
};

/**
 * The action target of the career mode's `TradeShips` group, read off the game root the way the
 * ship registry's is: `CareerMode = &<modes/career/career.rules>` names the file, and the group
 * inside it is the one the game's own routes live in.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @returns the target, or undefined when the game root names no career mode.
 */
const careerTradeShipsTarget = (rootDocument: AbstractNodeDocument, rootFsPath: string, dataRoot: string): string | undefined => {
    const file = gameRootListTarget(rootDocument, rootFsPath, dataRoot, CAREER_MODE_MEMBER);
    if (!file) return undefined;
    const withoutMember = file.replace(/>.*$/, '>');
    return `${withoutMember}/${TRADE_SHIPS_MEMBER}`;
};

/** The career mode's list of the ships a player may begin with. */
const STARTER_SHIPS_MEMBER = 'StarterShips';

/** A starter ship the manifest offers to the career mode. */
interface StarterShip {
    /** The ship file inside the mod. */
    readonly shipFile: string;
    /** The localization key its description is read under. */
    readonly descriptionKey: string;
}

/**
 * The career mode's `StarterShips` list as an action target, resolved through the game root the
 * same way the trade routes are.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @returns the target path, or undefined when the game root names no career mode.
 */
const careerStarterShipsTarget = (rootDocument: AbstractNodeDocument, rootFsPath: string, dataRoot: string): string | undefined => {
    const file = gameRootListTarget(rootDocument, rootFsPath, dataRoot, CAREER_MODE_MEMBER);
    if (!file) return undefined;
    return `${file.replace(/>.*$/, '>')}/${STARTER_SHIPS_MEMBER}`;
};

/**
 * Whether a `ManyToAdd` source of a starter-ship action already names a ship file.
 *
 * @param source the action's source value.
 * @param declaringDir the manifest's directory, which the entries' paths are relative to.
 * @param shipFile the ship file looked for.
 * @returns true when one entry's `Ship` is that file.
 */
const starterEntryNames = (source: ActionSource, declaringDir: string, shipFile: string): boolean => {
    const entries = isListNode(source) ? source.elements : [source];
    for (const entry of entries) {
        if (!isGroupNode(entry)) continue;
        for (const [member, node] of namedMembersOf(entry)) {
            if (member.toLowerCase() !== 'ship' || !('valueType' in node)) continue;
            const written = String((node as { valueType: { value: unknown } }).valueType.value).trim();
            if (pathKey(`${declaringDir}/${written}`) === pathKey(shipFile)) return true;
        }
    }
    return false;
};

/**
 * The reference to the game's own base trade route, in the `<./Data/…>` spelling a mod file names a
 * game file by: a `./` path resolves against the install root wherever it is written, so the route
 * file keeps working when the mod is moved or uploaded.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @returns the reference, or undefined when the game root names no career mode.
 */
const baseTradeShipReference = (
    rootDocument: AbstractNodeDocument,
    rootFsPath: string,
    dataRoot: string
): string | undefined => {
    const lower = CAREER_MODE_MEMBER.toLowerCase();
    for (const [name, node] of namedMembersOf(rootDocument)) {
        if (name.toLowerCase() !== lower || !('valueType' in node)) continue;
        const text = String((node as { valueType: { value: unknown } }).valueType.value).replace(/^&\s*/, '');
        const match = /^<([^<>]+)>/.exec(text);
        if (!match) return undefined;
        const careerFile = `${dirOf(rootFsPath)}/${match[1]}`.replace(/\\/g, '/');
        const inData = relative(dataRoot, careerFile).replace(/\\/g, '/');
        if (inData.startsWith('..')) return undefined;
        return `<./Data/${inData}>/BaseTradeShip`;
    }
    return undefined;
};

/**
 * Writes every file the workset holds: open buffers through the editor, the rest to disk.
 *
 * @param workset the files.
 * @param host the server facilities.
 * @returns the created files, the changed files, and whether the editor took its edits.
 */
const flush = async (
    workset: Workset,
    host: RegisterShipHost
): Promise<{ created: string[]; changed: string[]; applied: boolean }> => {
    const created: string[] = [];
    const changed: string[] = [];
    const edits: Record<string, TextEdit[]> = {};
    for (const file of workset.all()) {
        if (!file.changed) continue;
        changed.push(file.fsPath);
        if (file.created) created.push(file.fsPath);
        if (file.buffer) {
            const end = file.buffer.positionAt(file.buffer.getText().length);
            edits[file.buffer.uri] = [{ range: { start: { line: 0, character: 0 }, end }, newText: file.text }];
            continue;
        }
        await mkdir(dirname(file.fsPath), { recursive: true });
        await writeFile(file.fsPath, file.text, { encoding: 'utf-8' });
    }
    let applied = true;
    if (Object.keys(edits).length > 0) applied = await host.applyEdit(edits).catch(() => false);
    if (changed.length > 0) host.filesChanged(changed);
    return { created, changed, applied };
};

/**
 * Register the chosen ships in the faction.
 *
 * @param args the client's arguments.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what was registered.
 */
const applyRound = async (
    args: RegisterShipArgs,
    modRoot: string,
    host: RegisterShipHost,
    cancellationToken: CancellationToken
): Promise<RegisterShipApplyResult> => {
    const factionId = args.faction?.trim() ?? '';
    if (!factionId) return applyFailed('unknownFaction');
    const choices = (args.ships ?? []).filter((choice) => choice && typeof choice.fsPath === 'string');
    if (choices.length === 0) return applyFailed('noBlueprints', factionId);

    const figures = await judging(modRoot, host, cancellationToken);
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
    const lineEnding = await modLineEnding(modRoot);
    const workset = new Workset(openBuffers(host));

    const takenIds = new Set(await knownShipIds(host, cancellationToken));
    const factionLabel = await factionLabelOf(
        factionId,
        await factionEntriesFor(modRoot, figures.context, host, cancellationToken),
        host,
        cancellationToken
    );

    const dataRoot = host.dataRoot();
    const baseReference =
        rootDocument && root?.path && dataRoot ? baseTradeShipReference(rootDocument, root.path, dataRoot) : undefined;

    const ships: RegisteredShip[] = [];
    const rolesWritten = new Set<ShipRole>();
    const starters: StarterShip[] = [];
    let tradeRoutes = false;
    for (const choice of choices) {
        if (cancellationToken.isCancellationRequested) break;
        const fsPath = choice.fsPath.replace(/\\/g, '/');
        const blueprint = await readShipBlueprint(fsPath);
        const assessment = blueprint ? assessBlueprint(fsPath, blueprint, figures.stats, figures.balance) : undefined;
        const name = blueprintName(fsPath);
        const registered = await registerOne(
            { choice: { ...choice, fsPath }, assessment, blueprint, name },
            factionId,
            factionLabel,
            modRoot,
            workset,
            lineEnding,
            takenIds,
            baseReference,
            figures.stats
        );
        ships.push(registered);
        if (!registered.failure) {
            rolesWritten.add(registered.role);
            if (registered.tradeRouteIn) tradeRoutes = true;
            if (registered.role === 'starter') {
                const descriptionKey = `${STARTER_SHIPS_MEMBER}/${keyLabelOf(name)}`;
                starters.push({ shipFile: registered.shipFile, descriptionKey });
                (registered as { starterDescriptionKey?: string }).starterDescriptionKey = descriptionKey;
            }
        }
    }

    let manifest = { manifest: '' } as { manifest: string; failure?: ManifestFailure; manifests?: string[] };
    if (rolesWritten.size > 0) {
        await ensureAggregator(factionId, modRoot, rolesWritten, workset, lineEnding);
        manifest = await ensureManifest(factionId, modRoot, tradeRoutes, starters, host, workset);
    }

    const written = await flush(workset, host);
    if (!written.applied) {
        for (const ship of ships) if (!ship.failure) (ship as { failure?: ShipRegistrationFailure }).failure = 'editRejected';
    }

    // The description a starter ship is offered with is read from the strings, so each key is
    // declared with the ship's name as a placeholder for the author to replace.
    let localizationFiles: string[] = [];
    if (starters.length > 0 && written.applied) {
        const anchor = ships.find((ship) => ship.role === 'starter' && !ship.failure)?.registeredIn;
        if (anchor) {
            const declared = await writeLocalizationKeys(
                filePathToUri(anchor),
                starters.map((starter) => ({
                    key: starter.descriptionKey,
                    value: `"${basename(starter.shipFile).replace(/\.ship\.png$/i, '').replace(/"/g, '\\"')}"`,
                })),
                host,
                cancellationToken
            ).catch(() => ({ keys: [], files: [] }));
            localizationFiles = declared.files;
        }
    }
    return {
        kind: 'apply',
        faction: factionId,
        ships,
        manifest: manifest.manifest,
        manifestFailure: manifest.failure,
        manifests: manifest.manifests,
        createdFiles: [...written.created, ...ships.map((ship) => ship.stasisIcon).filter((icon): icon is string => !!icon)],
        changedFiles: [...written.changed, ...localizationFiles],
        localizationFiles,
    };
};

/**
 * The command entry point: report what the blueprints are when the client sent no choices, and
 * register them otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what the blueprints are, or what registering them did.
 */
export const registerShip = async (
    args: RegisterShipArgs,
    host: RegisterShipHost,
    cancellationToken: CancellationToken
): Promise<RegisterShipResult> => {
    const scanning = !args.ships;
    const located = modRootFor(args.uri, host.dataRoot());
    if ('failure' in located) return scanning ? scanFailed(located.failure) : applyFailed(located.failure);
    if (scanning) {
        const files = await blueprintFiles(args.blueprints ?? []);
        if (files.length === 0) return scanFailed('noBlueprints');
        return await scanRound(files, located.modRoot, host, cancellationToken);
    }
    return await applyRound(args, located.modRoot, host, cancellationToken);
};
