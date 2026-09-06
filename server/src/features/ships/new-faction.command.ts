import { constants, existsSync } from 'fs';
import { copyFile, mkdir, writeFile } from 'fs/promises';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { identityOfMod, ModIdentity } from '../../mod/mod-dependencies';
import { evaluateNumericValue } from '../../semantics/value-evaluator';
import { namedMembersOf } from '../../utils/ast.utils';
import { filePathToUri } from '../navigation/navigation-strategy';
import { lineEndingOf } from '../refactor/command-host';
import { authorPrefixOf } from '../refactor/new-content/content-id';
import { writeLocalizationKeys } from '../refactor/new-content/new-content.command';
import { gameRootListTarget, manifestForRegistration } from '../refactor/new-content/registration.emitter';
import { modRootsUnder } from '../refactor/register-part/ship-registry';
import { relativeRulesReference } from '../refactor/shared-base/base-file.emitter';
import { dirOf, readRulesFile } from '../refactor/shared-base/base-index';
import { factionSegment, keyLabelOf } from './builtin-ships.emitter';
import { LineEnding } from './builtin-ships.types';
import { collectFactions } from './faction-registry';
import { ManifestWiring, modRootFor, wireIntoManifest } from './mod-wiring';
import {
    NewFactionApplyResult,
    NewFactionArgs,
    NewFactionFailure,
    NewFactionHost,
    NewFactionResult,
    NewFactionScanResult,
} from './new-faction.types';

/**
 * The `workspace/executeCommand` id that creates a faction. Both clients invoke it twice: without
 * an id it reports what the mod is and which ids and player indexes are taken, with one it writes
 * the faction and everything the career mode needs to give it territory.
 *
 * A faction is more than its entry in the registry. The galaxy generator hands out systems only to
 * the factions its own territory list names, rates those systems only through its tier list, and
 * marks them on the map only through an FTL beacon doodad wired into the beacon spawner. A faction
 * missing any of those loads without an error and owns nothing, which is what this command exists
 * to prevent: every one of them is written, with the name declared in every language file, so the
 * faction exists in the game the moment its first ship is registered.
 */
export const NEW_FACTION_COMMAND = 'cosmoteer.newFaction';

/** The game root member naming the faction registry. */
const FACTIONS_MEMBER = 'Factions';

/** The game root member naming the doodad registry, which the FTL beacon is added to. */
const DOODADS_MEMBER = 'Doodads';

/** The galaxy generator file, and the members of it a faction is written into. */
const BASE_GALAXY_FILE = 'galaxy_map/map_generators/base_galaxy.rules';
const TERRITORY_TARGET = `<${BASE_GALAXY_FILE}>/Factions/Factions`;
const TIERS_TARGET = `<${BASE_GALAXY_FILE}>/FactionTiers/Factions`;
const MAX_TIER_MEMBER = 'MaxTier';
const TIER_SPREAD_MEMBER = 'TierSpread';

/** The beacon spawner the FTL beacon is offered to, at the slot the game's own beacons sit in. */
const BEACON_SPAWNER_FILE = 'modes/career/sectors/sysgen_ftl_beacons.rules';
const BEACON_TYPES_TARGET = `<${BEACON_SPAWNER_FILE}>/SubSpawners/0/DoodadTypes`;

/** The game's own beacon ship that stands in until the author draws one. */
const PLACEHOLDER_BEACON_SHIP = './Data/doodads/ftl/Fringe FTL Beacon.ship.png';

/** The game's own faction icon that stands in until the author draws one. */
const PLACEHOLDER_ICON = './Data/factions/fringe.png';

/** The lore codex the faction's page is offered to, where the game's own factions tell their story. */
const LORE_FILE = 'codex/lore/lore.rules';
const LORE_TARGET = `<${LORE_FILE}>/CodexPages`;

/** The tab the game's own lore pages sit under. */
const LORE_TAB_KEY = 'Codex/Lore';

/** How many lore paragraphs a new page starts with, each a key for the author to fill. */
const LORE_PARAGRAPHS = 3;

/** The galaxy figures the game ships, for a server that cannot read them. */
const VANILLA_MAX_TIER = 18;
const VANILLA_TIER_SPREAD = 2;

/**
 * The first index block offered to a new faction: the game throws under 100, its own factions take
 * the hundreds up to 500, and the guide mod the community copies warns against the next few.
 */
const FIRST_FREE_BLOCK = 1000;

