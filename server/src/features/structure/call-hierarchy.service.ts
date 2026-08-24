import {
    CallHierarchyIncomingCall,
    CallHierarchyItem,
    CallHierarchyOutgoingCall,
    CancellationToken,
    Location,
    Position,
    Range,
    SymbolKind,
} from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { Action } from '../../mod/action';
import { parseModActions } from '../../mod/action-parser';
import { normalizeTargetPath } from '../../mod/action-target-resolver';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { workspaceRelativePath } from '../../utils/relative-path';
import { cachedParseFilePath } from '../../workspace/fs-cache';
import { FileTree, isFile } from '../../workspace/cosmoteer-workspace.service';
import { atOrBefore, enclosingRange, orderRange, unionRange } from '../navigation/ast-range';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { filePathToUri } from '../navigation/navigation-strategy';
import { normalizeUri, rangeOf } from '../navigation/reference-location';
import { ReferenceIndex, referenceNodesOf } from '../navigation/reference-index';
import { documentsMentioning, uriToFsPath } from '../navigation/workspace-files';

/**
 * Call hierarchy (`textDocument/prepareCallHierarchy` and its two expansions) over the ways one
 * declaration reaches another.
 *
 * A `.rules` declaration has no calls, but it does have callers, and they are exactly the question
 * an author asks before touching a shared fragment: who reads this, and what breaks if I change it.
 * Three of the four edges are written the same way, so one search finds them all: a plain reference
 * (`Range = &<shared.rules>/Range`), an include of a whole member (`Components =
 * &<parts.rules>/Components`) and an inheritance base (`Derived : <base.rules>/Base`) are all
 * references resolving to the same node. The fourth is written differently and is searched
 * separately: a manifest action naming the node as its target, which is a quoted path.
 *
 * Incoming is the direction with the value. Outgoing is a second reading of what the document links
 * already make clickable, and it is here because a hierarchy with one direction is a list.
 *
 * One level per request, which is what the protocol asks for. The incoming search is one
 * find-all-references per expanded row, the slow path on a heavily referenced node, so it carries
 * the request's token and answers with what it has when the token is cancelled.
 */

/** The resolver that turns one written reference into the node it names. */
const navigation = new FullNavigationStrategy();

/** How many manifests the action-target search reads before it stops looking. */
const MANIFEST_LIMIT = 64;

/** A declaration a hierarchy row can stand for: a named container, or a member of one. */
type Declaration = AbstractNode;

/**
 * Whether a node names something a reference can resolve to. A named group or list does, and so
 * does an assignment, whose left-hand identifier is the name a reference reaches it by.
 *
 * @param node the node to judge.
 * @returns true when the node is a declaration.
 */
const isDeclaration = (node: AbstractNode | null | undefined): boolean =>
    !!node && (((isGroupNode(node) || isListNode(node)) && !!node.identifier) || isAssignmentNode(node));

/** The name a row carries: the assignment's or the container's own identifier. */
const nameOf = (declaration: Declaration): string =>
    isAssignmentNode(declaration)
        ? declaration.left.name
        : ((declaration as { identifier?: { name: string } }).identifier?.name ?? '');

/** The identifier a row's selection range covers, which is what the item is resolved back through. */
const identifierOf = (declaration: Declaration): AbstractNode =>
    isAssignmentNode(declaration) ? declaration.left : declaration;

/**
 * The assignment a value belongs to. The parser hangs a value off the container that holds it
 * rather than off the assignment that names it, so the name a reference resolved through is not on
 * the way out and has to be looked for among the container's own members.
 *
 * @param node the value node.
 * @returns the assignment writing it, or undefined when the value is not an assigned one.
 */
const owningAssignment = (node: AbstractNode): AbstractNode | undefined => {
    const parent = node.parent;
    if (!parent || (!isGroupNode(parent) && !isListNode(parent) && !isDocumentNode(parent))) return undefined;
    return parent.elements.find((element) => isAssignmentNode(element) && element.right === node);
};

/**
 * The innermost declaration covering a node, walking out through its parents. A reference site is
 * reported as the declaration that writes it, since that is the row an author expands next.
 *
 * @param node the node to start at.
 * @returns the declaration, or undefined when nothing on the way out is one.
 */
const enclosingDeclaration = (node: AbstractNode | undefined): Declaration | undefined => {
    let current: AbstractNode | undefined = node;
    while (current && !isDocumentNode(current)) {
        if (isDeclaration(current)) return current;
        const assignment = owningAssignment(current);
        if (assignment) return assignment;
        current = current.parent;
    }
    return undefined;
};

/**
 * The hierarchy item for one declaration. The selection range covers its own name, which is what
 * the expansion resolves the item back through, and the detail names the file, since a hierarchy of
 * rows all called `Components` is otherwise unreadable.
 *
 * @param declaration the declaration the row stands for.
 * @param folderPaths the project folders, used to shorten the path shown as the detail.
 * @returns the item.
 */
