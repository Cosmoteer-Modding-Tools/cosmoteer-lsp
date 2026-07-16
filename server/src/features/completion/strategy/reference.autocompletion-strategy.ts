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
import { getStartOfAstNode, parseFile } from '../../../utils/ast.utils';
import { cachedParseFilePath, cachedReaddir } from '../../../workspace/fs-cache';
import { isRulesFileName, isRulesPathSegment } from '../../../document/document-kind';
import { getParsedFileDocument } from '../../../workspace/parsed-file-cache';
import { CosmoteerWorkspaceService, FileTree, FileWithPath, isFile } from '../../../workspace/cosmoteer-workspace.service';
import { AutoCompletionStrategy } from './autocompletion.strategy';
import { join } from 'path';
import { CancellationError } from '../../../utils/cancellation';
import { FullNavigationStrategy } from '../../navigation/full.navigation-strategy';
import { modAddedGlobalNames, modOverrideMemberNamesForFile, resolveFromModContextOnly } from '../../../mod/mod-context';
import { AddBaseIndex } from '../../../mod/add-base.index';
import { MemberInjectionIndex } from '../../../mod/member-injection.index';
import { findInheritorsOf } from '../../../semantics/inheritor-resolver';
import { stepIntoNode } from '../../../semantics/reference-resolver';

const navigation = new FullNavigationStrategy();
const EMPTY_STRING = '';

/** A reference value node (file, super, or in-file alias) we can dereference to list its target's members. */
const isReferenceValueNode = (node: AbstractNode | null | undefined): node is ValueNode =>
    !!node && isValueNode(node) && node.valueType.type === 'Reference';

