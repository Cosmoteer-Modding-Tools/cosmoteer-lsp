import { readFile } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { CancellationToken, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { AbstractNode, ValueNode, isGroupNode, isListNode, isValueNode, childNodesOf } from '../../core/ast/ast';
import { documentForPath } from '../../document/parser-result-registrar';
import { filePathToUri } from '../../document/reference-path';
import { writableChanges, writeRefusalFor } from '../../mod/write-gate';
import { cachedPathExists } from '../../workspace/fs-cache';
import { documentsMatching, uriToFsPath } from '../../workspace/workspace-files';
import { isGameRootPath, looksLikeAssetPath } from './shared-base/reference-safety';

/**
 * Keeping the references to a `.rules` file working when the file is moved or renamed.
 *
 * A `<…>` reference names a file by a path written against the folder of the file writing it, so
 * moving either end breaks it. Nothing in the editor noticed: the rename went through, and the
 * broken references showed up later as unresolved-reference reports in files nobody had touched.
 * This rewrites each of them as the editor performs the rename, which is the moment the two paths
 * are both known.
 *
 * A moved file's sprites and sounds are measured from its folder the same way, so they are
 * re-expressed with its references. Only a path that names a file sitting there today is touched,
 * which is what keeps a string that merely carries a media extension out of the rewrite.
 *
 * Four rules keep it to that job, because the editor applies what this answers without asking:
 *
 * - Only a reference that really resolves to a moved file is rewritten. A file that is itself
 *   landing in another folder is the one exception, since every path it writes is measured from the
 *   folder it sits in, so all of them have to be re-expressed or they name something else.
 * - A reference is read out of the file's own text, at the offset the value begins, so a value
 *   carrying `<…>` runs that are not file references (text markup is written that way) is not
 *   mistaken for one, and the edit covers exactly the characters it replaces.
 * - Every edit is addressed to the file's path as it stands now, the moved file's own edits
 *   included. The editor applies what a rename participant answers before it performs the rename,
 *   so an edit addressed to a path that does not exist yet is not merely dropped: the one
 *   unreadable file takes the whole answer with it and nothing at all is repaired.
 * - A file the write gate refuses, the game's own install and somebody else's installed mod, is
 *   swept for mentions but never written to, at either end of the move.
 */

/** A file the editor is about to move, with where it is going. */
export interface FileRename {
    readonly oldPath: string;
    readonly newPath: string;
}

/**
 * The `<…>` run of a value written as a file reference: at the very start of the value, after the
 * sigils and the quote a reference may carry. Anything further along the value is prose or markup,
 * which the game reads as text and this must not touch.
 */
const REFERENCE_AT_VALUE_START = /^["'&^~:]*<([^<>\r\n"]+)>/;

/** A path in canonical compare form: forward slashes, lowercased. */
const canonical = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

/** The file name of a path, without its extension. */
const stemOf = (path: string): string => (canonical(path).split('/').pop() ?? '').replace(/\.rules$/, '');

/** Where a file reference is written: the `<…>` run's offsets, and the path inside it. */
interface ReferenceSite {
    /** The path as written, angle brackets excluded, padding included. */
    readonly inner: string;
    /** The offset of the `<`. */
    readonly start: number;
    /** The offset just past the `>`. */
    readonly end: number;
}

/**
 * The file reference a value begins with, read out of the file's own text.
 *
 * The text is what the author wrote, while the value the parser carries has already been normalized
 * (runs of whitespace between tokens are gone), so a replacement built from the parsed value would
 * not line up with the characters it replaces. Reading the run out of the text keeps the two ends of
 * the edit measured in the same string.
 *
 * @param text the file's text.
 * @param offset the offset the value begins at.
 * @returns the site, or undefined when no file reference begins there.
 */
