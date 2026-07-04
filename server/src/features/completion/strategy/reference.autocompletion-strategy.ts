import { CancellationToken } from 'vscode-languageserver';
import { extractSubstrings, filePathToDirectoryPath } from '../../navigation/navigation-strategy';
import {
    AbstractNode,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isIdentifierNode,
    isValueNode,
    ValueNode,
} from '../../../core/ast/ast';
import { findNodeByIdentifier, getStartOfAstNode, parseFile, parseFilePath } from '../../../utils/ast.utils';
import { CosmoteerWorkspaceService, FileTree, FileWithPath, isFile } from '../../../workspace/cosmoteer-workspace.service';
import { AutoCompletionStrategy } from './autocompletion.strategy';
import { join } from 'path';
import { CancellationError } from '../../../utils/cancellation';
import { opendir } from 'fs/promises';
import { existsSync } from 'fs';
import { FullNavigationStrategy } from '../../navigation/full.navigation-strategy';
import { modAddedGlobalNames, modOverrideMemberNamesForFile, resolveFromModContextOnly } from '../../../mod/mod-context';

const navigation = new FullNavigationStrategy();
const EMPTY_STRING = '';

/** A reference value node (file, super, or in-file alias) we can dereference to list its target's members. */
const isReferenceValueNode = (node: AbstractNode | null | undefined): node is ValueNode =>
    !!node && isValueNode(node) && node.valueType.type === 'Reference';

/** The reference value to dereference from a node — the node itself, or an assignment's reference right-hand side. */
const referenceValueOf = (node: AbstractNode): ValueNode | undefined => {
    if (isReferenceValueNode(node)) return node;
    if (isAssignmentNode(node) && isReferenceValueNode(node.right)) return node.right;
    return undefined;
};

/**
 * The completions offered when a reference is just being started, either an empty reference value or the
 * lone `&` the lexer classifies as a string. Lists the reference-kind prefixes, plus a `&^/N/` caret path
 * for each base in the enclosing group or list's inheritance so inherited members are discoverable from
 * the first keystroke. The caret paths come from the nearest enclosing container, since `&^` resolves
 * against the group or list the reference lives in.
 * @param node the value node the reference is being typed on.
 * @returns the reference-start prefix completions.
 */
const referenceStartCompletions = (node: AbstractNode): string[] => {
    const completions = ['&', '&<', '&~/', '&../', '&/', '&<./Data/', '&:/'];
    let container: AbstractNode | undefined = node.parent;
    while (container && !(isGroupNode(container) || isListNode(container))) container = container.parent;
    if (container && (isGroupNode(container) || isListNode(container)) && container.inheritance) {
        for (let i = 0; i < container.inheritance.length; i++) completions.push(`&^/${i}/`);
    }
    return completions;
};

/** Dereference a reference value and list the members of whatever it points at (cross-file aware). */
const optionsThroughReference = async (
    reference: ValueNode,
    cancellationToken: CancellationToken,
    originUri: string
): Promise<string[]> => {
    const resolved = await navigation
        .navigate(String(reference.valueType.value), reference, getStartOfAstNode(reference).uri, cancellationToken)
        .catch(() => undefined);
    if (!resolved) return [];
    const own =
        (resolved as { type?: string }).type === 'File'
            ? getOptionsForLevel(await parseFile(resolved as FileWithPath))
            : getOptionsForLevel(resolved as AbstractNode);
    // The reference may target a file the mod patches with a whole-file/global `Overrides`
    // (e.g. `&/INDICATORS/` → indicators.rules + the mod's added indicators): offer those
    // mod-added members alongside the file's own so completion reflects the effective tree.
    const modAdded = await modOverrideMemberNamesForFile(resolved as AbstractNode | FileWithPath, originUri).catch(
        () => []
    );
    return modAdded.length ? [...new Set([...own, ...modAdded])] : own;
};

/**
 *  Path-completion for reference values (file, super, in-file alias). Lists the members of 
 *  the referenced entity, supporting cross-file navigation and mod overrides.
 */
export class ReferenceAutoCompletionStrategy extends AutoCompletionStrategy<
    string[],
    { node: ValueNode; isInheritanceNode: boolean; cancellationToken: CancellationToken }
