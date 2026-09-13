import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, GroupNode, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { identityOfMod, ModIdentity } from '../../mod/mod-dependencies';
import { isUnder } from '../../utils/relative-path';
import { lineEndingOf } from '../refactor/command-host';
import { rulesFilesUnder } from '../refactor/new-content/content-id';
import { gameRootListTarget, manifestForRegistration } from '../refactor/new-content/registration.emitter';
import {
    memberOf,
    memberTextOf,
    modRegisteredIds,
    nodeAtPath,
    resolveReferencePath,
    TECH_REGISTRY,
    vanillaRegistryEntries,
} from '../refactor/new-content/registry-ids';
import { addManyActionText } from '../refactor/register-part/manifest-action.emitter';
import { relativeRulesReference } from '../refactor/shared-base/base-file.emitter';
import { dirOf, readRulesFile } from '../refactor/shared-base/base-index';
import { LineEnding } from './builtin-ships.types';
import { alreadyWired, appendManifestActions, modRootFor, openManifest } from './mod-wiring';
import {
    NewTechApplyResult,
    NewTechArgs,
    NewTechEntry,
    NewTechFailure,
    NewTechHost,
    NewTechPart,
    NewTechResult,
    NewTechScanResult,
    PartGroupField,
} from './new-tech.types';

/**
 * The `workspace/executeCommand` id that creates a tech. Both clients invoke it twice: without a
 * part it reports the mod's parts, the techs a new one can build on and the ids in use, with one
 * it writes the tech and adds it to the game's tech tree from the manifest.
 *
 * A tech is what makes a part something a career has to buy. The link runs from the tech to the
 * part, so a part no tech names is buildable from the start, and this command writes the one
 * entry that changes that. The tech mirrors the part's own group field, because a tech has to
 * carry one and a reference to the field the part does not declare fails to load.
 */
export const NEW_TECH_COMMAND = 'cosmoteer.newTech';

/** The game root member naming the career mode, whose file names the tech list. */
const CAREER_MODE_MEMBER = 'CareerMode';

/** The member of the career mode holding the techs, and the member the tech file declares. */
const TECHS_MEMBER = 'Techs';
const TECH_MEMBER = 'Tech';

/** The folder a mod's techs go under, mirroring what the tech-adding mods in the corpus do. */
const TECHS_FOLDER = 'techs';

/** The members of a part the tech references, and the group a part without a group field is put in. */
const PART_MEMBER = 'Part';
const EDITOR_GROUP_FIELD = 'EditorGroup';
const EDITOR_GROUPS_FIELD = 'EditorGroups';
const FALLBACK_EDITOR_GROUP = 'Structure';

/** The cost a tech gets when the client sends none the game could read. */
const DEFAULT_COST = 3000;

/** A tech id as the game's own files write one: a dotted or bare word with nothing that needs quoting. */
const TECH_ID = /^[A-Za-z0-9_.-]+$/;

/** The `<file>` and member path of a reference, sigil or not. */
const REFERENCE = /^\s*&?\s*<([^<>]+)>(.*)$/;

/** A scan result carrying nothing but the reason there is nothing to report. */
const scanFailed = (failure: NewTechFailure): NewTechScanResult => ({
    kind: 'scan',
    modRoot: '',
    modId: '',
    parts: [],
    techs: [],
    takenIds: [],
    failure,
});

/** An apply result carrying nothing but the reason nothing was created. */
const applyFailed = (id: string, failure: NewTechFailure): NewTechApplyResult => ({
    kind: 'apply',
    id,
    file: '',
    manifest: '',
    wiring: { techs: 'noTarget' },
    createdFiles: [],
    changedFiles: [],
    failure,
});

/** A part of the mod, with what the tech needs to know about its file. */
interface ModPart extends NewTechPart {
    /** Whether the part declares a `DescriptionKey` of its own, which the tech can then reference. */
    readonly hasDescriptionKey: boolean;
}

