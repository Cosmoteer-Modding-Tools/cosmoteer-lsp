import { dirname, relative, resolve } from 'path';
import { CancellationToken, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { childNodesOf, parseFilePath } from '../../utils/ast.utils';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { filePathToUri } from '../navigation/navigation-strategy';
import { documentsMentioning, uriToFsPath } from '../navigation/workspace-files';

/**
 * Keeping the references to a `.rules` file working when the file is moved or renamed.
 *
 * A `<…>` reference names a file by a path written against the folder of the file writing it, so
 * moving either end breaks it. Nothing in the editor noticed: the rename went through, and the
 * broken references showed up later as unresolved-reference reports in files nobody had touched.
 * This rewrites each of them as the editor performs the rename, which is the moment the two paths
 * are both known.
 *
 * Only a reference that really resolves to the moved file is rewritten. The search is by file name
 * rather than by path, so a file called `parts.rules` in two folders is found twice and only the
 * one whose path leads to the moved file is touched.
 */

/** A file the editor is about to move, with where it is going. */
export interface FileRename {
    readonly oldPath: string;
    readonly newPath: string;
}

/** The `<…>` reference forms this rewrites: a mod-relative path naming a file inside the project. */
const FILE_REFERENCE = /<([^<>\r\n"]+)>/;

/** A path in canonical compare form: forward slashes, lowercased. */
const canonical = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

/** The file name of a path, without its extension. */
const stemOf = (path: string): string => (canonical(path).split('/').pop() ?? '').replace(/\.rules$/, '');

/**
 * The path a `<…>` reference names, resolved the way the game resolves one: against the folder of
 * the file it is written in.
 *
 * A game-root path (`./Data/…`) is deliberately not resolved. It names a file the user is not
 * renaming, and following it would need the game folder to be known for a rewrite that could never
 * apply.
 *
 * @param reference the reference text as written, angle brackets included.
 * @param fromDir the folder of the file writing it.
 * @returns the absolute path it names, or undefined when the form is one this does not rewrite.
 */
const targetOf = (reference: string, fromDir: string): string | undefined => {
    const inner = FILE_REFERENCE.exec(reference)?.[1]?.trim();
    // A game-root path names a file the user is not renaming, and the workshop escape the corpus
    // writes is one of those, so both are left exactly as they are.
    if (!inner || /^\.\/data\//i.test(inner)) return undefined;
    const withExtension = /\.[^/\\.]+$/.test(inner) ? inner : `${inner}.rules`;
    if (!/\.rules$/i.test(withExtension)) return undefined;
    return resolve(fromDir, withExtension);
};

/**
 * The reference text naming a file from a folder, in the form the reference already used: with or
 * without the extension, and keeping whatever the reference wrote after the closing bracket.
 *
 * @param reference the reference text as written.
 * @param fromDir the folder of the file writing it.
 * @param target the file being named.
 * @returns the rewritten reference text.
 */
const rewritten = (reference: string, fromDir: string, target: string): string => {
    const inner = FILE_REFERENCE.exec(reference)![1];
    const hadExtension = /\.[^/\\.]+$/.test(inner.trim());
    let path = relative(fromDir, target).replace(/\\/g, '/');
    if (!hadExtension) path = path.replace(/\.rules$/i, '');
    // A sibling is written without a leading `./`, which is how every file in the corpus writes one.
    return reference.replace(FILE_REFERENCE, `<${path}>`);
};

/** Every value node of a document that is written as a reference. */
function* referenceValues(node: AbstractNode): Generator<AbstractNode> {
    if (isValueNode(node) && node.valueType.type === 'Reference') {
        yield node;
        return;
    }
    if (isGroupNode(node) || isListNode(node)) for (const base of node.inheritance ?? []) yield* referenceValues(base);
    for (const child of childNodesOf(node)) yield* referenceValues(child);
}

/**
 * The parsed document for a path, preferring the live editor buffer over the file on disk.
 *
 * @param path the file to read.
 * @returns the parsed document, or null when it cannot be read.
 */
const documentFor = async (path: string): Promise<AbstractNodeDocument | null> =>
    ParserResultRegistrar.instance.getResultByPath(path) ?? (await parseFilePath(path).catch(() => null));

/**
 * The edits that keep every reference to a set of moved files pointing at them.
 *
 * @param renames the files the editor is about to move.
 * @param folderUris the project folders the search sweeps.
 * @param token cancels the search and the parses.
 * @returns the workspace edit, or undefined when nothing references the moved files.
 */
export const referenceRepairEdit = async (
    renames: readonly FileRename[],
    folderUris: string[],
    token: CancellationToken
): Promise<WorkspaceEdit | undefined> => {
    const moved = new Map<string, string>();
    for (const rename of renames) {
        if (!/\.rules$/i.test(rename.oldPath)) continue;
        moved.set(canonical(rename.oldPath), rename.newPath);
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
        const document = await documentFor(path);
        if (!document) return;
        // A file that is itself moving writes its references against its new folder, so they are
        // rebased rather than left alone.
        const fromDir = dirname(moved.get(key) ?? path);
        const edits: TextEdit[] = [];
        for (const value of referenceValues(document)) {
            if (!isValueNode(value)) continue;
            const text = String(value.valueType.value);
            const target = targetOf(text, dirname(path));
            if (!target) continue;
            const destination = moved.get(canonical(target)) ?? target;
            const next = rewritten(text, fromDir, destination);
            if (next === text) continue;
            edits.push({
                range: {
                    start: { line: value.position.line, character: value.position.characterStart },
                    end: { line: value.position.line, character: value.position.characterEnd },
                },
                newText: next,
            });
        }
        if (edits.length > 0) changes[filePathToUri(moved.get(key) ?? path)] = edits;
    };

    // The moved files first: whatever they point at has to be re-expressed against where they land.
    for (const [oldPath] of moved) await visit(oldPath);
    for (const [oldPath] of moved) {
        if (token.isCancellationRequested) return undefined;
        const stem = stemOf(oldPath);
        if (!stem) continue;
        for await (const candidate of documentsMentioning(folderUris, stem, token)) {
            if (token.isCancellationRequested) return undefined;
            await visit(uriToFsPath(candidate.uri));
        }
    }
    return Object.keys(changes).length > 0 ? { changes } : undefined;
};
