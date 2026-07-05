import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CancellationToken, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isGroupNode, GroupNode } from '../../core/ast/ast';
import { parseText } from '../../utils/ast.utils';
import { safeReaddir } from '../../utils/fs.utils';
import { filePathToUri } from '../navigation/navigation-strategy';
import { findModRoot } from '../../mod/mod-root';
import { resolveStringsFolders, isUnderFolder } from '../../mod/strings-folder';

/** The mod's own language strings files (absolute paths): every `.rules` under its strings folders. */
const modStringsFiles = async (documentUri: string, cancellationToken: CancellationToken): Promise<string[]> => {
    const modRoot = findModRoot(documentUri);
    if (!modRoot) return [];
    // The folders declared/conventional for the editing mod (exclude the base game's).
    const declared = (await resolveStringsFolders(documentUri, cancellationToken).catch(() => [])).filter((folder) =>
        isUnderFolder(folder, modRoot)
    );
    const conventional = join(modRoot, 'strings');
    const folders = [...new Set([...declared, ...(existsSync(conventional) ? [conventional] : [])])];

    const files = new Set<string>();
    for (const folder of folders) {
        for (const name of safeReaddir(folder)) {
            if (name.toLowerCase().endsWith('.rules')) files.add(join(folder, name));
        }
    }
    return [...files];
};

/** The tab-depth at which a container's direct children are written (document root = 0). */
const childIndentOf = (container: AbstractNode | AbstractNodeDocument): number => {
    let depth = 0;
    let node: AbstractNode | undefined = container as AbstractNode;
    while (node) {
        if (isGroupNode(node)) depth++;
        node = node.parent;
    }
    return depth;
};

/** The direct child group of `container` named `name`, if any. */
const childGroup = (container: { elements: AbstractNode[] }, name: string): GroupNode | undefined => {
    for (const element of container.elements) {
        if (isGroupNode(element) && element.identifier?.name === name) return element;
    }
    return undefined;
};

/** Whether `container` already declares a member (group or leaf) named `name`. */
const hasMember = (container: { elements: AbstractNode[] }, name: string): boolean =>
    container.elements.some(
        (element) =>
            (isGroupNode(element) && element.identifier?.name === name) ||
            (element.type === 'Assignment' && (element as { left?: { name?: string } }).left?.name === name)
    );

const tabs = (n: number): string => '\t'.repeat(n);

/** Nested-group text creating `groups` (outer→inner) around a `leaf = ""`, indented from `indent`. */
const buildNested = (groups: string[], leaf: string, indent: number): string => {
    if (groups.length === 0) return `${tabs(indent)}${leaf} = ""`;
    const [head, ...rest] = groups;
    return `${tabs(indent)}${head}\n${tabs(indent)}{\n${buildNested(rest, leaf, indent + 1)}\n${tabs(indent)}}`;
};

/** Convert a byte offset into an LSP {line, character} position within `text`. */
const offsetToPosition = (text: string, offset: number): { line: number; character: number } => {
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < offset; i++) {
        if (text[i] === '\n') {
            line++;
            lineStart = i + 1;
        }
    }
    return { line, character: offset - lineStart };
};

/**
 * The single {@link TextEdit} that inserts the key path `key` into the already-parsed strings file
 * `document` (with source `text`): it walks to the deepest existing group along the path, then adds
 * the missing group chain plus a `Leaf = ""` placeholder. Returns null when the file already declares
 * the key (nothing to add) or its structure can't be edited safely.
 */
export const insertEditForFile = (document: AbstractNodeDocument, text: string, key: string): TextEdit | null => {
    const segments = key.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return null;
    const leaf = segments[segments.length - 1];
    const groups = segments.slice(0, -1);

    // Descend as far as existing groups match the path.
    let container: AbstractNodeDocument | GroupNode = document;
    let matched = 0;
    for (; matched < groups.length; matched++) {
        const next = childGroup(container, groups[matched]);
        if (!next) break;
        container = next;
    }
    const remaining = groups.slice(matched);
    // If the whole path already exists down to the leaf, there is nothing to insert.
    if (remaining.length === 0 && hasMember(container, leaf)) return null;

    if (isGroupNode(container)) {
        // Insert on its own line just before the group's closing `}` (its position ends right after it).
        const brace = container.position.end - 1;
        if (text[brace] !== '}') return null;
        const content = `${buildNested(remaining, leaf, childIndentOf(container))}\n`;
        const pos = offsetToPosition(text, brace);
        return { range: { start: pos, end: pos }, newText: content };
    }
    // Document root: append at end of file.
    const offset = text.length;
    const lead = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
    const pos = offsetToPosition(text, offset);
    return { range: { start: pos, end: pos }, newText: `${lead}${buildNested(remaining, leaf, 0)}\n` };
};

/**
 * A {@link WorkspaceEdit} inserting the missing localization key `key` into every language strings
 * file of the mod that owns `documentUri` (each gets a `Leaf = ""` placeholder to translate). Returns
 * null when the document is not in a mod or the mod has no strings files to insert into.
 *
 * @param documentUri the file the diagnostic fired in (used to locate the owning mod).
 * @param key the missing localization key path (`Parts/Foo`).
 * @param cancellationToken cancellation for the folder resolution.
 * @returns the cross-file edit, or null when there is nowhere to insert.
 */
export const buildInsertLocalizationKeyEdit = async (
    documentUri: string,
    key: string,
    cancellationToken: CancellationToken
): Promise<WorkspaceEdit | null> => {
    const files = await modStringsFiles(documentUri, cancellationToken);
    if (files.length === 0) return null;

    const changes: Record<string, TextEdit[]> = {};
    for (const file of files) {
        const text = await readFile(file, 'utf-8').catch(() => null);
        if (text === null) continue;
        const document = parseText(text, file);
        const edit = insertEditForFile(document, text, key);
        if (edit) changes[filePathToUri(file)] = [edit];
    }
    return Object.keys(changes).length > 0 ? { changes } : null;
};
