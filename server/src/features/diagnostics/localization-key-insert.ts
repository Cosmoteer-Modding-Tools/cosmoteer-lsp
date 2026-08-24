import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { CancellationToken, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isGroupNode, GroupNode } from '../../core/ast/ast';
import { parseText } from '../../utils/ast.utils';
import { safeReaddir } from '../../utils/fs.utils';
import { offsetToPosition } from '../../utils/text.utils';
import { filePathToUri } from '../navigation/navigation-strategy';
import { findModRoot } from '../../mod/mod-root';
import { isEnglish, languageOf, LocalizationKeyIndex } from '../completion/localization-key.index';
import { uriToFsPath } from '../navigation/workspace-files';
import { resolveStringsFolders, isUnderFolder } from '../../mod/strings-folder';

/**
 * The mod's own language strings files (absolute paths): every `.rules` under its strings folders.
 * The base game's folders are filtered out, so nothing here can ever write into the read-only install.
 *
 * @param documentUri a file of the mod whose strings files are wanted.
 * @param cancellationToken cancellation for the folder resolution.
 * @returns the absolute file paths, empty when the file is not in a mod or the mod ships no language file.
 */
export const modStringsFiles = async (documentUri: string, cancellationToken: CancellationToken): Promise<string[]> => {
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

/** One key a batch declares, with the text that file gets for it. */
export interface LocalizationKeyInsertion {
    /** The key path to declare (`Parts/Foo`). */
    readonly key: string;
    /** The value text to write, quotes included. */
    readonly value: string;
}

/** The group chain still to be written under one container, shared by every key that walks it. */
interface InsertBranch {
    /** Group name to the branch below it, in the order the keys asked for them. */
    readonly children: Map<string, InsertBranch>;
    /** The `Leaf = value` members written directly in this group. */
    readonly leaves: Array<{ name: string; value: string }>;
}

/** A fresh, empty branch. */
const newBranch = (): InsertBranch => ({ children: new Map(), leaves: [] });

/** The branch's text, its own members first and each nested group after them, indented from `indent`. */
const renderBranch = (branch: InsertBranch, indent: number): string[] => {
    const lines: string[] = [];
    for (const leaf of branch.leaves) lines.push(`${tabs(indent)}${leaf.name} = ${leaf.value}`);
    for (const [name, child] of branch.children) {
        lines.push(`${tabs(indent)}${name}`, `${tabs(indent)}{`, ...renderBranch(child, indent + 1), `${tabs(indent)}}`);
    }
    return lines;
};

/**
 * The single {@link TextEdit} that inserts the key path `key` into the already-parsed strings file
 * `document` (with source `text`): it walks to the deepest existing group along the path, then adds
 * the missing group chain plus a `Leaf = value` member. Returns null when the file already declares
 * the key (nothing to add) or its structure can't be edited safely.
 *
 * @param document the parsed strings file.
 * @param text that file's source, which the insertion point is measured in.
 * @param key the key path to declare (`Parts/Foo`).
 * @param value the value text to write, quotes included. Defaults to the empty placeholder.
 * @returns the single edit, or null when there is nothing to insert.
 */
export const insertEditForFile = (
    document: AbstractNodeDocument,
    text: string,
    key: string,
    value: string = '""'
): TextEdit | null => insertEditsForFile(document, text, [{ key, value }])[0] ?? null;

/**
 * The edits that declare a whole batch of key paths in one already-parsed strings file. Each key walks
 * to the deepest existing group along its path, and the missing group chain plus a `Leaf = value`
 * member is written under it. Keys landing in the same container become one edit, and keys sharing a
 * missing group chain write that chain once, so a batch never leaves two `Parts` groups behind.
 *
 * Measuring the whole batch against a single parse is what makes it worth having: the game's own
 * strings tree is 3.2 MB over eight files, and a clone declaring three keys would otherwise read and
 * parse every one of them three times inside an interactive command.
 *
 * @param document the parsed strings file.
 * @param text that file's source, which the insertion points are measured in.
 * @param insertions the keys to declare, with the text each of them gets.
 * @returns the edits in ascending offset order, empty when the file already declares every key or its
 * structure cannot be edited safely.
 */
export const insertEditsForFile = (
    document: AbstractNodeDocument,
    text: string,
    insertions: readonly LocalizationKeyInsertion[]
): TextEdit[] => {
    const byContainer = new Map<AbstractNodeDocument | GroupNode, InsertBranch>();
    const written = new Set<string>();
    for (const insertion of insertions) {
        const segments = insertion.key.split('/').filter((segment) => segment.length > 0);
        if (segments.length === 0) continue;
        // One key path is declared once however often the batch asks for it.
        const seen = segments.join('/').toLowerCase();
        if (written.has(seen)) continue;
        written.add(seen);
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
        if (remaining.length === 0 && hasMember(container, leaf)) continue;

        let branch: InsertBranch = byContainer.get(container) ?? newBranch();
        byContainer.set(container, branch);
        for (const group of remaining) {
            const child: InsertBranch = branch.children.get(group) ?? newBranch();
            branch.children.set(group, child);
            branch = child;
        }
        if (!branch.leaves.some((existing) => existing.name === leaf)) {
            branch.leaves.push({ name: leaf, value: insertion.value });
        }
    }

    const edits: Array<{ offset: number; edit: TextEdit }> = [];
    for (const [container, branch] of byContainer) {
        if (isGroupNode(container)) {
            // Insert on its own line just before the group's closing `}` (its position ends right after it).
            const brace = container.position.end - 1;
            if (text[brace] !== '}') continue;
            const content = `${renderBranch(branch, childIndentOf(container)).join('\n')}\n`;
            const pos = offsetToPosition(text, brace);
            edits.push({ offset: brace, edit: { range: { start: pos, end: pos }, newText: content } });
            continue;
        }
        // Document root: append at end of file.
        const offset = text.length;
        const lead = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
        const pos = offsetToPosition(text, offset);
        edits.push({
            offset,
            edit: { range: { start: pos, end: pos }, newText: `${lead}${renderBranch(branch, 0).join('\n')}\n` },
        });
    }
    return edits.sort((a, b) => a.offset - b.offset).map((entry) => entry.edit);
};

/**
 * A {@link WorkspaceEdit} inserting the missing localization key `key` into every language strings
 * file of the mod that owns `documentUri` (each gets a `Leaf = ""` placeholder to translate). Returns
 * null when the document is not in a mod or the mod has no strings files to insert into.
 *
 * @param documentUri the file the diagnostic fired in (used to locate the owning mod).
 * @param key the missing localization key path (`Parts/Foo`).
 * @param cancellationToken cancellation for the folder resolution.
 * @param value the value text each file gets, quotes included. Defaults to the empty placeholder.
 * @param readOverride the unsaved text of an open file, so an edit is measured against the buffer the
 *        client will apply it to rather than against stale bytes on disk.
 * @returns the cross-file edit, or null when there is nowhere to insert.
 */
export const buildInsertLocalizationKeyEdit = async (
    documentUri: string,
    key: string,
    cancellationToken: CancellationToken,
    value: string = '""',
    readOverride?: (absPath: string) => string | undefined
): Promise<WorkspaceEdit | null> => {
    const files = await modStringsFiles(documentUri, cancellationToken);
    if (files.length === 0) return null;

    const changes: Record<string, TextEdit[]> = {};
    for (const file of files) {
        const text = readOverride?.(file) ?? (await readFile(file, 'utf-8').catch(() => undefined));
        if (text === undefined) continue;
        const document = parseText(text, file);
        const edit = insertEditForFile(document, text, key, value);
        if (edit) changes[filePathToUri(file)] = [edit];
    }
    return Object.keys(changes).length > 0 ? { changes } : null;
};

/**
 * A {@link WorkspaceEdit} that writes into one language file every key the languages beside it in
 * the same folder declare and it does not. Each inserted key gets the English text as its value, so
 * the author translates what is already there instead of hunting the sentence down. Returns null
 * when the file is not a strings file of a mod, or when nothing is missing.
 *
 * @param documentUri the strings file to fill in.
 * @param folderPaths the project folders the strings index is built from.
 * @param cancellationToken cancellation for the index build and the read.
 * @param readOverride the unsaved text of an open file, so the edit is measured against the buffer
 *        the client will apply it to rather than against stale bytes on disk.
 * @returns the edit, or null when there is nothing to write.
 */
export const buildFillLanguageKeysEdit = async (
    documentUri: string,
    folderPaths: string[],
    cancellationToken: CancellationToken,
    readOverride?: (absPath: string) => string | undefined
): Promise<WorkspaceEdit | null> => {
    if (!findModRoot(documentUri)) return null;
    const file = uriToFsPath(documentUri);
    const text = readOverride?.(file) ?? (await readFile(file, 'utf-8').catch(() => undefined));
    if (text === undefined) return null;
    const document = parseText(text, file);
    const language = languageOf(document);
    const folder = dirname(file);
    const languages = await LocalizationKeyIndex.instance.languageTextsUnder(folder, folderPaths, cancellationToken);
    const own = languages.find((entry) => entry.language === language);
    if (!own) return null;
    const english = languages.find((entry) => isEnglish(entry.language));

    const declared = new Set<string>();
    for (const key of own.texts.keys()) declared.add(key.toLowerCase());
    const insertions: LocalizationKeyInsertion[] = [];
    for (const entry of languages) {
        if (entry.language === language) continue;
        for (const [key, translated] of entry.texts) {
            if (declared.has(key.toLowerCase())) continue;
            declared.add(key.toLowerCase());
            const source = english?.texts.get(key) ?? translated;
            insertions.push({ key, value: JSON.stringify(source) });
        }
    }
    if (insertions.length === 0) return null;
    const edits = insertEditsForFile(document, text, insertions);
    return edits.length > 0 ? { changes: { [filePathToUri(file)]: edits } } : null;
};
