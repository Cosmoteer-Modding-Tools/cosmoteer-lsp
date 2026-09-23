import { dirname, extname, resolve } from 'path';
import { AbstractNode, descendants, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import type { LintFinding } from '../findings';
import { ActionRecord, splitReference } from './actions';
import { DocumentCache, isInside, pathKey } from './documents';

// The files an action's own content comes from. An action's target is a place in the game's tree,
// and its source is the content to put there, which a real mod almost always writes as a reference
// into its own folder (`ManyToAdd [ &<parts/cannon.rules>/Part … ]`). The game materialises that
// content while it applies the action, so it parses those files, and a file it refuses costs the
// whole mod. Nothing here re-parses to find that out: our parser recovers from the inputs the game
// refuses, so a second parse would answer that everything is fine. The scan's own findings on those
// files are what says otherwise.

/** How many reference hops are followed out of a payload before the walk gives up. */
const MAX_PAYLOAD_DEPTH = 8;

/** The extension of a file the game reads as object text. Anything else is content, not a tree. */
const RULES_EXTENSION = '.rules';

/** What the check found out about the content one action adds. */
export interface ActionPayload {
    /** Every file of this mod the action's content reaches, absolute, in walk order. */
    files: string[];
    /** The findings on those files that say the game refuses the whole file. */
    blockers: { file: string; finding: LintFinding }[];
    /** The files among them the scan published no result for. */
    unchecked: string[];
}

/**
 * What the payload walk needs to know about the run around the action. One instance covers one mod,
 * so the files a mod's actions share are read and walked once rather than once per action.
 */
export interface PayloadContext {
    /** The mod folder, absolute. A reference leaving it belongs to the game or to another mod. */
    modRoot: string;
    /** The shared reader, so a file pulled in twice is read once. */
    cache: DocumentCache;
    /** Where each file of this mod references on to, filled in as the walk reaches each file. */
    links: Map<string, string[]>;
    /**
     * Whether the scan checked a file.
     *
     * @param file the absolute path of the file.
     * @returns true when the server published a result for it.
     */
    checked: (file: string) => boolean;
    /**
     * The findings on one file that say the game refuses the whole file.
     *
     * @param file the absolute path of the file.
     * @returns the findings, empty when the file carries none.
     */
    blockersOn: (file: string) => readonly LintFinding[];
}

/**
 * Walk the content one action adds, and say what the scan found on the files it comes from.
 *
 * A reference out of the mod folder is not followed. Whether a file of the game's own data or of
 * another mod is there depends on what the player has installed, which the standing limits of this
 * check already say it cannot know, so following one would trade a hole for a wrong answer.
 *
 * @param record the action entry and where it is written.
 * @param context the mod folder, the reader and the scan's results.
 * @returns the files the content reaches and what the scan said about them.
 */
export const payloadOf = async (record: ActionRecord, context: PayloadContext): Promise<ActionPayload> => {
    const files: string[] = [];
    const visited = new Set<string>([pathKey(record.file)]);
    let frontier = take(referencesFrom(record.action.sources, record.file, context.modRoot), visited);
    for (let depth = 0; depth < MAX_PAYLOAD_DEPTH && frontier.length > 0; depth++) {
        files.push(...frontier);
        const next: string[] = [];
        for (const file of frontier) next.push(...take(await linksFrom(file, context), visited));
        frontier = next;
    }

    const blockers: { file: string; finding: LintFinding }[] = [];
    const unchecked: string[] = [];
    for (const file of files) {
        if (!context.checked(file)) unchecked.push(file);
        for (const finding of context.blockersOn(file)) blockers.push({ file, finding });
    }
    return { files, blockers, unchecked };
};

/**
 * The files of this mod that one file references on to, worked out once per file.
 *
 * @param file the file to read, absolute.
 * @param context the mod folder, the reader and the memo the answer is kept in.
 * @returns the files it references, absolute, empty when it could not be read.
 */
const linksFrom = async (file: string, context: PayloadContext): Promise<string[]> => {
    const key = pathKey(file);
    const known = context.links.get(key);
    if (known) return known;
    const parsed = await context.cache.get(file);
    const links = parsed ? referencesFrom([parsed.document], file, context.modRoot) : [];
    context.links.set(key, links);
    return links;
};

/**
 * The files not reached yet, marking them reached.
 *
 * @param files the files the last hop found.
 * @param visited the files already taken, added to as files are taken.
 * @returns the ones that are new, in the order they were found.
 */
const take = (files: readonly string[], visited: Set<string>): string[] => {
    const fresh: string[] = [];
    for (const file of files) {
        const key = pathKey(file);
        if (visited.has(key)) continue;
        visited.add(key);
        fresh.push(file);
    }
    return fresh;
};

/**
 * The files of this mod that a set of nodes references, first hop only.
 *
 * @param nodes the nodes to read the references out of.
 * @param from the file they are written in, which a relative reference resolves against.
 * @param modRoot the mod folder, so a reference leaving it is left alone.
 * @returns the files reached, absolute, with repeats already dropped.
 */
const referencesFrom = (nodes: readonly AbstractNode[], from: string, modRoot: string): string[] => {
    const reached = new Map<string, string>();
    for (const text of referenceTexts(nodes)) {
        const split = splitReference(text);
        if (!split) continue;
        if (extname(split.file).toLowerCase() !== RULES_EXTENSION) continue;
        const file = resolve(dirname(from), split.file);
        if (!isInside(file, modRoot)) continue;
        reached.set(pathKey(file), file);
    }
    return [...reached.values()];
};

/**
 * Every reference written under a set of nodes, values and inheritance bases alike.
 *
 * @param nodes the nodes to walk.
 * @returns the reference texts as written, with their sigil left on.
 */
const referenceTexts = (nodes: readonly AbstractNode[]): string[] => {
    const texts: string[] = [];
    /**
     * Keep a node's text when it is written as a reference.
     *
     * @param candidate the node to consider.
     */
    const take = (candidate: AbstractNode): void => {
        if (!isValueNode(candidate)) return;
        const text = String(candidate.valueType.value);
        if (text.includes('<')) texts.push(text);
    };
    for (const node of nodes) {
        for (const reached of descendants(node)) {
            take(reached);
            // `descendants` walks a container's members and an assignment's value, and leaves the
            // bases of a group or a list to the caller, so they are read here.
            if (isGroupNode(reached) || isListNode(reached)) {
                for (const base of reached.inheritance ?? []) take(base);
            }
        }
    }
    return texts;
};
