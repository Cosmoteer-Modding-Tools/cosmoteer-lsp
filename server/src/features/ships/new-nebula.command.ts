import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { identityOfMod, ModIdentity } from '../mod-report/mod-dependencies';
import { namedMembersOf } from '../../utils/ast.utils';
import { filePathToUri } from '../../document/reference-path';
import { authorPrefixOf } from '../refactor/new-content/content-id';
import { NewContentHost, writeLocalizationKeys } from '../refactor/new-content/new-content.command';
import { gameRootListTarget } from '../refactor/new-content/registration.emitter';
import { relativeRulesReference } from '../refactor/shared-base/base-file.emitter';
import { dirOf, readRulesFile, resolveBasePath } from '../refactor/shared-base/base-index';
import { memberOf } from '../refactor/new-content/registry-ids';
import { factionSegment, keyLabelOf } from './builtin-ships.emitter';
import { LineEnding } from './builtin-ships.types';
import {
    BARE_RULES_ID,
    ManifestWiring,
    ResolvedGameRoot,
    elementTextOf,
    installReference,
    modRootFor,
    registrationLineEnding,
    wireIntoManifest,
    resolveGameRoot,
    takenIdsOf,
} from './mod-wiring';
import {
    NebulaBase,
    NebulaColor,
    NebulaColors,
    NewNebulaApply,
    NewNebulaApplyResult,
    NewNebulaArgs,
    NewNebulaResult,
} from './new-nebula.types';

/**
 * The `workspace/executeCommand` id that creates a nebula type. Both clients invoke it twice:
 * without an id it reports what the mod is, which ids are taken and which of the game's own nebulas
 * can be built on, with one it writes the nebula and everything the career and creative modes need
 * to put it in a galaxy.
 *
 * A nebula is more than its entry in the registry. The career sector generator only places the
 * nebula types its own spawner list names, and the creative palette only offers the ones a doodad
 * is declared for. A nebula missing either loads without an error and is never seen, which is what
 * this command exists to prevent: the type, a spawner entry and a doodad are all written, with the
 * texts declared in every language file, so the nebula is met in the game the moment it is saved.
 */
export const NEW_NEBULA_COMMAND = 'cosmoteer.newNebula';

/** The game root member naming the nebula registry, a whole-file reference. */
const NEBULAS_MEMBER = 'Nebulas';

/** The game root member naming the doodad registry, which the palette entry is added to. */
const DOODADS_MEMBER = 'Doodads';

/** The registry file and the list in it the game's own nebula types sit in. */
const REGISTRY_FILE = 'nebulas/nebulas.rules';
const REGISTRY_LIST = 'NebulaTypes';

/** The career sector generator whose list the spawner entry is offered to. */
const SPAWNER_FILE = 'modes/career/sectors/sysgen_standard_nebulas.rules';
const SPAWNER_LIST = 'SubSpawners';
const SPAWNER_TARGET = `<${SPAWNER_FILE}>/${SPAWNER_LIST}`;

/** The career file whose explored radius bounds how far out a nebula is placed, as the game's own spawners read it. */
const WORLD_RADIUS_REFERENCE = '&<./Data/modes/career/career.rules>/Exploration/UnexploredRadius';

/** The game's own palette icon, which stands in for the new nebula's. */
const PALETTE_ICON = './Data/doodads/nebulas/nebula_cloudy.png';

/** The category the game's own nebula doodads sit under in the creative palette. */
const PALETTE_CATEGORY_KEY = 'Doodads/Nebulas';

/** The material members of a nebula file, and the colour fields a look is made of. */
const MATERIAL_LOW_MEMBER = 'MaterialLow';
const COLOR_FIELDS = ['_color1', '_color2', '_color3'] as const;

/** The members every nebula file declares, which the derived one overrides by name. */
const ID_MEMBER = 'ID';
const TOOLTIP_KEY_MEMBER = 'ToolTipKey';
const HUD_TEXT_KEY_MEMBER = 'HudTextKey';

/** The schema class nebula types declare, which the host's id index is asked about. */
const NEBULA_CLASS = 'Cosmoteer.Nebulas.NebulaTypeRules';