const referenceSiteAt = (text: string, offset: number): ReferenceSite | undefined => {
    if (offset < 0 || offset >= text.length) return undefined;
    const lineBreak = text.indexOf('\n', offset);
    const line = text.slice(offset, lineBreak < 0 ? text.length : lineBreak);
    const match = REFERENCE_AT_VALUE_START.exec(line);
    if (!match) return undefined;
    const open = match[0].indexOf('<');
    return { inner: match[1], start: offset + open, end: offset + match[0].length };
};

/**
 * The path a `<…>` reference names, resolved the way the game resolves one: against the folder of
 * the file it is written in.
 *
 * A path the game resolves against something else is left alone. A rooted path (`/Data/…`) and an
 * explicit current directory (`./Data/…`) are both read from the install root rather than from the
 * declaring folder, so resolving either one here would name a file nobody is renaming and spell it
 * back as a climb out of the drive.
 *
 * @param inner the path inside the angle brackets, as written.
 * @param fromDir the folder of the file writing it.
 * @returns the absolute path it names, or undefined when the form is one this does not rewrite.
 */
const targetOf = (inner: string, fromDir: string): string | undefined => {
    const written = inner.trim();
    if (!written) return undefined;
    if (/^[\\/]/.test(written) || /^[A-Za-z]:/.test(written) || isAbsolute(written)) return undefined;
    if (/^\.[\\/]/.test(written)) return undefined;
    const hasExtension = /\.[^/\\.]+$/.test(written);
    // A name with neither a folder step nor an extension is not how the corpus writes a file path,
    // and reading one as a file is how a markup tag became a reference.
    if (!hasExtension && !/[\\/]/.test(written)) return undefined;
    const withExtension = hasExtension ? written : `${written}.rules`;
    // A `.txt` a reference reaches is rules content: the game's loader reads the file through the
    // same parser and never looks at the extension, and mods split fragments into `.txt` because of
    // it. Such a path is measured from the declaring folder like any other, so a file moving out of
    // that folder has to re-express it. The extensionless default stays `.rules`, which is the one
    // name the game fills in for itself.
    if (!/\.(rules|txt)$/i.test(withExtension)) return undefined;
    return resolve(fromDir, withExtension);
};

/**
 * The path text naming a file from a folder, in the form the reference already used: with or
 * without the extension.
 *
 * @param inner the path inside the angle brackets, as written.
 * @param fromDir the folder of the file writing it.
 * @param target the file being named.
 * @returns the rewritten path, or undefined when it cannot be written as a relative one.
 */
const rewritten = (inner: string, fromDir: string, target: string): string | undefined => {
    const written = inner.trim();
    const hadExtension = /\.[^/\\.]+$/.test(written);
    const path = relative(fromDir, target).replace(/\\/g, '/');
    // Another drive has no relative spelling, and `relative` answers an absolute path for it, which
    // is not a form a reference may carry.
    if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return undefined;
    // A sibling is written without a leading `./`, which is how every file in the corpus writes one.
    return hadExtension ? path : path.replace(/\.rules$/i, '');
};

/** Every value node of a document, the ones written in an inheritance list included. */
function* valueNodes(node: AbstractNode): Generator<ValueNode> {
    if (isValueNode(node)) {
        yield node;
        return;
    }
    if (isGroupNode(node) || isListNode(node)) for (const base of node.inheritance ?? []) yield* valueNodes(base);
    for (const child of childNodesOf(node)) yield* valueNodes(child);
}

/** The value types the lexer reads out of a file extension, which are the values naming an asset. */
const ASSET_VALUE_TYPES: ReadonlySet<string> = new Set(['Sprite', 'Sound', 'Shader']);

/**
 * A value that is a path and nothing else. A localized sentence about PNG files, and a credits line
 * carrying markup, are both typed as a sprite by the extension they mention, and neither names a
 * file the mod ships.
 */
const PATH_ONLY = /^[A-Za-z0-9_.\-/\\ ]+$/;

