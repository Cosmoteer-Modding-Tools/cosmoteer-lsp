import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { relative } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { ActionSource } from '../../mod/action';
import { identityOfMod, ModIdentity } from '../../mod/mod-dependencies';
import { parseText } from '../../utils/ast.utils';
import { filePathToUri } from '../navigation/navigation-strategy';
import { lineEndingOf } from '../refactor/command-host';
import { authorPrefixOf } from '../refactor/new-content/content-id';
import { writeLocalizationKeys } from '../refactor/new-content/new-content.command';
import {
    gameRootListTarget,
    manifestActionMatches,
    manifestForRegistration,
} from '../refactor/new-content/registration.emitter';
import { addManyActionText } from '../refactor/register-part/manifest-action.emitter';
import { relativeRulesReference } from '../refactor/shared-base/base-file.emitter';
import { dirOf, readRulesFile, resolveBasePath } from '../refactor/shared-base/base-index';
import { memberOf } from '../refactor/new-content/registry-ids';
import { actionEntryText, factionSegment, keyLabelOf } from './builtin-ships.emitter';
import { LineEnding } from './builtin-ships.types';
import { alreadyWired, appendManifestActions, elementTextOf, modRootFor, openManifest, scalarOf } from './mod-wiring';
import {
    NewPlanetApplyResult,
    NewPlanetArgs,
    NewPlanetFailure,
    NewPlanetHost,
    NewPlanetResult,
    NewPlanetScanResult,
    PlanetBase,
    PlanetPlacement,
} from './new-planet.types';

/**
 * The `workspace/executeCommand` id that creates a planet type. Both clients invoke it twice: without
 * an id it reports what the mod is, which doodad ids are taken and which of the game's own planets
 * can be built on, with one it writes the doodad and wires it into the registry and the career
 * sector generator.
 *
 * A planet is a doodad drawn in one of the game's styles. The style itself is hundreds of lines of
 * generator data with no simple knob, so the wizard never writes one: the new doodad inherits one of
 * the game's own whole and overrides its id, its texts, its icon and, when asked, its size. The
 * registry entry puts it in the creative palette, and the spawner entry is what makes career sectors
 * place it, since a doodad no spawner list names loads without an error and is never seen.
 */
export const NEW_PLANET_COMMAND = 'cosmoteer.newPlanet';

/** The game root member naming the doodad registry, which the new doodad is added to. */
const DOODADS_MEMBER = 'Doodads';

/** The registry file and the list in it the game's own doodads sit in, when the game root names none. */
const REGISTRY_FILE = 'doodads/doodads.rules';
const REGISTRY_LIST = 'Doodads';

/** The career planet spawner whose lists a placement names. */
const SPAWNER_FILE = 'modes/career/sectors/sysgen_planets.rules';

/** The schema class doodads declare, which the host's id index is asked about. */
const DOODAD_CLASS = 'Cosmoteer.Simulation.Doodads.DoodadRules';

/** The folder a planet's own file goes under, mirroring the game's own tree. */
const PLANETS_FOLDER = 'doodads/planets';

/** The bare word a planet id is built from: the doodad id is the author prefix, a dot and `planet_<word>`. */
const PLANET_WORD = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The members of a doodad file the wizard reads or overrides. */
const ID_MEMBER = 'ID';
const TYPE_MEMBER = 'Type';
const PLANET_TYPE = 'Planet';
const STYLE_MEMBER = 'StyleID';
const DESCRIPTION_KEY_MEMBER = 'DescriptionKey';
const CATEGORY_KEY_MEMBER = 'CategoryKey';
const ICON_MEMBER = 'Icon';
const TEXTURE_MEMBER = 'Texture';
const FILE_MEMBER = 'File';
const TEXTURE_SIZE_MEMBER = 'TextureSize';
const SCALE_RANGE_MEMBER = 'ScaleRange';
const RANDOM_SCALE_RANGE_MEMBER = 'RandomScaleRange';
const DEFAULT_SCALE_MEMBER = 'DefaultScale';
const DISTANCE_RANGE_MEMBER = 'DistanceRange';
const RANDOM_DISTANCE_RANGE_MEMBER = 'RandomDistanceRange';
const DEFAULT_DISTANCE_MEMBER = 'DefaultDistance';
const MINIMAP_COLOR_MEMBER = 'MinimapColorScale';