> {
    /** Regex to match reference values. */
    private readonly referenceRegex = /&[a-zA-Z0-9._]*$/;

    /**
     *  Complete a reference value node, listing the members of the referenced entity.
     * @param args  The arguments for the completion, including the node, whether it's an inheritance node, and the cancellation token.
     * @returns  A promise that resolves to an array of completion strings.
     */
    async complete(args: {
        node: ValueNode;
        isInheritanceNode: boolean;
        cancellationToken: CancellationToken;
    }): Promise<string[]> {
        const { node, isInheritanceNode, cancellationToken } = args;
        if (node.valueType.type !== 'Reference') {
            return [];
        }
        const reference = node.valueType.value;
        if (reference === EMPTY_STRING && !isInheritanceNode) {
            return referenceStartCompletions(node);
        } else if (reference === EMPTY_STRING && isInheritanceNode) {
            // Inheritance refs conventionally omit the `&`. Offer the path prefixes plus a `^/N/`
            // caret path per base of the enclosing container (the `X : ^/0/X` extend-own-member
            // idiom) and the sibling names of the inheriting group.
            const completions = ['/', '<./Data', '..', '~', '<'];
            const container = node.parent?.parent;
            if ((isGroupNode(container) || isListNode(container)) && container.inheritance) {
                for (let i = 0; i < container.inheritance.length; i++) completions.push(`^/${i}/`);
            }
            if (container) completions.push(...getOptionsForLevel(container));
            const inheritingName =
                isGroupNode(node.parent) || isListNode(node.parent) ? node.parent.identifier?.name : undefined;
            return inheritingName ? completions.filter((option) => option !== inheritingName) : completions;
        }
        // An inheritance ref (`Child : Par…`) names a sibling of the inheriting group, so its
        // relative lookups must resolve against the group's container, not the group's own
        // members (mirrors `isInheritanceMember` in the navigation strategy).
        const startNode = isInheritanceNode && node.parent?.parent ? node.parent.parent : node;
        if (this.referenceRegex.test(reference)) {
            const options = getOptionsForParentLevel(reference, startNode);
            // Don't offer the inheriting group itself as its own base (self-inheritance).
            const inheritingName =
                isGroupNode(node.parent) || isListNode(node.parent) ? node.parent.identifier?.name : undefined;
            return isInheritanceNode && inheritingName
                ? options.filter((option) => option !== inheritingName)
                : options;
        } else {
            return await traversePath(
                reference.startsWith('&') ? reference.substring(1) : reference,
                startNode,
                cancellationToken,
                getStartOfAstNode(node).uri
            ).catch(() => []);
        }
    }

    /**
     * The reference-start completions for a value node that begins a reference but is not yet a full
     * reference token. The lexer classifies a lone `&` as a string, so the reference completer routes it
     * here to offer the reference-kind prefixes the moment the user types `&`, including a `&^/N/` caret
     * path for each base in the enclosing inheritance.
     * @param node the in-progress value node the reference is being typed on.
     * @returns the reference-start prefix completions.
     */
    completeReferenceStart(node: AbstractNode): string[] {
        return referenceStartCompletions(node);
    }

    /**
     * Complete a raw reference/path string (not necessarily on `node`), reusing the
     * file/cosmoteer/workshop traversal. Used for mod-action target paths, which are
     * normalized to `<./Data/...>` before being passed here.
     */
    async completeRawPath(path: string, node: AbstractNode, cancellationToken: CancellationToken): Promise<string[]> {
        return traversePath(
            path.startsWith('&') ? path.substring(1) : path,
            node,
            cancellationToken,
            getStartOfAstNode(node).uri
        ).catch(() => []);
    }
}

/**
 *  Get the completion options for the parent level of a reference, considering inheritance if requested.
 * @param reference the reference string to resolve
 * @param node  the AST node from which the reference originates
 * @param isInheritanceRequested  whether to consider inheritance when resolving the reference
 * @returns  an array of completion options for the parent level of the reference
 */
const getOptionsForParentLevel = (reference: string, node: AbstractNode, isInheritanceRequested = false): string[] => {
    const value = reference.startsWith('&') ? reference.slice(1) : reference;
    if (isInheritanceRequested) {
        return getOptionsForInheritance(node, value);
    }
    if (isDocumentNode(node) || isGroupNode(node) || isListNode(node)) {
        return getOptionsForElement(node, value);
    }
    if (!node.parent) return [];
    return getOptionsForElement(node.parent, value) || [];
};

/**
 *  Get the completion options for a node considering inheritance and element options.
 * @param node  the AST node to get options for
 * @param search  the search string to filter options by
 * @returns  an array of completion options for the node
 */