/**
 * Whether a key was written as a reference into another file rather than as a key path.
 *
 * @param key the value as written.
 * @returns true for a reference.
 */
const isReference = (key: string): boolean => key.startsWith('&') || key.startsWith('<');

/**
 * The text a key shows, when the key is a plain key path and the host can read the language files.
 *
 * @param key the key as written, absent when the file declares none.
 * @param host the server facilities.
 * @param cancellationToken cancels the lookup.
 * @returns the text, or undefined.
 */
const localizedOf = async (
    key: string | undefined,
    host: NewTechHost,
    cancellationToken: CancellationToken
): Promise<string | undefined> => {
    if (!key || isReference(key) || !host.localizedName) return undefined;
    return await host.localizedName(key, cancellationToken).catch(() => undefined);
};

/**
 * The parts the mod's own files declare: every rules file whose top-level `Part` group carries an
 * `ID`, whether or not a ship lists it yet, since a tech is written for the part and not for its
 * registration.
 *
 * @param modRoot the mod to walk.
 * @param host the server facilities.
 * @param cancellationToken cancels the walk.
 * @returns the parts, in file order.
 */
const modPartsOf = async (
    modRoot: string,
    host: NewTechHost,
    cancellationToken: CancellationToken
): Promise<ModPart[]> => {
    const parts: ModPart[] = [];
    for (const fsPath of rulesFilesUnder(modRoot)) {
        if (cancellationToken.isCancellationRequested) break;
        const file = await readRulesFile(fsPath);
        if (!file) continue;
        const part = memberOf(file.document, PART_MEMBER);
        if (!isGroupNode(part)) continue;
        const id = memberTextOf(part, 'ID');
        if (!id) continue;
        const groupField: PartGroupField = memberOf(part, EDITOR_GROUPS_FIELD)
            ? 'EditorGroups'
            : memberOf(part, EDITOR_GROUP_FIELD)
              ? 'EditorGroup'
              : 'none';
        parts.push({
            id,
            name: await localizedOf(memberTextOf(part, 'NameKey'), host, cancellationToken),
            fsPath,
            groupField,
            hasDescriptionKey: memberOf(part, 'DescriptionKey') !== undefined,
        });
    }
    return parts;
};

/**
 * The key path a tech's `NameKey` resolves to. The game's own techs reference the part's key
 * (`&<./Data/ships/…>/Part/NameKey`) rather than spelling one, so a reference is followed into the
 * part file and the key read off it.
 *
 * @param tech the tech group.
 * @param declaringDir the directory of the file the tech is written in.
 * @param dataRoot the game's `Data` directory.
 * @returns the key path, or undefined when there is none to read.
 */
const techNameKeyOf = async (tech: GroupNode, declaringDir: string, dataRoot: string): Promise<string | undefined> => {
    const key = memberTextOf(tech, 'NameKey');
    if (!key || !isReference(key)) return key;
    const match = REFERENCE.exec(key);
    if (!match) return undefined;
    const fsPath = resolveReferencePath(match[1], declaringDir, dataRoot);
    const file = fsPath ? await readRulesFile(fsPath) : undefined;
    if (!file) return undefined;
    const node = nodeAtPath(file.document, match[2]);
    if (!node || !('valueType' in node) || !isValueNode(node)) return undefined;
    return node.valueType.type === 'String' ? String(node.valueType.value) : undefined;
};

/** The techs in play: the ones a new tech can build on, and every id a new one must not repeat. */
interface TechCatalog {
    /** The game's techs with their names, then the mod's own by id. */
    readonly entries: NewTechEntry[];
    /** Every id in use, folded, the aliases an entry's `OtherIDs` adds included. */
    readonly taken: Set<string>;
}

/**
 * The techs the game and the mod already have. The mod's own are the ones its manifests add and the
 * ones its tech folder holds, which an author may have written before wiring in.
 *
 * @param modRoot the mod being written to.
 * @param dataRoot the game's `Data` directory.
 * @param host the server facilities.
 * @param cancellationToken cancels the lookups.
 * @returns the catalog.
 */