/** The key path planet descriptions are declared under, as the game's own are. */
const DOODADS_KEY_GROUP = 'Doodads';

/** The chance weight a spawner entry gets when the client names none, which is what a bare entry has. */
const DEFAULT_WEIGHT = 1;

/**
 * The list under the spawner file each placement names. The named groups are targeted rather than
 * the `SubSpawners` indexes, since those entries inherit from the named groups and would not carry
 * the list themselves.
 */
const PLACEMENT_LISTS: Record<Exclude<PlanetPlacement, 'none'>, string> = {
    inner: 'InnerPlanet/DoodadTypes',
    outer: 'OuterPlanet/DoodadTypes',
    innerMoon: 'InnerPlanet/SubSpawners/0/DoodadTypes',
    outerMoon: 'OuterPlanet/SubSpawners/0/DoodadTypes',
};

/** Every placement, in the order a client offers them. */
const PLACEMENTS: readonly PlanetPlacement[] = ['inner', 'outer', 'innerMoon', 'outerMoon', 'none'];

/** A scan result carrying nothing but the reason there is nothing to report. */
const scanFailed = (failure: NewPlanetFailure): NewPlanetScanResult => ({
    kind: 'scan',
    modRoot: '',
    modId: '',
    authorPrefix: '',
    takenIds: [],
    bases: [],
    placements: [],
    failure,
});

/** An apply result carrying nothing but the reason nothing was created. */
const applyFailed = (id: string, failure: NewPlanetFailure): NewPlanetApplyResult => ({
    kind: 'apply',
    id,
    file: '',
    manifest: '',
    wiring: { doodads: 'noTarget', spawner: 'noTarget' },
    localizationKeys: [],
    localizationFiles: [],
    createdFiles: [],
    changedFiles: [],
    failure,
});

/**
 * A numeric list member written back the way the game's own files write it, `[a, b]`.
 *
 * @param node the parsed file or group.
 * @param name the member's name.
 * @returns the text, or undefined when the member is absent or holds anything but numbers.
 */
const numberListOf = (node: { elements: AbstractNode[] }, name: string): string | undefined => {
    const member = memberOf(node, name);
    if (!isListNode(member)) return undefined;
    const numbers: string[] = [];
    for (const element of member.elements) {
        if (!isValueNode(element) || element.valueType.type !== 'Number') return undefined;
        numbers.push(String(element.valueType.value));
    }
    return `[${numbers.join(', ')}]`;
};

/** A pair of numbers written the way the game's own files write a range. */
const rangeText = (range: readonly [number, number]): string => `[${range[0]}, ${range[1]}]`;

/**
 * A pair of positive numbers the client sent, taken only when both are finite and in order.
 *
 * @param value what the client sent.
 * @returns the pair, or undefined for anything else.
 */
const rangeOf = (value: unknown): readonly [number, number] | undefined => {
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [low, high] = value as unknown[];
    if (typeof low !== 'number' || typeof high !== 'number') return undefined;
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) return undefined;
    return [low, high];
};

/** One of the game's own planets, with everything of it the written file names or comments on. */
interface PlanetBaseInfo extends PlanetBase {
    /** The doodad file. */
    file: string;
    /** The key its description is declared under. */
    descriptionKey: string;
    /** The figures the derived file names in a comment, or copies in the explicit form. */
    figures: Record<string, string>;
}

