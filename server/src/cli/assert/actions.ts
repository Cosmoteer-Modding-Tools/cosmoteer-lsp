import { dirname, resolve } from 'path';
import {
    AbstractNode,
    AbstractNodeDocument,
    isGroupNode,
    isListNode,
    isValueNode,
    ListNode,
} from '../../core/ast/ast';
import { isActionFragmentDocument, parseModActions } from '../../mod/action-parser';
import { ModAction } from '../../mod/action';
import { namedMembersOf } from '../../utils/ast.utils';
import { DocumentCache, isInside, ParsedFile, pathKey, positionOf } from './documents';

// Collecting the actions of one mod. A manifest carries some of them in its own `Actions [ … ]`
// list and pulls the rest in from other files, which the game allows because `Actions` is read
// through `TryReadFromPath` rather than as a serialized member: the list can be inherited from a
// fragment, under any name, and those chains nest. Walking only the manifest would therefore miss
// whole action lists in a real mod, and reporting on a mod while missing half its actions is worse
// than not reporting at all.

/** How many include hops are followed before the walk gives up, which also ends a cycle. */
const MAX_INCLUDE_DEPTH = 8;

/** One action entry, with where it is written. */
export interface ActionRecord {
    /** The file the entry is written in, absolute. */
    file: string;
    /** One-based, the line the entry's `{` sits on. */
    line: number;
    column: number;
    /** The offsets the entry spans, for matching a reported finding to it. */
    startOffset: number;
    endOffset: number;
    action: ModAction;
}

/** What collecting the actions of one manifest produced. */
export interface ActionCollection {
    records: ActionRecord[];
    /** Files this manifest pulls its actions in from, absolute. */
    includedFiles: string[];
    /** Includes that could not be followed, each with the reason, for the report. */
    unfollowed: { file: string; reference: string; reason: string }[];
    /** Entries written as a reference, which the game runs as an action and this check cannot read. */
    referenceEntries: { file: string; reference: string }[];
}

/** A node that holds members, which is what the walk steps through. */
interface WithElements {
    elements: AbstractNode[];
}

/**
 * Whether a node holds members.
 *
 * @param node the node to test.
 * @returns true for a document, a group or a list.
 */
const hasElements = (node: AbstractNode): node is AbstractNode & WithElements =>
    node.type === 'Document' || isGroupNode(node) || isListNode(node);

/**
 * Collect every action a manifest runs: its own list, and every list it pulls in.
 *
 * @param manifest the parsed manifest.
 * @param modRoot the mod folder, so an include leaving it can be named rather than followed.
 * @param cache the shared reader.
 * @returns the entries in walk order, with the files they came from.
 */