/** The spawner figures the game's own storms use, taken when the client names none. */
const DEFAULT_RADIUS = 100000;
const DEFAULT_COUNT: readonly [number, number] = [0, 2];
const DEFAULT_DISTANCE: readonly [number, number] = [10000, 25000];
const DEFAULT_SPAWN_CHANCE = 100;
const DEFAULT_SPLAT_TRIANGLES: readonly [number, number] = [15, 30];

/** The colour a base gets when its own material declares none, a grey no game nebula uses. */
const FALLBACK_COLOR: NebulaColor = [128, 128, 128];

/** The folder a nebula's own files go under, mirroring the game's own tree. */
const NEBULAS_FOLDER = 'nebulas';

/**
 * A colour the client sent, taken only when it is three whole channels of 0 to 255.
 *
 * @param value what the client sent.
 * @returns the channels, or undefined for anything else.
 */
const colorOf = (value: unknown): NebulaColor | undefined => {
    if (!Array.isArray(value) || value.length !== 3) return undefined;
    const channels = value.map((channel) =>
        Number.isInteger(channel) && channel >= 0 && channel <= 255 ? (channel as number) : undefined
    );
    if (channels.some((channel) => channel === undefined)) return undefined;
    return channels as NebulaColor;
};

/**
 * A pair of whole numbers the client sent, taken only when both are finite and in order.
 *
 * @param value what the client sent.
 * @param fallback the pair used for anything else.
 * @returns the pair.
 */
const rangeOf = (value: unknown, fallback: readonly [number, number]): readonly [number, number] => {
    if (!Array.isArray(value) || value.length !== 2) return fallback;
    const [low, high] = value as unknown[];
    if (!Number.isInteger(low) || !Number.isInteger(high)) return fallback;
    if ((low as number) < 0 || (high as number) < (low as number)) return fallback;
    return [low as number, high as number];
};

/**
 * The colour a material declares under one of its `_color` fields, read off the first three
 * numbers of the list.
 *
 * @param material the material group.
 * @param field the colour field.
 * @returns the channels, or undefined when the material declares no such colour.
 */
const materialColorOf = (material: AbstractNode, field: string): NebulaColor | undefined => {
    if (!isGroupNode(material)) return undefined;
    const lower = field.toLowerCase();
    const node = namedMembersOf(material).find(([name]) => name.toLowerCase() === lower)?.[1];
    if (!isListNode(node)) return undefined;
    const channels = node.elements
        .filter((element): element is ValueNode => isValueNode(element) && element.valueType.type === 'Number')
        .map((element) => Math.round(Number(element.valueType.value)))
        .slice(0, 3);
    return channels.length === 3 ? colorOf(channels) : undefined;
};

/**
 * The game's own nebulas, in the order the registry lists them, each with the colours of its
 * low-detail material so a client can start from the look it derives from.
 *
 * @param dataRoot the game's `Data` directory.
 * @returns the bases with the file each is declared in, or undefined when the registry cannot be read.
 */
const basesOf = async (dataRoot: string): Promise<(NebulaBase & { file: string })[] | undefined> => {
    const registryPath = `${dataRoot.replace(/\\/g, '/')}/${REGISTRY_FILE}`;
    const registry = await readRulesFile(registryPath);
    if (!registry) return undefined;
    const list = memberOf(registry.document, REGISTRY_LIST);
    if (!isListNode(list)) return undefined;
    const bases: (NebulaBase & { file: string })[] = [];
    for (const element of list.elements) {
        const text = elementTextOf(element);
        const match = text ? /^\s*&?\s*<([^<>]+)>/.exec(text) : null;
        if (!match) continue;
        const file = resolveBasePath(match[1], dirOf(registryPath))?.replace(/\\/g, '/');
        const read = file ? await readRulesFile(file) : undefined;
        if (!file || !read) continue;
        const idNode = memberOf(read.document, ID_MEMBER);
        const id = isValueNode(idNode) ? String(idNode.valueType.value).trim() : '';
        if (!BARE_RULES_ID.test(id)) continue;
        const material = memberOf(read.document, MATERIAL_LOW_MEMBER);
        const colors = COLOR_FIELDS.map(
            (field) => (material ? materialColorOf(material, field) : undefined) ?? FALLBACK_COLOR
        ) as NebulaColors;
        bases.push({ id, colors, file });
    }
    return bases;
};