const getOptionsForInheritance = (node: AbstractNode, search: string = EMPTY_STRING): string[] => {
    if (isGroupNode(node) && node.inheritance) {
        return node.inheritance
            .filter((_, i) => search === EMPTY_STRING || i.toString().startsWith(search))
            .map((_, i) => i.toString() + '/');
    } else if (node.parent && isGroupNode(node.parent) && node.parent.inheritance) {
        return node.parent.inheritance
            .filter((_, i) => search === EMPTY_STRING || i.toString().startsWith(search))
            .map((_, i) => i.toString() + '/');
    }
    return [];
};

/**
 *  Get the completion options for a node's elements, filtered by a search string.
 * @param node  the AST node to get options for
 * @param search  the search string to filter options by
 * @returns  an array of completion options for the node's elements
 */
const getOptionsForElement = (node: AbstractNode, search: string = EMPTY_STRING): string[] => {
    if (isGroupNode(node) || isListNode(node) || isDocumentNode(node)) {
        // A bare `word` line in a group parses to a lone IdentifierNode: a named void field the
        // game keys by name (vanilla: `v_Faction // VIRTUAL; must be inherited`), so it is
        // offered like any member.
        const voidFieldName = (v: AbstractNode): string | undefined =>
            !isListNode(node) && isIdentifierNode(v) ? v.name : undefined;
        return node.elements
            .filter(
                (v) =>
                    ((isGroupNode(v) || isListNode(v)) && v.identifier?.name.startsWith(search)) ||
                    search === EMPTY_STRING ||
                    (isListNode(v) && v.identifier === undefined) ||
                    (isGroupNode(v) && v.identifier === undefined) ||
                    (isAssignmentNode(v) && v.left.name.startsWith(search)) ||
                    voidFieldName(v)?.startsWith(search)
            )
            .map((v) => {
                if ((isListNode(v) && v.identifier === undefined) || (isGroupNode(v) && v.identifier === undefined)) {
                    return node.elements.indexOf(v).toString() + '/';
                } else if ((isGroupNode(v) || isListNode(v)) && v.identifier) {
                    return v.identifier.name;
                } else if (isAssignmentNode(v)) {
                    return v.left.name;
                }
                return voidFieldName(v) ?? EMPTY_STRING;
            });
    }
    return [];
};

/**
 *  Get the completion options for a node's parent level, filtered by a search string.
 * @param node  the AST node to get options for
 * @param search  the search string to filter options by
 * @returns  an array of completion options for the node's parent level
 */
const getOptionsForLevel = (node: AbstractNode, search: string = EMPTY_STRING): string[] => {
    if (isGroupNode(node) || isListNode(node) || isDocumentNode(node)) {
        return getOptionsForElement(node, search);
    }
    return [];
};

/**
 *  Traverse a reference path, resolving it to the target entity and listing its members.
 * @param path  the reference path to traverse
 * @param node  the AST node from which the reference originates
 * @param cancellationToken  the cancellation token to abort the operation if needed
 * @param originUri  the URI of the file the user is editing, used to locate the owning mod for mod-added members
 * @returns  a promise that resolves to an array of completion options for the target entity
 */
const traversePath = async (
    path: string,
    node: AbstractNode,
    cancellationToken: CancellationToken,
    originUri: string
): Promise<string[]> => {
    if (cancellationToken.isCancellationRequested) throw new CancellationError();

    const parts = path === EMPTY_STRING ? [EMPTY_STRING] : extractSubstrings(path);
    if (path.endsWith('/')) parts.push(EMPTY_STRING);
    if (path.startsWith('<./Data/')) {
        return await traverseCosmoteerPath(parts, node, cancellationToken, originUri).catch(() => []);
    } else if (path.startsWith('<')) {
        return await traverseOwnPath(parts, node, cancellationToken, originUri).catch(() => []);
    } else if (path.startsWith('/')) {
        return await traverseSuperPath(parts, node, cancellationToken, originUri).catch(() => []);
    } else {
        return await traverseReferencePath(parts, node, cancellationToken, originUri).catch(() => []);
    }
};

/**
 *  Traverse a reference path that starts with a reference to another entity, resolving it to the target entity and listing its members.
 * @param parts  The parts of the reference path to traverse
 * @param node  The AST node from which the reference originates
 * @param cancellationToken  The cancellation token to abort the operation if needed
 * @param originUri  The URI of the file the user is editing, used to locate the owning mod for mod-added members
 * @returns  A promise that resolves to an array of completion options for the target entity
 */