/** Where the game's own doodads are listed, and how an action names that list. */
interface DoodadRegistry {
    readonly file: string;
    readonly list: string;
    readonly target: string;
}

/**
 * The doodad registry, read off the game root the way the faction registry's is: the root's
 * `Doodads = &<doodads/doodads.rules>/Doodads` names the file and the list inside it, and that same
 * path, sigil removed, is what the action target has to name. A game root naming no registry falls
 * back to the game's own path when the file is there.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @returns the registry, or undefined when neither names one.
 */
const doodadRegistryOf = (
    rootDocument: AbstractNodeDocument,
    rootFsPath: string,
    dataRoot: string
): DoodadRegistry | undefined => {
    const target = gameRootListTarget(rootDocument, rootFsPath, dataRoot, DOODADS_MEMBER);
    const match = target ? /^<([^<>]+)>\/(.+)$/.exec(target) : null;
    if (target && match) {
        const file = resolveBasePath(match[1], dirOf(rootFsPath))?.replace(/\\/g, '/');
        if (file) return { file, list: match[2], target };
    }
    const fallback = `${dataRoot.replace(/\\/g, '/')}/${REGISTRY_FILE}`;
    return existsSync(fallback)
        ? { file: fallback, list: REGISTRY_LIST, target: `<${REGISTRY_FILE}>/${REGISTRY_LIST}` }
        : undefined;
};

/**
 * The figures of a base doodad that a derived file names, each read back in the game's own spelling
 * so the comment in the derived file shows what it would override.
 *
 * @param document the parsed doodad.
 * @returns the figures by member name, only the ones the doodad declares.
 */
const figuresOf = (document: AbstractNodeDocument): Record<string, string> => {
    const figures: Record<string, string> = {};
    for (const member of [
        TEXTURE_SIZE_MEMBER,
        SCALE_RANGE_MEMBER,
        RANDOM_SCALE_RANGE_MEMBER,
        DISTANCE_RANGE_MEMBER,
        RANDOM_DISTANCE_RANGE_MEMBER,
        MINIMAP_COLOR_MEMBER,
    ]) {
        const text = numberListOf(document, member);
        if (text) figures[member] = text;
    }
    for (const member of [DEFAULT_SCALE_MEMBER, DEFAULT_DISTANCE_MEMBER]) {
        const text = scalarOf(document, member);
        if (text && Number.isFinite(Number(text))) figures[member] = text;
    }
    return figures;
};

/**
 * The palette icon a doodad names, resolved against the doodad's own folder the way the game
 * resolves it.
 *
 * @param document the parsed doodad.
 * @param file the doodad's path.
 * @returns the icon's absolute path, or undefined when the doodad names none.
 */
const iconOf = (document: AbstractNodeDocument, file: string): string | undefined => {
    const icon = memberOf(document, ICON_MEMBER);
    const texture = isGroupNode(icon) ? memberOf(icon, TEXTURE_MEMBER) : undefined;
    const named = isGroupNode(texture) ? scalarOf(texture, FILE_MEMBER) : undefined;
    if (!named) return undefined;
    return resolveBasePath(named, dirOf(file))?.replace(/\\/g, '/');
};

/** The game's own doodads: every id the registry lists, and the planets among them in full. */
interface RegistryRead {
    readonly ids: string[];
    readonly planets: PlanetBaseInfo[];
}

/**
 * The game's own doodads, in the order the registry lists them. Every doodad's id is taken, since
 * the game keeps one dictionary of them all, and the ones whose `Type` is `Planet` are what a new
 * planet can be built on.
 *
 * @param registry the registry file and list.
 * @param host the server facilities, for the base names.
 * @param cancellationToken cancels the lookups.
 * @returns the ids and the planets, or undefined when the registry cannot be read.
 */
