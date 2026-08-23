import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    ValueNode,
    isAssignmentNode,
    isListNode,
    isValueNode,
} from '../core/ast/ast';
import { parseFilePath } from '../utils/ast.utils';
import { normalizeUri } from '../features/navigation/reference-location';
import { ReverseIncludeIndex } from '../features/navigation/reverse-include.index';
import { SchemaIdIndex } from '../features/completion/schema-id.index';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { FileTree, FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';
import {
    BUILD_BATTLE_TECH_RULES_CLASS,
    MODE_PART_FIELDS,
    PART_RULES_CLASS,
    TECH_RULES_CLASS,
} from '../features/part-editor/part-fields';
import { getStartOfAstNode } from '../utils/ast.utils';

/**
 * Which of a mod's own parts no tech in the project unlocks.
 *
 * The part wiring report answers this one part at a time, by searching the project for the techs
 * that name it. Asked of a whole mod that way it would run that search once per part. Asked the
 * other way round it is one pass: read the project's techs once, collect every part they name, and
 * subtract that from the parts the mod itself declares.
 *
 * This is never a fault. The game's own data leaves plenty of parts unnamed by any tech, and such a
 * part is simply buildable from the start of a career. What it answers is the question a modder
 * cannot answer by reading their own files: whether the part they meant to gate behind research is
 * gated at all.
 *
 * Only parts the game actually loads are judged, since a part in a file nothing reaches is already
 * reported as unreachable and saying it is also ungated would be a second finding about the same
 * thing. The count the report shows is that judged population, not every declaration in the folder.
 *
 * `PartsWhitelist` is deliberately not counted. It belongs to the build battle mode rather than to a
 * tech, and the wiring report keeps the two apart for the same reason.
 */

/** What the sweep found for one mod. */
interface PartTechCoverage {
    /** False when no file in the project declares a tech at all, so nothing can be judged. */
    readonly judged: boolean;
    /** How many of the mod's parts were judged, which is how many the game loads. */
    readonly total: number;
    /** How many declarations were left out because nothing reaches the file they sit in. */
    readonly unreachable: number;
    /** The judged parts no tech names, with the file each is declared in. */
    readonly uncovered: Array<{ id: string; file: string }>;
}

/** The tech classes whose `PartsUnlocked` decides whether a part is gated. */
const TECH_CLASSES = [TECH_RULES_CLASS, BUILD_BATTLE_TECH_RULES_CLASS];

/** The one field that gates a part behind research. */
const UNLOCK_FIELD = 'partsunlocked';

/** The per-choice field a mode toggle uses to name a part, which gates it the same way. */
const CHOICE_FIELD = 'partid';

/** The mode fields that count as an unlock, restricted to the two the schema really carries. */
const UNLOCK_FIELDS: ReadonlySet<string> = new Set(
    [UNLOCK_FIELD, CHOICE_FIELD].filter((field) => MODE_PART_FIELDS.has(field))
);

const navigation = new FullNavigationStrategy();

/**
 * The real path of an indexed declaration. The index keys a source by its normalized form, which is
 * lower-cased and has lost its leading slash, so it cannot be handed to the file system as it is.
 *
 * @param source the normalized source key.
 * @returns a path the file system accepts.
 */
const realPathOf = (source: string): string =>
    ReverseIncludeIndex.instance.realPathFor(source) ?? (/^[a-z]:\//i.test(source) ? source : '/' + source);

/**
 * Every part a tech document names, as the ids it spells and the files it points at.
 *
 * A tech names a part either by its id or by a reference to the part file's own `ID`, which is the
 * form the game's own tech tree is written in, so both are collected. A file reference is resolved
 * rather than matched as text: two mods can hold a `wired_part.rules` each.
 *
 * @param document the parsed tech document.
 * @param named the accumulator of named ids, lower-cased.
 * @param namedFiles the accumulator of named part files, as normalized uris.
 * @param token cancels the reference resolution.
 */
const collectNamedParts = async (
    document: AbstractNodeDocument,
    named: Set<string>,
    namedFiles: Set<string>,
    token: CancellationToken
): Promise<void> => {
    const references: ValueNode[] = [];
    const walk = (node: AbstractNode, field: string | undefined): void => {
        if (isAssignmentNode(node)) {
            const name = node.left.name.toLowerCase();
            if (node.right) walk(node.right, UNLOCK_FIELDS.has(name) ? name : undefined);
            return;
        }
        // `PartsUnlocked [ … ]` carries its name on the list itself rather than through an `=`, and
        // the game reads both spellings the same way.
        if (isListNode(node) && node.identifier) {
            const name = node.identifier.name.toLowerCase();
            for (const element of node.elements) walk(element, UNLOCK_FIELDS.has(name) ? name : field);
            return;
        }
        if (isValueNode(node)) {
            if (!field) return;
            if (node.valueType.type === 'Reference') references.push(node);
            else named.add(String(node.valueType.value).toLowerCase());
            return;
        }
        const elements = (node as { elements?: AbstractNode[] }).elements;
        if (elements) for (const element of elements) walk(element, field);
    };
    for (const element of document.elements) walk(element, undefined);

    for (const reference of references) {
        if (token.isCancellationRequested) return;
        const resolved = await navigation
            .navigate(String(reference.valueType.value), reference, getStartOfAstNode(reference).uri, token)
            .catch(() => null);
        if (!resolved) continue;
        const uri = isFile(resolved as FileTree)
            ? (resolved as FileWithPath).path
            : getStartOfAstNode(resolved as AbstractNode).uri;
        namedFiles.add(normalizeUri(uri));
    }
};

/**
 * The parts of one mod that no tech in the project unlocks.
 *
 * @param modRoot the mod's root directory.
 * @param reachable the reachability closure's reachable set, so dead files are left out.
 * @param folderPaths the project folders, for the index build.
 * @param token cancels the index build and the tech reads.
 * @returns what the sweep found, or undefined when the mod declares no parts at all.
 */
export const partTechCoverage = async (
    modRoot: string,
    reachable: Set<string>,
    folderPaths: string[],
    token: CancellationToken
): Promise<PartTechCoverage | undefined> => {
    const index = SchemaIdIndex.instance;
    const modPrefix = normalizeUri(modRoot) + '/';
    const declarations = await index.declarationsForClass(PART_RULES_CLASS, folderPaths, token, modPrefix);
    const own = declarations.filter((part) => !part.alias);
    if (own.length === 0) return undefined;

    // Both sides through the same normalizer: the index keys a source lower-cased and without its
    // leading slash, while the reachability set holds paths as the walk found them on disk.
    const reachableKeys = new Set([...reachable].map((path) => normalizeUri(path)));
    const judgedParts = own.filter((part) => reachableKeys.size === 0 || reachableKeys.has(part.source));
    if (judgedParts.length === 0) {
        return { judged: false, total: 0, unreachable: own.length, uncovered: [] };
    }

    // The same gate the wiring report's tech row uses: with no tech declared anywhere in the project,
    // every part would read as ungated and the answer would be noise rather than information.
    const judged = TECH_CLASSES.some((cls) => index.hasFileDeclarationsFor(cls));
    if (!judged) {
        return { judged: false, total: judgedParts.length, unreachable: own.length - judgedParts.length, uncovered: [] };
    }

    const named = new Set<string>();
    const namedFiles = new Set<string>();
    const techFiles = new Set<string>();
    for (const cls of TECH_CLASSES) {
        for (const tech of await index.declarationsForClass(cls, folderPaths, token)) techFiles.add(tech.source);
    }
    for (const file of techFiles) {
        if (token.isCancellationRequested) break;
        const document = await parseFilePath(realPathOf(file)).catch(() => null);
        if (document) await collectNamedParts(document, named, namedFiles, token);
    }

    const uncovered: Array<{ id: string; file: string }> = [];
    const seen = new Set<string>();
    for (const part of judgedParts) {
        if (named.has(part.id.toLowerCase())) continue;
        if (namedFiles.has(part.source)) continue;
        const key = `${part.source}|${part.id.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uncovered.push({ id: part.id, file: realPathOf(part.source) });
    }
    return {
        judged: true,
        total: judgedParts.length,
        unreachable: own.length - judgedParts.length,
        uncovered,
    };
};