const traverseOwnPath = async (
    parts: string[],
    node: AbstractNode,
    cancellationToken: CancellationToken,
    originUri: string
) => {
    const currentLocation = getStartOfAstNode(node).uri;
    const indexOfRules = parts.findIndex((part) => part.endsWith('.rules>'));
    if (indexOfRules !== -1) {
        // Resolve the referenced file (the path up to and including the `.rules>`
        // token — slicing it off would parse the directory and throw), then list /
        // drill into the in-file path that follows.
        const filePath = join(
            filePathToDirectoryPath(currentLocation),
            parts
                .slice(0, indexOfRules + 1)
                .join('/')
                .replaceAll(/[<>]/g, EMPTY_STRING)
        );
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        const nextNode = await parseFilePath(filePath, cancellationToken);
        return await optionsInFile(parts.slice(indexOfRules + 1), nextNode, cancellationToken, originUri);
    } else {
        const ownPath = join(
            filePathToDirectoryPath(currentLocation),
            parts.join('/').replaceAll(/[<>]/g, EMPTY_STRING)
        );
        return await getPathOptions(ownPath);
    }
};

/** List members at the in-file path `inFileParts` within a freshly-resolved document. */
const optionsInFile = async (
    inFileParts: string[],
    document: AbstractNode,
    cancellationToken: CancellationToken,
    originUri: string
): Promise<string[]> => {
    const meaningful = inFileParts.filter((part) => part !== EMPTY_STRING);
    if (meaningful.length === 0) {
        // `<…file.rules>` or `<…file.rules>/` — list the file's root members, plus any the mod
        // merges into that file via a whole-file Override (effective tree).
        const own = getOptionsForLevel(document);
        const modAdded = await modOverrideMemberNamesForFile(document, originUri).catch(() => []);
        return modAdded.length ? [...new Set([...own, ...modAdded])] : own;
    }
    return await traverseReferencePath(inFileParts, document, cancellationToken, originUri);
};

/**
 *  Traverse a reference path that starts with a reference to a super entity, resolving it to the target entity and listing its members.
 * @param parts  The parts of the reference path to traverse
 * @param _node  The AST node from which the reference originates
 * @param cancellationToken  The cancellation token to abort the operation if needed
 * @param originUri  The URI of the file the user is editing, used to locate the owning mod for mod-added members
 * @returns  A promise that resolves to an array of completion options for the target entity
 */
const traverseCosmoteerPath = async (
    parts: string[],
    _node: AbstractNode,
    cancellationToken: CancellationToken,
    originUri: string
) => {
    const isWorkshopPath = parts.some((part) => part.startsWith('..'));
    const indexOfRules = parts.findIndex((part) => part.endsWith('.rules>'));
    if (indexOfRules !== -1 && !isWorkshopPath) {
        // parts look like ['<.', 'Data', <dirs…>, 'file.rules>', <in-file…>]. findFile
        // wants the workspace-relative path BELOW Data, with the trailing `>` stripped —
        // not the `<.`/`Data` prefix and not the in-file tail (the previous code passed
        // those, so the lookup never matched).
        const fileSegments = parts.slice(2, indexOfRules + 1).map((part) => part.replace('>', EMPTY_STRING));
        const cosmoteerRules = CosmoteerWorkspaceService.instance.findFile(fileSegments);
        if (!cosmoteerRules) return [];

        if (!cosmoteerRules.content.parsedDocument) {
            cosmoteerRules.content.parsedDocument = await parseFile(cosmoteerRules);
        }

        return await optionsInFile(
            parts.slice(indexOfRules + 1),
            cosmoteerRules.content.parsedDocument,
            cancellationToken,
            originUri
        );
    } else if (isWorkshopPath) {
        return await tarverseWorkshopPath(parts, cancellationToken, originUri);
    } else {
        return await getPathOptions(
            join(CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath, parts.join('/').replace('<./Data/', ''))
        );
    }
};

/**
 *  Traverse a reference path that starts with a reference to a workshop path, resolving it to the target entity and listing its members.
 * @param parts  The parts of the reference path to traverse
 * @param cancellationToken  The cancellation token to abort the operation if needed
 * @param originUri  The URI of the file the user is editing, used to locate the owning mod for mod-added members
 * @returns  A promise that resolves to an array of completion options for the target entity
 */