const techCatalog = async (
    modRoot: string,
    dataRoot: string,
    host: NewTechHost,
    cancellationToken: CancellationToken
): Promise<TechCatalog> => {
    const entries: NewTechEntry[] = [];
    const taken = new Set<string>();
    const vanilla = await vanillaRegistryEntries(TECH_REGISTRY, dataRoot);
    for (const group of vanilla?.groups ?? []) {
        for (const alias of TECH_REGISTRY.idsOfGroup(group)) taken.add(alias.toLowerCase());
        const id = memberTextOf(group, 'ID');
        if (!id || entries.some((entry) => entry.id.toLowerCase() === id.toLowerCase())) continue;
        const key = await techNameKeyOf(group, dirOf(vanilla?.fsPath ?? ''), dataRoot);
        entries.push({ id, name: await localizedOf(key, host, cancellationToken) });
    }
    const own = [...(await modRegisteredIds(TECH_REGISTRY, modRoot, dataRoot))];
    for (const fsPath of rulesFilesUnder(`${modRoot}/${TECHS_FOLDER}`)) {
        const file = await readRulesFile(fsPath);
        const tech = file ? memberOf(file.document, TECH_MEMBER) : undefined;
        if (isGroupNode(tech)) own.push(...TECH_REGISTRY.idsOfGroup(tech));
    }
    for (const id of own) {
        if (taken.has(id.toLowerCase())) continue;
        taken.add(id.toLowerCase());
        entries.push({ id });
    }
    return { entries, taken };
};

/**
 * The action target of the game's tech list, read off the game root the way the ship registry's
 * is: `CareerMode = &<modes/career/career.rules>` names the file, and `Techs = &<techs.rules>/Techs`
 * inside it names the list. A game root or a career file that does not say falls back to the path
 * the game's own tree uses, when the file is really there.
 *
 * @param rootDocument the game root, parsed, absent when it could not be read.
 * @param rootFsPath its path.
 * @param dataRoot the game's `Data` directory.
 * @returns the target, or undefined when no tech list can be found.
 */
const techsTargetOf = async (
    rootDocument: AbstractNodeDocument | undefined,
    rootFsPath: string,
    dataRoot: string
): Promise<string | undefined> => {
    const root = dataRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const careerRef = rootDocument
        ? gameRootListTarget(rootDocument, rootFsPath, dataRoot, CAREER_MODE_MEMBER)
        : undefined;
    const careerMatch = careerRef ? REFERENCE.exec(careerRef) : null;
    if (careerMatch) {
        const careerPath = careerMatch[1].trim().replace(/\\/g, '/');
        const career = await readRulesFile(`${root}/${careerPath}`);
        const techs = career ? memberOf(career.document, TECHS_MEMBER) : undefined;
        if (isListNode(techs)) return `<${careerPath}>/${TECHS_MEMBER}`;
        if (isValueNode(techs) && techs.valueType.type === 'Reference') {
            const match = REFERENCE.exec(String(techs.valueType.value));
            const fsPath = match ? resolveReferencePath(match[1], dirOf(`${root}/${careerPath}`), dataRoot) : undefined;
            if (fsPath && isUnder(fsPath, root)) {
                const rel = fsPath.slice(root.length).replace(/^\/+/, '');
                return `<${rel}>${match![2].trim()}`;
            }
        }
    }
    const fallback = TECH_REGISTRY.vanillaFile;
    return existsSync(`${root}/${fallback}`) ? `<${fallback}>/${TECHS_MEMBER}` : undefined;
};

/**
 * The file-name segment of a tech id: the part after the author's dot, folded, so a mod's techs are
 * named the way its parts are without repeating the author on every file.
 *
 * @param id the tech id.
 * @returns the segment.
 */
