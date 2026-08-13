import { readFile } from 'fs/promises';
import { join } from 'path';
import { Position, TextEdit } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isListNode, isValueNode } from '../core/ast/ast';
import { isManifestBasename } from '../document/document-kind';
import { filePathToUri } from '../features/navigation/navigation-strategy';
import { workshopModOf } from '../features/mod-schema/workshop-link';
import { parseText } from '../utils/ast.utils';
import { safeReaddir } from '../utils/fs.utils';

/**
 * What a mod says it needs from other mods, read from its manifest.
 *
 * The game itself reads no such field, so this is a statement of intent between the author and the
 * editor rather than something the loader enforces. It exists because an id that only an installed
 * mod declares resolves silently on the author's machine and names nothing for anybody else, and
 * without a place to write the dependency down there is no way to tell that apart from a mistake.
 * The `Dependencies` spelling follows what the workshop corpus already writes.
 */

/** The manifest members read as dependency declarations, required and optional. */
const DEPENDENCY_FIELDS = ['Dependencies', 'OptionalDependencies'] as const;

/** How a mod can be named: its published file id, its manifest id, and its display name. */
export interface ModIdentity {
    readonly root: string;
    readonly publishedFileId?: string;
    readonly manifestId?: string;
    readonly name?: string;
}

/** Every manifest of a mod root: `mod.rules` plus the `mod_*.rules` version variants. */
export const manifestPathsIn = (modRoot: string): string[] =>
    safeReaddir(modRoot)
        .filter((name) => isManifestBasename(name))
        .map((name) => join(modRoot, name));

/** A top-level scalar member's text, unquoted. Names match ignoring case, the way the game binds them. */
const scalarMember = (document: AbstractNodeDocument, name: string): string | undefined => {
    for (const element of document.elements) {
        if (!isAssignmentNode(element) || element.left.name.toLowerCase() !== name.toLowerCase()) continue;
        if (element.right && isValueNode(element.right)) {
            return String(element.right.valueType.value).replace(/^"|"$/g, '');
        }
    }
    return undefined;
};

/** A top-level list member, in either the `X = [ … ]` or the `X [ … ]` spelling. */
const listMember = (document: AbstractNodeDocument, name: string): AbstractNode | undefined => {
    for (const element of document.elements) {
        if (isListNode(element) && element.identifier?.name.toLowerCase() === name.toLowerCase()) return element;
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === name.toLowerCase()) {
            if (element.right && isListNode(element.right)) return element.right;
        }
    }
    return undefined;
};

/** The written entries of a list member, unquoted. */
const listEntries = (document: AbstractNodeDocument, name: string): string[] => {
    const list = listMember(document, name);
    if (!list || !isListNode(list)) return [];
    return list.elements
        .filter(isValueNode)
        .map((value) => String(value.valueType.value).replace(/^"|"$/g, '').trim())
        .filter((text) => text.length > 0);
};

/** Parses one manifest, or null when it cannot be read. */
const readManifest = async (path: string): Promise<AbstractNodeDocument | null> => {
    try {
        return parseText(await readFile(path, 'utf8'), path);
    } catch {
        return null;
    }
};

/**
 * How a mod may be referred to in somebody else's dependency list.
 *
 * @param root the mod's root folder.
 * @returns its published file id (when it is an installed workshop mod), manifest id and name.
 */
export const identityOfMod = async (root: string): Promise<ModIdentity> => {
    const workshop = workshopModOf(root);
    for (const path of manifestPathsIn(root)) {
        const manifest = await readManifest(path);
        if (!manifest) continue;
        const manifestId = scalarMember(manifest, 'ID');
        const name = scalarMember(manifest, 'Name');
        if (manifestId || name) return { root, publishedFileId: workshop?.id, manifestId, name };
    }
    return { root, publishedFileId: workshop?.id };
};

/**
 * Every dependency a mod declares, folded to lower case for matching. Variant manifests are read as
 * a union, since which one the game picks depends on the version it was launched at.
 *
 * @param modRoot the declaring mod's root folder.
 * @returns the declared tokens, required and optional alike.
 */