const tarverseWorkshopPath = async (parts: string[], cancellationToken: CancellationToken, originUri: string) => {
    const pathWithoutData = parts.slice(parts.findIndex((part) => part.startsWith('..')));
    const workshopPath = join(CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath, pathWithoutData.join('/'));
    if (parts[parts.length - 1].endsWith('.rules>')) {
        const cosmoteerRules = await parseFilePath(workshopPath, cancellationToken);
        return getOptionsForLevel(cosmoteerRules);
    } else if (parts.some((part) => part.endsWith('.rules>'))) {
        const cosmoteerRules = await parseFilePath(workshopPath, cancellationToken);
        return await traversePath(
            parts.slice(parts.findIndex((part) => part.endsWith('.rules'))).join('/'),
            cosmoteerRules,
            cancellationToken,
            originUri
        );
    } else {
        return await getPathOptions(workshopPath);
    }
};

/**
 *  Get the completion options for a given path, listing files and directories.
 * @param path  The path to get completion options for.
 * @returns  A promise that resolves to an array of completion options for the given path.
 */
const getPathOptions = async (path: string) => {
    const options: string[] = [];

    if (existsSync(path)) {
        const dirents = await opendir(path);

        for await (const dirent of dirents) {
            if (dirent.isFile() && dirent.name.endsWith('.rules')) options.push(dirent.name + '>');
            else if (dirent.isDirectory()) options.push(dirent.name + '/');
        }
    } else {
        const subPath = path.substring(path.lastIndexOf('/') + 1);
        const dirents = await opendir(path.substring(0, path.lastIndexOf('/') + 1));
        for await (const dirent of dirents) {
            if (dirent.isFile() && dirent.name.startsWith(subPath) && dirent.name.endsWith('.rules'))
                options.push(dirent.name + '>');
            else if (dirent.isDirectory() && dirent.name.startsWith(subPath)) options.push(dirent.name + '/');
        }
    }
    return options;
};

/** This walk intentionally differs from the canonical single-step navigation
* in semantics/reference-resolver.ts (`stepIntoNode`, used by FullNavigationStrategy):
 * for completion we enumerate candidates, so we keep assignment nodes (not their
 * right-hand side), anchor `^` on the original node, and treat numeric segments on
 * groups as inheritance indices. Cross-file/reference dereferencing is delegated to
 * FullNavigationStrategy.navigate so the file-resolution engine is not duplicated.
 */
const traverseReferencePath = async (
    parts: string[],
    node: AbstractNode,
    cancellationToken: CancellationToken,
    originUri: string
) => {
    if (parts.length === 1) {
        return getOptionsForParentLevel(parts[0], node);
    }
    let currentNode = node;
    if (!(isGroupNode(currentNode) || isListNode(currentNode) || isDocumentNode(currentNode)) && node.parent) {
        currentNode = node.parent;
    }
    for (const path of parts) {
        if (path === EMPTY_STRING) break;

        if (path === '^') {
            // `^` selects the current node's own inheritance anchor, mirroring the game's
            // `OTNode.FindAtPath` and the shared resolver's `stepInto` in semantics/reference-resolver.ts.
            // For a group or list that anchor is the node itself, and the following `/N` then reads its
            // `inheritance`, so keep `currentNode`. Only a value or void node, which has no inheritance of
            // its own, climbs to its owning group (the grandparent). The previous code jumped to the
            // original node's grandparent unconditionally. For `X = &^/0/` that landed on the document,
            // because value nodes are parented to their enclosing group, so `/0` found no member and
            // completion listed the base file's root instead of the inherited base's members.
            if (!(isGroupNode(currentNode) || isListNode(currentNode)) && currentNode.parent?.parent) {
                currentNode = currentNode.parent.parent;
            }
            continue;
        }

        if (path === '..' && currentNode.parent) {
            currentNode = currentNode.parent;
            continue;
        }
        if (path === '~') {
            currentNode = getStartOfAstNode(currentNode);
            continue;
        }
        if (path === ':') {
            // `:` selects the most-derived inheritor (virtual inheritance), statically approximated
            // as the node itself (see `stepIntoNode` in semantics/reference-resolver.ts). `currentNode`
            // has already been normalized to a container above, so keep it.
            continue;
        }

        if (isGroupNode(currentNode) && !isNaN(parseInt(path)) && currentNode.inheritance) {
            const nextNode = currentNode.inheritance.find((_, i) => i === parseInt(path));
            if (!nextNode) break;
            currentNode = nextNode;
            continue;
        }

        if (isGroupNode(currentNode) || isListNode(currentNode) || isDocumentNode(currentNode)) {
            const nextNode = currentNode.elements.find(
                (v, i) =>
                    ((isGroupNode(v) || isListNode(v)) && v.identifier?.name === path) ||
                    (isAssignmentNode(v) && v.left.name === path) ||
                    (isListNode(currentNode) && i === parseInt(path))
            );
            if (!nextNode) break;
            currentNode = nextNode;
            continue;
        }
        if (
            (isValueNode(currentNode) && currentNode.valueType.type === 'Reference') ||
            (isAssignmentNode(currentNode) &&
                isValueNode(currentNode.right) &&
                currentNode.right.valueType.type === 'Reference')
        ) {
            const value = (isValueNode(currentNode) ? currentNode : currentNode.right) as ValueNode;
            if (value.valueType.type !== 'Reference') return [];
            const node = await navigation
                .navigate(value.valueType.value, currentNode, getStartOfAstNode(currentNode).uri, cancellationToken)
                .catch(() => undefined);
            if (node?.type === 'File') {
                if (cancellationToken.isCancellationRequested) throw new CancellationError();
                const parsedDocument = await parseFile(node);
                currentNode = parsedDocument;
                const nextNode = findNodeByIdentifier(currentNode, path);
                if (!nextNode) break;
                currentNode = nextNode;
            } else if (node?.type) {
                currentNode = node;
                const nextNode = findNodeByIdentifier(currentNode, path);
                if (!nextNode) break;
                currentNode = nextNode;
            } else {
                return [];
            }
        }
    }
    // The walk stopped on a reference (or an assignment to
    // one) and the user typed a trailing `/`. Dereference it and list the target's
    // members — covers `&Alias/` (in-file) and `&Ref/` (cross-file). Without this the
    // guard below would just return [].
    if (parts[parts.length - 1] === EMPTY_STRING) {
        const reference = referenceValueOf(currentNode);
        if (reference) {
            return await optionsThroughReference(reference, cancellationToken, originUri);
        }
    }
    if (isAssignmentNode(currentNode) && currentNode.left.name === parts[parts.length - 2]) return [];
    return getOptionsForParentLevel(parts[parts.length - 1], currentNode, parts[parts.length - 2] === '^');
};