const registryRead = async (
    registry: DoodadRegistry,
    host: NewPlanetHost,
    cancellationToken: CancellationToken
): Promise<RegistryRead | undefined> => {
    const read = await readRulesFile(registry.file);
    if (!read) return undefined;
    const list = memberOf(read.document, registry.list);
    if (!isListNode(list)) return undefined;
    const ids: string[] = [];
    const planets: PlanetBaseInfo[] = [];
    for (const element of list.elements) {
        const text = elementTextOf(element);
        const match = text ? /^\s*&?\s*<([^<>]+)>/.exec(text) : null;
        if (!match) continue;
        const file = resolveBasePath(match[1], dirOf(registry.file))?.replace(/\\/g, '/');
        const doodad = file ? await readRulesFile(file) : undefined;
        if (!file || !doodad) continue;
        const id = scalarOf(doodad.document, ID_MEMBER);
        if (!id) continue;
        ids.push(id);
        if (scalarOf(doodad.document, TYPE_MEMBER)?.toLowerCase() !== PLANET_TYPE.toLowerCase()) continue;
        const style = scalarOf(doodad.document, STYLE_MEMBER);
        const icon = iconOf(doodad.document, file);
        if (!style || !icon) continue;
        const descriptionKey = scalarOf(doodad.document, DESCRIPTION_KEY_MEMBER) ?? '';
        const label =
            descriptionKey && host.localizedName
                ? await host.localizedName(descriptionKey, cancellationToken).catch(() => undefined)
                : undefined;
        planets.push({
            id,
            style,
            icon,
            file,
            descriptionKey,
            figures: figuresOf(doodad.document),
            ...(label ? { label } : {}),
        });
    }
    return { ids, planets };
};

/**
 * The doodad ids the game and the workspace mods already declare, folded.
 *
 * @param registryIds the ids the game's registry lists.
 * @param host the server facilities.
 * @param cancellationToken cancels the lookup.
 * @returns the ids.
 */
const takenIdsOf = async (
    registryIds: readonly string[],
    host: NewPlanetHost,
    cancellationToken: CancellationToken
): Promise<Set<string>> => {
    const taken = new Set(registryIds.map((id) => id.toLowerCase()));
    const declared = await host
        .existingIds?.(DOODAD_CLASS, cancellationToken)
        .catch((): ReadonlySet<string> => new Set());
    for (const id of declared ?? []) taken.add(id.toLowerCase());
    return taken;
};

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

/**
 * The path a mod file names one of the game's own assets by, in the same `./Data/…` spelling.
 *
 * @param dataRoot the game's `Data` directory.
 * @param file a file under it.
 * @returns the path.
 */
const installPath = (dataRoot: string, file: string): string =>
    `./Data/${relative(dataRoot, file).replace(/\\/g, '/')}`;

/** The size figures the client asked for, each absent when the base's stands. */
interface ScaleOverrides {
    readonly scale?: readonly [number, number];
    readonly defaultScale?: number;
}

/**
 * The size lines of the derived file: the fields the client overrode, written, and the base's
 * figures the file inherits, named in a comment so the author sees what to override next.
 *
 * A new size range also replaces the base's random band, since a band outside the new range is
 * what the sector generator would otherwise keep placing the planet at. A default size the base
 * declares outside the new range is replaced by the range's middle for the same reason.
 *
 * @param base the base doodad.
 * @param overrides the sizes the client chose.
 * @returns the lines, without indentation.
 */