/** The border colour a faction gets when the client names none, a purple no game faction uses. */
const DEFAULT_BORDER_COLOR: readonly [number, number, number] = [143, 48, 220];

/**
 * A colour the client sent, taken only when it is three whole channels of 0 to 255.
 *
 * @param value what the client sent.
 * @returns the channels, or undefined for anything else.
 */
const colorOf = (value: unknown): readonly [number, number, number] | undefined => {
    if (!Array.isArray(value) || value.length !== 3) return undefined;
    const channels = value.map((channel) => (Number.isInteger(channel) && channel >= 0 && channel <= 255 ? (channel as number) : undefined));
    if (channels.some((channel) => channel === undefined)) return undefined;
    return channels as unknown as readonly [number, number, number];
};

/** The folder a faction's own files go under. */
const FACTIONS_FOLDER = 'factions';

/** A scan result carrying nothing but the reason there is nothing to report. */
const scanFailed = (failure: NewFactionFailure): NewFactionScanResult => ({
    kind: 'scan',
    modRoot: '',
    modId: '',
    takenIds: [],
    takenPlayerIndexes: [],
    suggestedPlayerIndex: FIRST_FREE_BLOCK,
    failure,
});

/** An apply result carrying nothing but the reason nothing was created. */
const applyFailed = (id: string, failure: NewFactionFailure): NewFactionApplyResult => ({
    kind: 'apply',
    id,
    factionFile: '',
    galaxyFile: '',
    beaconFile: '',
    manifest: '',
    wiring: { registry: 'noTarget', territory: 'noTarget', tiers: 'noTarget', beacon: 'noTarget', beaconSpawner: 'noTarget', lore: 'skipped' },
    nameKey: '',
    localizationFiles: [],
    placeholderAssets: [],
    loreKeys: [],
    militaryPlayerIndex: 0,
    civilianPlayerIndex: 0,
    createdFiles: [],
    changedFiles: [],
    failure,
});

/** A faction id as the game accepts one: a bare word, since ships and sectors write it unquoted. */
const FACTION_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The id's display form for a localization key, `my_faction` reading as `MyFaction` the way the
 * game's own `Factions/Cabal` does.
 *
 * @param id the faction id.
 * @returns the key's last segment.
 */

/** What the scan and the apply rounds both read. */
interface Known {
    readonly modRoots: string[];
    readonly takenIds: Set<string>;
    readonly takenPlayerIndexes: Set<number>;
    readonly suggestedPlayerIndex: number;
}

/**
 * The factions the game and the workspace mods already declare, and the first free index block.
 *
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what is taken.
 */
const known = async (modRoot: string, host: NewFactionHost, cancellationToken: CancellationToken): Promise<Known> => {
    const modRoots = new Set<string>([modRoot]);
    for (const folder of await host.folderPaths().catch((): string[] => [])) {
        for (const root of modRootsUnder(folder)) modRoots.add(root.replace(/\\/g, '/'));
    }
    const context = await host.layerContext();
    const factions = await collectFactions(context, [...modRoots], cancellationToken);
    const takenIds = new Set(factions.map((faction) => faction.id.toLowerCase()));
    const takenPlayerIndexes = new Set<number>();
    for (const faction of factions) {
        if (faction.militaryPlayerIndex !== undefined) takenPlayerIndexes.add(faction.militaryPlayerIndex);
        if (faction.civilianPlayerIndex !== undefined) takenPlayerIndexes.add(faction.civilianPlayerIndex);
    }
    // Whole hundreds past the game's own blocks, the first one neither index of which is taken.
    let suggested = FIRST_FREE_BLOCK;
    while (takenPlayerIndexes.has(suggested) || takenPlayerIndexes.has(suggested + 1)) suggested += 100;
    return { modRoots: [...modRoots], takenIds, takenPlayerIndexes, suggestedPlayerIndex: suggested };
};

/**
 * The galaxy's highest tier and its spread, read from the game's own generator so the tier ranges
 * written for the faction match the ones the game's own factions get.
 *
 * @param dataRoot the game's `Data` directory.
 * @param cancellationToken cancels the evaluation.
 * @returns the two figures, vanilla ones when the file cannot be read.
 */