const itemFor = (declaration: Declaration, folderPaths: readonly string[]): CallHierarchyItem => {
    const fsPath = getStartOfAstNode(declaration).uri;
    const selectionRange = orderRange(rangeOf(identifierOf(declaration)));
    const kind = isListNode(declaration)
        ? SymbolKind.Array
        : isAssignmentNode(declaration)
          ? SymbolKind.Field
          : SymbolKind.Object;
    return {
        name: nameOf(declaration) || workspaceRelativePath(fsPath, folderPaths),
        kind,
        uri: filePathToUri(fsPath),
        range: unionRange(orderRange(enclosingRange(declaration)), selectionRange),
        selectionRange,
        detail: workspaceRelativePath(fsPath, folderPaths),
    };
};

/** The identity of a row, so one declaration reached twice is listed once. */
const itemKey = (item: CallHierarchyItem): string =>
    `${normalizeUri(item.uri)}#${item.selectionRange.start.line}:${item.selectionRange.start.character}`;

/**
 * Visits every declaration of a document, outermost first.
 *
 * @param root the node to walk.
 * @param visit called for each declaration found.
 */
const forEachDeclaration = (root: AbstractNode | AbstractNodeDocument, visit: (declaration: Declaration) => void): void => {
    const node = root as AbstractNode;
    if (isDeclaration(node)) visit(node);
    if (isGroupNode(node) || isListNode(node) || isDocumentNode(node)) {
        for (const child of node.elements) forEachDeclaration(child, visit);
    } else if (isAssignmentNode(node) && node.right) {
        forEachDeclaration(node.right, visit);
    }
};

/**
 * The declaration the caret names: the innermost one whose written span covers it. A caret inside a
 * value belongs to the member that writes the value, which is the declaration an author means when
 * they open the hierarchy from a line.
 *
 * @param document the parsed document.
 * @param position the caret.
 * @returns the declaration, or undefined when the caret sits in none.
 */
const declarationAt = (document: AbstractNodeDocument, position: Position): Declaration | undefined => {
    const covers = (range: Range): boolean =>
        atOrBefore(range.start.line, range.start.character, position.line, position.character) &&
        atOrBefore(position.line, position.character, range.end.line, range.end.character);
    let innermost: Declaration | undefined;
    forEachDeclaration(document, (declaration) => {
        if (covers(orderRange(enclosingRange(declaration)))) innermost = declaration;
    });
    return innermost;
};

/**
 * The declaration an item stands for, found again in its own file. Only the item's protocol fields
 * survive the round trip through the client, so the file is parsed from the cache the rest of the
 * server reads and the declaration covering the item's selection range is the one it named.
 *
 * @param item the item the client handed back.
 * @param cancellationToken cancels the re-parse.
 * @returns the declaration and its document, or undefined when either is gone.
 */
const declarationForItem = async (
    item: CallHierarchyItem,
    cancellationToken: CancellationToken
): Promise<{ declaration: Declaration; document: AbstractNodeDocument } | undefined> => {
    const document = await cachedParseFilePath(uriToFsPath(item.uri), cancellationToken).catch(() => null);
    if (!document) return undefined;
    const declaration = declarationAt(document, item.selectionRange.start);
    return declaration ? { declaration, document } : undefined;
};

/**
 * The project's manifests, capped so a workspace holding a whole mod library does not turn one
 * expansion into a full walk. Every manifest writes `Actions`, so the mention pre-filter finds them
 * without a folder walk of its own.
 *
 * @param folderPaths the project folders.
 * @param cancellationToken cancels the walk.
 * @returns the parsed manifests.
 */