const sizeLines = (base: PlanetBaseInfo, overrides: ScaleOverrides): string[] => {
    const written: string[] = [];
    const overridden = new Set<string>();
    if (overrides.scale) {
        written.push(
            `${SCALE_RANGE_MEMBER} = ${rangeText(overrides.scale)}`,
            `${RANDOM_SCALE_RANGE_MEMBER} = ${rangeText(overrides.scale)}`
        );
        overridden.add(SCALE_RANGE_MEMBER).add(RANDOM_SCALE_RANGE_MEMBER);
    }
    let defaultScale = overrides.defaultScale;
    if (defaultScale === undefined && overrides.scale) {
        const own = Number(base.figures[DEFAULT_SCALE_MEMBER]);
        if (!Number.isFinite(own) || own < overrides.scale[0] || own > overrides.scale[1]) {
            defaultScale = Math.round((overrides.scale[0] + overrides.scale[1]) / 2);
        }
    }
    if (defaultScale !== undefined) {
        written.push(`${DEFAULT_SCALE_MEMBER} = ${defaultScale}`);
        overridden.add(DEFAULT_SCALE_MEMBER);
    }
    const inherited = [SCALE_RANGE_MEMBER, RANDOM_SCALE_RANGE_MEMBER, DEFAULT_SCALE_MEMBER]
        .filter((member) => !overridden.has(member) && base.figures[member] !== undefined)
        .map((member) => `${member} = ${base.figures[member]}`);
    const lines = [...written];
    if (inherited.length > 0) lines.push(`// The base's sizes, to override here: ${inherited.join('  ')}`);
    if (base.figures[MINIMAP_COLOR_MEMBER] !== undefined)
        lines.push(`// ${MINIMAP_COLOR_MEMBER} = ${base.figures[MINIMAP_COLOR_MEMBER]}`);
    return lines;
};

/**
 * The doodad file: the base inherited whole at the file root, with the id, the description, the
 * icon and the chosen sizes overridden. The style stays the base's by id, and everything else, the
 * orbit figures included, is read off the base at load time, which is why the file derives rather
 * than copies.
 *
 * @param doodadId the doodad id.
 * @param label the key label the description is declared under.
 * @param base the base doodad.
 * @param dataRoot the game's `Data` directory, which the base and its icon are named against.
 * @param overrides the sizes the client chose.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const doodadFileText = (
    doodadId: string,
    label: string,
    base: PlanetBaseInfo,
    dataRoot: string,
    overrides: ScaleOverrides,
    lineEnding: LineEnding
): string =>
    [
        "// The planet, built on one of the game's own: the style it is drawn in and every size and orbit",
        "// figure not named here are the base's. The icon is the game's own until you draw one: put a",
        '// PNG beside this file and name it here.',
        `${DOODAD_MEMBER} : ${installReference(dataRoot, base.file)}`,
        '{',
        `\t${ID_MEMBER} = ${doodadId}`,
        `\t${DESCRIPTION_KEY_MEMBER} = "${DOODADS_KEY_GROUP}/${label}"`,
        `\t${ICON_MEMBER} { ${TEXTURE_MEMBER} { ${FILE_MEMBER} = "${installPath(dataRoot, base.icon)}"; MipLevels = 2; SampleMode = Linear } }`,
        ...sizeLines(base, overrides).map((line) => `\t${line}`),
        '}',
        '',
    ].join(lineEnding);

/**
 * Whether a doodad file written in the derived form parses as one group inheriting the base, which
 * is the shape the game reads it in. A parser that cannot read a file-root inheritance list would
 * make the written file unnavigable, and the explicit form is written instead.
 *
 * @param text the derived file's text.
 * @returns true when it parses as intended.
 */
const derivedFormParses = (text: string): boolean => {
    const document = parseText(text, 'file:///planet.rules');
    const root = document.elements.find(isGroupNode);
    return (
        !!root &&
        root.identifier?.name === DOODAD_MEMBER &&
        (root.inheritance?.length ?? 0) === 1 &&
        scalarOf(root, ID_MEMBER) !== undefined
    );
};

/**
 * The member the doodad is written under. A file whose root is the doodad itself would have to be
 * a nameless group, which the game does not read, so the doodad is a named member the manifest
 * reaches as `&<file>/Planet`, the way a nebula file carries its `Nebula`.
 */
const DOODAD_MEMBER = 'Planet';