const galaxyTiers = async (
    dataRoot: string,
    cancellationToken: CancellationToken
): Promise<{ maxTier: number; tierSpread: number; found: boolean }> => {
    const file = await readRulesFile(`${dataRoot.replace(/\\/g, '/')}/${BASE_GALAXY_FILE}`);
    if (!file) return { maxTier: VANILLA_MAX_TIER, tierSpread: VANILLA_TIER_SPREAD, found: false };
    const read = async (name: string, fallback: number): Promise<number> => {
        const lower = name.toLowerCase();
        const node = namedMembersOf(file.document).find(([memberName]) => memberName.toLowerCase() === lower)?.[1];
        if (!node) return fallback;
        const value = await evaluateNumericValue(node, cancellationToken).catch(() => null);
        return value !== null && Number.isFinite(value) ? value : fallback;
    };
    return { maxTier: await read(MAX_TIER_MEMBER, VANILLA_MAX_TIER), tierSpread: await read(TIER_SPREAD_MEMBER, VANILLA_TIER_SPREAD), found: true };
};

/** Where a faction's own files sit. */
interface FactionFiles {
    readonly folder: string;
    readonly faction: string;
    readonly galaxy: string;
    readonly beacon: string;
    /** The faction's own icon, when one is copied in. */
    readonly icon: string;
    /** The faction's own beacon ship, when one is copied in. */
    readonly beaconShip: string;
    /** The lore page, when one is written. */
    readonly lore: string;
}

/**
 * Where a faction's own files sit under a mod: one folder under `factions`, holding the faction,
 * its galaxy entries and its beacon.
 *
 * @param modRoot the mod.
 * @param id the faction id.
 * @returns the paths.
 */
const factionFilesOf = (modRoot: string, id: string): FactionFiles => {
    const segment = factionSegment(id);
    const folder = `${modRoot}/${FACTIONS_FOLDER}/${segment}`;
    return {
        folder,
        faction: `${folder}/faction_${segment}.rules`,
        galaxy: `${folder}/galaxy_${segment}.rules`,
        beacon: `${folder}/ftl_beacon_${segment}.rules`,
        icon: `${folder}/${segment}.png`,
        beaconShip: `${folder}/ftl_beacon_${segment}.ship.png`,
        lore: `${folder}/lore_${segment}.rules`,
    };
};