/**
 * Where an asset path is written: the path run itself, with the quotes around it left out of the
 * span so the edit writes over the path and nothing else.
 *
 * The parsed value is matched against the file's own text at the offset the value begins, so a
 * buffer that has moved on since the parse answers with no site rather than with a misplaced one.
 *
 * @param text the file's text.
 * @param offset the offset the value begins at.
 * @param written the value the parse carries.
 * @returns the site, or undefined when the text no longer writes that value there.
 */
const assetSiteAt = (text: string, offset: number, written: string): ReferenceSite | undefined => {
    if (text.startsWith(written, offset)) return { inner: written, start: offset, end: offset + written.length };
    if (text.startsWith(`"${written}"`, offset)) {
        return { inner: written, start: offset + 1, end: offset + 1 + written.length };
    }
    return undefined;
};

/**
 * The asset path naming the same file from the folder a moved file lands in.
 *
 * Only a path that names a file sitting next to the moving file today is rewritten. That one test
 * carries the whole safety of this: a value the lexer typed as an asset because it mentions `.png`
 * somewhere, a key a mod action writes, a path that was already broken before the move, none of them
 * name a file on disk, so none of them is touched.
 *
 * @param written the value as the parse carries it.
 * @param ownDir the folder the file sits in today, which the path is measured from.
 * @param newDir the folder it is landing in.
 * @returns the rewritten path, or undefined when this is not a path to rewrite.
 */
const rebasedAsset = (written: string, ownDir: string, newDir: string): string | undefined => {
    const path = written.trim();
    if (!path || !PATH_ONLY.test(path) || !looksLikeAssetPath(path)) return undefined;
    // The game reads a rooted path and a `./…` path from its own install root, so both name the
    // same file from every folder and neither moves with the file.
    if (isGameRootPath(path) || /^[\\/]/.test(path) || /^[A-Za-z]:/.test(path) || isAbsolute(path)) return undefined;
    const target = resolve(ownDir, path);
    if (!cachedPathExists(target)) return undefined;
    const next = relative(newDir, target).replace(/\\/g, '/');
    if (!next || isAbsolute(next) || /^[A-Za-z]:/.test(next)) return undefined;
    return next === path ? undefined : next;
};

/**
 * The text of a file, which every edit's offsets are measured in.
 *
 * The file on disk is what is read, while an open buffer may have moved on. That costs nothing,
 * because a reference is only rewritten when the text still writes one at the offset the parse
 * reports, so a buffer that has moved on answers with no edit rather than with a misplaced one.
 *
 * @param path the file to read.
 * @returns its text, or null when it cannot be read.
 */
const textFor = async (path: string): Promise<string | null> => readFile(path, { encoding: 'utf-8' }).catch(() => null);

/**
 * The edits that keep every reference to a set of moved files pointing at them.
 *
 * @param renames the files the editor is about to move.
 * @param folderUris the project folders the search sweeps. It holds the game's own install as well,
 * which is searched and never written, so the answer is filtered through the write gate.
 * @param token cancels the search and the parses.
 * @returns the workspace edit, or undefined when nothing references the moved files.
 */