/**
 *  Traverse a reference path that starts with a reference to a super entity, resolving it to the target entity and listing its members.
 * @param parts  The parts of the reference path to traverse
 * @param node  The AST node from which the reference originates, used to resolve mod-added globals
 * @param cancellationToken  The cancellation token to abort the operation if needed
 * @param originUri  The URI of the file the user is editing, used to locate the owning mod for mod-added members
 * @returns  A promise that resolves to an array of completion options for the target entity
 */
const traverseSuperPath = async (
    parts: string[],
    node: AbstractNode,
    cancellationToken: CancellationToken,
    originUri: string
) => {
    const rules = await CosmoteerWorkspaceService.instance.getCosmoteerRules();
    if (!rules?.content.parsedDocument) return [];
    if (parts.length === 1) {
        // Root level of the effective game tree: the vanilla cosmoteer.rules members plus the
        // globals the mod itself adds there (`SW_SOUNDS = &<…>` in the mod's cosmoteer.rules or
        // manifest `Add` actions), so `&/` offers a mod's own convenience globals too.
        const own = getOptionsForLevel(rules.content.parsedDocument, parts[0]);
        const modAdded = (await modAddedGlobalNames(originUri).catch(() => [])).filter((name) =>
            name.startsWith(parts[0])
        );
        return modAdded.length ? [...new Set([...own, ...modAdded])] : own;
    }
    // A deeper path may run through a mod-added global vanilla navigation can't see (`/SW_SOUNDS/…`).
    // Try the mod context first: it resolves only when the leading global is mod-added (null for
    // vanilla-rooted paths), whereas the vanilla walk below never returns empty for an unknown
    // member (it falls back to listing the current level), so it can't signal the miss itself.
    const resolved = await resolveFromModContextOnly(
        '/' + parts.slice(0, parts.length - 1).join('/'),
        node,
        cancellationToken
    ).catch(() => null);
    if (resolved) {
        const target = isFile(resolved as unknown as FileTree)
            ? await parseFile(resolved as FileWithPath)
            : (resolved as AbstractNode);
        const options = getOptionsForLevel(target, parts[parts.length - 1]);
        if (options.length > 0) return options;
    }
    return await traversePath(parts.join('/'), rules.content.parsedDocument, cancellationToken, originUri);
};