/**
 * The top-level members of a nebula file that carry a look: every group declaring `_color1`
 * itself, and every group inheriting from one that does, since an override of the base alone
 * would leave the derived material with the base's colours baked in at load time.
 *
 * @param document the parsed base nebula.
 * @returns the member names, in file order.
 */
const coloredMembersOf = (document: AbstractNodeDocument): string[] => {
    const groups = new Map<string, { node: AbstractNode; bases: string[] }>();
    for (const [name, node] of namedMembersOf(document)) {
        if (!isGroupNode(node)) continue;
        const bases = (node.inheritance ?? []).map((base) =>
            String(base.valueType.value).trim().replace(/^&\s*/, '').replace(/^~\//, '').toLowerCase()
        );
        groups.set(name.toLowerCase(), { node, bases });
    }
    const memo = new Map<string, boolean>();
    const colored = (key: string, visiting: Set<string>): boolean => {
        const known = memo.get(key);
        if (known !== undefined) return known;
        const group = groups.get(key);
        if (!group || visiting.has(key)) return false;
        visiting.add(key);
        const own = materialColorOf(group.node, COLOR_FIELDS[0]) !== undefined;
        const result = own || group.bases.some((base) => colored(base, visiting));
        memo.set(key, result);
        return result;
    };
    const names: string[] = [];
    for (const [name, node] of namedMembersOf(document)) {
        if (isGroupNode(node) && colored(name.toLowerCase(), new Set())) names.push(name);
    }
    return names;
};

/** Where a nebula's own files sit. */
interface NebulaFiles {
    readonly folder: string;
    readonly nebula: string;
    readonly spawner: string;
    readonly doodad: string;
}

/**
 * Where a nebula's own files sit under a mod: one folder under `nebulas`, holding the type, its
 * spawner entry and its doodad.
 *
 * @param modRoot the mod.
 * @param id the nebula id.
 * @returns the paths.
 */
const nebulaFilesOf = (modRoot: string, id: string): NebulaFiles => {
    const segment = factionSegment(id);
    const folder = `${modRoot}/${NEBULAS_FOLDER}/${segment}`;
    return {
        folder,
        nebula: `${folder}/nebula_${segment}.rules`,
        spawner: `${folder}/spawner_${segment}.rules`,
        doodad: `${folder}/doodad_nebula_${segment}.rules`,
    };
};

/**
 * The nebula file: the base inherited whole, with the id, the texts and every coloured material
 * overridden. The base's own textures and shaders keep resolving against the base's folder, which
 * is why the file is derived rather than copied.
 *
 * @param id the nebula id.
 * @param label the key label the texts are declared under.
 * @param baseReference the base nebula, as the file names it.
 * @param members the base's coloured materials, each of which gets the new colours.
 * @param colors the look.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const nebulaFileText = (
    id: string,
    label: string,
    baseReference: string,
    members: readonly string[],
    colors: NebulaColors,
    lineEnding: LineEnding
): string => {
    const colorLines = COLOR_FIELDS.map((field, index) => `${field} = [${colors[index].join(', ')}, 255];`).join(' ');
    return [
        "// The nebula, built on one of the game's own: everything not named here (the textures, the",
        "// shaders, how ships see through it) is the base's. Override more of its fields here as the",
        '// look needs, and the materials below carry the three colours it is drawn in.',
        `Nebula : ${baseReference}`,
        '{',
        `\t${ID_MEMBER} = ${id}`,
        `\t${TOOLTIP_KEY_MEMBER} = "${NEBULAS_MEMBER}/${label}"`,
        `\t${HUD_TEXT_KEY_MEMBER} = "${NEBULAS_MEMBER}/${label}HudFmt"`,
        ...members.map((member) => `\t${member} { ${colorLines} }`),
        '}',
        '',
    ].join(lineEnding);
};

/** The spawner figures a nebula is placed with. */
interface SpawnerFigures {
    readonly radius: number;
    readonly count: readonly [number, number];
    readonly distance: readonly [number, number];
    readonly spawnChance: number;
    readonly avoidStartingSector: boolean;
}

/**
 * The spawner file: one entry in a `SubSpawners` list, in the shape the game's own storm entries
 * take, ready to be added to the career sector generator with one action.
 *
 * @param id the nebula id.
 * @param figures how it is placed.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const spawnerFileText = (id: string, figures: SpawnerFigures, lineEnding: LineEnding): string =>
    [
        '// How the career mode places the nebula: how many a system gets, how far from its centre and',
        "// how wide each is. The starting system is kept clear of it the way the game's own storms are.",
        SPAWNER_LIST,
        '[',
        '\t{',
        ...(figures.avoidStartingSector ? ['\t\tConditions { IsInitNode=false }'] : []),
        '\t\tType = Nebula',
        ...(figures.spawnChance !== DEFAULT_SPAWN_CHANCE ? [`\t\tSpawnChance = ${figures.spawnChance}%`] : []),
        `\t\tCount = [${figures.count[0]}, ${figures.count[1]}]`,
        `\t\tDistance = [${figures.distance[0]}, ${figures.distance[1]}]`,
        `\t\tNebulaType = ${id}`,
        `\t\tNebulaRadius = ${figures.radius}`,
        `\t\tNebulaSplatTriCount = [${DEFAULT_SPLAT_TRIANGLES[0]}, ${DEFAULT_SPLAT_TRIANGLES[1]}]`,
        `\t\tMaxDistanceFromWorldOrigin = ${WORLD_RADIUS_REFERENCE}`,
        '\t}',
        ']',
        '',
    ].join(lineEnding);

/**
 * The palette doodad, in the shape the game's own `doodad_nebula_*.rules` have, so the creative
 * mode offers the nebula for placing by hand.
 *
 * @param doodadId the doodad's id.
 * @param id the nebula id it places.
 * @param label the key label its description is declared under.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const doodadFileText = (doodadId: string, id: string, label: string, lineEnding: LineEnding): string =>
    [
        "// The creative palette entry that places the nebula by hand. The icon is the game's own until",
        '// you draw one: put a PNG beside this file and name it here.',
        `ID = ${doodadId}`,
        'Type = Nebula',
        `NebulaID = ${id}`,
        `DescriptionKey = "${NEBULAS_MEMBER}/${label}"`,
        `CategoryKey = "${PALETTE_CATEGORY_KEY}"`,
        'Icon',
        '{',
        '\tTexture',
        '\t{',
        `\t\tFile = "${PALETTE_ICON}"`,
        '\t\tMipLevels = 2',
        '\t\tSampleMode = Linear',
        '\t}',
        '}',
        '',
    ].join(lineEnding);

/**
 * The action target of the registry's `NebulaTypes` list, read off the game root the way the
 * faction registry's is: `Nebulas = &<nebulas/nebulas.rules>` names the file, and the list inside
 * it is the one the game's own types sit in. A game root naming no registry falls back to the
 * game's own path when the file is there.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @returns the target, or undefined when neither names a registry.
 */
const registryTarget = (
    rootDocument: AbstractNodeDocument,
    rootFsPath: string,
    dataRoot: string
): string | undefined => {
    const file = gameRootListTarget(rootDocument, rootFsPath, dataRoot, NEBULAS_MEMBER);
    if (file) return `${file.replace(/>.*$/, '>')}/${REGISTRY_LIST}`;
    return existsSync(`${dataRoot.replace(/\\/g, '/')}/${REGISTRY_FILE}`)
        ? `<${REGISTRY_FILE}>/${REGISTRY_LIST}`
        : undefined;
};

/** One manifest action to write, keyed by the wiring it reports as. */
type Wiring = ManifestWiring<keyof NewNebulaApply['wiring']>;

/**
 * The spawner figures the client asked for, each falling back to the one the game's own storms use
 * when what arrived is not a figure the generator could read.
 *
 * @param args the client's arguments.
 * @returns the figures.
 */
const spawnerFiguresOf = (args: NewNebulaArgs): SpawnerFigures => ({
    radius:
        Number.isFinite(args.radius) && (args.radius as number) > 0
            ? Math.round(args.radius as number)
            : DEFAULT_RADIUS,
    count: rangeOf(args.count, DEFAULT_COUNT),
    distance: rangeOf(args.distance, DEFAULT_DISTANCE),
    spawnChance:
        Number.isFinite(args.spawnChance) && (args.spawnChance as number) >= 0 && (args.spawnChance as number) <= 100
            ? Math.round(args.spawnChance as number)
            : DEFAULT_SPAWN_CHANCE,
    avoidStartingSector: args.avoidStartingSector !== false,
});

/** What a nebula's own three files are written from, once the base has been read. */
interface NebulaPlan {
    readonly id: string;
    readonly label: string;
    readonly doodadId: string;
    /** The base file the nebula inherits, as the new file has to spell the reference. */
    readonly baseReference: string;
    /** The members of the base that carry a colour, which the new file overrides. */
    readonly coloredMembers: ReturnType<typeof coloredMembersOf>;
    readonly colors: NebulaColors;
    readonly figures: SpawnerFigures;
}

/**
 * Writes a nebula's own files: the type, the career spawner entry and the palette doodad.
 *
 * @param plan what the files are written from.
 * @param files where they go.
 * @param lineEnding the ending the new files are written with.
 * @returns the files written, or undefined when a write failed.
 */
const writeNebulaFiles = async (
    plan: NebulaPlan,
    files: NebulaFiles,
    lineEnding: LineEnding
): Promise<string[] | undefined> => {
    const created: string[] = [];
    try {
        await mkdir(files.folder, { recursive: true });
        await writeFile(
            files.nebula,
            nebulaFileText(plan.id, plan.label, plan.baseReference, plan.coloredMembers, plan.colors, lineEnding),
            { encoding: 'utf-8', flag: 'wx' }
        );
        await writeFile(files.spawner, spawnerFileText(plan.id, plan.figures, lineEnding), {
            encoding: 'utf-8',
            flag: 'wx',
        });
        await writeFile(files.doodad, doodadFileText(plan.doodadId, plan.id, plan.label, lineEnding), {
            encoding: 'utf-8',
            flag: 'wx',
        });
        created.push(files.nebula, files.spawner, files.doodad);
    } catch {
        return undefined;
    }
    return created;
};

/**
 * The actions a manifest has to carry for a nebula to be met: its registry entry, its career
 * spawner entry and its palette doodad.
 *
 * @param files the nebula's own files.
 * @param game the game tree the targets are read against.
 * @param manifestDir the directory the manifest sits in, which its references are relative to.
 * @returns one wiring per key, each with the target it needs or undefined when the game names none.
 */
const nebulaWirings = (files: NebulaFiles, game: ResolvedGameRoot, manifestDir: string): Wiring[] => {
    const { dataRoot, rootPath, rootDocument } = game;
    const reference = (file: string, member?: string): string =>
        `&${relativeRulesReference(manifestDir, file, member)}`;
    return [
        {
            key: 'registry',
            target: registryTarget(rootDocument, rootPath, dataRoot),
            reference: reference(files.nebula, 'Nebula'),
            file: files.nebula,
            wholeList: false,
        },
        {
            key: 'spawner',
            target: existsSync(`${dataRoot.replace(/\\/g, '/')}/${SPAWNER_FILE}`) ? SPAWNER_TARGET : undefined,
            reference: reference(files.spawner, SPAWNER_LIST),
            file: files.spawner,
            wholeList: true,
        },
        {
            key: 'doodad',
            target: gameRootListTarget(rootDocument, rootPath, dataRoot, DOODADS_MEMBER),
            reference: reference(files.doodad),
            file: files.doodad,
            wholeList: false,
        },
    ];
};

/**
 * Create the nebula and wire it in.
 *
 * @param args the client's arguments.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what was created.
 */
const applyRound = async (
    args: NewNebulaArgs,
    modRoot: string,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<NewNebulaApplyResult> => {
    const id = (args.id ?? '').trim();
    if (!BARE_RULES_ID.test(id)) return { kind: 'apply', failure: 'invalidId' };
    const game = await resolveGameRoot(host);
    if (!game) return { kind: 'apply', failure: 'noGameRoot' };
    const { dataRoot } = game;
    const bases = await basesOf(dataRoot);
    if (!bases || bases.length === 0) return { kind: 'apply', failure: 'noGameRoot' };
    const taken = await takenIdsOf(
        bases.map((base) => base.id),
        [NEBULA_CLASS],
        host,
        cancellationToken
    );
    if (taken.has(id.toLowerCase())) return { kind: 'apply', failure: 'idTaken' };
    const files = nebulaFilesOf(modRoot, id);
    if (existsSync(files.folder)) return { kind: 'apply', failure: 'pathTaken' };

    const wantedBase = (args.base ?? '').trim().toLowerCase();
    const base = bases.find((candidate) => candidate.id.toLowerCase() === wantedBase) ?? bases[0];
    const baseFile = await readRulesFile(base.file);
    if (!baseFile) return { kind: 'apply', failure: 'noGameRoot' };
    const identity = await identityOfMod(modRoot).catch((): ModIdentity => ({ root: modRoot }));
    const prefix = authorPrefixOf(identity.manifestId);
    const label = keyLabelOf(id);
    const tooltipKey = `${NEBULAS_MEMBER}/${label}`;
    const hudKey = `${NEBULAS_MEMBER}/${label}HudFmt`;
    const plan: NebulaPlan = {
        id,
        label,
        doodadId: `${prefix ? `${prefix}.` : ''}nebula_${factionSegment(id)}`,
        baseReference: installReference(dataRoot, base.file),
        coloredMembers: coloredMembersOf(baseFile.document),
        colors: (Array.isArray(args.colors) && args.colors.length === 3
            ? args.colors.map((color, index) => colorOf(color) ?? base.colors[index])
            : base.colors) as NebulaColors,
        figures: spawnerFiguresOf(args),
    };

    const { choice, lineEnding } = await registrationLineEnding(modRoot);

    const created = await writeNebulaFiles(plan, files, lineEnding);
    if (!created) return { kind: 'apply', failure: 'writeFailed' };
    host.filesChanged(created);

    // The tooltip opens with the name in bold and goes on with a line to fill, and the hud text
    // shows the density figure over the name in small grey, both in the markup the game's own use.
    const name = (args.name ?? id).replace(/"/g, '\\"');
    const localization = await writeLocalizationKeys(
        filePathToUri(files.nebula),
        [
            { key: tooltipKey, value: `"<b>${name}</b>\\nDescribe what ships meet inside it."` },
            { key: hudKey, value: `"<s14>{0:0.}%</s14>\\n<s12><gray>${name.toLowerCase()}</gray></s12>"` },
        ],
        host,
        cancellationToken
    ).catch(() => ({ keys: [], files: [] }));

    const wiring: NewNebulaApply['wiring'] = { registry: 'noTarget', spawner: 'noTarget', doodad: 'noTarget' };
    let manifestPath = '';
    let manifests: string[] | undefined;
    const changed = [...created, ...localization.files];

    if (choice.kind === 'ambiguous') {
        for (const key of Object.keys(wiring) as (keyof typeof wiring)[]) wiring[key] = 'ambiguousManifest';
        manifests = choice.manifests;
    } else if (choice.kind === 'manifest') {
        manifestPath = choice.fsPath;
        const wirings = nebulaWirings(files, game, dirOf(choice.fsPath));
        if (await wireIntoManifest(choice.fsPath, modRoot, wirings, wiring, host)) changed.push(choice.fsPath);
    }

    return {
        kind: 'apply',
        id,
        nebulaFile: files.nebula,
        spawnerFile: files.spawner,
        doodadFile: files.doodad,
        manifest: manifestPath,
        wiring,
        manifests,
        localizationKeys: [tooltipKey, hudKey],
        localizationFiles: localization.files,
        createdFiles: created,
        changedFiles: changed,
    };
};

/**
 * The command entry point: report what is taken and what can be built on when the client sent no
 * id, and create the nebula otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what is taken, or what was created.
 */
export const newNebula = async (
    args: NewNebulaArgs,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<NewNebulaResult> => {
    const scanning = args.id === undefined;
    const located = modRootFor(args.uri, host.dataRoot());
    if ('failure' in located)
        return scanning ? { kind: 'scan', failure: located.failure } : { kind: 'apply', failure: located.failure };
    if (scanning) {
        const identity = await identityOfMod(located.modRoot).catch((): ModIdentity => ({ root: located.modRoot }));
        const dataRoot = host.dataRoot();
        const bases = dataRoot ? await basesOf(dataRoot) : undefined;
        if (!bases || bases.length === 0) return { kind: 'scan', failure: 'noGameRoot' };
        const taken = await takenIdsOf(
            bases.map((base) => base.id),
            [NEBULA_CLASS],
            host,
            cancellationToken
        );
        return {
            kind: 'scan',
            modRoot: located.modRoot,
            modId: identity.manifestId ?? '',
            takenIds: [...taken],
            bases: bases.map(({ id, colors }) => ({ id, colors })),
        };
    }
    return await applyRound(args, located.modRoot, host, cancellationToken);
};