/** The reference value to dereference from a node: the node itself, or an assignment's reference right-hand side. */
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
    if (container && (isGroupNode(container) || isListNode(container))) {
        const total = (container.inheritance?.length ?? 0) + AddBaseIndex.instance.appendedBaseCount(container);
        for (let i = 0; i < total; i++) completions.push(`&^/${i}/`);
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
        /** The value text up to the cursor, used instead of the whole written value so a mid-path
         *  edit completes the segment at the cursor. Undefined completes the whole value. */
        valueUpToCursor?: string;
    }): Promise<string[]> {
        const { node, isInheritanceNode, cancellationToken } = args;
        if (node.valueType.type !== 'Reference') {
            return [];
        }
        const reference = args.valueUpToCursor ?? node.valueType.value;
        if (reference === EMPTY_STRING && !isInheritanceNode) {
            return referenceStartCompletions(node);
        } else if (reference === EMPTY_STRING && isInheritanceNode) {
            // Inheritance refs conventionally omit the `&`. Offer the path prefixes plus a `^/N/`
            // caret path per base of the enclosing container (the `X : ^/0/X` extend-own-member
            // idiom) and the sibling names of the inheriting group.
            const completions = ['/', '<./Data', '..', '~', '<'];
            const container = node.parent?.parent;
            if (isGroupNode(container) || isListNode(container)) {
                const total = (container.inheritance?.length ?? 0) + AddBaseIndex.instance.appendedBaseCount(container);
                for (let i = 0; i < total; i++) completions.push(`^/${i}/`);
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
const inheritanceSlotOptions = (container: AbstractNode, search: string): string[] => {
    // Slots are the node's own written bases followed by the bases a mod's `AddBase` action appends,
    // so `^/N/` completion suggests the added slots too (their members already complete, this offers
    // the index that reaches them).
    const staticLength = isGroupNode(container) || isListNode(container) ? (container.inheritance?.length ?? 0) : 0;
    const total = staticLength + AddBaseIndex.instance.appendedBaseCount(container);
    const out: string[] = [];
    for (let i = 0; i < total; i++) {
        if (search === EMPTY_STRING || i.toString().startsWith(search)) out.push(i.toString() + '/');
    }
    return out;
};

const getOptionsForInheritance = (node: AbstractNode, search: string = EMPTY_STRING): string[] => {
    const forNode = isGroupNode(node) || isListNode(node) ? inheritanceSlotOptions(node, search) : [];
    if (forNode.length) return forNode;
    const parent = node.parent;
    if (parent && (isGroupNode(parent) || isListNode(parent))) return inheritanceSlotOptions(parent, search);
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
        // Member names are matched case-insensitively, like the game's node lookup (and stepIntoNode),
        // so typing a lower-case prefix still offers a capitalized member. The client re-filters anyway,
        // but an exact-case pre-filter here would wrongly drop it before the client ever sees it.
        const lowerSearch = search.toLowerCase();
        const matches = (name: string | undefined): boolean =>
            search === EMPTY_STRING || (name?.toLowerCase().startsWith(lowerSearch) ?? false);
        // Members a mod's nested `Overrides`/`Add` merges into this node are offered alongside its own.
        const injected = MemberInjectionIndex.instance.injectedMemberNames(node).filter(matches);
        // A bare `word` line in a group parses to a lone IdentifierNode: a named void field the
        // game keys by name (vanilla: `v_Faction // VIRTUAL; must be inherited`), so it is
        // offered like any member.
        const voidFieldName = (v: AbstractNode): string | undefined =>
            !isListNode(node) && isIdentifierNode(v) ? v.name : undefined;
        const own = node.elements
            .filter(
                (v) =>
                    ((isGroupNode(v) || isListNode(v)) && matches(v.identifier?.name)) ||
                    search === EMPTY_STRING ||
                    (isListNode(v) && v.identifier === undefined) ||
                    (isGroupNode(v) && v.identifier === undefined) ||
                    (isAssignmentNode(v) && matches(v.left.name)) ||
                    matches(voidFieldName(v))
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
        return [...own, ...injected.filter((name) => !own.includes(name))];
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

    // ObjectText `<...>` file paths may use a backslash separator, which the game resolves via the
    // .NET path APIs (see navigateRules in full.navigation-strategy.ts). Normalize to `/` so the
    // segment split and the on-disk lookups behave identically on every OS.
    if (path.startsWith('<')) path = path.replace(/\\/g, '/');

    // Mods write the game-root prefix in any casing (`&<./data/...>`) and the game resolves it
    // through the case-insensitive Windows FS. Canonicalize to `<./Data/` so the case-sensitive
    // branch below matches, mirroring navigateRules' case-insensitive `data` check.
    path = path.replace(/^<\.\/data\//i, '<./Data/');

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
    const indexOfRules = parts.findIndex((part) => isRulesPathSegment(part));
    if (indexOfRules !== -1) {
        // Resolve the referenced file (the path up to and including the `.rules>`
        // token: slicing it off would parse the directory and throw), then list /
        // drill into the in-file path that follows.
        const filePath = join(
            filePathToDirectoryPath(currentLocation),
            parts
                .slice(0, indexOfRules + 1)
                .join('/')
                .replaceAll(/[<>]/g, EMPTY_STRING)
        );
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        const nextNode = await cachedParseFilePath(filePath, cancellationToken);
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
        // `<…file.rules>` or `<…file.rules>/`: list the file's root members, plus any the mod
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
    const indexOfRules = parts.findIndex((part) => isRulesPathSegment(part));
    if (indexOfRules !== -1 && !isWorkshopPath) {
        // parts look like ['<.', 'Data', <dirs…>, 'file.rules>', <in-file…>]. findFile
        // wants the workspace-relative path below Data, with the trailing `>` stripped,
        // not the `<.`/`Data` prefix and not the in-file tail (the previous code passed
        // those, so the lookup never matched).
        const fileSegments = parts.slice(2, indexOfRules + 1).map((part) => part.replace('>', EMPTY_STRING));
        const cosmoteerRules = CosmoteerWorkspaceService.instance.findFile(fileSegments);
        if (!cosmoteerRules) return [];

        const document = await getParsedFileDocument(cosmoteerRules);
        return await optionsInFile(parts.slice(indexOfRules + 1), document, cancellationToken, originUri);
    } else if (isWorkshopPath) {
        return await traverseWorkshopPath(parts, cancellationToken, originUri);
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
const traverseWorkshopPath = async (parts: string[], cancellationToken: CancellationToken, originUri: string) => {
    // The escape resolves against the game Data root: ['<.', 'Data', '..', …, 'file.rules>', <in-file…>]
    // becomes <Data>/../…/file.rules on disk. The file segment keeps its `>` from the split, so it is
    // stripped before touching the filesystem, and everything after it is the in-file member path.
    const pathWithoutData = parts.slice(parts.findIndex((part) => part.startsWith('..')));
    const indexOfRules = pathWithoutData.findIndex((part) => isRulesPathSegment(part));
    if (indexOfRules !== -1) {
        const workshopFilePath = join(
            CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
            pathWithoutData
                .slice(0, indexOfRules + 1)
                .join('/')
                .replaceAll(/[<>]/g, EMPTY_STRING)
        );
        const document = await cachedParseFilePath(workshopFilePath, cancellationToken);
        return await optionsInFile(pathWithoutData.slice(indexOfRules + 1), document, cancellationToken, originUri);
    }
    return await getPathOptions(
        join(CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath, pathWithoutData.join('/'))
    );
};

/**
 *  Get the completion options for a given path, listing files and directories.
 * @param path  The path to get completion options for.
 * @returns  A promise that resolves to an array of completion options for the given path.
 */
const getPathOptions = async (path: string) => {
    const options: string[] = [];
    // The callers assemble the path with `join`, which uses the OS separator (`\` on Windows,
    // where a plain `lastIndexOf('/')` would then miss every boundary). Node's fs accepts `/`
    // on every platform, so normalize once and keep the splitting logic below platform-neutral.
    path = path.replace(/\\/g, '/');

    // One cached listing serves both cases: the typed path as a directory, or, when that listing
    // fails, a partially typed entry whose parent is listed filtered by the typed prefix. The
    // cache bounds this to at most one real `readdir` per directory per TTL window instead of one
    // `existsSync` + `opendir` per keystroke.
    const dirents = await cachedReaddir(path).catch(() => null);
    if (dirents) {
        for (const dirent of dirents) {
            if (dirent.isFile() && isRulesFileName(dirent.name)) options.push(dirent.name + '>');
            else if (dirent.isDirectory()) options.push(dirent.name + '/');
        }
    } else {
        // Compare case-insensitively, matching how Windows and the game resolve paths.
        const lastSlash = path.lastIndexOf('/');
        const subPath = path.substring(lastSlash + 1).toLowerCase();
        const parentDirents = await cachedReaddir(path.substring(0, lastSlash + 1)).catch(() => null);
        if (!parentDirents) return options;
        for (const dirent of parentDirents) {
            if (dirent.isFile() && dirent.name.toLowerCase().startsWith(subPath) && isRulesFileName(dirent.name))
                options.push(dirent.name + '>');
            else if (dirent.isDirectory() && dirent.name.toLowerCase().startsWith(subPath))
                options.push(dirent.name + '/');
        }
    }
    return options;
};

/**
 * Walks a reference path to the container the cursor is in, then the caller lists that container's
 * members (the completion-specific part). The per-segment stepping is delegated to the shared
 * `stepIntoNode` (semantics/reference-resolver.ts), the same resolver navigation, hover and validation
 * use, so completion can never diverge from them on what a segment resolves to (a class of bug this
 * used to reimplement). Cross-file/reference dereferencing is delegated to `FullNavigationStrategy`,
 * and a trailing `/` (list the deref target) and a `:` virtual base are handled after the loop.
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
    // The base a virtual-inheritance `:` was traversed against, so its concrete inheritors' members can
    // be offered alongside the base's own (a member that exists only on a deriving override).
    let virtualBase: AbstractNode | undefined;
    // Walk the in-file segments through the SHARED per-segment resolver `stepIntoNode`, the same one
    // FullNavigationStrategy uses, so completion resolves every segment type (`..`, `~`, `^`, `:`,
    // numeric, named member, case-insensitively) exactly as go-to-definition, hover and validation do.
    // Reimplementing this walk is what repeatedly diverged. AddBase-appended bases and Overrides/Add-
    // injected members come through stepIntoNode's registered extension hooks, so no special cases here.
    for (let i = 0; i < parts.length; i++) {
        const path = parts[i];
        if (path === EMPTY_STRING) break;
        // A `:` statically resolves to the node itself; remember it so the leaf can also offer the
        // members its concrete inheritors supply.
        if (path === ':') virtualBase = currentNode;

        // `isInheritance` mirrors stepIntoNode's flag exactly: the previous segment was `^`.
        const isInheritance = i > 0 && parts[i - 1] === '^';
        let stepped: AbstractNode | null | undefined = stepIntoNode(currentNode, path, isInheritance);

        // stepIntoNode is synchronous and does not follow a reference result (an inheritance base, or a
        // member whose value is `&…`). Dereference it through the shared navigation engine only when a
        // real next segment will descend into it; when the reference is the last walked segment before a
        // trailing `/`, leave it un-dereferenced so the leaf below lists its target through
        // `optionsThroughReference`, which also merges the members a whole-file `Overrides` adds.
        const derefToContinue = i + 1 < parts.length && parts[i + 1] !== EMPTY_STRING;
        if (derefToContinue && isReferenceValueNode(stepped)) {
            const target = await navigation
                .navigate(String(stepped.valueType.value), stepped, getStartOfAstNode(stepped).uri, cancellationToken)
                .catch(() => undefined);
            if (cancellationToken.isCancellationRequested) throw new CancellationError();
            stepped =
                target?.type === 'File'
                    ? await parseFile(target as FileWithPath)
                    : (target as AbstractNode | null | undefined);
        }
        if (stepped == null) break;
        currentNode = stepped;
    }
    // The walk stopped on a reference (or an assignment to
    // one) and the user typed a trailing `/`. Dereference it and list the target's
    // members. Covers `&Alias/` (in-file) and `&Ref/` (cross-file). Without this the
    // guard below would just return [].
    if (parts[parts.length - 1] === EMPTY_STRING) {
        const reference = referenceValueOf(currentNode);
        if (reference) {
            return await optionsThroughReference(reference, cancellationToken, originUri);
        }
    }
    if (isAssignmentNode(currentNode) && currentNode.left.name === parts[parts.length - 2]) return [];
    const search = parts[parts.length - 1];
    const options = getOptionsForParentLevel(search, currentNode, parts[parts.length - 2] === '^');
    if (!virtualBase) return options;
    // Merge the members every concrete inheritor of the base defines, so a `:` path offers a
    // virtual member that only a deriving override supplies, not just the base's own declarations.
    const inheritorNames = await inheritorMemberNames(virtualBase, search, cancellationToken);
    return inheritorNames.length ? [...new Set([...options, ...inheritorNames])] : options;
}

/**
 * The member names every concrete inheritor of a virtual-inheritance base defines, filtered by the
 * typed prefix. These complete a `&Base/:/…` path with the members the derivers supply, including any
 * the base itself only declares virtually (or not at all).
 *
 * @param base the virtual base a `:` was traversed against.
 * @param search the member-name prefix typed so far.
 * @param cancellationToken cancels the inheritor search.
 * @returns the deduplicated inheritor member names.
 */
const inheritorMemberNames = async (
    base: AbstractNode,
    search: string,
    cancellationToken: CancellationToken
): Promise<string[]> => {
    const inheritors = await findInheritorsOf(base, cancellationToken).catch(() => []);
    const names = new Set<string>();
    for (const inheritor of inheritors) for (const name of getOptionsForLevel(inheritor, search)) names.add(name);
    return [...names];
};;

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