export const collectManifestActions = async (
    manifest: ParsedFile,
    modRoot: string,
    cache: DocumentCache
): Promise<ActionCollection> => {
    const records: ActionRecord[] = [];
    const includedFiles: string[] = [];
    const unfollowed: { file: string; reference: string; reason: string }[] = [];
    const referenceEntries: { file: string; reference: string }[] = [];
    const visited = new Set<string>();

    const ownList = actionsMember(manifest.document);
    for (const action of parseModActions(manifest.document)) {
        records.push(toRecord(manifest, action));
    }
    for (const reference of referenceEntriesOf(ownList)) {
        referenceEntries.push({ file: manifest.file, reference });
    }

    /**
     * Follow the includes written on one node, adding what they bring in.
     *
     * @param from the file the references are written in.
     * @param node the `Actions` member, or a list already reached through one.
     * @param depth how many hops have been taken.
     * @returns once the branch has been walked.
     */
    const follow = async (from: ParsedFile, node: AbstractNode | undefined, depth: number): Promise<void> => {
        if (!node || depth > MAX_INCLUDE_DEPTH) return;
        for (const reference of includeReferencesOf(node)) {
            const target = splitReference(reference);
            if (!target) {
                unfollowed.push({
                    file: from.file,
                    reference,
                    reason: 'it names no file, so the list it pulls in could not be found',
                });
                continue;
            }
            const file = resolve(dirname(from.file), target.file);
            if (!isInside(file, modRoot)) {
                unfollowed.push({
                    file: from.file,
                    reference,
                    reason: 'it reads a list from outside this mod folder, which this check does not follow',
                });
                continue;
            }
            const key = `${pathKey(file)}#${target.member.toLowerCase()}`;
            if (visited.has(key)) continue;
            visited.add(key);
            const parsed = await cache.get(file);
            if (!parsed) {
                unfollowed.push({ file: from.file, reference, reason: 'the file it names could not be read' });
                continue;
            }
            if (!includedFiles.some((known) => pathKey(known) === pathKey(file))) includedFiles.push(file);
            const list = memberAtPath(parsed.document, target.member);
            if (!list) {
                unfollowed.push({
                    file: from.file,
                    reference,
                    reason: 'the file it names holds no list under that path',
                });
                continue;
            }
            for (const action of actionsInList(list, parsed)) records.push(toRecord(parsed, action));
            for (const entry of referenceEntriesOf(list)) referenceEntries.push({ file: parsed.file, reference: entry });
            await follow(parsed, list, depth + 1);
        }
    };

    await follow(manifest, ownList, 0);
    return { records, includedFiles, unfollowed, referenceEntries };
};

/**
 * Every file under the mod that holds a literal `Actions` list of its own. The server validates
 * such a file on sight, so its findings are in the scan whether or not a manifest was seen to
 * include it, and the load check has to account for each of them one way or the other.
 *
 * @param files every rules file under the mod, absolute.
 * @param manifests the manifests among them, which are collected through their own walk.
 * @param cache the shared reader.
 * @returns the files that hold an action list.
 */
export const findActionFragments = async (
    files: readonly string[],
    manifests: readonly string[],
    cache: DocumentCache
): Promise<string[]> => {
    const manifestKeys = new Set(manifests.map(pathKey));
    const fragments: string[] = [];
    for (const file of files) {
        if (manifestKeys.has(pathKey(file))) continue;
        const parsed = await cache.get(file);
        // The word has to be in the file for an entry to declare `Action = …`, so this spares a
        // large mod thousands of parses it would throw away.
        if (!parsed || !/action/i.test(parsed.text)) continue;
        if (isActionFragmentDocument(parsed.document)) fragments.push(file);
    }
    return fragments;
};

/**
 * How many action entries a fragment file holds.
 *
 * A file no manifest was seen to include is named as a whole rather than judged entry by entry: the
 * game runs none of it, and one such file in the corpus carries hundreds of entries, so a line each
 * would bury everything the report has to say about the actions that do run.
 *
 * @param parsed the parsed fragment.
 * @returns the number of entries in its `Actions` list.
 */
export const countActionEntries = (parsed: ParsedFile): number => parseModActions(parsed.document).length;

/**
 * Turn one parsed action into the record the rest of the check works on.
 *
 * @param parsed the file it is written in.
 * @param action the parsed entry.
 * @returns the record.
 */
const toRecord = (parsed: ParsedFile, action: ModAction): ActionRecord => {
    const { line, column } = positionOf(parsed.lineStarts, action.group.position.start);
    return {
        file: parsed.file,
        line,
        column,
        startOffset: action.group.position.start,
        endOffset: action.group.position.end,
        action,
    };
};

/**
 * The top-level `Actions` member of a document, whatever shape it takes. The game reads it without
 * regard to case, and it may be a list, an assignment of a reference, or a list that inherits one.
 *
 * @param document the parsed file.
 * @returns the member node, or undefined when the file has none.
 */
const actionsMember = (document: AbstractNodeDocument): AbstractNode | undefined => {
    for (const [name, node] of namedMembersOf(document)) {
        if (name.toLowerCase() === 'actions') return node;
    }
    return undefined;
};

