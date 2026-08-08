import { readFile, stat } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode, isValueNode } from '../../../core/ast/ast';
import { parseText } from '../../../utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../../workspace/cosmoteer-workspace.service';
import { foldPathCase, onFsInvalidation } from '../../../workspace/fs-cache';
import { topLevelMembersOf } from './member-record';
import { BaseLocation } from './plan.types';

/** An existing base file a plan can move fields into, resolved against what it says right now. */
export interface BaseTarget extends BaseLocation {
    /** Byte offset the moved members are inserted at, just past the container's last member. */
    insertOffset: number;
    /** The indentation the container's own members carry, which the moved ones are given. */
    indent: string;
    /** True when the container has no member yet, so the insert opens the first line itself. */
    empty: boolean;
    /** The member keys the container already declares, none of which a plan may move onto it. */
    declaredKeys: Set<string>;
}

/**
 * A `<./Data/…>` path is read from the game's own data root rather than from the declaring file, so
 * it is resolved against the install instead.
 *
 * @param path the reference path as written.
 * @param declaringDir the directory of the file the reference is written in.
 * @returns the absolute path, or undefined when the game root is not known yet.
 */
export const resolveBasePath = (path: string, declaringDir: string): string | undefined => {
    const trimmed = path.trim();
    if (!/^\.[\\/]/.test(trimmed)) return resolve(declaringDir, trimmed);
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return undefined;
    // The path spells the data folder itself (`./Data/ships/…`), which is the root that was scanned.
    const withoutPrefix = trimmed.replace(/^\.[\\/]/, '').replace(/^data[\\/]/i, '');
    return join(dataRoot, withoutPrefix);
};

/**
 * The group a base reference names inside a file, found by walking the reference's own path segments.
 * Matching folds case, the way the game itself matches member names.
 *
 * @param document the parsed base file.
 * @param groupPath the segment names, outermost first.
 * @returns the group, or undefined when the file does not hold it.
 */
export const groupAtPath = (
    document: AbstractNodeDocument,
    groupPath: readonly string[]
): GroupNode | undefined => {
    if (groupPath.length === 0) return undefined;
    let elements: readonly AbstractNode[] = document.elements;
    let found: GroupNode | undefined;
    for (const segment of groupPath) {
        found = elements.find(
            (element): element is GroupNode =>
                isGroupNode(element) && element.identifier?.name.toLowerCase() === segment.toLowerCase()
        );
        if (!found) return undefined;
        elements = found.elements;
    }
    return found;
};

/**
 * The parsed source of a rules file, memoized by path for as long as the filesystem caches stand.
 *
 * Separate from the shared parse cache because the text itself is needed, not only the tree: a base
 * file's members are moved and compared as source, and the tree cannot spell them back out. Base
 * files are few and small, so the cap is about entries rather than memory. Unsaved edits to a base
 * file are not seen until it is saved, the same as for the sibling files the duplication scan reads.
 */
const fileCache = new Map<string, { size: number; mtimeMs: number; text: string; document: AbstractNodeDocument }>();

/** Resolved targets, memoized alongside the files they were read out of. */
const targetCache = new Map<string, BaseTarget | undefined>();

/** How many files the reader keeps, comfortably more base files than a mod has. */
const MAX_FILE_ENTRIES = 512;

onFsInvalidation(() => {
    fileCache.clear();
    targetCache.clear();
});

/** Drop every memoized base file, so a test or a settings change starts from a clean slate. */
export const clearBaseFileCache = (): void => {
    fileCache.clear();
    targetCache.clear();
};

/**
 * Read and parse a rules file, keeping its source text alongside the tree.
 *
 * @param fsPath the file to read.
 * @returns the text and the parsed document, or undefined when the file cannot be read or parsed.
 */
export const readRulesFile = async (
    fsPath: string
): Promise<{ text: string; document: AbstractNodeDocument } | undefined> => {
    const key = foldPathCase(fsPath);
    try {
        const stats = await stat(fsPath);
        const cached = fileCache.get(key);
        if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached;
        const text = await readFile(fsPath, { encoding: 'utf-8' });
        const entry = { size: stats.size, mtimeMs: stats.mtimeMs, text, document: parseText(text, fsPath) };
        if (fileCache.size >= MAX_FILE_ENTRIES) fileCache.clear();
        fileCache.set(key, entry);
        return entry;
    } catch {
        return undefined;
    }
};

/**
 * Everything the plan builder needs about a base file that already exists: where new members go, how
 * they are indented, and what it already declares.
 *
 * @param location the file and group path the base was reached by.
 * @returns the target, or undefined when the file cannot be read or no longer holds that group.
 */