const manifestsIn = async (
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<AbstractNodeDocument[]> => {
    const manifests: AbstractNodeDocument[] = [];
    for await (const document of documentsMentioning(folderPaths, 'Actions', cancellationToken)) {
        if (!isModRules(document.uri)) continue;
        manifests.push(document);
        if (manifests.length >= MANIFEST_LIMIT) break;
    }
    return manifests;
};

/** The member path of a declaration inside its own file, folded, as an action target spells it. */
const memberPathOf = (declaration: Declaration): string => {
    const segments: string[] = [];
    let current: AbstractNode | undefined = declaration;
    while (current && !isDocumentNode(current)) {
        if (isDeclaration(current)) {
            const name = nameOf(current);
            if (name) segments.unshift(name);
        }
        current = current.parent;
    }
    return segments.join('/').toLowerCase();
};

/**
 * The target value nodes of an action that name the declaration. A target is a quoted path resolved
 * against the game root rather than a reference, so it is matched on the file it ends with and the
 * member path it walks: a target naming a container reaches every member below it too.
 *
 * @param action the parsed action.
 * @param targetUri the normalized uri of the file the declaration sits in.
 * @param memberPath the declaration's member path inside that file, folded.
 * @returns the target nodes naming it.
 */
const actionTargetsNaming = (action: Action, targetUri: string, memberPath: string): AbstractNode[] => {
    const naming: AbstractNode[] = [];
    for (const target of action.targets) {
        const written = normalizeTargetPath(String(target.valueType.value)).toLowerCase();
        const fileEnd = written.indexOf('>');
        if (fileEnd < 0) continue;
        const file = written.slice(0, fileEnd + 1);
        const member = written.slice(fileEnd + 2);
        // The path inside `<…>` is written against the game root, so the two file halves are
        // compared by their tail, which is where a mod's own path and the real one agree.
        const tail = file.replace(/^<\.\/data\//, '').replace(/>$/, '');
        if (!tail || !targetUri.endsWith(tail)) continue;
        if (member && member !== memberPath && !memberPath.startsWith(`${member}/`)) continue;
        naming.push(target);
    }
    return naming;
};

/**
 * The hierarchy root for the caret (`textDocument/prepareCallHierarchy`).
 *
 * @param document the parsed document under the caret.
 * @param position the caret.
 * @param folderPaths the project folders, for the item detail.
 * @returns the single root item, or null when the caret names no declaration.
 */
export const prepareCallHierarchy = (
    document: AbstractNodeDocument,
    position: Position,
    folderPaths: readonly string[]
): CallHierarchyItem[] | null => {
    const declaration = declarationAt(document, position);
    return declaration ? [itemFor(declaration, folderPaths)] : null;
};

/**
 * Everything that reaches one declaration: the references resolving to it, whatever shape they are
 * written in, and the manifest actions naming it as a target. Each row is the declaration that
 * writes the reference, with the reference's own range beside it, so expanding a row walks one hop
 * further out.
 *
 * @param item the item whose callers are wanted.
 * @param folderPaths the project folders the search covers.
 * @param cancellationToken cancels the search.
 * @returns one row per calling declaration, references and action targets alike.
 */
export const incomingCallsOf = async (
    item: CallHierarchyItem,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<CallHierarchyIncomingCall[]> => {
    const found = await declarationForItem(item, cancellationToken);
    if (!found) return [];
    const sites: Location[] = await ReferenceIndex.instance
        .findReferences(found.document, item.selectionRange.start, false, folderPaths, cancellationToken)
        .catch(() => []);

    const byItem = new Map<string, CallHierarchyIncomingCall>();
    const add = (declaration: Declaration, range: Range): void => {
        const from = itemFor(declaration, folderPaths);
        const key = itemKey(from);
        const existing = byItem.get(key);
        if (existing) existing.fromRanges.push(range);
        else byItem.set(key, { from, fromRanges: [range] });
    };

    for (const site of sites) {
        if (cancellationToken.isCancellationRequested) return [...byItem.values()];
        const document = await cachedParseFilePath(uriToFsPath(site.uri), cancellationToken).catch(() => null);
        if (!document) continue;
        const caller = declarationAt(document, site.range.start);
        if (caller) add(caller, site.range);
    }

    // An action reaches the node without writing a reference to it, so the target paths are searched
    // on their own. The row is the action entry, which is where an author edits it.
    const targetUri = normalizeUri(item.uri);
    const memberPath = memberPathOf(found.declaration);
    for (const manifest of await manifestsIn(folderPaths, cancellationToken)) {
        if (cancellationToken.isCancellationRequested) break;
        for (const action of parseModActions(manifest)) {
            for (const target of actionTargetsNaming(action, targetUri, memberPath)) {
                add(enclosingDeclaration(action.group) ?? action.group, orderRange(rangeOf(target)));
            }
        }
    }
    return [...byItem.values()];
};

/**
 * What one declaration reaches: every reference written inside it, resolved to the declaration it
 * names. A reference resolving to a whole file or to nothing contributes no row, so a broken
 * reference is absent rather than a wrong row.
 *
 * @param item the item whose references are wanted.
 * @param folderPaths the project folders, for the item detail.
 * @param cancellationToken cancels the resolutions.
 * @returns one row per declaration the node reaches.
 */
export const outgoingCallsOf = async (
    item: CallHierarchyItem,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<CallHierarchyOutgoingCall[]> => {
    const found = await declarationForItem(item, cancellationToken);
    if (!found) return [];
    const byItem = new Map<string, CallHierarchyOutgoingCall>();
    for (const reference of referenceNodesOf(found.declaration)) {
        if (cancellationToken.isCancellationRequested) break;
        const target = await navigation
            .navigate(String(reference.valueType.value), reference, getStartOfAstNode(reference).uri, cancellationToken)
            .catch(() => null);
        if (!target || isFile(target as FileTree)) continue;
        const declaration = enclosingDeclaration(target as AbstractNode);
        if (!declaration) continue;
        const to = itemFor(declaration, folderPaths);
        const key = itemKey(to);
        const range = orderRange(rangeOf(reference));
        const existing = byItem.get(key);
        if (existing) existing.fromRanges.push(range);
        else byItem.set(key, { to, fromRanges: [range] });
    }
    return [...byItem.values()];
};