/**
 * The references a node pulls a whole action list in through: the bases it inherits, and a
 * reference written as its value. An element of the list is left out on purpose. The game
 * dereferences such an element into one action rather than into a list, so it is reported as an
 * entry this check could not read instead of being followed as an include.
 *
 * @param node the `Actions` member, or a list reached through one.
 * @returns the references as written, with their sigil left on.
 */
export const includeReferencesOf = (node: AbstractNode): string[] => {
    const references: string[] = [];
    /**
     * Keep a value node when it is written as a path.
     *
     * @param candidate the node to consider.
     */
    const take = (candidate: AbstractNode): void => {
        if (!isValueNode(candidate)) return;
        const text = String(candidate.valueType.value);
        if (text.includes('<')) references.push(text);
    };
    if (isValueNode(node)) take(node);
    if (isListNode(node) || isGroupNode(node)) {
        for (const base of node.inheritance ?? []) take(base);
    }
    return references;
};

/**
 * The entries of an action list that are written as a reference rather than as a `{}` group. The
 * game reads each of them as one action, and neither the server nor this check can say what that
 * action does without following it, so they are counted and disclosed.
 *
 * @param node the `Actions` member, or a list reached through one.
 * @returns the references as written.
 */
export const referenceEntriesOf = (node: AbstractNode | undefined): string[] => {
    if (!node || !isListNode(node)) return [];
    return node.elements
        .filter(isValueNode)
        .map((element) => String(element.valueType.value))
        .filter((text) => text.includes('<'));
};

/**
 * Split a reference into the file it names and the path inside that file.
 *
 * @param reference the reference as written.
 * @returns the two halves, or undefined when the reference names no file.
 */
export const splitReference = (reference: string): { file: string; member: string } | undefined => {
    const match = /^&?\s*<([^>]+)>\s*(?:\/(.*))?$/.exec(reference.trim());
    if (!match) return undefined;
    const file = match[1].trim();
    // A path starting at the game folder or at a drive is not this mod's file to read.
    if (file === '' || file.startsWith('/') || file.startsWith('./') || /^[a-zA-Z]:/.test(file)) return undefined;
    return { file, member: (match[2] ?? '').trim() };
};

/**
 * Walk a path of plain member names to the list it names.
 *
 * @param document the file to walk.
 * @param memberPath the path after the file part, which may be empty.
 * @returns the list, or undefined when the path names something else or cannot be walked.
 */
const memberAtPath = (document: AbstractNodeDocument, memberPath: string): ListNode | undefined => {
    let current: AbstractNode = document;
    const segments = memberPath === '' ? [] : memberPath.split('/').map((segment) => segment.trim());
    for (const segment of segments) {
        if (!hasElements(current)) return undefined;
        const next = namedMembersOf(current).find(([name]) => name.toLowerCase() === segment.toLowerCase());
        if (!next) return undefined;
        current = next[1];
    }
    return isListNode(current) ? current : undefined;
};

/**
 * The action entries of a list that is not called `Actions`.
 *
 * The parser reads action entries out of a document's own `Actions` list, which is the shape a
 * manifest and a fragment both take. A list reached through an include may carry any name, since
 * the game reads the manifest's member and never the fragment's, so the list is handed over under
 * the name the parser looks for. The entries themselves are the original nodes, so their positions
 * and their file are unchanged.
 *
 * @param list the list holding the entries.
 * @param parsed the file it lives in.
 * @returns the parsed entries.
 */
const actionsInList = (list: ListNode, parsed: ParsedFile): ModAction[] => {
    const renamed: ListNode = {
        ...list,
        identifier: list.identifier
            ? { ...list.identifier, name: 'Actions' }
            : { type: 'Identifier', name: 'Actions', position: list.position },
    };
    const document: AbstractNodeDocument = {
        type: 'Document',
        elements: [renamed],
        uri: parsed.document.uri,
        position: parsed.document.position,
    };
    return parseModActions(document);
};