export const resolveBaseTarget = async (location: BaseLocation): Promise<BaseTarget | undefined> => {
    const key = `${foldPathCase(location.fsPath)}|${location.groupPath.join('/').toLowerCase()}`;
    if (targetCache.has(key)) return targetCache.get(key);
    const target = await buildBaseTarget(location);
    if (targetCache.size >= MAX_FILE_ENTRIES) targetCache.clear();
    targetCache.set(key, target);
    return target;
};

/** The uncached half of {@link resolveBaseTarget}. */
const buildBaseTarget = async (location: BaseLocation): Promise<BaseTarget | undefined> => {
    const file = await readRulesFile(location.fsPath);
    return file ? baseTargetFrom(location, file.text, file.document) : undefined;
};

/**
 * Resolve a base target against source text the caller already has, so an insertion offset is never
 * taken from a copy of the file the editor has since moved past.
 *
 * @param location the file and group path the base was reached by.
 * @param text the file's source text.
 * @param document that text, parsed.
 * @returns the target, or undefined when the text no longer holds that group.
 */
export const baseTargetFrom = (
    location: BaseLocation,
    text: string,
    document: AbstractNodeDocument
): BaseTarget | undefined => {
    const container = groupAtPath(document, location.groupPath);
    if (!container?.identifier) return undefined;
    // An unclosed group leaves its end at zero, and inserting into it would put the members outside
    // the braces the author meant them to be in.
    if (container.position.end <= container.position.start) return undefined;
    const members = topLevelMembersOf(container, text);
    const last = members[members.length - 1];
    const ownIndent = indentOfLineAt(text, container.identifier.position.start);
    return {
        fsPath: location.fsPath,
        groupPath: [...location.groupPath],
        insertOffset: last ? last.end : container.position.start + 1,
        indent: last ? last.indent : `${ownIndent}\t`,
        empty: members.length === 0,
        declaredKeys: new Set(members.map((member) => member.key)),
    };
};

/** The whitespace the line holding an offset begins with. */
const indentOfLineAt = (text: string, offset: number): string => {
    let start = offset;
    while (start > 0 && text[start - 1] !== '\n') start--;
    let end = start;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    return text.slice(start, end);
};

/**
 * Every base a file's groups inherit from another file, one entry per inheritance reference so the
 * entries can be counted, plus where each distinct one lives.
 *
 * Every named container is walked, at any depth and whether or not it could ever take part in an
 * extraction. The count is what proves that moving a field into an existing base file gives it to
 * nobody new, so a container the extraction itself would refuse still has to be counted here.
 *
 * @param document the parsed file.
 * @param declaringDir the directory the file lives in.
 * @param identityOf the identity function inheritance references are compared by.
 * @returns the identities in document order, and how to reach each distinct one.
 */
export const collectBaseUses = (
    document: AbstractNodeDocument,
    declaringDir: string,
    identityOf: (reference: string, declaringDir: string) => string | undefined
): { identities: string[]; locations: Map<string, BaseLocation> } => {
    const identities: string[] = [];
    const locations = new Map<string, BaseLocation>();
    const visit = (node: AbstractNode): void => {
        if (!isGroupNode(node) && !isListNode(node)) return;
        for (const base of node.inheritance ?? []) {
            if (!isValueNode(base) || base.valueType.type !== 'Reference') continue;
            const reference = String(base.valueType.value);
            const identity = identityOf(reference, declaringDir);
            if (!identity) continue;
            identities.push(identity);
            if (!locations.has(identity)) {
                const location = locationOf(reference, declaringDir);
                if (location) locations.set(identity, location);
            }
        }
        for (const element of node.elements) visit(element);
    };
    for (const element of document.elements) visit(element);
    return { identities, locations };
};

/**
 * Where an inheritance reference points, in the spelling needed to read the file again.
 *
 * @param reference the reference's text.
 * @param declaringDir the directory of the file it is written in.
 * @returns the file and the group path inside it, or undefined when it names no group of a file.
 */
export const locationOf = (reference: string, declaringDir: string): BaseLocation | undefined => {
    const match = /^\s*&?\s*<([^<>]+)>(.*)$/.exec(reference);
    if (!match) return undefined;
    const groupPath = match[2].split('/').map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    if (groupPath.length === 0) return undefined;
    const fsPath = resolveBasePath(match[1], declaringDir);
    return fsPath ? { fsPath: fsPath.replace(/\\/g, '/'), groupPath } : undefined;
};

/** The directory of a file, with forward slashes on every platform. */
export const dirOf = (fsPath: string): string => dirname(fsPath).replace(/\\/g, '/');
