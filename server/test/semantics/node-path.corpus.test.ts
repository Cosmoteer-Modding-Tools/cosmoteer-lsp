import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode } from '../../src/core/ast/ast';
import { memberPathOf, NodePathRefusal } from '../../src/semantics/node-path';
import { stepIntoNode } from '../../src/semantics/reference-resolver';
import { parseText } from '../../src/utils/ast.utils';
import { filePathToUri } from '../../src/features/navigation/navigation-strategy';

// The generator behind the override and clone refactorings emits a member path for a node the caret
// sits on, and a mod then ships that path as an action target. A path that lands on the wrong node
// rewrites content the author never looked at, so the property is proved against the real game tree
// rather than against fixtures: every path the builder emits resolves back to the node it was built
// from, and everything else is refused for one of the reasons the type enumerates.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const HAVE_DATA = existsSync(DATA_DIR);
const HAVE_MODS = existsSync(MODS_DIR);

/** Every `.rules` file under `root`, skipping the directories that hold no rules. */
const rulesFilesUnder = (root: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(root)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const path = join(root, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) rulesFilesUnder(path, out);
        else if (entry.toLowerCase().endsWith('.rules')) out.push(path);
    }
    return out;
};

/** Every node of a document, including the right-hand side of each assignment. */
const walk = (node: AbstractNode, out: AbstractNode[] = []): AbstractNode[] => {
    out.push(node);
    const elements = (node as { elements?: AbstractNode[] }).elements;
    if (elements) for (const element of elements) walk(element, out);
    const right = (node as { right?: AbstractNode }).right;
    if (right) walk(right, out);
    return out;
};

/**
 * Whether resolving a member path landed on the node it was built from.
 *
 * A path names a member, and resolving a member yields its value, so the path of an assignment lands
 * on the assignment's right-hand side. The one exception is a member the game folds into the value
 * above it, as in `Type = ModeToggle  Mode = X` written on one line: there the swallowed assignment
 * is itself the value, so the path lands on the assignment node rather than on its own right.
 *
 * @param node the node the path was built from.
 * @param landing what resolving the path returned.
 * @returns true when the landing is that node or that node's value.
 */
const landsOn = (node: AbstractNode, landing: AbstractNode | null): boolean =>
    landing === node || (isAssignmentNode(node) && landing === node.right);

/** What a path lands on when walked from the document root, member by member. */
const resolve = (document: AbstractNodeDocument, segments: string[]): AbstractNode | null => {
    let current: AbstractNode | null = document;
    for (const segment of segments) {
        if (!current) return null;
        current = stepIntoNode(current, segment) ?? null;
    }
    return current;
};

/** The counts one tree produces, so a regression shows up as a number rather than as a stack. */
interface Tally {
    files: number;
    emitted: number;
    landed: number;
    wrong: string[];
    refusals: Map<NodePathRefusal, number>;
}

/**
 * Build a path for every node of every file under `root` and check it resolves back.
 *
 * @param files the rules files to walk.
 * @returns the tally over those files.
 */
const tally = (files: string[]): Tally => {
    const result: Tally = { files: 0, emitted: 0, landed: 0, wrong: [], refusals: new Map() };
    for (const path of files) {
        let document: AbstractNodeDocument;
        try {
            document = parseText(readFileSync(path, 'utf8'), filePathToUri(path));
        } catch {
            continue;
        }
        result.files++;
        for (const node of walk(document)) {
            const built = memberPathOf(node);
            if (!built.segments) {
                result.refusals.set(built.refusal!, (result.refusals.get(built.refusal!) ?? 0) + 1);
                continue;
            }
            if (!built.segments.length) continue;
            result.emitted++;
            if (landsOn(node, resolve(document, built.segments))) result.landed++;
            else if (result.wrong.length < 20) result.wrong.push(`${path}: ${built.segments.join('/')}`);
        }
    }
    return result;
};

describe.skipIf(!HAVE_DATA)('member paths over the game data tree', () => {
    it('resolves every emitted path back to its own node', () => {
        const files = rulesFilesUnder(DATA_DIR);
        expect(files.length).toBeGreaterThan(500);
        const result = tally(files);
        console.log(
            `vanilla: ${result.files} files, ${result.emitted} paths emitted, ${result.landed} landed, ` +
                `refusals ${[...result.refusals].map(([reason, count]) => `${reason}=${count}`).join(' ')}`
        );
        expect(result.wrong).toEqual([]);
        expect(result.landed).toBe(result.emitted);
    }, 240_000);

    it('never emits an index segment or a navigation segment', () => {
        const files = rulesFilesUnder(DATA_DIR);
        const bad: string[] = [];
        for (const path of files) {
            let document: AbstractNodeDocument;
            try {
                document = parseText(readFileSync(path, 'utf8'), filePathToUri(path));
            } catch {
                continue;
            }
            for (const node of walk(document)) {
                const built = memberPathOf(node);
                if (!built.segments) continue;
                for (const segment of built.segments) {
                    if (/^\d+$/.test(segment) || ['^', '..', ':', '#'].includes(segment)) {
                        if (bad.length < 20) bad.push(`${path}: ${built.segments.join('/')}`);
                    }
                }
            }
        }
        expect(bad).toEqual([]);
    }, 240_000);
});

describe.skipIf(!HAVE_MODS)('member paths over the installed workshop mods', () => {
    it('resolves every emitted path back to its own node', () => {
        const files: string[] = [];
        for (const entry of readdirSync(MODS_DIR)) {
            const modRoot = join(MODS_DIR, entry);
            if (!statSync(modRoot).isDirectory()) continue;
            rulesFilesUnder(modRoot, files);
        }
        expect(files.length).toBeGreaterThan(1000);
        const result = tally(files);
        console.log(
            `workshop: ${result.files} files, ${result.emitted} paths emitted, ${result.landed} landed, ` +
                `refusals ${[...result.refusals].map(([reason, count]) => `${reason}=${count}`).join(' ')}`
        );
        expect(result.wrong).toEqual([]);
        expect(result.landed).toBe(result.emitted);
    }, 600_000);
});
