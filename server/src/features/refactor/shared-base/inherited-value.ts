import { dirname } from 'path';
import { isValueNode } from '../../../core/ast/ast';
import { foldPathCase, onFsInvalidation } from '../../../workspace/fs-cache';
import { groupAtPath, locationOf, readRulesFile } from './base-index';
import { topLevelMembersOf } from './member-record';
import { BaseLocation } from './plan.types';

/** One member a base supplies to everything that inherits it. */
export interface InheritedMember {
    /** The member's exact source in the file that declares it. */
    raw: string;
    /** That file's directory, which the paths inside the member resolve against. */
    declaringDir: string;
    /** That file's path, so a hint can name what the value is being inherited from. */
    fsPath: string;
}

/** What one group declares directly, and what it inherits in turn. */
interface GroupFacts {
    members: Map<string, InheritedMember>;
    /** Names the group declares more than once, which no single value can be attributed to. */
    ambiguous: Set<string>;
    /** The group's own inheritance references, in the order the game resolves them. */
    bases: string[];
    declaringDir: string;
}

/**
 * How far up an inheritance chain the search walks. Every real chain in the game's data and its mods
 * is a handful of links deep, and the bound is what keeps a malformed one from being followed
 * forever even before the cycle guard catches it.
 */
const MAX_CHAIN_DEPTH = 12;

/** How many base groups are remembered, comfortably more than a mod inherits from. */
const MAX_GROUP_ENTRIES = 4000;

/** Facts per base group, memoized because a whole family of files asks about the same one. */
const factsCache = new Map<string, GroupFacts | undefined>();

onFsInvalidation(() => factsCache.clear());

/** Drop every memoized base group, so a test starts from a clean slate. */
export const clearInheritedValueCache = (): void => factsCache.clear();

/** The cache key of a group inside a file, folded the way the game matches both. */
const keyOf = (location: BaseLocation): string =>
    `${foldPathCase(location.fsPath)}|${location.groupPath.join('/').toLowerCase()}`;

/** The uncached half of {@link declaredFactsOf}. */
const buildGroupFacts = async (location: BaseLocation): Promise<GroupFacts | undefined> => {
    const file = await readRulesFile(location.fsPath);
    if (!file) return undefined;
    const group = groupAtPath(file.document, location.groupPath);
    if (!group) return undefined;
    const declaringDir = dirname(location.fsPath).replace(/\\/g, '/');
    const members = new Map<string, InheritedMember>();
    const ambiguous = new Set<string>();
    for (const member of topLevelMembersOf(group, file.text)) {
        if (members.has(member.key)) {
            ambiguous.add(member.key);
            continue;
        }
        members.set(member.key, { raw: member.raw, declaringDir, fsPath: location.fsPath });
    }
    const bases: string[] = [];
    for (const base of group.inheritance ?? []) {
        // A base written in a form that is not a plain reference could supply anything, so the whole
        // group is treated as unreadable rather than as one that inherits less than it does.
        if (!isValueNode(base) || base.valueType.type !== 'Reference') return undefined;
        bases.push(String(base.valueType.value));
    }
    return { members, ambiguous, bases, declaringDir };
};

/**
 * What a base group declares, read from disk. An unsaved edit to a base file is not seen until it is
 * saved, the same as for every other cross-file read the duplication analysis makes.
 *
 * @param location the file and group path to read.
 * @returns the group's facts, or undefined when it cannot be read or understood.
 */
const declaredFactsOf = async (location: BaseLocation): Promise<GroupFacts | undefined> => {
    const key = keyOf(location);
    if (factsCache.has(key)) return factsCache.get(key);
    const facts = await buildGroupFacts(location);
    if (factsCache.size >= MAX_GROUP_ENTRIES) factsCache.clear();
    factsCache.set(key, facts);
    return facts;
};

/**
 * The value each of a set of names resolves to through a container's inheritance, or undefined when
 * that cannot be established.
 *
 * Every uncertainty answers undefined rather than a partial map, because the caller uses the answer
 * to decide that writing a value again is pointless: a base that cannot be read, an inheritance form
 * that cannot be followed, or a chain that loops all mean the inherited value is unknown, and a
 * guess there would delete a line that was doing something. An earlier base wins over a later one,
 * and a group's own declaration wins over anything it inherits, which is the order the game resolves
 * them in.
 *
 * @param references the container's inheritance references, in the order they are written.
 * @param declaringDir the directory of the file the container is written in.
 * @param wanted the member names to resolve, folded to lower case.
 * @returns the inherited value of each name that is inherited at all, or undefined when the chain
 * could not be followed.
 */
export const inheritedMembersOf = async (
    references: readonly string[],
    declaringDir: string,
    wanted: ReadonlySet<string>
): Promise<Map<string, InheritedMember> | undefined> => {
    const found = new Map<string, InheritedMember>();
    const missing = new Set(wanted);
    const visited = new Set<string>();
    const walk = async (refs: readonly string[], dir: string, depth: number): Promise<boolean> => {
        if (missing.size === 0) return true;
        if (depth > MAX_CHAIN_DEPTH) return false;
        for (const reference of refs) {
            const location = locationOf(reference, dir);
            if (!location) return false;
            // A base reached twice means the chain loops or rejoins itself. Skipping the second visit
            // would let a later base answer for a name the rejoined branch really supplies, so the
            // whole question is abandoned instead.
            const key = keyOf(location);
            if (visited.has(key)) return false;
            visited.add(key);
            const facts = await declaredFactsOf(location);
            if (!facts) return false;
            for (const name of [...missing]) {
                if (facts.ambiguous.has(name)) {
                    // Declared twice in the base: no single value to compare against, so the name is
                    // dropped from the search rather than answered.
                    missing.delete(name);
                    continue;
                }
                const member = facts.members.get(name);
                if (!member) continue;
                found.set(name, member);
                missing.delete(name);
            }
            if (!(await walk(facts.bases, facts.declaringDir, depth + 1))) return false;
            if (missing.size === 0) return true;
        }
        return true;
    };
    return (await walk(references, declaringDir, 0)) ? found : undefined;
};