export const referenceRepairEdit = async (
    renames: readonly FileRename[],
    folderUris: string[],
    token: CancellationToken
): Promise<WorkspaceEdit | undefined> => {
    const moved = new Map<string, string>();
    // The paths as the filesystem writes them: the map is keyed in compare form, which is lowercased
    // and names nothing on a case-sensitive filesystem.
    const movedPaths: string[] = [];
    for (const rename of renames) {
        if (!/\.rules$/i.test(rename.oldPath)) continue;
        moved.set(canonical(rename.oldPath), rename.newPath);
        movedPaths.push(rename.oldPath);
    }
    if (moved.size === 0) return undefined;

    const changes: Record<string, TextEdit[]> = {};
    const seen = new Set<string>();

    /**
     * Rewrites every reference one file writes to a moved file.
     *
     * @param path the file to read, at the place it is written today.
     */
    const visit = async (path: string): Promise<void> => {
        const key = canonical(path);
        if (seen.has(key)) return;
        seen.add(key);
        // A file that is itself moving writes its paths against the folder it lands in, while the
        // edit still goes to where it sits today.
        const writtenPath = moved.get(key) ?? path;
        // Both ends are asked, because the edit is applied at the old path while the file is meant
        // to end up at the new one, so either being somebody else's tree is a refusal.
        if (writeRefusalFor(path) || writeRefusalFor(writtenPath)) return;
        const document = await documentForPath(path);
        if (!document) return;
        const text = await textFor(path);
        if (text === null) return;
        const ownDir = dirname(path);
        // A file that is itself moving writes its references against its new folder, so they are
        // rebased rather than left alone.
        const fromDir = dirname(writtenPath);
        const rebases = canonical(fromDir) !== canonical(ownDir);
        const edits: TextEdit[] = [];
        /**
         * Records one rewrite over the characters a value's path occupies.
         *
         * @param value the value node the path is written in.
         * @param site the span of the path inside it.
         * @param newText the text to write over that span.
         */
        const replace = (value: ValueNode, site: ReferenceSite, newText: string): void => {
            // The line the value begins on, which is where its path run is: the value's own
            // character offset says where that line starts in the file.
            const lineStart = value.position.start - value.position.characterStart;
            edits.push({
                range: {
                    start: { line: value.position.line, character: site.start - lineStart },
                    end: { line: value.position.line, character: site.end - lineStart },
                },
                newText,
            });
        };
        for (const value of valueNodes(document)) {
            if (value.valueType.type === 'Reference') {
                const site = referenceSiteAt(text, value.position.start);
                if (!site) continue;
                const target = targetOf(site.inner, ownDir);
                if (!target) continue;
                const destination = moved.get(canonical(target));
                // A reference naming a file nobody is renaming is left as the author wrote it.
                if (destination === undefined && !rebases) continue;
                const next = rewritten(site.inner, fromDir, destination ?? target);
                if (next === undefined || next === site.inner) continue;
                replace(value, site, `<${next}>`);
                continue;
            }
            // An asset path is only ever wrong because the file writing it changed folder. Nobody
            // renames a sprite through this, so a file that is staying put has nothing to rewrite.
            if (!rebases || !ASSET_VALUE_TYPES.has(value.valueType.type)) continue;
            const written = String(value.valueType.value);
            const next = rebasedAsset(written, ownDir, fromDir);
            if (next === undefined) continue;
            const site = assetSiteAt(text, value.position.start, written);
            if (!site) continue;
            replace(value, site, next);
        }
        // The edit is addressed to where the file is now. The editor applies it before it performs
        // the rename, and it drops every edit of the answer when one of them names a file that is
        // not there yet.
        if (edits.length > 0) changes[filePathToUri(path)] = edits;
    };

    // The moved files first: whatever they point at has to be re-expressed against where they land.
    for (const oldPath of movedPaths) await visit(oldPath);
    for (const oldPath of movedPaths) {
        if (token.isCancellationRequested) return undefined;
        const stem = stemOf(oldPath);
        if (!stem) continue;
        // The stem is already in compare form, and the candidate's text is folded to meet it: a
        // file named with a capital, and a reference that spells the name in another case than the
        // file does, are both how the corpus is written, and the filesystem reads either one.
        for await (const candidate of documentsMatching(folderUris, stem, token, (candidateText) =>
            candidateText.toLowerCase().includes(stem)
        )) {
            if (token.isCancellationRequested) return undefined;
            await visit(uriToFsPath(candidate.uri));
        }
    }
    // The whole answer goes through the gate once more on its way out, so a file the sweep reached
    // by a route the visit did not judge still cannot be written.
    const { kept } = writableChanges(changes);
    return Object.keys(kept).length > 0 ? { changes: kept } : undefined;
};