/**
 * The faction file: one entry in a `Factions` list, in the shape `factions/factions.rules` writes.
 *
 * @param id the faction id.
 * @param nameKey the localization key of its name.
 * @param color the border colour.
 * @param indexes the player indexes.
 * @param iconFile the icon, as the file names it: the faction's own beside it, or the game's.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const factionFileText = (
    id: string,
    nameKey: string,
    color: readonly [number, number, number],
    indexes: { military: number; civilian: number },
    iconFile: string,
    lineEnding: LineEnding
): string =>
    [
        ...(iconFile === PLACEHOLDER_ICON
            ? [
                  '// The faction itself. The icon is the game\'s own until you draw one: put a square PNG beside',
                  '// this file and name it here.',
              ]
            : ['// The faction itself. The icon sits beside this file.']),
        'Factions',
        '[',
        '\t{',
        `\t\tID = ${id}`,
        `\t\tNameKey = "${nameKey}"`,
        '\t\tIcon',
        '\t\t{',
        '\t\t\tTexture',
        '\t\t\t{',
        `\t\t\t\tFile = "${iconFile}"`,
        '\t\t\t\tSampleMode = Linear',
        '\t\t\t\tMipLevels = max',
        '\t\t\t}',
        '\t\t}',
        '\t\t// The colour the galaxy map draws the faction\'s territory border in, as red, green, blue.',
        `\t\tBorderColor = [${color[0]}, ${color[1]}, ${color[2]}]`,
        '\t\t// The two player slots the faction\'s ships fight under: warships and stations use the',
        '\t\t// military one, traders and transports the civilian one. Each must be 100 or more, or the',
        '\t\t// game refuses to load, and no two factions may share one, or their ships count as the',
        '\t\t// first faction that claims it. These are the first free pair above the game\'s own.',
        `\t\tMilitaryPlayerIndex = ${indexes.military}`,
        `\t\tCivilianPlayerIndex = ${indexes.civilian}`,
        '\t}',
        ']',
        '',
    ].join(lineEnding);

/**
 * The galaxy file: the faction's territory, its tier ranges and its beacon type, each in the list
 * shape the generator's own entries have, ready to be added to the generator with one action each.
 *
 * @param id the faction id.
 * @param beaconType the beacon doodad's id.
 * @param tiers the galaxy's highest tier and spread.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const galaxyFileText = (
    id: string,
    beaconType: string,
    tiers: { maxTier: number; tierSpread: number },
    lineEnding: LineEnding
): string =>
    [
        '// How much of the galaxy the faction owns. 100% is a share equal to each of the game\'s own',
        '// factions, and the strength figures decide how its systems cluster around its home.',
        'Territory',
        '[',
        '\t{',
        `\t\tFactionID = ${id}`,
        '\t\tTerritoryRatio = 100%',
        '\t\tAvoidOtherFactionsStrength = .3',
        '\t\tAvoidEdgeStrength = .3',
        '\t\tFactionStrengthExponent = 3',
        '\t\tMinFactionStrength = 5%',
        '\t}',
        ']',
        '',
        '// The tiers its systems can be, from the fringe of its territory (low) to its home (high),',
        `// the same spread the game's own factions get.`,
        'Tiers',
        '[',
        '\t{',
        `\t\tFactionID = ${id}`,
        `\t\tTierRangeLow = [1, ${tiers.maxTier - tiers.tierSpread}]`,
        `\t\tTierRangeHigh = [${1 + tiers.tierSpread}, ${tiers.maxTier}]`,
        '\t}',
        ']',
        '',
        '// The FTL beacon that marks the faction\'s systems on the map.',
        'Beacons',
        '[',
        `\t{ Type=${beaconType}; Faction=${id}; }`,
        ']',
        '',
    ].join(lineEnding);

/**
 * The beacon doodad, in the shape the game's own `doodad_ftl_beacon_*.rules` have, pointing at the
 * game's own beacon ship until the author saves one.
 *
 * @param beaconType the doodad's id.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const beaconFileText = (beaconType: string, shipFile: string, lineEnding: LineEnding): string =>
    [
        ...(shipFile === PLACEHOLDER_BEACON_SHIP
            ? [
                  '// The FTL beacon the faction\'s systems are entered through. The ship it is built from is the',
                  '// game\'s own until you save one of yours beside this file and name it here.',
              ]
            : ['// The FTL beacon the faction\'s systems are entered through, built from the ship beside this file.']),
        `ID = ${beaconType}`,
        'Type = Landmark',
        'DescriptionKey = "Doodads/FTLBeacon"',
        'CategoryKey = "Doodads/Ftl"',
        'Icon',
        '{',
        '\tTexture',
        '\t{',
        `\t\tFile = "${shipFile}"`,
        '\t\tResize = [128, 128]',
        '\t\tMipLevels = max',
        '\t\tSampleMode = Linear',
        '\t}',
        '}',
        'Allegiance = -1',
        `Ship = "${shipFile}"`,
        'IsFtlPoint = true',
        '',
    ].join(lineEnding);

/**
 * The lore page: one codex page in the shape the game's own faction pages take, opening with the
 * icon and going on with paragraphs whose texts are keys in the strings.
 *
 * @param id the faction id.
 * @param label the key label the page's texts are declared under.
 * @param imageFile the icon, as the file names it.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const loreFileText = (id: string, label: string, imageFile: string, lineEnding: LineEnding): string =>
    [
        '// The faction\'s page in the lore codex. The texts are keys in the language files: fill them',
        '// there, and add or remove paragraphs here as the story needs.',
        `ID = ${id}`,
        `TitleKey = "Lore/${label}/Title"`,
        `TabNameKey = "${LORE_TAB_KEY}"`,
        'Entries',
        '[',
        '\t{',
        '\t\tImage',
        '\t\t{',
        '\t\t\tTexture',
        '\t\t\t{',
        `\t\t\t\tFile = "${imageFile}"`,
        '\t\t\t\tSampleMode = Linear',
        '\t\t\t\tMipLevels = max',
        '\t\t\t}',
        '\t\t}',
        '\t}',
        ...Array.from({ length: LORE_PARAGRAPHS }, (_, index) => `\t{ TextKey = "Lore/${label}/Lore${index + 1}" }`),
        ']',
        '',
    ].join(lineEnding);

/**
 * Copies an asset the author picked into the faction's folder, keeping the file that is already
 * there when the folder was created earlier.
 *
 * @param source the picked file, absent when nothing was picked.
 * @param target where the copy goes.
 * @returns true when the target holds the file afterwards.
 */
const copyAsset = async (source: string | undefined, target: string): Promise<boolean> => {
    if (!source) return false;
    try {
        await copyFile(source, target, constants.COPYFILE_EXCL);
        return true;
    } catch {
        return existsSync(target);
    }
};