/**
 * The doodad file in the explicit form, every field copied from the base, for a parser that cannot
 * read the derived form. The values are the base's as read, so the two forms load the same.
 *
 * @param doodadId the doodad id.
 * @param label the key label the description is declared under.
 * @param base the base doodad.
 * @param dataRoot the game's `Data` directory, which the icon is named against.
 * @param overrides the sizes the client chose.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const explicitFileText = (
    doodadId: string,
    label: string,
    base: PlanetBaseInfo,
    dataRoot: string,
    overrides: ScaleOverrides,
    lineEnding: LineEnding
): string => {
    const figures = { ...base.figures };
    if (overrides.scale) {
        figures[SCALE_RANGE_MEMBER] = rangeText(overrides.scale);
        figures[RANDOM_SCALE_RANGE_MEMBER] = rangeText(overrides.scale);
    }
    if (overrides.defaultScale !== undefined) figures[DEFAULT_SCALE_MEMBER] = String(overrides.defaultScale);
    return [
        "// The planet, in the shape of the game's own: drawn in one of its styles, with its figures.",
        DOODAD_MEMBER,
        '{',
        `\t${ID_MEMBER} = ${doodadId}`,
        `\t${TYPE_MEMBER} = ${PLANET_TYPE}`,
        `\t${DESCRIPTION_KEY_MEMBER} = "${DOODADS_KEY_GROUP}/${label}"`,
        `\t${CATEGORY_KEY_MEMBER} = "${DOODADS_KEY_GROUP}/Planets"`,
        `\t${ICON_MEMBER} { ${TEXTURE_MEMBER} { ${FILE_MEMBER} = "${installPath(dataRoot, base.icon)}"; MipLevels = 2; SampleMode = Linear } }`,
        `\t${STYLE_MEMBER} = ${base.style}`,
        ...Object.entries(figures).map(([member, value]) => `\t${member} = ${value}`),
        '}',
        '',
    ].join(lineEnding);
};

/**
 * Whether a `ManyToAdd` source of a spawner action already names a doodad id, as a bare entry or
 * as a `{ Type = <id> }` group.
 *
 * @param source the action's source value.
 * @param doodadId the id looked for.
 * @returns true when one entry is that id.
 */
const spawnerEntryNames = (source: ActionSource, doodadId: string): boolean => {
    const wanted = doodadId.toLowerCase();
    const entries = isListNode(source) ? source.elements : [source];
    for (const entry of entries) {
        if (isGroupNode(entry)) {
            if (scalarOf(entry, TYPE_MEMBER)?.toLowerCase() === wanted) return true;
            continue;
        }
        if (elementTextOf(entry)?.trim().toLowerCase() === wanted) return true;
    }
    return false;
};

/** The file a planet is declared in, and the folder it sits in. */
interface PlanetFiles {
    readonly folder: string;
    readonly doodad: string;
}

/**
 * Where a planet's file sits under a mod: one folder under `doodads/planets`, holding the doodad.
 *
 * @param modRoot the mod.
 * @param segment the planet's folded word.
 * @returns the paths.
 */
const planetFilesOf = (modRoot: string, segment: string): PlanetFiles => {
    const folder = `${modRoot}/${PLANETS_FOLDER}/${segment}`;
    return { folder, doodad: `${folder}/doodad_planet_${segment}.rules` };
};

/**
 * The placement the client sent, taken only when it is one the command supports.
 *
 * @param value what the client sent.
 * @returns the placement, inner planets standing in for anything else.
 */
const placementOf = (value: unknown): PlanetPlacement =>
    PLACEMENTS.includes(value as PlanetPlacement) ? (value as PlanetPlacement) : 'inner';

/**
 * Create the planet and wire it in.
 *
 * @param args the client's arguments.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what was created.
 */
