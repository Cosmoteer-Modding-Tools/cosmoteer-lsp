import { existsSync } from 'fs';
import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNode, isIdentifierNode, isValueNode } from '../../core/ast/ast';
import { findModRoot } from '../../mod/mod-root';
import { parseText } from '../../utils/ast.utils';
import { isUnder } from '../../utils/relative-path';
import { uriToFsPath } from '../navigation/workspace-files';
import { documentFor, lineEndingOf, openBuffers } from '../refactor/command-host';
import { memberOf } from '../refactor/new-content/registry-ids';
import { manifestActionMatches } from '../refactor/new-content/registration.emitter';
import { addManyActionText, ManifestInsert, manifestActionInsert } from '../refactor/register-part/manifest-action.emitter';
import { referenceTextsOf } from '../refactor/register-part/ship-registry';
import { editableModRootOf } from '../refactor/shared-base/shared-base.analysis-entry';

/**
 * What the content wizards share: finding the mod a command may write into, reading scalar members
 * off the game's own files, and writing the manifest actions that wire new content in.
 */

/** How one wiring of a piece of content went. */
export type WiringOutcome = 'written' | 'present' | 'noTarget' | 'manifestUnusable' | 'ambiguousManifest' | 'editRejected' | 'skipped';

/** Why a command may not write beside the file or folder it was invoked on. */
export type ModRootFailure = 'notEditable' | 'noModRoot';

/** The name a folder stands in as a file under, so the mod gate judges it as a file inside itself. */
export const FOLDER_ANCHOR = 'anchor.rules';

/**
 * The mod a file or folder belongs to, or why the command may not write beside it. A file that does
 * sit in a mod, or in the game's own tree, was refused by the gate rather than simply not found, and
 * saying which of the two happened is the whole difference between "open a mod first" and "this is
 * not yours to edit".
 *
 * @param uri the uri the client sent.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the mod root, or the refusal.
 */
export const modRootFor = (
    uri: string,
    dataRoot: string | undefined
): { readonly modRoot: string } | { readonly failure: ModRootFailure } => {
    let fsPath = uriToFsPath(uri).replace(/\\/g, '/').replace(/\/+$/, '');
    if (existsSync(fsPath) && !fsPath.toLowerCase().endsWith('.rules')) fsPath = `${fsPath}/${FOLDER_ANCHOR}`;
    const modRoot = editableModRootOf(fsPath);
    if (modRoot) return { modRoot: modRoot.replace(/\\/g, '/') };
    const refused = findModRoot(fsPath) !== null || isUnder(fsPath, dataRoot);
    return { failure: refused ? 'notEditable' : 'noModRoot' };
};

/**
 * The text of a scalar member, whatever the parser typed it as.
 *
 * @param node the parsed file or group.
 * @param name the member's name.
 * @returns the text trimmed, or undefined when the member is absent or not a scalar.
 */
export const scalarOf = (node: { elements: AbstractNode[] }, name: string): string | undefined => {
    const member = memberOf(node, name);
    if (isValueNode(member)) return String(member.valueType.value).trim();
    if (isIdentifierNode(member)) return member.name.trim();
    return undefined;
};

/**
 * The text of a bare list element, which the parser hands over as an identifier for a reference
 * and as a value for anything quoted or numeric.
 *
 * @param element the list element.
 * @returns its text, or undefined for an element that is a group or a list.
 */
export const elementTextOf = (element: AbstractNode): string | undefined => {
    if (isIdentifierNode(element)) return element.name;
    if (isValueNode(element)) return String(element.valueType.value);
    return undefined;
};

/** The `<…>` span of a reference, whatever member path follows it. */
const REFERENCE_FILE = /^\s*&?\s*<([^<>]+)>/;

/**
 * Whether the mod's manifests already add a file to a target, whatever spelling the reference uses.
 *
 * @param modRoot the mod.
 * @param target the action target.
 * @param file the file.
 * @returns true when one manifest already carries it.
 */
export const alreadyWired = async (modRoot: string, target: string, file: string): Promise<boolean> => {
    const wanted = file.replace(/\\/g, '/').toLowerCase();
    return await manifestActionMatches(modRoot, target, (source, declaringDir) =>
        referenceTextsOf(source).some((text) => {
            const match = REFERENCE_FILE.exec(text);
            return !!match && `${declaringDir}/${match[1].trim()}`.replace(/\\/g, '/').toLowerCase() === wanted;
        })
    );
};