/** One manifest action to write, keyed by the wiring it reports as. */
type Wiring = ManifestWiring<keyof NewFactionApplyResult['wiring']>;

/**
 * Create the faction and wire it in.
 *
 * @param args the client's arguments.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what was created.
 */
const applyRound = async (
    args: NewFactionArgs,
    modRoot: string,
    host: NewFactionHost,
    cancellationToken: CancellationToken
): Promise<NewFactionApplyResult> => {
    const id = (args.id ?? '').trim();
    if (!FACTION_ID.test(id)) return applyFailed(id, 'invalidId');
    const facts = await known(modRoot, host, cancellationToken);
    if (facts.takenIds.has(id.toLowerCase())) return applyFailed(id, 'idTaken');
    const files = factionFilesOf(modRoot, id);
    if (existsSync(files.folder)) return applyFailed(id, 'pathTaken');

    const dataRoot = host.dataRoot();
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
    if (!dataRoot || !root?.path || !rootDocument) return applyFailed(id, 'noGameRoot');

    const identity = await identityOfMod(modRoot).catch((): ModIdentity => ({ root: modRoot }));
    const prefix = authorPrefixOf(identity.manifestId);
    const beaconType = `${prefix ? `${prefix}.` : ''}ftl_beacon_${factionSegment(id)}`;
    const nameKey = `${FACTIONS_MEMBER}/${keyLabelOf(id)}`;
    const color = colorOf(args.color) ?? DEFAULT_BORDER_COLOR;
    const indexes = { military: facts.suggestedPlayerIndex, civilian: facts.suggestedPlayerIndex + 1 };
    const tiers = await galaxyTiers(dataRoot, cancellationToken);

    const choice = manifestForRegistration(modRoot);
    const lineEnding: LineEnding =
        choice.kind === 'manifest' ? lineEndingOf((await readRulesFile(choice.fsPath))?.text ?? '') : '\n';

    const label = keyLabelOf(id);
    const loreKeys = args.lore
        ? [`Lore/${label}/Title`, ...Array.from({ length: LORE_PARAGRAPHS }, (_, index) => `Lore/${label}/Lore${index + 1}`)]
        : [];
    const created: string[] = [];
    let iconFile: string | undefined;
    let beaconShipFile: string | undefined;
    try {
        await mkdir(files.folder, { recursive: true });
        // The author's own assets go in first, so the files written next can name them.
        if (await copyAsset(args.icon, files.icon)) {
            iconFile = files.icon;
            created.push(files.icon);
        }
        if (await copyAsset(args.beaconShip, files.beaconShip)) {
            beaconShipFile = files.beaconShip;
            created.push(files.beaconShip);
        }
        const iconName = iconFile ? files.icon.slice(files.folder.length + 1) : PLACEHOLDER_ICON;
        const beaconShipName = beaconShipFile ? files.beaconShip.slice(files.folder.length + 1) : PLACEHOLDER_BEACON_SHIP;
        await writeFile(files.faction, factionFileText(id, nameKey, color, indexes, iconName, lineEnding), { encoding: 'utf-8', flag: 'wx' });
        await writeFile(files.galaxy, galaxyFileText(id, beaconType, tiers, lineEnding), { encoding: 'utf-8', flag: 'wx' });
        await writeFile(files.beacon, beaconFileText(beaconType, beaconShipName, lineEnding), { encoding: 'utf-8', flag: 'wx' });
        created.push(files.faction, files.galaxy, files.beacon);
        if (args.lore) {
            await writeFile(files.lore, loreFileText(id, label, iconName, lineEnding), { encoding: 'utf-8', flag: 'wx' });
            created.push(files.lore);
        }
    } catch {
        return applyFailed(id, 'writeFailed');
    }
    host.filesChanged(created);

    // The story starts as its keys, each holding a line that says what goes there, so the page
    // shows something readable until the author writes it.
    const localization = await writeLocalizationKeys(
        filePathToUri(files.faction),
        [
            { key: nameKey, value: `"${(args.name ?? id).replace(/"/g, '\\"')}"` },
            ...loreKeys.map((key) => ({
                key,
                value: key.endsWith('/Title') ? `"${(args.name ?? id).replace(/"/g, '\\"')}"` : '"Write this part of the story here."',
            })),
        ],
        host,
        cancellationToken
    ).catch(() => ({ keys: [], files: [] }));

    const wiring: NewFactionApplyResult['wiring'] = {
        registry: 'noTarget',
        territory: 'noTarget',
        tiers: 'noTarget',
        beacon: 'noTarget',
        beaconSpawner: 'noTarget',
        lore: args.lore ? 'noTarget' : 'skipped',
    };
    let manifestPath = '';
    let manifests: string[] | undefined;
    const changed = [...created, ...localization.files];

    if (choice.kind === 'ambiguous') {
        for (const key of Object.keys(wiring) as (keyof typeof wiring)[]) wiring[key] = 'ambiguousManifest';
        manifests = choice.manifests;
    } else if (choice.kind === 'manifest') {
        manifestPath = choice.fsPath;
        const manifestDir = dirOf(choice.fsPath);
        const reference = (file: string, member?: string): string => `&${relativeRulesReference(manifestDir, file, member)}`;
        const galaxyExists = existsSync(`${dataRoot.replace(/\\/g, '/')}/${BASE_GALAXY_FILE}`);
        const spawnerExists = existsSync(`${dataRoot.replace(/\\/g, '/')}/${BEACON_SPAWNER_FILE}`);
        const wirings: Wiring[] = [
            {
                key: 'registry',
                target: gameRootListTarget(rootDocument, root.path, dataRoot, FACTIONS_MEMBER),
                reference: reference(files.faction, FACTIONS_MEMBER),
                file: files.faction,
                wholeList: true,
            },
            { key: 'territory', target: galaxyExists ? TERRITORY_TARGET : undefined, reference: reference(files.galaxy, 'Territory'), file: files.galaxy, wholeList: true },
            { key: 'tiers', target: galaxyExists ? TIERS_TARGET : undefined, reference: reference(files.galaxy, 'Tiers'), file: files.galaxy, wholeList: true },
            {
                key: 'beacon',
                target: gameRootListTarget(rootDocument, root.path, dataRoot, DOODADS_MEMBER),
                reference: reference(files.beacon),
                file: files.beacon,
                wholeList: false,
            },
            { key: 'beaconSpawner', target: spawnerExists ? BEACON_TYPES_TARGET : undefined, reference: reference(files.galaxy, 'Beacons'), file: files.galaxy, wholeList: true },
        ];
        const loreExists = existsSync(`${dataRoot.replace(/\\/g, '/')}/${LORE_FILE}`);
        if (args.lore) {
            wirings.push({ key: 'lore', target: loreExists ? LORE_TARGET : undefined, reference: reference(files.lore), file: files.lore, wholeList: false });
        }
        if (await wireIntoManifest(choice.fsPath, modRoot, wirings, wiring, host)) changed.push(choice.fsPath);
    }

    return {
        kind: 'apply',
        id,
        factionFile: files.faction,
        galaxyFile: files.galaxy,
        beaconFile: files.beacon,
        manifest: manifestPath,
        wiring,
        manifests,
        nameKey,
        localizationFiles: localization.files,
        placeholderAssets: [...(iconFile ? [] : [PLACEHOLDER_ICON]), ...(beaconShipFile ? [] : [PLACEHOLDER_BEACON_SHIP])],
        iconFile,
        beaconShipFile,
        loreFile: args.lore ? files.lore : undefined,
        loreKeys,
        militaryPlayerIndex: indexes.military,
        civilianPlayerIndex: indexes.civilian,
        createdFiles: created,
        changedFiles: changed,
    };
};

/**
 * The command entry point: report what is taken when the client sent no id, and create the faction
 * otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what is taken, or what was created.
 */
export const newFaction = async (
    args: NewFactionArgs,
    host: NewFactionHost,
    cancellationToken: CancellationToken
): Promise<NewFactionResult> => {
    const scanning = args.id === undefined;
    const located = modRootFor(args.uri, host.dataRoot());
    if ('failure' in located) return scanning ? scanFailed(located.failure) : applyFailed(args.id ?? '', located.failure);
    if (scanning) {
        const identity = await identityOfMod(located.modRoot).catch((): ModIdentity => ({ root: located.modRoot }));
        const facts = await known(located.modRoot, host, cancellationToken);
        return {
            kind: 'scan',
            modRoot: located.modRoot,
            modId: identity.manifestId ?? '',
            takenIds: [...facts.takenIds],
            takenPlayerIndexes: [...facts.takenPlayerIndexes].sort((a, b) => a - b),
            suggestedPlayerIndex: facts.suggestedPlayerIndex,
        };
    }
    return await applyRound(args, located.modRoot, host, cancellationToken);
};
