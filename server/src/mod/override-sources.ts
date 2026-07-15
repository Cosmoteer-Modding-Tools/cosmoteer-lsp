import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../core/ast/ast';
import { parseFilePath } from '../utils/ast.utils';
import { safeReaddir } from '../utils/fs.utils';
import { isManifestBasename } from '../document/document-kind';
import { documentsMentioning, uriToFsPath } from '../features/navigation/workspace-files';
import { ReverseIncludeIndex } from '../features/navigation/reverse-include.index';
import { FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';
import { ParserResultRegistrar } from '../registrar/parser-result-registrar';
import { findModRoot } from './mod-root';
import { parseModActions } from './action-parser';
import { resolveActionTarget } from './action-target-resolver';

/** Load a mod file, preferring the live in-editor (possibly unsaved) buffer over disk. */
const loadDocument = async (osPath: string): Promise<AbstractNodeDocument | null> =>
    ParserResultRegistrar.instance.getResultByPath(osPath) ?? (await parseFilePath(osPath).catch(() => null));

/** A path in canonical compare form: forward slashes, lowercased (Windows-style folding). */
const canonical = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

/** Every cross-file reference written in a document: assignment values, list elements, and inheritance bases. */
function* crossFileReferencesOf(node: AbstractNode): Generator<string> {
    if (isValueNode(node) && node.valueType.type === 'Reference') yield String(node.valueType.value);
    for (const base of (node as { inheritance?: AbstractNode[] }).inheritance ?? []) yield* crossFileReferencesOf(base);
    const children: AbstractNode[] =
        isGroupNode(node) || isListNode(node) || isDocumentNode(node)
            ? node.elements
            : isAssignmentNode(node)
              ? (node.right ? [node.right] : [])
              : [];
    for (const child of children) yield* crossFileReferencesOf(child);
}

/** The file name a fragment is referenced by (`…/jump_wire_stuff.rules` → `jump_wire_stuff`). */
const fileStemOf = (documentUri: string): string =>
    (uriToFsPath(documentUri).split(/[/\\]/).pop() ?? '').replace(/\.rules$/i, '');

/** Escapes a file stem for use inside the `<…>` file-ref pattern. */
const escapeForPattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The documents that pull a fragment's members into themselves — as a field include
 * (`Components = &<fragment.rules>/Part/Components`) or as an inheritance base written across lines
 * (`Components : ^/0/Components` + `<jump_wire_stuff.rules>/Part/Components`).
 *
 * The game merges the fragment's members into the consuming part at load, so references written in
 * the fragment (component ids, most importantly) resolve against that part, not against the fragment
 * alone. Judging such a fragment standalone false-positives every id the consumer supplies. This
 * finds every consuming document, letting callers fold its contents into their resolution scope the
 * way {@link overrideTargetsOf} folds in an override target.
 *
 * The reverse-include index answers the field-include form directly, but deliberately does not record
 * a DEEP inheritance base (`: <file>/Top/Nested`, whose nested class would mis-root the top member),
 * which is exactly the form the components fragments use — so the consumers are also searched by the
 * fragment's file name within its mod.
 *
 * @param documentUri the fragment whose consuming documents are wanted.
 * @param cancellationToken cancels the document loads and the name search.
 * @returns the parsed consuming documents, empty when nothing pulls the fragment in.
 */
export const includingDocumentsOf = async (
    documentUri: string,
    cancellationToken: CancellationToken
): Promise<AbstractNodeDocument[]> => {
    const self = canonical(uriToFsPath(documentUri));
    const documents: AbstractNodeDocument[] = [];
    const seen = new Set<string>([self]);

    const add = (document: AbstractNodeDocument | null): void => {
        if (!document) return;
        const key = canonical(uriToFsPath(document.uri));
        if (seen.has(key)) return;
        seen.add(key);
        documents.push(document);
    };

    for (const { source } of ReverseIncludeIndex.instance.includesOf(documentUri)) {
        if (cancellationToken.isCancellationRequested) return documents;
        if (!seen.has(canonical(uriToFsPath(source)))) add(await loadDocument(uriToFsPath(source)));
    }

    const modRoot = findModRoot(documentUri);
    const stem = fileStemOf(documentUri);
    if (!modRoot || !stem) return documents;
    // A file ref names the fragment by file name, with or without the extension: `<jump_wire_stuff.rules>/…`.
    const referencesFragment = new RegExp(`<[^>]*${escapeForPattern(stem)}(\\.rules)?\\s*>`, 'i');
    for await (const candidate of documentsMentioning([pathToFileURL(modRoot).href], stem, cancellationToken)) {
        if (cancellationToken.isCancellationRequested) break;
        if (seen.has(canonical(uriToFsPath(candidate.uri)))) continue;
        for (const reference of crossFileReferencesOf(candidate)) {
            if (referencesFragment.test(reference)) {
                add(candidate);
                break;
            }
        }
    }
    return documents;
};

/**
 * The game-tree nodes a document's content is merged into by its mod's `Overrides` actions.
 *
 * A mod patches a vanilla part by pairing a sparse local file with a manifest action
 * (`OverrideIn = "<./Data/ships/…/airlock.rules>"  Overrides = &<ships/…/airlock.rules>`). At
 * runtime the local file's members merge into the vanilla target, so references written in the
 * local file (component ids, most importantly) resolve against the merged result. This finds every
 * such target for a document, letting callers fold the target's contents into their resolution
 * scope.
 *
 * @param documentUri the document whose override targets are wanted (an override source file).
 * @param cancellationToken cancels the manifest reads and target navigation.
 * @returns the resolved target nodes, empty when the document is not an override source.
 */
export const overrideTargetsOf = async (
    documentUri: string,
    cancellationToken: CancellationToken
): Promise<AbstractNode[]> => {
    const modRoot = findModRoot(documentUri);
    if (!modRoot) return [];
    const documentPath = canonical(uriToFsPath(documentUri));
    const targets: AbstractNode[] = [];
    for (const name of safeReaddir(modRoot).filter(isManifestBasename).sort()) {
        if (cancellationToken.isCancellationRequested) break;
        const manifest = await loadDocument(join(modRoot, name));
        if (!manifest) continue;
        for (const action of parseModActions(manifest)) {
            if (action.type !== 'Overrides') continue;
            const source = action.sources[0];
            const target = action.targets[0];
            if (!target || !source || !isValueNode(source) || source.valueType.type !== 'Reference') continue;
            // The source `&<relpath>[/Members…]` names a file of the mod; match it to the document.
            const file = /<([^>]+)>/.exec(String(source.valueType.value))?.[1];
            if (!file) continue;
            const withExt = /\.[^/\\.]+$/.test(file) ? file : `${file}.rules`;
            if (canonical(join(modRoot, withExt)) !== documentPath) continue;
            const resolved = await resolveActionTarget(target, cancellationToken);
            if (!resolved) continue;
            if (isFile(resolved as FileWithPath)) {
                const parsed = await loadDocument((resolved as FileWithPath).path);
                if (parsed) targets.push(parsed);
            } else {
                targets.push(resolved as AbstractNode);
            }
        }
    }
    return targets;
};