export const declaredDependenciesOf = async (modRoot: string): Promise<Set<string>> => {
    const declared = new Set<string>();
    for (const path of manifestPathsIn(modRoot)) {
        const manifest = await readManifest(path);
        if (!manifest) continue;
        for (const field of DEPENDENCY_FIELDS) {
            for (const entry of listEntries(manifest, field)) declared.add(entry.toLowerCase());
        }
    }
    return declared;
};

/**
 * Whether a declared dependency list names a mod. Both spellings count, its published file id and
 * its manifest id, matched ignoring case, since an author types the id by hand.
 *
 * @param declared the lower-cased declared tokens.
 * @param identity the mod to look for.
 * @returns true when the list names it.
 */
export const isDeclaredDependency = (declared: ReadonlySet<string>, identity: ModIdentity): boolean =>
    (identity.publishedFileId !== undefined && declared.has(identity.publishedFileId.toLowerCase())) ||
    (identity.manifestId !== undefined && declared.has(identity.manifestId.toLowerCase()));

/** How a mod is written into a dependency list: its published file id, else its manifest id. */
export const dependencyTokenOf = (identity: ModIdentity): string | undefined =>
    identity.publishedFileId ?? identity.manifestId;

/** The manifest a dependency is written into: plain `mod.rules` when there is one, else the first. */
const primaryManifestOf = (modRoot: string): string | undefined => {
    const paths = manifestPathsIn(modRoot);
    return paths.find((path) => path.toLowerCase().endsWith('mod.rules')) ?? paths[0];
};

/** The line a top-level member starts on, taken from its identifier when it has one. */
const startLineOf = (element: AbstractNode): number =>
    (isListNode(element) && element.identifier ? element.identifier.position.line : element.position.line);

/**
 * The edit adding one dependency to a mod's manifest: appended to the existing `Dependencies` list,
 * or written as a new member above the actions when the manifest has no such list yet.
 *
 * @param modRoot the mod whose manifest is edited.
 * @param token the id to add, its published file id or its manifest id.
 * @returns the manifest's uri and the single edit, or null when there is nothing to edit safely.
 */
export const addDependencyEdit = async (
    modRoot: string,
    token: string
): Promise<{ readonly uri: string; readonly edit: TextEdit } | null> => {
    const path = primaryManifestOf(modRoot);
    if (!path) return null;
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text === null) return null;
    let manifest: AbstractNodeDocument;
    try {
        manifest = parseText(text, path);
    } catch {
        return null;
    }
    const uri = filePathToUri(path);
    const quoted = `"${token}"`;

    const list = listMember(manifest, 'Dependencies');
    if (list && isListNode(list)) {
        const last = list.elements[list.elements.length - 1];
        if (last) {
            const at = Position.create(last.position.line, last.position.characterEnd);
            return { uri, edit: { range: { start: at, end: at }, newText: `, ${quoted}` } };
        }
        // An empty list: write the first entry just inside its opening bracket.
        const at = Position.create(list.position.line, list.position.characterStart + 1);
        return { uri, edit: { range: { start: at, end: at }, newText: quoted } };
    }

    // No list yet. Put it above the actions, where the manifest's own header fields are, rather
    // than after them, so the author sees it next to `ID` and `Name`.
    const actions = manifest.elements.find(
        (element) => isListNode(element) && element.identifier?.name.toLowerCase() === 'actions'
    );
    if (actions) {
        const at = Position.create(startLineOf(actions), 0);
        return { uri, edit: { range: { start: at, end: at }, newText: `Dependencies = [${quoted}]\n\n` } };
    }
    const lines = text.split('\n');
    const at = Position.create(lines.length - 1, lines[lines.length - 1].length);
    const lead = text.endsWith('\n') ? '' : '\n';
    return { uri, edit: { range: { start: at, end: at }, newText: `${lead}Dependencies = [${quoted}]\n` } };
};
