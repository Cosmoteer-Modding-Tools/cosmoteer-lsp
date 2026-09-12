import { existsSync, readdirSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { relative } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isDocumentNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { identityOfMod, ModIdentity } from '../../mod/mod-dependencies';
import { namedMembersOf } from '../../utils/ast.utils';
import { filePathToUri } from '../navigation/navigation-strategy';
import { lineEndingOf } from '../refactor/command-host';
import { authorPrefixOf } from '../refactor/new-content/content-id';
import { LocalizationEntry } from '../refactor/new-content/content-templates';
import { writeLocalizationKeys } from '../refactor/new-content/new-content.command';
import { gameRootListTarget, manifestForRegistration } from '../refactor/new-content/registration.emitter';
import { addManyActionText } from '../refactor/register-part/manifest-action.emitter';
import { shipPartsIn } from '../refactor/register-part/ship-registry';
import { relativeRulesReference } from '../refactor/shared-base/base-file.emitter';
import { dirOf, locationOf, readRulesFile, resolveBasePath } from '../refactor/shared-base/base-index';
import { memberOf as memberOfContainer } from '../refactor/new-content/registry-ids';
import { factionSegment, keyLabelOf } from './builtin-ships.emitter';
import { LineEnding } from './builtin-ships.types';
import { alreadyWired, appendManifestActions, modRootFor, openManifest } from './mod-wiring';
import {
    AsteroidLook,
    AsteroidRarity,
    AsteroidResource,
    AsteroidSize,
    NewAsteroidTypeApplyResult,
    NewAsteroidTypeArgs,
    NewAsteroidTypeFailure,
    NewAsteroidTypeHost,
    NewAsteroidTypeResult,
    NewAsteroidTypeScanResult,
} from './new-asteroid-type.types';

/**
 * The `workspace/executeCommand` id that creates an asteroid type. Both clients invoke it twice:
 * without an id it reports what the mod is, which resources and looks there are to build on and
 * which ids are taken, with one it writes the deposit tiles, the asteroid recipes and the spawner
 * entries, and wires each in from the manifest.
 *
 * An asteroid type is four pieces meeting through ids. The deposit tiles have to sit in the game's
 * own asteroid class, or the recipe crashes the moment a sector is generated. The recipes have to be
 * registered as doodads, or the spawner entry naming them fails the load. The spawner entry has to be
 * in one of the three rarity lists, or the type is never placed. And the soft-to-hard pairs have to
 * be in the shared conversion list, or the deposits stay crew-mineable everywhere. This command
 * writes all four so the type is met in a career sector the moment the mod is loaded.
 */
export const NEW_ASTEROID_TYPE_COMMAND = 'cosmoteer.newAsteroidType';

/** The game root members naming the registries the command reads and wires into. */
const RESOURCES_MEMBER = 'Resources';
const DOODADS_MEMBER = 'Doodads';

/** The game's asteroid class: its file, its group and the parts list the deposits are added to. */
const ASTEROID_CLASS_FILE = 'ships/asteroid/asteroid.rules';
const ASTEROID_CLASS_GROUP = 'Asteroid';
const ASTEROID_CLASS_ID = 'cosmoteer.asteroid';
const ASTEROID_PARTS_TARGET = `<${ASTEROID_CLASS_FILE}>/${ASTEROID_CLASS_GROUP}/Parts`;

/** The base every deposit tile derives from, and the folder the game's own deposits sit beside it. */
const ASTEROID_FOLDER = 'ships/asteroid';
const DEPOSIT_BASE_FILE = `${ASTEROID_FOLDER}/base_small_part_asteroid.rules`;
const DEPOSIT_FOLDER_PREFIX = 'deposit_';

/** The shared soft-to-hard conversion list every recipe's convert stage reads. */
const CONVERSIONS_FILE = 'doodads/asteroids/hard_conversions.rules';
const CONVERSIONS_LIST = 'Conversions';
const CONVERSIONS_TARGET = `<${CONVERSIONS_FILE}>/${CONVERSIONS_LIST}`;

/** The folder the game's own palette icons for asteroids sit under, by look. */
const DOODAD_ICON_FOLDER = 'doodads/asteroids';

/** The category the game's own asteroid doodads sit under in the creative palette. */
const PALETTE_CATEGORY_KEY = 'Doodads/Asteroids';

/** The career files holding the three rarity lists, and the size ladder the common list is weighted by. */
const ASTEROID_SPAWNER_FILE = 'modes/career/sectors/sysgen_asteroids.rules';
const SUN_SPAWNER_FILE = 'modes/career/sectors/sysgen_suns.rules';

/** The list a types file declares, and the member of every entry. */
const TYPES_LIST = 'Types';

/** The list a parts file declares, which the manifest adds to the asteroid class. */
const PARTS_LIST = 'Parts';

/** The folder a type's own files go under. */
const ASTEROIDS_FOLDER = 'asteroids';

/** An id as the game accepts a bare word. */
const BARE_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The schema classes the host's id index is asked about. */
const DOODAD_CLASS = 'Cosmoteer.Simulation.Doodads.DoodadRules';
const PART_CLASS = 'Cosmoteer.Ships.Parts.PartRules';
const RESOURCE_CLASS = 'Cosmoteer.Resources.ResourceRules';

/** The deposit sizes, as the game names them in ids and keys. */
const DEPOSIT_SIZES = [1, 2, 3] as const;

/** The asteroid sizes in the game's order, with the rock counts each recipe grows. */
export const ASTEROID_SIZES = ['s', 'm', 'l', 'xl', 'xxl'] as const;
const PART_COUNTS: Readonly<Record<AsteroidSize, readonly [number, number]>> = {
    s: [100, 200],
    m: [200, 400],
    l: [400, 800],
    xl: [800, 1600],
    xxl: [1600, 3200],
};

/** The sizes the rare and sun lists take, and the weight ladder the game's own entries use there. */
const RARE_SIZES: readonly AsteroidSize[] = ['l', 'xl', 'xxl'];
const RARE_LADDER: Readonly<Partial<Record<AsteroidSize, string>>> = { l: '', xl: '/2', xxl: '/4' };

/** The rarities, each with the file and the list its entries go into. */
export const RARITIES = ['common', 'rare', 'sun'] as const;
const RARITY_LISTS: Readonly<Record<AsteroidRarity, { file: string; list: string }>> = {
    common: { file: ASTEROID_SPAWNER_FILE, list: 'CommonAsteroidTypes' },
    rare: { file: ASTEROID_SPAWNER_FILE, list: 'RareAsteroidTypes' },
    sun: { file: SUN_SPAWNER_FILE, list: 'SunAsteroidTypes' },
};

/** The rock tiles every recipe is grown from and enlarged with, all the game's own. */
const ROCK_TILE = 'cosmoteer.rock_1x1';
const LARGER_ROCKS = ['cosmoteer.rock_4x4', 'cosmoteer.rock_3x3', 'cosmoteer.rock_2x2'] as const;
const WEDGE_ROCKS = ['cosmoteer.rock_1x2_wedge_L', 'cosmoteer.rock_1x2_wedge_R', 'cosmoteer.rock_1x1_wedge'] as const;

/** The deposit fractions and counts the game's own recipes use. */
const MIN_FRACTION = '0.125';
const MAX_FRACTION = '0.25';
const MIN_PER_DEPOSIT = 3;
const MAX_PER_DEPOSIT = 10;

/** The health a hard tile carries, twice the base's. */
const HARD_HEALTH = 20000;

/** A scan result carrying nothing but the reason there is nothing to report. */
const scanFailed = (failure: NewAsteroidTypeFailure): NewAsteroidTypeScanResult => ({
    kind: 'scan',
    modRoot: '',
    modId: '',
    resources: [],
    looks: [],
    takenIds: [],
    authorPrefix: '',
    failure,
});

/** An apply result carrying nothing but the reason nothing was created. */
const applyFailed = (id: string, failure: NewAsteroidTypeFailure): NewAsteroidTypeApplyResult => ({
    kind: 'apply',
    id,
    folder: '',
    files: [],
    manifest: '',
    wiring: { parts: 'noTarget', conversions: 'noTarget', doodads: 'noTarget', types: 'noTarget' },
    localizationKeys: [],
    localizationFiles: [],
    createdFiles: [],
    changedFiles: [],
    failure,
});

/** The `<…>` span of a reference, whatever member path follows it. */
const REFERENCE_FILE = /^\s*&?\s*<([^<>]+)>/;

/**
 * A named member of a document or group, matched the way the game matches member names.
 *
 * @param node the parsed file or the group.
 * @param name the member's name.
 * @returns the member node, or undefined when there is none.
 */
const memberOf = (node: AbstractNode | undefined, name: string): AbstractNode | undefined =>
    isDocumentNode(node) || isGroupNode(node) ? memberOfContainer(node, name) : undefined;

/**
 * The text of a plain value, quotes removed. A bare word arrives as an identifier where the parser
 * reads a list element, and as a value where it reads an assignment, so both are answered.
 *
 * @param node the node.
 * @returns its text, or undefined for a group, a list or nothing.
 */
const textOf = (node: AbstractNode | undefined): string | undefined => {
    if (!node) return undefined;
    if (isIdentifierNode(node)) return node.name.trim();
    if (!isValueNode(node)) return undefined;
    return String(node.valueType.value)
        .trim()
        .replace(/^"(.*)"$/s, '$1');
};

/**
 * The ids a declaration answers to: its `ID` and every `OtherIDs` alias, since the game interns all
 * of them into the same table.
 *
 * @param node the parsed file or the group declaring them.
 * @returns the ids, unfolded.
 */
const declaredIdsOf = (node: AbstractNode): string[] => {
    const ids: string[] = [];
    const id = textOf(memberOf(node, 'ID'));
    if (id) ids.push(id);
    const others = memberOf(node, 'OtherIDs');
    if (isListNode(others)) {
        for (const element of others.elements) {
            const alias = textOf(element);
            if (alias) ids.push(alias);
        }
    }
    return ids;
};

/**
 * The file a reference names, resolved against the file it is written in.
 *
 * @param reference the reference's text, sigil or not.
 * @param declaringDir the directory of the file it is written in.
 * @returns the file with forward slashes, or undefined when the text names no file.
 */
const referencedFileOf = (reference: string | undefined, declaringDir: string): string | undefined => {
    const match = reference ? REFERENCE_FILE.exec(reference) : null;
    if (!match) return undefined;
    return resolveBasePath(match[1], declaringDir)?.replace(/\\/g, '/');
};

/**
 * The list a game root member names: the member's own list when it is written inline, else the list
 * inside the file its reference points at.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param memberName the top-level member, matched ignoring case.
 * @returns the list's elements and the directory their references resolve against, or undefined.
 */
const registryListOf = async (
    rootDocument: AbstractNodeDocument,
    rootFsPath: string,
    memberName: string
): Promise<{ elements: readonly AbstractNode[]; dir: string } | undefined> => {
    const member = memberOf(rootDocument, memberName);
    if (isListNode(member)) return { elements: member.elements, dir: dirOf(rootFsPath) };
    if (!isValueNode(member) || member.valueType.type !== 'Reference') return undefined;
    const location = locationOf(String(member.valueType.value), dirOf(rootFsPath));
    const file = location?.fsPath ?? referencedFileOf(String(member.valueType.value), dirOf(rootFsPath));
    if (!file) return undefined;
    const read = await readRulesFile(file);
    if (!read) return undefined;
    const list = location ? memberOf(read.document, location.groupPath[0]) : undefined;
    if (!isListNode(list)) return undefined;
    return { elements: list.elements, dir: dirOf(file) };
};

/** A resource as the game's own registry declares it. */
interface ResourceInfo extends AsteroidResource {
    /** The file it is declared in, absent for a resource a workspace mod declares. */
    file?: string;
    /** Its `DescriptionKey`, when it declares one. */
    descriptionKey?: string;
    /** Whether the file declares the `AsteroidDensity` variable the game's own recipes read. */
    hasDensity: boolean;
}

/**
 * The resources the deposits can yield: the game's own registry, with names from the language files
 * when the host can read them, then every id a workspace mod declares.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns the resources, the game's own first in registry order.
 */
const resourcesOf = async (
    rootDocument: AbstractNodeDocument,
    rootFsPath: string,
    host: NewAsteroidTypeHost,
    cancellationToken: CancellationToken
): Promise<ResourceInfo[]> => {
    const resources: ResourceInfo[] = [];
    const seen = new Set<string>();
    const registry = await registryListOf(rootDocument, rootFsPath, RESOURCES_MEMBER);
    for (const element of registry?.elements ?? []) {
        const file = referencedFileOf(textOf(element), registry?.dir ?? '');
        const read = file ? await readRulesFile(file) : undefined;
        if (!file || !read) continue;
        const id = textOf(memberOf(read.document, 'ID'));
        if (!id || !BARE_ID.test(id) || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        const nameKey = textOf(memberOf(read.document, 'NameKey'));
        const name =
            nameKey && host.localizedName
                ? await host.localizedName(nameKey, cancellationToken).catch(() => undefined)
                : undefined;
        resources.push({
            id,
            name,
            file,
            descriptionKey: textOf(memberOf(read.document, 'DescriptionKey')),
            hasDensity: memberOf(read.document, 'AsteroidDensity') !== undefined,
        });
    }
    const declared = await host
        .existingIds?.(RESOURCE_CLASS, cancellationToken)
        .catch((): ReadonlySet<string> => new Set());
    for (const id of declared ?? []) {
        if (!BARE_ID.test(id) || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        resources.push({ id, hasDensity: false });
    }
    return resources;
};

/**
 * The game's own deposits whose textures can be borrowed, one per `deposit_*` folder beside the
 * asteroid class.
 *
 * @param dataRoot the game's `Data` directory.
 * @returns the looks, in folder order.
 */
const looksOf = (dataRoot: string): AsteroidLook[] => {
    let names: string[];
    try {
        names = readdirSync(`${dataRoot}/${ASTEROID_FOLDER}`, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(DEPOSIT_FOLDER_PREFIX))
            .map((entry) => entry.name.slice(DEPOSIT_FOLDER_PREFIX.length))
            .filter((key) => BARE_ID.test(key));
    } catch {
        return [];
    }
    return names.sort().map((id) => ({ id, label: keyLabelOf(id) }));
};

/**
 * Every doodad id the game's own registry declares, folded, so a recipe id that would take a slot
 * twice is refused before it crashes the load.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @returns the ids.
 */
const gameDoodadIdsOf = async (rootDocument: AbstractNodeDocument, rootFsPath: string): Promise<Set<string>> => {
    const ids = new Set<string>();
    const registry = await registryListOf(rootDocument, rootFsPath, DOODADS_MEMBER);
    for (const element of registry?.elements ?? []) {
        if (isGroupNode(element)) {
            for (const id of declaredIdsOf(element)) ids.add(id.toLowerCase());
            continue;
        }
        const file = referencedFileOf(textOf(element), registry?.dir ?? '');
        const read = file ? await readRulesFile(file) : undefined;
        if (!read) continue;
        for (const id of declaredIdsOf(read.document)) ids.add(id.toLowerCase());
    }
    return ids;
};

/**
 * Every part id the game's asteroid class declares, folded, since two parts of one class sharing an
 * id throw at load.
 *
 * @param dataRoot the game's `Data` directory.
 * @returns the ids.
 */
const asteroidPartIdsOf = async (dataRoot: string): Promise<Set<string>> => {
    const ids = new Set<string>();
    const classPath = `${dataRoot}/${ASTEROID_CLASS_FILE}`;
    const read = await readRulesFile(classPath);
    if (!read) return ids;
    const parts = shipPartsIn(read.text, read.document, ASTEROID_CLASS_GROUP)?.partsList;
    for (const element of parts?.elements ?? []) {
        if (isGroupNode(element)) {
            for (const id of declaredIdsOf(element)) ids.add(id.toLowerCase());
            continue;
        }
        const location = locationOf(textOf(element) ?? '', dirOf(classPath));
        const file = location ? await readRulesFile(location.fsPath) : undefined;
        if (!location || !file) continue;
        const group = memberOf(file.document, location.groupPath[0]);
        if (!isGroupNode(group)) continue;
        for (const id of declaredIdsOf(group)) ids.add(id.toLowerCase());
    }
    return ids;
};

/**
 * Every doodad and part id the game and the workspace mods already declare, folded.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @param host the server facilities.
 * @param cancellationToken cancels the lookups.
 * @returns the ids.
 */
const takenIdsOf = async (
    rootDocument: AbstractNodeDocument,
    rootFsPath: string,
    dataRoot: string,
    host: NewAsteroidTypeHost,
    cancellationToken: CancellationToken
): Promise<Set<string>> => {
    const taken = new Set<string>([
        ...(await gameDoodadIdsOf(rootDocument, rootFsPath)),
        ...(await asteroidPartIdsOf(dataRoot)),
    ]);
    for (const cls of [DOODAD_CLASS, PART_CLASS]) {
        const declared = await host.existingIds?.(cls, cancellationToken).catch((): ReadonlySet<string> => new Set());
        for (const id of declared ?? []) taken.add(id.toLowerCase());
    }
    return taken;
};

/** The ids a type is made of: one recipe per size and one tile per deposit size, hard or soft. */
interface TypeIds {
    readonly doodad: (size: AsteroidSize) => string;
    readonly part: (n: number, hard: boolean) => string;
}

/**
 * The ids a type of one segment declares under an author prefix.
 *
 * @param prefix the author prefix.
 * @param segment the folded type id.
 * @returns the id makers.
 */
const typeIdsOf = (prefix: string, segment: string): TypeIds => ({
    doodad: (size) => `${prefix}.asteroid_${segment}_${size}`,
    part: (n, hard) => `${prefix}.deposit_${segment}_${n}x${hard ? '_hard' : ''}`,
});

/**
 * Every id a type of one segment could declare, whatever sizes and hardness are chosen, so a type
 * is refused when any of its possible ids is already in use.
 *
 * @param ids the id makers.
 * @returns the ids, folded.
 */
const allTypeIds = (ids: TypeIds): string[] => [
    ...ASTEROID_SIZES.map((size) => ids.doodad(size).toLowerCase()),
    ...DEPOSIT_SIZES.flatMap((n) => [ids.part(n, false).toLowerCase(), ids.part(n, true).toLowerCase()]),
];

/**
 * The type ids already in use under an author prefix, read back off the doodad and part ids that
 * this command would write, so a client can refuse a typed id before the apply round.
 *
 * @param taken every doodad and part id, folded.
 * @param prefix the author prefix, folded.
 * @returns the segments, folded.
 */
const takenSegmentsOf = (taken: ReadonlySet<string>, prefix: string): string[] => {
    const escaped = prefix.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const doodad = new RegExp(`^${escaped}\\.asteroid_(.+)_(?:s|m|l|xl|xxl)$`);
    const part = new RegExp(`^${escaped}\\.deposit_(.+)_[123]x(?:_hard)?$`);
    const segments = new Set<string>();
    for (const id of taken) {
        const match = doodad.exec(id) ?? part.exec(id);
        if (match) segments.add(match[1]);
    }
    return [...segments].sort();
};

/** The texture files one deposit tile names, bare as the game's own file writes them. */
interface DepositTextures {
    readonly icon: string;
    readonly levels: readonly { readonly file: string; readonly normals: string }[];
    readonly blueprints: string;
    /** The toolbar group the look's own tile sits in, absent when its file could not be read. */
    readonly editorGroup?: string;
}

/**
 * The texture names the game's own deposit of a look and size uses when its file cannot be read.
 *
 * @param look the look's folder key.
 * @param n the deposit size.
 * @param hard whether the hard variant is wanted.
 * @returns the names.
 */
const fallbackTextures = (look: string, n: number, hard: boolean): DepositTextures => {
    const stem = hard ? `deposit_${look}_hard_${n}x` : `deposit_${look}_${n}x`;
    return {
        icon: `${stem}_icon.png`,
        levels: ['', '_33', '_66'].map((suffix) => ({
            file: `${stem}${suffix}.png`,
            normals: `${stem}_normals${suffix}.png`,
        })),
        blueprints: `${stem}_blueprints.png`,
    };
};

/**
 * The texture names the game's own deposit of a look and size really uses, read off its file so a
 * renamed vanilla texture cannot break the derived tile, with the fallback names for anything the
 * file does not name.
 *
 * @param dataRoot the game's `Data` directory.
 * @param look the look's folder key.
 * @param n the deposit size.
 * @param hard whether the hard variant is wanted.
 * @returns the names.
 */
const depositTexturesOf = async (
    dataRoot: string,
    look: string,
    n: number,
    hard: boolean
): Promise<DepositTextures> => {
    const fallback = fallbackTextures(look, n, hard);
    const file = `${dataRoot}/${ASTEROID_FOLDER}/${DEPOSIT_FOLDER_PREFIX}${look}/deposit_${look}_${n}x${hard ? '_hard' : ''}.rules`;
    const read = await readRulesFile(file);
    const part = read ? memberOf(read.document, 'Part') : undefined;
    if (!isGroupNode(part)) return fallback;
    const icon = textOf(memberOf(memberOf(part, 'EditorIcon'), 'Texture')) ?? fallback.icon;
    const components = memberOf(part, 'Components');
    const damageLevels = memberOf(memberOf(memberOf(components, 'Graphics'), 'Floor'), 'DamageLevels');
    const levels = fallback.levels.map((level, index) => {
        const entry = isListNode(damageLevels) ? damageLevels.elements[index] : undefined;
        return {
            file: textOf(memberOf(entry, 'File')) ?? level.file,
            normals: textOf(memberOf(entry, 'NormalsFile')) ?? level.normals,
        };
    });
    const blueprints = textOf(memberOf(memberOf(components, 'Blueprints'), 'File')) ?? fallback.blueprints;
    const editorGroup = textOf(memberOf(part, 'EditorGroup'));
    return { icon, levels, blueprints, ...(editorGroup ? { editorGroup } : {}) };
};

/** The game's toolbar groups, whose names are the ids a part's `EditorGroup` has to name. */
const EDITOR_GROUPS_FILE = 'gui/game/designer/editor_groups.rules';

/** The group the game files its plain rock tiles under, the one every install has. */
const DEFAULT_EDITOR_GROUP = 'Rock';

/**
 * The toolbar group a resource's deposits sit in: the game's own group named after the resource
 * (`Iron`, `Gold`), when the game has one. A group the game does not know is not a display detail:
 * the build toolbox indexes its groups by name and throws when a part names a missing one, and the
 * asteroid class is editable in creative mode, so a made-up name would take the editor down.
 *
 * @param dataRoot the game's `Data` directory.
 * @param resourceId the resource.
 * @returns the group's name as the game writes it, or undefined when it has none for the resource.
 */
const resourceEditorGroupOf = async (dataRoot: string, resourceId: string): Promise<string | undefined> => {
    const read = await readRulesFile(`${dataRoot}/${EDITOR_GROUPS_FILE}`);
    if (!read) return undefined;
    const wanted = resourceId.toLowerCase();
    return namedMembersOf(read.document).find(([name]) => name.toLowerCase() === wanted)?.[0];
};

/**
 * A texture path as a mod file has to write it: the game's own deposit folder from the install
 * root, since the tile's own folder holds no textures. A name already written against the install
 * is kept as it is.
 *
 * @param look the look's folder key.
 * @param name the name as the game's own file writes it.
 * @returns the path.
 */
const rebasedTexture = (look: string, name: string): string =>
    name.startsWith('./Data/')
        ? name
        : `./Data/${ASTEROID_FOLDER}/${DEPOSIT_FOLDER_PREFIX}${look}/${name.replace(/^\.\//, '')}`;

/**
 * The reference a mod file names one of the game's own files by: `<./Data/…>` resolves against the
 * install wherever the mod sits, which a path relative to the mod would not.
 *
 * @param dataRoot the game's `Data` directory.
 * @param file a file under it.
 * @returns the reference, without the reading sigil.
 */
const installReference = (dataRoot: string, file: string): string =>
    `<./Data/${relative(dataRoot, file).replace(/\\/g, '/')}>`;

/** What every file of the type is written from. */
interface TypePlan {
    readonly id: string;
    readonly segment: string;
    readonly label: string;
    readonly name: string;
    readonly ids: TypeIds;
    readonly resource: ResourceInfo;
    readonly look: string;
    readonly rarity: AsteroidRarity;
    readonly sizes: readonly AsteroidSize[];
    readonly weight: number;
    readonly hard: boolean;
    /** The density expression the deposit fractions are multiplied by, parenthesized by the caller. */
    readonly density: string;
    /** The overlay the ship icon shows, as the tile names it. */
    readonly overlayReference: string;
    /**
     * The toolbar group the tiles name, the game's own group for the resource when it has one, else
     * the look's, since a group the game does not know throws in the build toolbox.
     */
    readonly editorGroup?: string;
    /** The description keys the tiles point at, the resource's own. */
    readonly descriptionKey: string;
    readonly hardDescriptionKey: string;
}

/**
 * A number as the rules text writes it, without an exponent a reader would have to unpick.
 *
 * @param value the number.
 * @returns its text.
 */
const numberText = (value: number): string => {
    const text = String(value);
    return /e/i.test(text) ? value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : text;
};

/**
 * A deposit tile: the game's own small asteroid tile with the resource, the ids, the keys and the
 * borrowed textures named, in the shape the game's own deposit files take.
 *
 * @param plan the type.
 * @param n the deposit size.
 * @param hard whether this is the hard variant.
 * @param textures the borrowed texture names.
 * @param dataRoot the game's `Data` directory.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const depositFileText = (
    plan: TypePlan,
    n: number,
    hard: boolean,
    textures: DepositTextures,
    dataRoot: string,
    lineEnding: LineEnding
): string => {
    const keyStem = `Parts/${plan.label}Deposit${n}x${hard ? 'Hard' : ''}`;
    const texture = (name: string): string => rebasedTexture(plan.look, name);
    return [
        "// One resource-bearing asteroid tile. Everything not named here is the game's own small asteroid",
        `// tile (health, density, salvage effects). The textures are the game's ${plan.look} deposit until you`,
        '// draw your own and name them here.',
        `Part : ${installReference(dataRoot, `${dataRoot}/${DEPOSIT_BASE_FILE}`)}/Part`,
        '{',
        `\tNameKey = "${keyStem}"`,
        `\tIconNameKey = "${keyStem}Icon"`,
        `\tDescriptionKey = "${hard ? plan.hardDescriptionKey : plan.descriptionKey}"`,
        `\tID = ${plan.ids.part(n, hard)}`,
        `\tSelectionTypeID = "deposit_${plan.segment}"`,
        `\tEditorGroup = "${plan.editorGroup ?? textures.editorGroup ?? DEFAULT_EDITOR_GROUP}"`,
        '\tIsFlippable = true',
        ...(hard ? [`\tMaxHealth = ${HARD_HEALTH}`, '\tIsCrewSalvageable = false'] : []),
        '\tReceivableBuffs : ^/0/ReceivableBuffs []',
        '\tResources',
        '\t[',
        `\t\t[${plan.resource.id}, ${n}]`,
        '\t]',
        '\tEditorIcon',
        '\t{',
        `\t\tTexture = "${texture(textures.icon)}"`,
        '\t\tSize = [32, 32]',
        '\t}',
        '\tComponents : ^/0/Components',
        '\t{',
        '\t\tGraphics',
        '\t\t{',
        '\t\t\tType = Graphics',
        '\t\t\tLocation = [0.5, 0.5]',
        '\t\t\tFloor',
        '\t\t\t{',
        '\t\t\t\tLayer = "asteroid"',
        '\t\t\t\tRandomUVRotation = true',
        '\t\t\t\tDamageLevels',
        '\t\t\t\t[',
        ...textures.levels.flatMap((level) => [
            '\t\t\t\t\t{',
            `\t\t\t\t\t\tFile = "${texture(level.file)}"`,
            `\t\t\t\t\t\tNormalsFile = "${texture(level.normals)}"`,
            '\t\t\t\t\t\tSize = [1, 1]',
            '\t\t\t\t\t}',
        ]),
        '\t\t\t\t]',
        '\t\t\t}',
        '\t\t}',
        '',
        '\t\tBlueprints',
        '\t\t{',
        '\t\t\tType = BlueprintSprite',
        `\t\t\tFile = "${texture(textures.blueprints)}"`,
        '\t\t\tSize = [1, 1]',
        '\t\t}',
        '',
        '\t\tCustomShipIcon',
        '\t\t{',
        '\t\t\tType = CustomShipIcon',
        `\t\t\tIcon : ${plan.overlayReference}`,
        '\t\t\t{',
        '\t\t\t\tSize = [32, 32]',
        '\t\t\t}',
        '\t\t\tWeight = &~/Part/Resources/0/1',
        '\t\t\tPulseInterval = 2',
        '\t\t\tPulseColor = [255, 255, 255, 64]',
        '\t\t\tShowAtZoom = 5',
        '\t\t}',
        '\t}',
        '}',
        '',
    ].join(lineEnding);
};

/**
 * The parts file: the list of tiles the manifest adds to the asteroid class in one action.
 *
 * @param plan the type.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const partsFileText = (plan: TypePlan, lineEnding: LineEnding): string =>
    [
        "// The deposit tiles, listed once so one manifest action puts them all into the game's asteroid",
        '// class, where every tile a recipe grows has to be.',
        PARTS_LIST,
        '[',
        ...DEPOSIT_SIZES.flatMap((n) => [
            `\t&<deposit_${plan.segment}_${n}x.rules>/Part`,
            ...(plan.hard ? [`\t&<deposit_${plan.segment}_${n}x_hard.rules>/Part`] : []),
        ]),
        ']',
        '',
    ].join(lineEnding);

/**
 * The conversions file: the soft-to-hard pair of every deposit size, added to the game's shared
 * conversion list so the recipes' convert stage hardens these tiles like its own.
 *
 * @param plan the type.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const conversionsFileText = (plan: TypePlan, lineEnding: LineEnding): string =>
    [
        '// Which soft tile turns into which hard one towards the middle of an asteroid, added to the',
        "// game's own conversion list. A pair only affects asteroids that grew the soft tile.",
        CONVERSIONS_LIST,
        '[',
        ...DEPOSIT_SIZES.flatMap((n) => [
            '\t{',
            `\t\tFrom = ${plan.ids.part(n, false)}`,
            `\t\tTo = ${plan.ids.part(n, true)}`,
            '\t}',
        ]),
        ']',
        '',
    ].join(lineEnding);

/**
 * A list member written over several lines at one indentation.
 *
 * @param indent the indentation of the member's own line.
 * @param name the member's name.
 * @param entries the elements, one per line.
 * @returns the lines.
 */
const listLines = (indent: string, name: string, entries: readonly string[]): string[] => [
    `${indent}${name}`,
    `${indent}[`,
    ...entries.map((entry) => `${indent}\t${entry}`),
    `${indent}]`,
];

/**
 * One recipe: the game's own asteroid doodad shape with this type's ids, the deposit tiles and the
 * density named, and the game's own palette icon of the look until the author draws one.
 *
 * @param plan the type.
 * @param size the asteroid size.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const doodadFileText = (plan: TypePlan, size: AsteroidSize, lineEnding: LineEnding): string => {
    const [minParts, maxParts] = PART_COUNTS[size];
    return [
        `// The asteroid recipe the game builds a ${plan.name} asteroid from: a blob of rock with deposits of`,
        `// ${plan.resource.id} grown into it. The palette icon is the game's own until you draw one.`,
        `ID = ${plan.ids.doodad(size)}`,
        'Type = GeneratedShip',
        `DescriptionKey = "Doodads/${plan.label}_${size.toUpperCase()}"`,
        `CategoryKey = "${PALETTE_CATEGORY_KEY}"`,
        'Tags = [asteroid]',
        'Icon',
        '{',
        '\tTexture',
        '\t{',
        `\t\tFile = "./Data/${DOODAD_ICON_FOLDER}/${plan.look}/asteroid_${plan.look}_${size}.png"`,
        '\t\tMipLevels = 2',
        '\t\tSampleMode = Linear',
        '\t}',
        '}',
        'Allegiance = -3 // Junk',
        'SpawnRadius = sqrt(&Generator/Stages/0/MaxParts)',
        'Generator',
        '{',
        `\tShipRulesID = "${ASTEROID_CLASS_ID}"`,
        '\tStages',
        '\t[',
        '\t\t{',
        '\t\t\tType = AsteroidStage',
        '\t\t\tName = AsteroidStage',
        ...listLines('\t\t\t', 'Parts', [ROCK_TILE]),
        `\t\t\tMinParts = ${minParts}`,
        `\t\t\tMaxParts = ${maxParts}`,
        '\t\t}',
        '\t\t{',
        '\t\t\tType = AsteroidDepositsStage',
        ...listLines('\t\t\t', 'ReplaceableParts', [ROCK_TILE]),
        '\t\t\tName = AsteroidDepositsStage',
        ...listLines(
            '\t\t\t',
            'Parts',
            DEPOSIT_SIZES.map((n) => plan.ids.part(n, false))
        ),
        `\t\t\tMinPartsFraction = ${MIN_FRACTION} * (${plan.density})`,
        `\t\t\tMaxPartsFraction = ${MAX_FRACTION} * (${plan.density})`,
        `\t\t\tMinPartsPerDeposit = ${MIN_PER_DEPOSIT}`,
        `\t\t\tMaxPartsPerDeposit = ${MAX_PER_DEPOSIT}`,
        '\t\t}',
        '\t\t{',
        '\t\t\tType = AsteroidWedgesStage',
        ...listLines('\t\t\t', 'ReplaceableParts', [ROCK_TILE]),
        ...listLines('\t\t\t', 'LargerParts', LARGER_ROCKS),
        '\t\t\tRandomizeReplaceOrder = true',
        '\t\t\tName = AsteroidWedgesStage',
        ...listLines('\t\t\t', 'WedgeParts', WEDGE_ROCKS),
        '\t\t}',
        '\t\t{',
        '\t\t\tType = EnlargeTilesStage',
        ...listLines('\t\t\t', 'ReplaceableParts', [ROCK_TILE]),
        ...listLines('\t\t\t', 'LargerParts', LARGER_ROCKS),
        '\t\t\tRandomizeReplaceOrder = true',
        '\t\t\tName = EnlargeTilesStage',
        '\t\t}',
        '\t\t{',
        '\t\t\tType = ConvertTypeStage',
        `\t\t\tConversions = &<./Data/${CONVERSIONS_FILE}>/${CONVERSIONS_LIST}`,
        '\t\t\tChanceAtCenter = 1.2',
        '\t\t\tChanceAtEdge = 0',
        '\t\t\tName = ConvertTypeStage',
        '\t\t\tChanceExponent = 1',
        '\t\t}',
        '\t]',
        '}',
        '',
    ].join(lineEnding);
};

/**
 * The sizes a rarity's list takes: every size for the common list, the three the game's own rare
 * and sun entries stop at for the other two.
 *
 * @param plan the type.
 * @returns the sizes, in the game's order.
 */
const spawnedSizesOf = (plan: TypePlan): AsteroidSize[] =>
    plan.sizes.filter((size) => plan.rarity === 'common' || RARE_SIZES.includes(size));

/**
 * The spawn weight of one size: the game's own size ladder times the factor for the common list,
 * read off the spawner file so a rebalance there carries over, and the literal ladder the game's own
 * rare and sun entries use for the other two.
 *
 * @param plan the type.
 * @param size the size.
 * @returns the weight expression.
 */
const chanceWeightOf = (plan: TypePlan, size: AsteroidSize): string => {
    const factor = numberText(plan.weight);
    if (plan.rarity !== 'common') return `${factor}${RARE_LADDER[size] ?? ''}`;
    return `${factor} * (&<./Data/${ASTEROID_SPAWNER_FILE}>/${size.toUpperCase()}Chance)`;
};

/**
 * The types file: one spawner entry per size, in the shape the game's own rarity lists hold.
 *
 * @param plan the type.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const typesFileText = (plan: TypePlan, lineEnding: LineEnding): string => {
    const sizes = spawnedSizesOf(plan);
    const width = Math.max(...sizes.map((size) => plan.ids.doodad(size).length), 0);
    return [
        '// How often each size of the asteroid turns up where the game places asteroids of this rarity.',
        "// The weights are the game's own size ladder times a rarity factor. Raise a weight to see more.",
        TYPES_LIST,
        '[',
        ...sizes.map((size) => {
            const type = `${plan.ids.doodad(size)};`.padEnd(width + 1);
            return `\t{ Type=${type}  ChanceWeight=${chanceWeightOf(plan, size)}; }`;
        }),
        ']',
        '',
    ].join(lineEnding);
};

/** Where a type's own files sit. */
interface TypeFiles {
    readonly folder: string;
    readonly deposits: readonly { readonly n: number; readonly hard: boolean; readonly path: string }[];
    readonly parts: string;
    readonly conversions: string;
    readonly doodads: readonly { readonly size: AsteroidSize; readonly path: string }[];
    readonly types: string;
}

/**
 * Where a type's files sit under a mod: one folder under `asteroids`, holding the tiles, the parts
 * and conversions lists, the recipes and the spawner entries.
 *
 * @param modRoot the mod.
 * @param plan the type.
 * @returns the paths.
 */
const typeFilesOf = (modRoot: string, plan: TypePlan): TypeFiles => {
    const folder = `${modRoot}/${ASTEROIDS_FOLDER}/${plan.segment}`;
    return {
        folder,
        deposits: DEPOSIT_SIZES.flatMap((n) => {
            const soft = { n, hard: false, path: `${folder}/deposit_${plan.segment}_${n}x.rules` };
            return plan.hard
                ? [soft, { n, hard: true, path: `${folder}/deposit_${plan.segment}_${n}x_hard.rules` }]
                : [soft];
        }),
        parts: `${folder}/parts_${plan.segment}.rules`,
        conversions: `${folder}/conversions_${plan.segment}.rules`,
        doodads: plan.sizes.map((size) => ({ size, path: `${folder}/doodad_asteroid_${plan.segment}_${size}.rules` })),
        types: `${folder}/types_${plan.segment}.rules`,
    };
};

/**
 * The texts a type declares: a name per recipe, and a name and an icon name per tile, worded the
 * way the game's own are.
 *
 * @param plan the type.
 * @returns the entries, in the order the files are written.
 */
const localizationEntriesOf = (plan: TypePlan): LocalizationEntry[] => {
    const name = plan.name.replace(/"/g, '\\"');
    const entries: LocalizationEntry[] = plan.sizes.map((size) => ({
        key: `Doodads/${plan.label}_${size.toUpperCase()}`,
        value: `"${name} Asteroid (${size.toUpperCase()})"`,
    }));
    for (const n of DEPOSIT_SIZES) {
        for (const hard of plan.hard ? [false, true] : [false]) {
            const stem = `Parts/${plan.label}Deposit${n}x${hard ? 'Hard' : ''}`;
            const grade = hard ? 'Hard' : 'Soft';
            entries.push({ key: stem, value: `"${name} Deposit (${n}x ${grade})"` });
            entries.push({ key: `${stem}Icon`, value: `"${name} (${n}x ${grade})"` });
        }
    }
    // The hard tiles describe themselves the way the game's own hard deposits do: the resource's own
    // description, then the line saying a mining laser is needed. Both are composed by reference, so
    // the text follows the player's language without the type restating either of them.
    if (plan.hard) {
        entries.push({
            key: plan.hardDescriptionKey,
            value: `"<string id='${plan.descriptionKey}'/>\\n\\n<string id='Resource/NotMineable'/>"`,
        });
    }
    return entries;
};

/** One manifest action to write, and how to tell it is already there. */
interface Wiring {
    readonly key: keyof NewAsteroidTypeApplyResult['wiring'];
    /** The action target, or undefined when the game names no such list. */
    readonly target: string | undefined;
    /** The files the action adds, each with the `&` reference the manifest names it by. */
    readonly sources: readonly { readonly file: string; readonly reference: string }[];
    /** True when the one reference names a list of entries, all of which are added, rather than one entry. */
    readonly wholeList: boolean;
}

/**
 * One `AddMany` action listing several whole-file references, in the shape the game's own example
 * manifest writes a list of entries, one per line.
 *
 * @param target the game-root path of the list the references are added to.
 * @param references the references to add, sigils included.
 * @param indent the indentation the entry's own lines carry.
 * @param lineEnding the ending the manifest already uses.
 * @returns the entry's text, with no trailing line ending.
 */
const addManyListActionText = (
    target: string,
    references: readonly string[],
    indent: string,
    lineEnding: LineEnding
): string =>
    [
        `${indent}{`,
        `${indent}\tAction = AddMany`,
        `${indent}\tAddTo = "${target}"`,
        ...listLines(`${indent}\t`, 'ManyToAdd', references),
        `${indent}}`,
    ].join(lineEnding);

/**
 * The sizes the client chose, in the game's order, with the rarity's own sizes standing in when it
 * chose none that exist.
 *
 * @param value what the client sent.
 * @param rarity the rarity.
 * @returns the sizes.
 */
const sizesOf = (value: unknown, rarity: AsteroidRarity): AsteroidSize[] => {
    const wanted = new Set(Array.isArray(value) ? value.map((size) => String(size).trim().toLowerCase()) : []);
    const chosen = ASTEROID_SIZES.filter((size) => wanted.has(size));
    if (chosen.length > 0) return chosen;
    return rarity === 'common' ? [...ASTEROID_SIZES] : [...RARE_SIZES];
};

/**
 * Create the type and wire it in.
 *
 * @param args the client's arguments.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what was created.
 */
const applyRound = async (
    args: NewAsteroidTypeArgs,
    modRoot: string,
    host: NewAsteroidTypeHost,
    cancellationToken: CancellationToken
): Promise<NewAsteroidTypeApplyResult> => {
    const id = (args.id ?? '').trim();
    if (!BARE_ID.test(id)) return applyFailed(id, 'invalidId');
    const dataRoot = host.dataRoot()?.replace(/\\/g, '/').replace(/\/+$/, '');
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
    if (!dataRoot || !root?.path || !rootDocument) return applyFailed(id, 'noGameRoot');
    const looks = looksOf(dataRoot);
    if (looks.length === 0 || !existsSync(`${dataRoot}/${DEPOSIT_BASE_FILE}`)) return applyFailed(id, 'noGameRoot');
    const resources = await resourcesOf(rootDocument, root.path, host, cancellationToken);
    if (resources.length === 0) return applyFailed(id, 'noGameRoot');

    // The game throws on a doodad or part id without a dot, so a manifest with no author prefix has
    // nothing usable to build ids from.
    const identity = await identityOfMod(modRoot).catch((): ModIdentity => ({ root: modRoot }));
    const prefix = authorPrefixOf(identity.manifestId);
    if (!prefix) return applyFailed(id, 'noAuthorPrefix');

    const segment = factionSegment(id);
    const ids = typeIdsOf(prefix, segment);
    const taken = await takenIdsOf(rootDocument, root.path, dataRoot, host, cancellationToken);
    if (allTypeIds(ids).some((candidate) => taken.has(candidate))) return applyFailed(id, 'idTaken');

    const wantedResource = (args.resource ?? '').trim().toLowerCase();
    const resource = resources.find((candidate) => candidate.id.toLowerCase() === wantedResource) ?? resources[0];
    const wantedLook = (args.look ?? '').trim().toLowerCase();
    const look =
        looks.find((candidate) => candidate.id.toLowerCase() === wantedLook) ??
        looks.find((candidate) => candidate.id.toLowerCase() === resource.id.toLowerCase()) ??
        looks[0];
    const rarity: AsteroidRarity = RARITIES.includes(args.rarity as AsteroidRarity)
        ? (args.rarity as AsteroidRarity)
        : 'common';
    const weight = typeof args.weight === 'number' && Number.isFinite(args.weight) && args.weight > 0 ? args.weight : 1;
    const literalDensity =
        typeof args.density === 'number' && Number.isFinite(args.density) && args.density > 0
            ? args.density
            : undefined;
    const density =
        literalDensity !== undefined
            ? numberText(literalDensity)
            : resource.file && resource.hasDensity
              ? `&${installReference(dataRoot, resource.file)}/AsteroidDensity`
              : '1';
    // A resource with no file of its own (one a workspace mod declares) has no overlay to point at,
    // so the ship icon shows the look's own resource, which is at least the right shape of icon.
    const overlayFile = resource.file ?? `${dataRoot}/resources/${look.id}/${look.id}.rules`;
    const resourceLabel = keyLabelOf(resource.id);
    const descriptionKey = resource.descriptionKey ?? `Resource/${resourceLabel}Desc`;
    const plan: TypePlan = {
        id,
        segment,
        label: keyLabelOf(id),
        name: (args.name ?? '').trim() || keyLabelOf(id),
        ids,
        resource,
        look: look.id,
        rarity,
        sizes: sizesOf(args.sizes, rarity),
        weight,
        hard: args.hard !== false,
        density,
        overlayReference: `${installReference(dataRoot, overlayFile)}/Overlay`,
        editorGroup: await resourceEditorGroupOf(dataRoot, resource.id),
        descriptionKey,
        // The game ships a `<Resource>HardDesc` for the laser-mined resources only, so deriving one
        // from the resource's key writes a reference nothing declares for every other resource. The
        // type declares its own key instead, the way it does for its names and icons.
        hardDescriptionKey: `Parts/${keyLabelOf(id)}DepositHardDesc`,
    };
    const files = typeFilesOf(modRoot, plan);
    if (existsSync(files.folder)) return applyFailed(id, 'pathTaken');

    const choice = manifestForRegistration(modRoot);
    const lineEnding: LineEnding =
        choice.kind === 'manifest' ? lineEndingOf((await readRulesFile(choice.fsPath))?.text ?? '') : '\n';

    const created: string[] = [];
    try {
        await mkdir(files.folder, { recursive: true });
        const write = async (path: string, text: string): Promise<void> => {
            await writeFile(path, text, { encoding: 'utf-8', flag: 'wx' });
            created.push(path);
        };
        for (const deposit of files.deposits) {
            const textures = await depositTexturesOf(dataRoot, plan.look, deposit.n, deposit.hard);
            await write(deposit.path, depositFileText(plan, deposit.n, deposit.hard, textures, dataRoot, lineEnding));
        }
        await write(files.parts, partsFileText(plan, lineEnding));
        if (plan.hard) await write(files.conversions, conversionsFileText(plan, lineEnding));
        for (const doodad of files.doodads) await write(doodad.path, doodadFileText(plan, doodad.size, lineEnding));
        await write(files.types, typesFileText(plan, lineEnding));
    } catch {
        return applyFailed(id, 'writeFailed');
    }
    host.filesChanged(created);

    const entries = localizationEntriesOf(plan);
    const localization = await writeLocalizationKeys(
        filePathToUri(files.types),
        entries,
        host,
        cancellationToken
    ).catch(() => ({
        keys: [],
        files: [],
    }));

    const wiring: NewAsteroidTypeApplyResult['wiring'] = {
        parts: 'noTarget',
        conversions: plan.hard ? 'noTarget' : 'skipped',
        doodads: 'noTarget',
        types: spawnedSizesOf(plan).length > 0 ? 'noTarget' : 'skipped',
    };
    let manifestPath = '';
    let manifests: string[] | undefined;
    const changed = [...created, ...localization.files];

    if (choice.kind === 'ambiguous') {
        for (const key of Object.keys(wiring) as (keyof typeof wiring)[]) {
            if (wiring[key] !== 'skipped') wiring[key] = 'ambiguousManifest';
        }
        manifests = choice.manifests;
    } else if (choice.kind === 'manifest') {
        manifestPath = choice.fsPath;
        const manifestDir = dirOf(choice.fsPath);
        const reference = (file: string, member?: string): string =>
            `&${relativeRulesReference(manifestDir, file, member)}`;
        const rarityList = RARITY_LISTS[plan.rarity];
        const wirings: Wiring[] = [
            {
                key: 'parts',
                target: existsSync(`${dataRoot}/${ASTEROID_CLASS_FILE}`) ? ASTEROID_PARTS_TARGET : undefined,
                sources: [{ file: files.parts, reference: reference(files.parts, PARTS_LIST) }],
                wholeList: true,
            },
            {
                key: 'conversions',
                target: plan.hard && existsSync(`${dataRoot}/${CONVERSIONS_FILE}`) ? CONVERSIONS_TARGET : undefined,
                sources: [{ file: files.conversions, reference: reference(files.conversions, CONVERSIONS_LIST) }],
                wholeList: true,
            },
            {
                key: 'doodads',
                target: gameRootListTarget(rootDocument, root.path, dataRoot, DOODADS_MEMBER),
                sources: files.doodads.map((doodad) => ({ file: doodad.path, reference: reference(doodad.path) })),
                wholeList: false,
            },
            {
                key: 'types',
                target:
                    spawnedSizesOf(plan).length > 0 && existsSync(`${dataRoot}/${rarityList.file}`)
                        ? `<${rarityList.file}>/${rarityList.list}`
                        : undefined,
                sources: [{ file: files.types, reference: reference(files.types, TYPES_LIST) }],
                wholeList: true,
            },
        ];
        const manifest = await openManifest(choice.fsPath, host);
        const { insert, lineEnding } = manifest;
        const actions: string[] = [];
        for (const item of wirings) {
            if (!item.target || wiring[item.key] === 'skipped') continue;
            const missing: string[] = [];
            for (const source of item.sources) {
                if (!(await alreadyWired(modRoot, item.target, source.file))) missing.push(source.reference);
            }
            if (missing.length === 0) {
                wiring[item.key] = 'alreadyThere';
                continue;
            }
            if (insert.kind === 'unusable') {
                wiring[item.key] = 'manifestUnusable';
                continue;
            }
            actions.push(
                item.wholeList
                    ? addManyActionText(item.target, missing[0], insert.indent, lineEnding, true)
                    : addManyListActionText(item.target, missing, insert.indent, lineEnding)
            );
            wiring[item.key] = 'written';
        }
        if (actions.length > 0) {
            if (await appendManifestActions(manifest, actions, host)) {
                changed.push(choice.fsPath);
            } else {
                for (const key of Object.keys(wiring) as (keyof typeof wiring)[]) {
                    if (wiring[key] === 'written') wiring[key] = 'editRejected';
                }
            }
        }
    }

    return {
        kind: 'apply',
        id,
        folder: files.folder,
        files: created,
        manifest: manifestPath,
        wiring,
        manifests,
        localizationKeys: entries.map((entry) => entry.key),
        localizationFiles: localization.files,
        createdFiles: created,
        changedFiles: changed,
    };
};

/**
 * The command entry point: report the resources, the looks and what is taken when the client sent
 * no id, and create the type otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what could be created, or what was created.
 */
export const newAsteroidType = async (
    args: NewAsteroidTypeArgs,
    host: NewAsteroidTypeHost,
    cancellationToken: CancellationToken
): Promise<NewAsteroidTypeResult> => {
    const scanning = args.id === undefined;
    const located = modRootFor(args.uri, host.dataRoot());
    if ('failure' in located)
        return scanning ? scanFailed(located.failure) : applyFailed(args.id ?? '', located.failure);
    if (scanning) {
        const identity = await identityOfMod(located.modRoot).catch((): ModIdentity => ({ root: located.modRoot }));
        const dataRoot = host.dataRoot()?.replace(/\\/g, '/').replace(/\/+$/, '');
        const root = await host.gameRoot().catch(() => undefined);
        const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
        if (!dataRoot || !root?.path || !rootDocument) return scanFailed('noGameRoot');
        const looks = looksOf(dataRoot);
        if (looks.length === 0) return scanFailed('noGameRoot');
        const resources = await resourcesOf(rootDocument, root.path, host, cancellationToken);
        const prefix = authorPrefixOf(identity.manifestId) ?? '';
        const taken = await takenIdsOf(rootDocument, root.path, dataRoot, host, cancellationToken);
        return {
            kind: 'scan',
            modRoot: located.modRoot,
            modId: identity.manifestId ?? '',
            resources: resources.map(({ id, name }) => (name === undefined ? { id } : { id, name })),
            looks,
            takenIds: prefix ? takenSegmentsOf(taken, prefix) : [],
            authorPrefix: prefix,
        };
    }
    return await applyRound(args, located.modRoot, host, cancellationToken);
};
