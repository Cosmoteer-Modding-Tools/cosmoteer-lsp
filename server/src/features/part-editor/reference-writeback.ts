import { readFile } from 'fs/promises';
import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AssignmentNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { isReferenceValue } from '../navigation/definition.service';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { normalizeUri } from '../navigation/reference-location';
import { documentsMentioning, uriToFsPath } from '../navigation/workspace-files';
import { referenceNodesOf } from '../navigation/reference-index';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { CosmoteerWorkspaceService, FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { findModRoot, sameModRoot } from '../../mod/mod-root';
import { isUnderFolder } from '../../mod/strings-folder';

/**
 * Where a grid edit lands when the value the handle sits on is a reference.
 *
 * A part that writes `PhysicalRect = [0, 0, &~/SIZE/0, &~/SIZE/1]` is saying its collision box is
 * the part's size, and the editor used to answer a drag by pasting literals over that sentence,
 * which silently unbinds the two. The value the game reads lives in the declaration, so the write
 * goes there: the reference is followed to the number it names and the number is rewritten in the
 * file that declares it.
 *
 * What it refuses, and why each refusal is load bearing:
 *
 * - A declaration in the game's own `Data` tree. Those files are the installed game, not the
 *   author's work, and a mod cannot ship an edit to them.
 * - A declaration in another mod. The same reason one step out: the file belongs to somebody else's
 *   package, and writing into it changes a dependency rather than this mod.
 * - A reference that still resolves to a reference after the walk. The navigator stops at forms it
 *   does not follow (a runtime-rooted path, an unresolvable base), and a write at that node would
 *   move a path rather than set a number.
 * - A target that is not the shape the handle edits. `&~/SIZE` naming a three-member group is not a
 *   vector, and slicing one member out of it would write a number where the file means a group.
 */

/** How many hops a chain of references is followed before the walk gives up. */
const MAX_HOPS = 4;

/** Hooks the request handler supplies so a write can reach files this document does not own. */
export interface GridEditOptions {
    /** The editor's own buffer for a uri, so an unsaved file is written from what the author sees. */
    readonly openText?: (uri: string) => string | undefined;
    /**
     * How many other places read the declaration a write landed in, for the status note. Best
     * effort: null means the count was not available in time and the note is written without it.
     */
    readonly countReaders?: (
        declaration: AbstractNode,
        uri: string,
        token: CancellationToken
    ) => Promise<number | null>;
}

/** The file and node a write should be applied to, once references have been followed. */
export interface WriteSite {
    /** The file the edit belongs in, which is not this document when the declaration is elsewhere. */
    readonly uri: string;
    /** That file's current text, the offsets of the edit are measured against it. */
    readonly text: string;
    /** The node whose span the new value replaces. */
    readonly node: AbstractNode;
    /** The reference this site was reached through, as written, or null for a local value. */
    readonly through: string | null;
}

/** A localized refusal from the walk. */
export interface WriteRefusal {
    readonly error: string;
}

/**
 * Whether a walk answered with a refusal instead of a site.
 *
 * @param value the walk's answer.
 * @returns true when it carries a message rather than a site.
 */
export const isRefusal = (value: WriteSite | WriteRefusal): value is WriteRefusal => 'error' in value;

/** The file name of a uri or path, for a message a person reads. */
const fileNameOf = (uri: string): string => {
    const path = uriToFsPath(uri).replace(/\\/g, '/');
    return path.slice(path.lastIndexOf('/') + 1);
};

/**
 * Whether a declaration in `targetUri` may be written from a part in `ownUri`: the same file
 * always, another file only when both sit in the same mod and outside the installed game.
 *
 * @param targetUri the file the declaration was found in.
 * @param ownUri the file the part being edited is written in.
 * @returns a localized refusal, or null when the write may go ahead.
 */
const gateTarget = (targetUri: string, ownUri: string): WriteRefusal | null => {
    if (normalizeUri(targetUri) === normalizeUri(ownUri)) return null;

    const targetPath = uriToFsPath(targetUri);
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (dataRoot && isUnderFolder(targetPath, dataRoot)) {
        return {
            error: l10n.t("The value is declared in {0}, one of the game's own files, which a mod cannot edit.", fileNameOf(targetUri)),
        };
    }

    const ownRoot = findModRoot(ownUri);
    const targetRoot = findModRoot(targetUri);
    if (!ownRoot || !targetRoot || !sameModRoot(ownRoot, targetRoot)) {
        return { error: l10n.t('The value is declared in {0}, which is outside this mod.', fileNameOf(targetUri)) };
    }
    return null;
};

/**
 * The current text of a file the write may land in: the editor's buffer when it is open, this
 * document's own text when it is this document, and the file on disk otherwise.
 *
 * @param uri the file to read.
 * @param ownUri the uri of the document being edited.
 * @param ownText that document's text, already in hand.
 * @param options the handler's hooks.
 * @returns the text, or null when the file could not be read.
 */
const textOf = async (
    uri: string,
    ownUri: string,
    ownText: string,
    options: GridEditOptions
): Promise<string | null> => {
    if (normalizeUri(uri) === normalizeUri(ownUri)) return ownText;
    const open = options.openText?.(uri);
    if (open !== undefined) return open;
    return readFile(uriToFsPath(uri), { encoding: 'utf-8' }).catch(() => null);
};

/**
 * Follows a reference value to the declaration a write should land in, through as many hops as the
 * chain has.
 *
 * @param node the reference value the handle sits on.
 * @param ownUri the uri of the document being edited.
 * @param ownText that document's text.
 * @param options the handler's hooks.
 * @param token cancels the cross-file resolution.
 * @returns the site to write in, or a refusal naming why the reference cannot be written through.
 */
export const followToDeclaration = async (
    node: AbstractNode,
    ownUri: string,
    ownText: string,
    options: GridEditOptions,
    token: CancellationToken
): Promise<WriteSite | WriteRefusal> => {
    const written = String((node as { valueType?: { value?: unknown } }).valueType?.value ?? '');
    let current = node;
    const seen = new Set<AbstractNode>([node]);

    for (let hop = 0; hop < MAX_HOPS; hop++) {
        const from = getStartOfAstNode(current).uri;
        const path = String((current as { valueType?: { value?: unknown } }).valueType?.value ?? '');
        const resolved = await new FullNavigationStrategy().navigate(path, current, from, token).catch(() => null);
        if (!resolved || isFile(resolved as FileWithPath)) {
            return { error: l10n.t('{0} could not be resolved, edit the value in the text.', written) };
        }

        const target = resolved as AbstractNode;
        const targetUri = getStartOfAstNode(target).uri;
        const refused = gateTarget(targetUri, ownUri);
        if (refused) return refused;

        // A target that is itself a reference is one more hop, unless the walk is going in circles or
        // the navigator has stopped at a form it does not follow, in which case the loop runs out.
        if (isReferenceValue(target) && !seen.has(target)) {
            seen.add(target);
            current = target;
            continue;
        }
        if (isReferenceValue(target)) break;

        const text = await textOf(targetUri, ownUri, ownText, options);
        if (text === null) {
            return { error: l10n.t('{0} names a file that could not be read.', written) };
        }
        return { uri: targetUri, text, node: target, through: written };
    }
    return { error: l10n.t('{0} names another reference, edit the value in the text.', written) };
};

/**
 * Whether a node, or anything the handle would write inside it, is a reference. The plain path
 * rewrites a whole vector in one span and must stay the common case, so this is what decides
 * between it and the per-component walk that follows references.
 *
 * @param node the value node the handle sits on.
 * @returns true when a write into it has to follow at least one reference.
 */
export const holdsReference = (node: AbstractNode | null | undefined): boolean => {
    if (!node) return false;
    if (isReferenceValue(node)) return true;
    if (!isGroupNode(node) && !isListNode(node)) return false;
    return node.elements.some((element) => {
        if (isReferenceValue(element)) return true;
        // A group form writes its components as assignments, so the reference sits on the right.
        const right = (element as { right?: AbstractNode }).right;
        return !!right && isReferenceValue(right);
    });
};

/**
 * The declaration a write landed inside: the value of the nearest member that carries a name. A
 * write into `SIZE = [1, 2]` through `&~/SIZE/0` lands on the list element, and the thing other
 * files read is the list, so the reader count is taken for that.
 *
 * @param node the node the write replaces.
 * @returns the named member's value node, or the node itself when nothing above it is named.
 */
export const declarationOf = (node: AbstractNode): AbstractNode => {
    let current: AbstractNode | undefined = node;
    while (current) {
        if (assignmentWriting(current) || ((isGroupNode(current) || isListNode(current)) && current.identifier)) {
            return current;
        }
        current = current.parent;
    }
    return node;
};

/**
 * The assignment a value is written by. The parser hangs an assignment's value off the enclosing
 * container rather than off the assignment, so the member name is not reachable by walking up: the
 * container's own elements have to be asked which of them writes this node.
 *
 * @param node the value node.
 * @returns the assignment writing it, or undefined when the node is not a member's value.
 */
const assignmentWriting = (node: AbstractNode): AssignmentNode | undefined => {
    const parent = node.parent;
    if (!parent || (!isGroupNode(parent) && !isListNode(parent) && !isDocumentNode(parent))) return undefined;
    return parent.elements.find(
        (element): element is AssignmentNode => isAssignmentNode(element) && element.right === node
    );
};

/** The name a declaration is written under, which is the word a reader has to mention. */
const declarationName = (declaration: AbstractNode): string | null => {
    const written = assignmentWriting(declaration);
    if (written) return written.left.name;
    if ((isGroupNode(declaration) || isListNode(declaration)) && declaration.identifier) {
        return declaration.identifier.name;
    }
    return null;
};

/**
 * Whether a node is the declaration or something written inside it, compared by file and span
 * rather than by identity. The two are reached through different parses of the same file, since the
 * document the write is built from and the one a reference resolves into come from different
 * caches, and identity would answer false for the same text.
 *
 * @param node the node to test.
 * @param nodeUri the file it was parsed from.
 * @param declaration the declaration the write landed in.
 * @param declarationUri the file that is written in.
 * @returns true when the node lies within the declaration's span in the same file.
 */
const within = (
    node: AbstractNode,
    nodeUri: string,
    declaration: AbstractNode,
    declarationUri: string
): boolean =>
    normalizeUri(nodeUri) === normalizeUri(declarationUri) &&
    node.position.start >= declaration.position.start &&
    node.position.end <= declaration.position.end;

/**
 * How many places other than the declaration itself read it, counting a reference that names a
 * path through it (`&~/SIZE/0` reads `SIZE`) as a reader, which is what makes the number mean
 * "moving this handle moves that many other things".
 *
 * Find-all-references cannot answer this: it matches a reference against the exact node it
 * resolves to, so a path into a list resolves to the element and never to the list the author
 * named. The search is scoped to the folders it is given and pre-filtered by the declaration's own
 * name, so it only ever parses files that mention the word.
 *
 * @param declaration the declaration the write landed in.
 * @param declarationUri the file it is written in.
 * @param folderPaths the folders to search.
 * @param token cancels the search.
 * @returns the number of reading sites outside the declaration itself.
 */
export const countReadersOf = async (
    declaration: AbstractNode,
    declarationUri: string,
    folderPaths: string[],
    token: CancellationToken
): Promise<number> => {
    const name = declarationName(declaration);
    if (!name) return 0;
    let readers = 0;
    for await (const document of documentsMentioning(folderPaths, name, token)) {
        for (const reference of referenceNodesOf(document)) {
            const path = String(reference.valueType.value ?? '');
            if (!path.includes(name)) continue;
            if (within(reference, document.uri, declaration, declarationUri)) continue;
            const target = await new FullNavigationStrategy()
                .navigate(path, reference, document.uri, token)
                .catch(() => null);
            if (!target || isFile(target as FileWithPath)) continue;
            const resolved = target as AbstractNode;
            if (within(resolved, getStartOfAstNode(resolved).uri, declaration, declarationUri)) readers++;
        }
    }
    return readers;
};