const techSegment = (id: string): string => {
    const bare = id.includes('.') ? id.slice(id.indexOf('.') + 1) : id;
    return (
        bare
            .toLowerCase()
            .replace(/[^a-z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'tech'
    );
};

/**
 * The group line the tech writes: the part's own field by reference, or a literal group when the
 * part declares neither, since the tech has to carry one and the station tab indexes it.
 *
 * @param part the part the tech unlocks.
 * @param reference the reference to the part's `Part` group, from the tech file.
 * @returns the line, without indentation.
 */
const groupLineOf = (part: ModPart, reference: string): string => {
    switch (part.groupField) {
        case 'EditorGroups':
            return `${EDITOR_GROUPS_FIELD} = &${reference}/${EDITOR_GROUPS_FIELD}`;
        case 'EditorGroup':
            return `${EDITOR_GROUP_FIELD} = &${reference}/${EDITOR_GROUP_FIELD}`;
        case 'none':
            return `${EDITOR_GROUP_FIELD} = "${FALLBACK_EDITOR_GROUP}"`;
    }
};

/**
 * The tech file, in the shape the game's own `techs.rules` writes each entry in, with every part
 * reference relative to the tech file.
 *
 * @param id the tech id.
 * @param part the part the tech unlocks.
 * @param techDir the directory the tech file is written in.
 * @param cost the cost at a station.
 * @param prerequisites the techs bought first, empty for none.
 * @param lineEnding the ending to write with.
 * @returns the file's text.
 */
const techFileText = (
    id: string,
    part: ModPart,
    techDir: string,
    cost: number,
    prerequisites: readonly string[],
    lineEnding: LineEnding
): string => {
    const reference = relativeRulesReference(techDir, part.fsPath, PART_MEMBER);
    const lines = [
        '// A part is buildable from the start of a career until a tech names it in PartsUnlocked. This',
        `// tech puts ${part.id} behind a purchase at a station. Its name, description, icon and group`,
        "// are the part's own, read by reference, so the tech follows the part.",
        TECH_MEMBER,
        '{',
        `\tID = ${id}`,
        `\tNameKey = &${reference}/NameKey`,
        part.hasDescriptionKey ? `\tDescriptionKey = &${reference}/DescriptionKey` : '\tDescriptionKey = ""',
        `\tIcon = &${reference}/EditorIcon`,
        `\t${groupLineOf(part, reference)}`,
        `\tPartsUnlocked = [&${reference}/ID]`,
        `\tCost = ${cost}`,
    ];
    if (prerequisites.length > 0) lines.push(`\tPrerequisites = [${prerequisites.join(', ')}]`);
    lines.push('}', '');
    return lines.join(lineEnding);
};

/**
 * Create the tech and wire it in.
 *
 * @param args the client's arguments.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what was created.
 */
const applyRound = async (
    args: NewTechArgs,
    modRoot: string,
    host: NewTechHost,
    cancellationToken: CancellationToken
): Promise<NewTechApplyResult> => {
    const wantedPart = (args.part ?? '').trim().toLowerCase();
    const part = (await modPartsOf(modRoot, host, cancellationToken)).find(
        (candidate) => candidate.id.toLowerCase() === wantedPart
    );
    const id = (args.id ?? part?.id ?? '').trim();
    if (!part) return applyFailed(id, 'unknownPart');
    if (!TECH_ID.test(id)) return applyFailed(id, 'invalidId');
    const dataRoot = host.dataRoot();
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as { parsedDocument?: AbstractNodeDocument } | undefined)?.parsedDocument;
    if (!dataRoot || !root?.path) return applyFailed(id, 'noGameRoot');
    const target = await techsTargetOf(rootDocument, root.path, dataRoot);
    if (!target) return applyFailed(id, 'noGameRoot');

    const techDir = `${modRoot}/${TECHS_FOLDER}`;
    const file = `${techDir}/${techSegment(id)}.rules`;
    if (existsSync(file)) return applyFailed(id, 'pathTaken');
    const catalog = await techCatalog(modRoot, dataRoot, host, cancellationToken);
    if (catalog.taken.has(id.toLowerCase())) return applyFailed(id, 'idTaken');

    const cost = Number.isInteger(args.cost) && (args.cost as number) > 0 ? (args.cost as number) : DEFAULT_COST;
    const prerequisites = [
        ...new Set(
            (args.prerequisites ?? []).map((entry) => String(entry).trim()).filter((entry) => TECH_ID.test(entry))
        ),
    ];

    const choice = manifestForRegistration(modRoot);
    const lineEnding: LineEnding =
        choice.kind === 'manifest' ? lineEndingOf((await readRulesFile(choice.fsPath))?.text ?? '') : '\n';

    const created: string[] = [];
    try {
        await mkdir(techDir, { recursive: true });
        await writeFile(file, techFileText(id, part, techDir, cost, prerequisites, lineEnding), {
            encoding: 'utf-8',
            flag: 'wx',
        });
        created.push(file);
    } catch {
        return applyFailed(id, existsSync(file) ? 'pathTaken' : 'writeFailed');
    }
    host.filesChanged(created);

    const wiring: NewTechApplyResult['wiring'] = { techs: 'noTarget' };
    let manifestPath = '';
    let manifests: string[] | undefined;
    const changed = [...created];

    if (choice.kind === 'ambiguous') {
        wiring.techs = 'ambiguousManifest';
        manifests = choice.manifests;
    } else if (choice.kind === 'manifest') {
        manifestPath = choice.fsPath;
        if (await alreadyWired(modRoot, target, file)) {
            wiring.techs = 'present';
        } else {
            const manifest = await openManifest(choice.fsPath, host);
            if (manifest.insert.kind === 'unusable') {
                wiring.techs = 'manifestUnusable';
            } else {
                const reference = `&${relativeRulesReference(dirOf(choice.fsPath), file, TECH_MEMBER)}`;
                const entry = addManyActionText(target, reference, manifest.insert.indent, manifest.lineEnding, false);
                if (await appendManifestActions(manifest, [entry], host)) {
                    wiring.techs = 'written';
                    changed.push(choice.fsPath);
                } else {
                    wiring.techs = 'editRejected';
                }
            }
        }
    }

    return {
        kind: 'apply',
        id,
        file,
        manifest: manifestPath,
        wiring,
        manifests,
        createdFiles: created,
        changedFiles: changed,
    };
};

/**
 * The command entry point: report the parts, the techs and the ids in use when the client sent no
 * part, and create the tech otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what could be created, or what was.
 */
export const newTech = async (
    args: NewTechArgs,
    host: NewTechHost,
    cancellationToken: CancellationToken
): Promise<NewTechResult> => {
    const scanning = args.part === undefined;
    const located = modRootFor(args.uri, host.dataRoot());
    if ('failure' in located)
        return scanning ? scanFailed(located.failure) : applyFailed(args.id ?? '', located.failure);
    if (scanning) {
        const dataRoot = host.dataRoot();
        if (!dataRoot) return scanFailed('noGameRoot');
        const identity = await identityOfMod(located.modRoot).catch((): ModIdentity => ({ root: located.modRoot }));
        const parts = await modPartsOf(located.modRoot, host, cancellationToken);
        if (parts.length === 0) return scanFailed('noParts');
        const catalog = await techCatalog(located.modRoot, dataRoot, host, cancellationToken);
        return {
            kind: 'scan',
            modRoot: located.modRoot,
            modId: identity.manifestId ?? '',
            parts: parts.map(({ id, name, fsPath, groupField }) => ({ id, name, fsPath, groupField })),
            techs: catalog.entries,
            takenIds: [...catalog.taken],
        };
    }
    return await applyRound(args, located.modRoot, host, cancellationToken);
};