/** One manifest action to write, and how to tell it is already there. */
export interface ManifestWiring<K extends string> {
    readonly key: K;
    /** The action target, or undefined when the game names no such list. */
    readonly target: string | undefined;
    /** The `&` reference the action adds, from the manifest's directory. */
    readonly reference: string;
    /** The file the reference names, for the already-present check. */
    readonly file: string;
    /** True when the reference names a list of entries, all of which are added, rather than one entry. */
    readonly wholeList?: boolean;
}

/** What writing the manifest needs of the server facilities. */
export interface ManifestWiringHost {
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** Hands the client the edit, which it applies as one undo step. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Tells the server which files changed on disk or in the editor. */
    filesChanged(paths: readonly string[]): void;
}

/** A manifest opened for appending actions: its buffer, its line ending and where the entries go. */
export interface OpenManifest {
    readonly fsPath: string;
    /** The open buffer or the disk content, undefined when the file cannot be read. */
    readonly document: TextDocument | undefined;
    readonly lineEnding: '\n' | '\r\n';
    /** Where an entry goes, unusable when the file cannot be read or its `Actions` cannot be appended to. */
    readonly insert: ManifestInsert;
}

/**
 * Opens a manifest for appending actions, reading the editor's buffer over disk.
 *
 * @param manifestFsPath the manifest.
 * @param host the server facilities.
 * @returns the manifest and where its next entry goes.
 */
export const openManifest = async (manifestFsPath: string, host: Pick<ManifestWiringHost, 'openDocuments'>): Promise<OpenManifest> => {
    const document = await documentFor(manifestFsPath, openBuffers(host));
    const text = document?.getText() ?? '';
    const lineEnding = lineEndingOf(text);
    const insert = document ? manifestActionInsert(text, parseText(text, manifestFsPath), lineEnding) : { kind: 'unusable' as const };
    return { fsPath: manifestFsPath, document, lineEnding, insert };
};

/**
 * Appends action entries to an opened manifest as one edit.
 *
 * @param manifest the manifest, as {@link openManifest} answered.
 * @param entries the entries' text, each without a trailing line ending.
 * @param host the server facilities.
 * @returns true when the manifest was changed, false when there was nothing to write, nowhere to
 *          write it, or the client rejected the edit.
 */
export const appendManifestActions = async (
    manifest: OpenManifest,
    entries: readonly string[],
    host: Pick<ManifestWiringHost, 'applyEdit' | 'filesChanged'>
): Promise<boolean> => {
    const { document, insert, lineEnding } = manifest;
    if (entries.length === 0 || !document || insert.kind === 'unusable') return false;
    const at = document.positionAt(insert.offset);
    const applied = await host
        .applyEdit({
            [document.uri]: [{ range: { start: at, end: at }, newText: `${insert.before}${entries.join(lineEnding)}${insert.after}` }],
        })
        .catch(() => false);
    if (applied) host.filesChanged([manifest.fsPath]);
    return applied;
};

/**
 * Writes the manifest actions that wire new content in, one `AddMany` per wiring the manifest does
 * not already carry, and records how each went in the outcomes. Presence is judged per target, so
 * two wirings naming different lists of one file are each checked on their own.
 *
 * @param manifestFsPath the manifest the actions are appended to.
 * @param modRoot the mod the manifest belongs to.
 * @param wirings the actions to write.
 * @param outcomes the per-key outcomes, updated in place.
 * @param host the server facilities.
 * @returns true when the manifest was changed.
 */
export const wireIntoManifest = async <K extends string>(
    manifestFsPath: string,
    modRoot: string,
    wirings: readonly ManifestWiring<K>[],
    outcomes: Record<K, WiringOutcome>,
    host: ManifestWiringHost
): Promise<boolean> => {
    const manifest = await openManifest(manifestFsPath, host);
    const entries: string[] = [];
    const written: K[] = [];
    for (const item of wirings) {
        if (!item.target) continue;
        if (await alreadyWired(modRoot, item.target, item.file)) {
            outcomes[item.key] = 'present';
            continue;
        }
        if (manifest.insert.kind === 'unusable') {
            outcomes[item.key] = 'manifestUnusable';
            continue;
        }
        entries.push(addManyActionText(item.target, item.reference, manifest.insert.indent, manifest.lineEnding, item.wholeList ?? false));
        outcomes[item.key] = 'written';
        written.push(item.key);
    }
    if (await appendManifestActions(manifest, entries, host)) return true;
    for (const key of written) outcomes[key] = 'editRejected';
    return false;
};