const applyRound = async (
    args: NewPlanetArgs,
    modRoot: string,
    host: NewPlanetHost,
    cancellationToken: CancellationToken
): Promise<NewPlanetApplyResult> => {
    const word = (args.id ?? '').trim();
    if (!PLANET_WORD.test(word)) return applyFailed(word, 'invalidId');
    const dataRoot = host.dataRoot();
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
    if (!dataRoot || !root?.path || !rootDocument) return applyFailed(word, 'noGameRoot');
    const registry = doodadRegistryOf(rootDocument, root.path, dataRoot);
    const read = registry ? await registryRead(registry, host, cancellationToken) : undefined;
    if (!registry || !read || read.planets.length === 0) return applyFailed(word, 'noGameRoot');

    // The game refuses a doodad id without an author segment at load, so a mod whose id carries
    // none cannot declare a doodad at all.
    const identity = await identityOfMod(modRoot).catch((): ModIdentity => ({ root: modRoot }));
    const prefix = authorPrefixOf(identity.manifestId);
    const segment = factionSegment(word);
    const doodadId = `${prefix ?? ''}.planet_${segment}`;
    if (!prefix) return applyFailed(doodadId, 'noAuthorPrefix');
    const taken = await takenIdsOf(read.ids, host, cancellationToken);
    if (taken.has(doodadId.toLowerCase())) return applyFailed(doodadId, 'idTaken');
    const files = planetFilesOf(modRoot, segment);
    if (existsSync(files.folder)) return applyFailed(doodadId, 'pathTaken');

    const wantedBase = (args.base ?? '').trim().toLowerCase();
    const base = read.planets.find((candidate) => candidate.id.toLowerCase() === wantedBase) ?? read.planets[0];
    const overrides: ScaleOverrides = {
        scale: rangeOf(args.scale),
        defaultScale:
            typeof args.defaultScale === 'number' && Number.isFinite(args.defaultScale) && args.defaultScale > 0
                ? args.defaultScale
                : undefined,
    };
    const placement = placementOf(args.placement);
    const weight =
        typeof args.weight === 'number' && Number.isFinite(args.weight) && args.weight > 0
            ? args.weight
            : DEFAULT_WEIGHT;
    const label = keyLabelOf(word);
    const descriptionKey = `${DOODADS_KEY_GROUP}/${label}`;

    const choice = manifestForRegistration(modRoot);
    const lineEnding: LineEnding =
        choice.kind === 'manifest' ? lineEndingOf((await readRulesFile(choice.fsPath))?.text ?? '') : '\n';

    const derived = doodadFileText(doodadId, label, base, dataRoot, overrides, lineEnding);
    const text = derivedFormParses(derived)
        ? derived
        : explicitFileText(doodadId, label, base, dataRoot, overrides, lineEnding);
    const created: string[] = [];
    try {
        await mkdir(files.folder, { recursive: true });
        await writeFile(files.doodad, text, { encoding: 'utf-8', flag: 'wx' });
        created.push(files.doodad);
    } catch {
        return applyFailed(doodadId, 'writeFailed');
    }
    host.filesChanged(created);

    const name = (args.name ?? word).replace(/"/g, '\\"');
    const localization = await writeLocalizationKeys(
        filePathToUri(files.doodad),
        [{ key: descriptionKey, value: `"${name}"` }],
        host,
        cancellationToken
    ).catch(() => ({ keys: [], files: [] }));

    const wiring: NewPlanetApplyResult['wiring'] = {
        doodads: 'noTarget',
        spawner: placement === 'none' ? 'skipped' : 'noTarget',
    };
    let manifestPath = '';
    let manifests: string[] | undefined;
    const changed = [...created, ...localization.files];

    if (choice.kind === 'ambiguous') {
        wiring.doodads = 'ambiguousManifest';
        if (placement !== 'none') wiring.spawner = 'ambiguousManifest';
        manifests = choice.manifests;
    } else if (choice.kind === 'manifest') {
        manifestPath = choice.fsPath;
        const manifestDir = dirOf(choice.fsPath);
        const manifest = await openManifest(choice.fsPath, host);
        const { insert, lineEnding } = manifest;
        const entries: string[] = [];
        const written: (keyof typeof wiring)[] = [];

        const reference = `&${relativeRulesReference(manifestDir, files.doodad, DOODAD_MEMBER)}`;
        if (await alreadyWired(modRoot, registry.target, files.doodad)) {
            wiring.doodads = 'present';
        } else if (insert.kind === 'unusable') {
            wiring.doodads = 'manifestUnusable';
        } else {
            entries.push(addManyActionText(registry.target, reference, insert.indent, lineEnding));
            wiring.doodads = 'written';
            written.push('doodads');
        }

        const spawnerTarget =
            placement !== 'none' && existsSync(`${dataRoot.replace(/\\/g, '/')}/${SPAWNER_FILE}`)
                ? `<${SPAWNER_FILE}>/${PLACEMENT_LISTS[placement]}`
                : undefined;
        if (spawnerTarget) {
            if (await manifestActionMatches(modRoot, spawnerTarget, (source) => spawnerEntryNames(source, doodadId))) {
                wiring.spawner = 'present';
            } else if (insert.kind === 'unusable') {
                wiring.spawner = 'manifestUnusable';
            } else {
                const entry = `{ Type=${doodadId}; ChanceWeight=${weight}; }`;
                entries.push(
                    actionEntryText(
                        ['Action = AddMany', `AddTo = "${spawnerTarget}"`, 'ManyToAdd', '[', `\t${entry}`, ']'],
                        insert.indent,
                        lineEnding
                    )
                );
                wiring.spawner = 'written';
                written.push('spawner');
            }
        }

        if (entries.length > 0) {
            if (await appendManifestActions(manifest, entries, host)) changed.push(choice.fsPath);
            else for (const key of written) wiring[key] = 'editRejected';
        }
    }

    return {
        kind: 'apply',
        id: doodadId,
        file: files.doodad,
        manifest: manifestPath,
        wiring,
        manifests,
        localizationKeys: [descriptionKey],
        localizationFiles: localization.files,
        createdFiles: created,
        changedFiles: changed,
    };
};

/**
 * The command entry point: report what is taken and what can be built on when the client sent no
 * id, and create the planet otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what is taken, or what was created.
 */
export const newPlanet = async (
    args: NewPlanetArgs,
    host: NewPlanetHost,
    cancellationToken: CancellationToken
): Promise<NewPlanetResult> => {
    const scanning = args.id === undefined;
    const located = modRootFor(args.uri, host.dataRoot());
    if ('failure' in located)
        return scanning ? scanFailed(located.failure) : applyFailed(args.id ?? '', located.failure);
    if (!scanning) return await applyRound(args, located.modRoot, host, cancellationToken);

    const identity = await identityOfMod(located.modRoot).catch((): ModIdentity => ({ root: located.modRoot }));
    const dataRoot = host.dataRoot();
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
    if (!dataRoot || !root?.path || !rootDocument) return scanFailed('noGameRoot');
    const registry = doodadRegistryOf(rootDocument, root.path, dataRoot);
    const read = registry ? await registryRead(registry, host, cancellationToken) : undefined;
    if (!read || read.planets.length === 0) return scanFailed('noGameRoot');
    const taken = await takenIdsOf(read.ids, host, cancellationToken);
    const spawnerExists = existsSync(`${dataRoot.replace(/\\/g, '/')}/${SPAWNER_FILE}`);
    return {
        kind: 'scan',
        modRoot: located.modRoot,
        modId: identity.manifestId ?? '',
        authorPrefix: authorPrefixOf(identity.manifestId) ?? '',
        takenIds: [...taken],
        bases: read.planets.map(({ id, style, label, icon }) => ({ id, style, icon, ...(label ? { label } : {}) })),
        placements: spawnerExists ? [...PLACEMENTS] : ['none'],
    };
};
