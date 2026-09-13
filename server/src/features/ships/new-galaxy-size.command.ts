import { existsSync, readdirSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { posix } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { identityOfMod, ModIdentity } from '../../mod/mod-dependencies';
import { namedMembersOf } from '../../utils/ast.utils';
import { indentOfLineAt } from '../../utils/text.utils';
import { filePathToUri } from '../navigation/navigation-strategy';
import { lineEndingOf } from '../refactor/command-host';
import { NewContentHost, writeLocalizationKeys } from '../refactor/new-content/new-content.command';
import { gameRootListTarget, manifestForRegistration } from '../refactor/new-content/registration.emitter';
import { reindent, relativeRulesReference } from '../refactor/shared-base/base-file.emitter';
import { dirOf, readRulesFile } from '../refactor/shared-base/base-index';
import { memberOf } from '../refactor/new-content/registry-ids';
import { factionSegment, keyLabelOf } from './builtin-ships.emitter';
import { LineEnding } from './builtin-ships.types';
import { ManifestWiring, modRootFor, wireIntoManifest } from './mod-wiring';
import {
    NewGalaxySizeApplyResult,
    NewGalaxySizeArgs,
    NewGalaxySizeFailure,
    NewGalaxySizeResult,
    NewGalaxySizeScanResult,
} from './new-galaxy-size.types';

/**
 * The `workspace/executeCommand` id that creates a galaxy size. Both clients invoke it twice:
 * without an id it reports what the mod is, which size names are taken and how many systems the
 * game's standard galaxy has, with one it writes the size and offers it to both game modes.
 *
 * A size is a generator and a menu entry. The generator is the game's standard one cloned with
 * another number of systems, since the standard generator is what every other size the game ships
 * is built from, and the menu entry is what the career and creative modes list, each through its
 * own `MapSizes`. A size wired into only one of them is offered in one new-game screen and not the
 * other, which is what this command exists to prevent.
 */
export const NEW_GALAXY_SIZE_COMMAND = 'cosmoteer.newGalaxySize';

/** The game root members naming the two modes that list map sizes. */
const CAREER_MODE_MEMBER = 'CareerMode';
const CREATIVE_MODE_MEMBER = 'CreativeMode';

/** The list each mode offers its sizes through. */
const MAP_SIZES_MEMBER = 'MapSizes';

/** The generator folder, the standard generator cloned and the file the game's own sizes are named in. */
const GENERATORS_FOLDER = 'galaxy_map/map_generators';
const STANDARD_GENERATOR_FILE = `${GENERATORS_FOLDER}/galaxy_standard.rules`;
const MAP_SIZES_FILE = `${GENERATORS_FOLDER}/map_sizes.rules`;

/** The members of a generator and the spawner the system count sits in. */
const SPAWNERS_MEMBER = 'Spawners';
const MAP_NODES_MEMBER = 'MapNodes';
const COUNT_MEMBER = 'Count';

/** The members the size file writes, which the manifest and the size's own reference name. */
const GENERATOR_MEMBER = 'Generator';
const SIZE_MEMBER = 'Size';

/** The system counts the game ships, for a server that cannot read them, and the default a new size gets. */
const VANILLA_STANDARD_SYSTEMS = 75;
const DEFAULT_SYSTEMS = 150;
const MAX_SYSTEMS = 2000;

/** The folder a size's own files go under, mirroring the game's own tree. */
const SIZES_FOLDER = 'galaxy_map';

/** A size id as a bare word, since it names a group and a folder. */
const SIZE_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A scan result carrying nothing but the reason there is nothing to report. */
const scanFailed = (failure: NewGalaxySizeFailure): NewGalaxySizeScanResult => ({
    kind: 'scan',
    modRoot: '',
    modId: '',
    takenIds: [],
    standardSystems: VANILLA_STANDARD_SYSTEMS,
    failure,
});

/** An apply result carrying nothing but the reason nothing was created. */
const applyFailed = (id: string, failure: NewGalaxySizeFailure): NewGalaxySizeApplyResult => ({
    kind: 'apply',
    id,
    file: '',
    manifest: '',
    wiring: { career: 'noTarget', creative: 'noTarget' },
    localizationKeys: [],
    localizationFiles: [],
    createdFiles: [],
    changedFiles: [],
    failure,
});

/** The game's standard generator, read once for both rounds. */
interface StandardGenerator {
    readonly text: string;
    /** The elements of its `Spawners` list, in file order. */
    readonly spawners: AbstractNode[];
    /** The spawner that places the systems, when the list holds one. */
    readonly mapNodes: GroupNode | undefined;
    /** How many systems it places. */
    readonly systems: number;
}

/**
 * Whether a group inherits the base generator's `MapNodes` spawner, which is the one carrying the
 * system count.
 *
 * @param group the group.
 * @returns true when one of its bases ends in that member.
 */
const inheritsMapNodes = (group: GroupNode): boolean =>
    (group.inheritance ?? []).some((base) =>
        String(base.valueType.value).trim().toLowerCase().endsWith(`/${MAP_NODES_MEMBER.toLowerCase()}`)
    );

/**
 * The `Count` assignment of a spawner group, as the value node the number is written in.
 *
 * @param group the group.
 * @returns the value node, or undefined when the group declares no count or not as a plain number.
 */
const countValueOf = (group: GroupNode): ValueNode | undefined => {
    const lower = COUNT_MEMBER.toLowerCase();
    const node = namedMembersOf(group).find(([name]) => name.toLowerCase() === lower)?.[1];
    return isValueNode(node) && node.valueType.type === 'Number' ? node : undefined;
};

/**
 * The game's standard generator, which a new size clones.
 *
 * @param dataRoot the game's `Data` directory.
 * @returns the generator, or undefined when the file cannot be read or holds no spawner list.
 */
const standardGeneratorOf = async (dataRoot: string): Promise<StandardGenerator | undefined> => {
    const file = await readRulesFile(`${dataRoot.replace(/\\/g, '/')}/${STANDARD_GENERATOR_FILE}`);
    if (!file) return undefined;
    const list = memberOf(file.document, SPAWNERS_MEMBER);
    if (!isListNode(list)) return undefined;
    const mapNodes = list.elements.find(
        (element): element is GroupNode => isGroupNode(element) && inheritsMapNodes(element)
    );
    const count = mapNodes ? countValueOf(mapNodes) : undefined;
    const systems = count ? Number(count.valueType.value) : NaN;
    return {
        text: file.text,
        spawners: list.elements,
        mapNodes,
        systems: Number.isInteger(systems) && systems > 0 ? systems : VANILLA_STANDARD_SYSTEMS,
    };
};

/** A reference's file part, when it names a rules file. */
const RULES_REFERENCE = /<([^<>]+\.rules)>/gi;

/**
 * A reference as the size file has to spell it: the generator's own references are relative to its
 * folder, and the clone sits in the mod, so each is re-expressed against the install, which
 * `<./Data/…>` resolves against wherever the mod sits. A reference already spelled that way, or
 * anchored to a file root, is left as written.
 *
 * @param text the text the references are written in.
 * @returns the text with every file reference re-expressed.
 */
const againstInstall = (text: string): string =>
    text.replace(RULES_REFERENCE, (whole, path: string) => {
        const trimmed = path.trim();
        if (/^(\.[\\/]data[\\/]|~|\/)/i.test(trimmed)) return whole;
        return `<./Data/${posix.normalize(posix.join(GENERATORS_FOLDER, trimmed.replace(/\\/g, '/')))}>`;
    });

/**
 * One spawner of the standard generator, cloned for the size file: a bare reference is re-expressed
 * against the install, and a group keeps its body with the same done to every reference inside,
 * the system-placing one with its count replaced.
 *
 * @param element the spawner.
 * @param generator the generator it comes from.
 * @param systems the count the system-placing spawner gets.
 * @param indent the indentation the clone's first line gets.
 * @returns the clone's lines, or nothing for an element that cannot be cloned.
 */
const clonedSpawner = (
    element: AbstractNode,
    generator: StandardGenerator,
    systems: number,
    indent: string
): string[] => {
    if (isIdentifierNode(element)) return [`${indent}${againstInstall(element.name)}`];
    if (isValueNode(element)) return [`${indent}${againstInstall(String(element.valueType.value))}`];
    if (!isGroupNode(element) && !isListNode(element)) return [];
    let raw = generator.text.slice(element.position.start, element.position.end);
    const sourceIndent = indentOfLineAt(generator.text, element.position.start);
    if (isGroupNode(element) && element === generator.mapNodes) {
        const count = countValueOf(element);
        if (count) {
            const from = count.position.start - element.position.start;
            const to = count.position.end - element.position.start;
            raw = `${raw.slice(0, from)}${systems}${raw.slice(to)}`;
        } else {
            raw = `${raw.slice(0, 1)}\n${sourceIndent}\t${COUNT_MEMBER} = ${systems}${raw.slice(1)}`;
        }
    }
    const lines: string[] = [];
    const bases = (element.inheritance ?? []).map((base) => againstInstall(String(base.valueType.value).trim()));
    if (bases.length > 0) lines.push(`${indent}: ${bases.join(', ')}`);
    lines.push(...reindent(againstInstall(raw), sourceIndent, indent).split('\n'));
    return lines;
};

/**
 * The size file: the standard generator cloned under `Generator` with the new system count, and
 * the menu entry under `Size`, pointing at the generator beside it.
 *
 * @param label the key label the texts are declared under.
 * @param generator the game's standard generator.
 * @param systems the system count.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const sizeFileText = (label: string, generator: StandardGenerator, systems: number, lineEnding: LineEnding): string =>
    [
        "// The galaxy size: the game's standard generator with another number of systems, and the entry",
        '// both new-game screens list it under. Change the count here, or any other spawner, and the',
        '// entry follows.',
        GENERATOR_MEMBER,
        '{',
        `\t${SPAWNERS_MEMBER}`,
        '\t[',
        ...generator.spawners.flatMap((element) => clonedSpawner(element, generator, systems, '\t\t')),
        '\t]',
        '}',
        SIZE_MEMBER,
        '{',
        `\tNameKey = "${MAP_SIZES_MEMBER}/${label}"`,
        `\tTipKey = "${MAP_SIZES_MEMBER}/${label}Tip"`,
        `\tMapGenerator = &~/${GENERATOR_MEMBER}`,
        '}',
        '',
    ].join(lineEnding);

/**
 * The entries of a folder, none for a folder that is not there.
 *
 * @param folder the folder.
 * @returns its entry names.
 */
const folderEntriesOf = (folder: string): string[] => {
    try {
        return readdirSync(folder);
    } catch {
        return [];
    }
};

/**
 * The size names already in use, folded: the game's own from its size file, and the ones this mod
 * wrote earlier, each of which is a folder under the mod's `galaxy_map` holding a size file.
 *
 * @param modRoot the mod being written to.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the names.
 */
const takenIdsOf = async (modRoot: string, dataRoot: string | undefined): Promise<Set<string>> => {
    const taken = new Set<string>();
    const sizes = dataRoot ? await readRulesFile(`${dataRoot.replace(/\\/g, '/')}/${MAP_SIZES_FILE}`) : undefined;
    for (const [name, node] of sizes ? namedMembersOf(sizes.document) : []) {
        if (isGroupNode(node)) taken.add(name.toLowerCase());
    }
    const folder = `${modRoot}/${SIZES_FOLDER}`;
    for (const entry of folderEntriesOf(folder)) {
        if (existsSync(`${folder}/${entry}/galaxy_${entry}.rules`)) taken.add(entry.toLowerCase());
    }
    return taken;
};

/**
 * The action target of a mode's `MapSizes` list, read off the game root the way the ship
 * registry's is: `CareerMode = &<modes/career/career.rules>` names the file, and the list inside
 * it is the one the game's own sizes sit in.
 *
 * @param rootDocument the game root, parsed.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @param member the game root member naming the mode.
 * @returns the target, or undefined when the game root names no such mode.
 */
const modeSizesTarget = (
    rootDocument: AbstractNodeDocument,
    rootFsPath: string,
    dataRoot: string,
    member: string
): string | undefined => {
    const file = gameRootListTarget(rootDocument, rootFsPath, dataRoot, member);
    if (!file) return undefined;
    return `${file.replace(/>.*$/, '>')}/${MAP_SIZES_MEMBER}`;
};

/** One manifest action to write, keyed by the mode it reports as. */
type Wiring = ManifestWiring<keyof NewGalaxySizeApplyResult['wiring']>;

/**
 * Create the size and wire it in.
 *
 * @param args the client's arguments.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what was created.
 */
const applyRound = async (
    args: NewGalaxySizeArgs,
    modRoot: string,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<NewGalaxySizeApplyResult> => {
    const id = (args.id ?? '').trim();
    if (!SIZE_ID.test(id)) return applyFailed(id, 'invalidId');
    const dataRoot = host.dataRoot();
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
    if (!dataRoot || !root?.path || !rootDocument) return applyFailed(id, 'noGameRoot');
    const generator = await standardGeneratorOf(dataRoot);
    if (!generator) return applyFailed(id, 'noGameRoot');
    // The mod's own sizes are known by their folders, so a folder that is there is reported as the
    // path it is rather than as a name in use.
    const segment = factionSegment(id);
    const folder = `${modRoot}/${SIZES_FOLDER}/${segment}`;
    if (existsSync(folder)) return applyFailed(id, 'pathTaken');
    const taken = await takenIdsOf(modRoot, dataRoot);
    if (taken.has(id.toLowerCase())) return applyFailed(id, 'idTaken');
    const file = `${folder}/galaxy_${segment}.rules`;

    const systems =
        Number.isInteger(args.systems) && (args.systems as number) >= 1 && (args.systems as number) <= MAX_SYSTEMS
            ? (args.systems as number)
            : DEFAULT_SYSTEMS;
    const label = keyLabelOf(id);
    const nameKey = `${MAP_SIZES_MEMBER}/${label}`;
    const tipKey = `${MAP_SIZES_MEMBER}/${label}Tip`;

    const choice = manifestForRegistration(modRoot);
    const lineEnding: LineEnding =
        choice.kind === 'manifest' ? lineEndingOf((await readRulesFile(choice.fsPath))?.text ?? '') : '\n';

    const created: string[] = [];
    try {
        await mkdir(folder, { recursive: true });
        await writeFile(file, sizeFileText(label, generator, systems, lineEnding), { encoding: 'utf-8', flag: 'wx' });
        created.push(file);
    } catch {
        return applyFailed(id, 'writeFailed');
    }
    host.filesChanged(created);

    const localization = await writeLocalizationKeys(
        filePathToUri(file),
        [
            { key: nameKey, value: `"${(args.name ?? id).replace(/"/g, '\\"')}"` },
            { key: tipKey, value: `"${systems} solar systems."` },
        ],
        host,
        cancellationToken
    ).catch(() => ({ keys: [], files: [] }));

    const wiring: NewGalaxySizeApplyResult['wiring'] = { career: 'noTarget', creative: 'noTarget' };
    let manifestPath = '';
    let manifests: string[] | undefined;
    const changed = [...created, ...localization.files];

    if (choice.kind === 'ambiguous') {
        for (const key of Object.keys(wiring) as (keyof typeof wiring)[]) wiring[key] = 'ambiguousManifest';
        manifests = choice.manifests;
    } else if (choice.kind === 'manifest') {
        manifestPath = choice.fsPath;
        const reference = `&${relativeRulesReference(dirOf(choice.fsPath), file, SIZE_MEMBER)}`;
        const wirings: Wiring[] = [
            {
                key: 'career',
                target: modeSizesTarget(rootDocument, root.path, dataRoot, CAREER_MODE_MEMBER),
                reference,
                file,
            },
            {
                key: 'creative',
                target: modeSizesTarget(rootDocument, root.path, dataRoot, CREATIVE_MODE_MEMBER),
                reference,
                file,
            },
        ];
        if (await wireIntoManifest(choice.fsPath, modRoot, wirings, wiring, host)) changed.push(choice.fsPath);
    }

    return {
        kind: 'apply',
        id,
        file,
        manifest: manifestPath,
        wiring,
        manifests,
        localizationKeys: [nameKey, tipKey],
        localizationFiles: localization.files,
        createdFiles: created,
        changedFiles: changed,
    };
};

/**
 * The command entry point: report what is taken and how big the standard galaxy is when the client
 * sent no id, and create the size otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what is taken, or what was created.
 */
export const newGalaxySize = async (
    args: NewGalaxySizeArgs,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<NewGalaxySizeResult> => {
    const scanning = args.id === undefined;
    const located = modRootFor(args.uri, host.dataRoot());
    if ('failure' in located)
        return scanning ? scanFailed(located.failure) : applyFailed(args.id ?? '', located.failure);
    if (scanning) {
        const identity = await identityOfMod(located.modRoot).catch((): ModIdentity => ({ root: located.modRoot }));
        const dataRoot = host.dataRoot();
        const generator = dataRoot ? await standardGeneratorOf(dataRoot) : undefined;
        if (!generator) return scanFailed('noGameRoot');
        const taken = await takenIdsOf(located.modRoot, dataRoot);
        return {
            kind: 'scan',
            modRoot: located.modRoot,
            modId: identity.manifestId ?? '',
            takenIds: [...taken],
            standardSystems: generator.systems,
        };
    }
    return await applyRound(args, located.modRoot, host, cancellationToken);
};
