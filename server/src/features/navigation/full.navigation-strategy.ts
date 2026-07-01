import { readdir } from 'fs/promises';
import { AbstractNode, isListNode, isGroupNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { getStartOfAstNode, parseFile, parseFilePath } from '../../utils/ast.utils';
import {
    CosmoteerFile,
    CosmoteerWorkspaceService,
    FileTree,
    FileWithPath,
    isFile,
} from '../../workspace/cosmoteer-workspace.service';
import {
    createDirentPath,
    extractSubstrings,
    filePathToDirectoryPath,
    NavigationStrategy,
    stripReferenceWhitespace,
} from './navigation-strategy';
import * as path from 'path';
import { globalSettings } from '../../settings';
import { stepIntoNode } from '../../semantics/reference-resolver';
import { findMemberThroughInheritance, ResolveReferenceFn } from '../../semantics/inheritance-resolver';
import { CancellationToken } from 'vscode-languageserver';
import { CancellationError } from '../../utils/cancellation';

/** True if `node` is a reference value that points elsewhere (file, super, or in-file alias). */
const isReferenceValue = (node: AbstractNode | null | undefined): node is ValueNode =>
    !!node &&
    isValueNode(node) &&
    node.valueType.type === 'Reference' &&
    (node.valueType.value.startsWith('&') ||
        node.valueType.value.startsWith('<') ||
        node.valueType.value.startsWith('/'));

/**
 * A reference value whose target is the runtime root (`&~/…` / `~/…`). Such a value only resolves
 * once the part is instantiated, so when it is the final member a path lands on, the member itself
 * is a valid target even though its value can't be dereferenced statically (see the terminal-deref
 * handling in {@link FullNavigationStrategy.navigateReference}).
 */
const isRuntimeReferenceValue = (node: AbstractNode | null | undefined): node is ValueNode =>
    isReferenceValue(node) && String(node.valueType.value).replace(/^&/, '').startsWith('~');

/**
 * True if `node` is itself one of its parent group's inheritance references
 * (e.g. the `&BatteryStorageLeft` produced by `BatteryStorageRight : BatteryStorageLeft`).
 * Such a reference names a sibling of the inheriting group, so a relative `&`
 * lookup must resolve against the group's container, not the group's own members.
 */
const isInheritanceMember = (node: AbstractNode | null | undefined): boolean =>
    !!node &&
    !!node.parent &&
    (isGroupNode(node.parent) || isListNode(node.parent)) &&
    !!node.parent.inheritance &&
    node.parent.inheritance.some((inheritance) => inheritance === node);

export class FullNavigationStrategy extends NavigationStrategy<AbstractNode | null | FileWithPath> {
    async navigate(
        path: string,
        startNode: AbstractNode,
        currentLocation: string,
        cancellationToken: CancellationToken,
        // Reference value nodes already dereferenced on this resolution path. Threaded
        // through so an in-file alias cycle (e.g. `A = &B` / `B = &A`) terminates
        // instead of recursing forever — replaces any depth-based guard.
        visited: Set<AbstractNode> = new Set(),
        // Inheritance nodes already seen on this resolution path. Distinct from `visited`
        // (which guards reference-value derefs) and threaded so a cyclic inheritance chain
        // reached through a reference's path terminates instead of overflowing the stack.
        inheritanceVisited?: Set<AbstractNode>
    ): Promise<AbstractNode | null | FileWithPath> {
        if (!path) {
            return null;
        }
        // ObjectText allows insignificant whitespace in a reference path (after `&`, around `/` and
        // segments), e.g. `& <file>/X` or `^ / 0 / Part`. Strip it (outside any `<...>` file path)
        // so the prefix checks below and the segment walk see a canonical `&<file>/X` form.
        path = stripReferenceWhitespace(path);
        let promise;
        if (path.startsWith('&<') || path.startsWith('<')) {
            promise = this.navigateRules(
                path.substring(path.startsWith('&') ? 2 : 1),
                currentLocation,
                cancellationToken
            );
        } else if (path.startsWith('&/') || path.startsWith('/')) {
            promise = this.navigateSuperPath(path, cancellationToken);
        } else if (path.startsWith('&') && startNode.parent) {
            // A relative `&Name` is resolved one scope up from the bearer node. When
            // the bearer is itself an inheritance reference (`Child : Parent`), the
            // name is a sibling of the inheriting group, so resolve against the
            // group's container (grandparent) instead of the group's own members.
            let scope: AbstractNode | undefined = isInheritanceMember(startNode)
                ? startNode.parent.parent
                : startNode.parent;
            // A bare relative `&Name` names a field in the nearest enclosing named scope. List
            // containers are positional (their elements have no names), so a name reference
            // sitting inside a list e.g., `Costs = [&BaseCost * 2]` must resolve against
            // the list's enclosing group, not the list itself. Climb out of any lists.
            // This does not apply to a positional `&N` (a numeric index, e.g. the `&1` of a
            // `: 1` numeric-inheritance) nor to the explicit traversal operators (`..`, `~`,
            // `^`) — those address the list as a real level, so leave their scope alone.
            const leadingSegment = path.substring(1).split('/')[0];
            const isNamedLookup = /^[A-Za-z_]/.test(leadingSegment);
            if (isNamedLookup) while (scope && isListNode(scope)) scope = scope.parent;
            if (!scope) return null;
            promise = this.navigateReference(path.substring(1), scope, cancellationToken, visited, inheritanceVisited);
        } else {
            promise = this.navigateReference(path, startNode, cancellationToken, visited, inheritanceVisited);
        }
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        return await promise.catch(() => null);
    }

    navigateReference = async (
        path: string,
        startNode: AbstractNode,
        cancellationToken: CancellationToken,
        visited: Set<AbstractNode> = new Set(),
        inheritanceVisited?: Set<AbstractNode>
    ): Promise<AbstractNode | null> => {
        // Resolve inheritance refs through `navigate` while forwarding both guard sets, so
        // an inheritance lookup that loops back here shares the same `visited` set.
        const resolveReference: ResolveReferenceFn = (p, n, location, token, inherited) =>
            this.navigate(p, n, location, token, visited, inherited);
        const substrings = extractSubstrings(path);
        let node: AbstractNode | null | undefined = startNode;
        let lastNode: AbstractNode | null | undefined = startNode;
        let index = 0;
        for (const substring of substrings) {
            if (!node) return null;
            node = this.navigateReferenceRecursive(
                substring,
                node,
                substrings.length > 1 && index > 0 && substrings[index - 1] === '^' && substrings[index] === substring
            );
            index++;
            if (!node) {
                // The segment was not found directly: look for it through the
                // inheritance chain.
                // Prefer the node's own inheritance (an inherited member of `lastNode`)
                // before the parent's inheritance. The parent branch only applies when
                // `lastNode` itself can't inherit (e.g. it is an unresolved `^/0/X`
                // reference value whose group parent carries the inheritance).
                if (
                    (isGroupNode(lastNode) || isListNode(lastNode)) &&
                    lastNode.inheritance &&
                    !lastNode.inheritance.some((v) => v.valueType.value === substring)
                ) {
                    node = await findMemberThroughInheritance(
                        lastNode,
                        substring,
                        resolveReference,
                        cancellationToken,
                        // Reuse the threaded guard when this resolution is itself nested inside
                        // an inheritance lookup. Otherwise start one fresh per member lookup.
                        inheritanceVisited ?? new Set()
                    ).catch(() => null);
                } else if (
                    lastNode.parent &&
                    (isGroupNode(lastNode.parent) || isListNode(lastNode.parent)) &&
                    lastNode.parent.inheritance
                ) {
                    node = await findMemberThroughInheritance(
                        lastNode.parent,
                        substring,
                        resolveReference,
                        cancellationToken,
                        inheritanceVisited ?? new Set()
                    ).catch(() => null);
                } else if (lastNode?.type === 'Value' && (lastNode as ValueNode).valueType.type === 'Reference') {
                    node = this.navigateReferenceRecursive(substring, lastNode.parent as AbstractNode);
                    continue;
                }
                if (!node) return null;
            }
            // If the segment resolved to a reference value, dereference it so the
            // remaining path can continue through it. This covers file/super refs
            // (`&<…>`, `&/…`, `<…>`, `/…`) and plain in-file aliases (`&Name`), e.g.
            // `Test1 = &TestBase` then `&Test1/TestValue`. `visited` breaks cycles.
            if (isReferenceValue(node)) {
                // Terminal segment whose member value is a runtime (`~`) reference: the member was
                // found, but its value only resolves at instantiation. Return the member itself
                // rather than failing the whole path — otherwise a valid `&../DamagePerShot`, whose
                // value is `&~/Components/.../Damage`, is wrongly reported as an unknown reference.
                // (A non-`~` broken alias, `Foo = &Typo`, still fails below that is a real error.)
                if (index === substrings.length && isRuntimeReferenceValue(node)) return node;
                if (visited.has(node)) return null;
                visited.add(node);
                const nextNode = await this.navigate(
                    String(node.valueType.value),
                    node,
                    getStartOfAstNode(node).uri,
                    cancellationToken,
                    visited,
                    inheritanceVisited
                ).catch(() => null);
                if (!nextNode) return null;
                if (isFile(nextNode as unknown as FileTree)) {
                    // The reference points at a whole file (no member after `>`), e.g.
                    // `BASE_SOUNDS = &<…/base_sounds.rules>`. Continue the remaining path
                    // INTO that file's document so `…/AudioInterior` still resolves.
                    const file = nextNode as unknown as FileWithPath;
                    const document = file.content.parsedDocument ?? (await parseFile(file));
                    file.content.parsedDocument = document;
                    node = document;
                } else {
                    node = nextNode as AbstractNode;
                }
            }
            lastNode = node;
        }
        return node ?? null;
    };;

    navigateRules = async (path: string, currentLocation: string, cancellationToken: CancellationToken) => {
        // ObjectText `<...>` file paths may use a backslash separator (`<hit_effects\foo.rules>`):
        // `\` is not in `Path.GetInvalidPathChars()`, so the game's PATH_RE accepts it and resolves
        // it on Windows via the .NET path APIs (which treat `\` and `/` interchangeably). Normalize
        // to `/` so the segment walk below — which splits on `/` only — finds the directory/file
        // instead of treating `hit_effects\foo.rules` as one bogus segment and flagging the ref.
        path = path.replace(/\\/g, '/');
        const pathes = extractSubstrings(path);
        const lastWorkspacePathIndex = pathes.findLastIndex((v) => v.includes('>'));
        if (lastWorkspacePathIndex === -1) return null;
        pathes[lastWorkspacePathIndex] = pathes[lastWorkspacePathIndex].replace('>', '');
        // `./Data/...` (case-insensitive — mods write `./data/...` too) addresses the merged game
        // `Data` tree: a mod referencing vanilla via `&<./data/.../foo.rules>` resolves against the
        // game install, not the mod folder. Match `data` case-insensitively so those don't fall
        // through to mod-relative resolution (which can't find them) and get wrongly flagged.
        const isDataRoot = pathes[0] === '.' && pathes[1]?.toLowerCase() === 'data';
        if (isDataRoot && pathes[2] !== '..') {
            const file = this.navigateCosmoteerRules(pathes.slice(2, lastWorkspacePathIndex + 1));
            if (file && lastWorkspacePathIndex < pathes.length - 1) {
                const document = file.content.parsedDocument ?? (await parseFile(file));
                file.content.parsedDocument = document;
                return await this.navigate(
                    pathes.slice(lastWorkspacePathIndex + 1).join('/'),
                    document,
                    document.uri,
                    cancellationToken
                ).catch(() => null);
            }
            return file;
        } else {
            if (isDataRoot && pathes[2] === '..') {
                return await this.navigateRulesByCurrentLocation(
                    pathes.slice(2),
                    CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
                    lastWorkspacePathIndex - 2,
                    cancellationToken
                );
            }
            return await this.navigateRulesByCurrentLocation(
                pathes,
                currentLocation,
                lastWorkspacePathIndex,
                cancellationToken
            );
        }
    };

    navigateRulesByCurrentLocation = async (
        pathes: string[],
        currentLocation: string,
        lastWorkspacePathIndex: number,
        cancellationToken: CancellationToken
    ) => {
        try {
            const cleanedPath = filePathToDirectoryPath(currentLocation);
            let dir = await readdir(cleanedPath, {
                withFileTypes: true,
            });
            let currentPath = cleanedPath;
            let nextPath: string | null = null;
            for (let i = 0; i <= lastWorkspacePathIndex; i++) {
                if (pathes[i] === '..') {
                    dir = await readdir(filePathToDirectoryPath(path.join(currentPath, '..')), {
                        withFileTypes: true,
                    });
                    currentPath = path.join(currentPath, '..');
                    continue;
                }
                for (const dirent of dir) {
                    if (dirent.name.toLowerCase() === pathes[i].toLowerCase()) {
                        if (i === lastWorkspacePathIndex && dirent.isFile()) {
                            const parsed = await parseFilePath(createDirentPath(dirent));
                            if (pathes.length - 1 > lastWorkspacePathIndex) {
                                return await this.navigate(
                                    pathes.slice(lastWorkspacePathIndex + 1).join('/'),
                                    parsed,
                                    dirent.parentPath,
                                    cancellationToken
                                ).catch(() => null);
                            }
                            return parsed;
                        } else if (dirent.isDirectory()) {
                            nextPath = createDirentPath(dirent);
                            currentPath = nextPath;
                            break;
                        } else {
                            return null;
                        }
                    }
                }
                if (nextPath) dir = await readdir(nextPath, { withFileTypes: true });
            }
        } catch (e) {
            // Per-reference resolution failures are routine when scanning the whole tree for
            // find-all-references. Only surface under 'verbose' to avoid flooding the channel.
            if (globalSettings.trace.server === 'verbose') {
                console.error(e);
            }
            throw e;
        }
        return null;
    };

    navigateReferenceRecursive = (substring: string, node: AbstractNode, isInheritance = false) =>
        stepIntoNode(node, substring, isInheritance);

    navigateCosmoteerRules = (pathes: string[]) => {
        const file = CosmoteerWorkspaceService.instance.findFile(pathes) ?? null;
        return file;
    };

    navigateSuperPath = async (path: string, cancellationToken: CancellationToken) => {
        const comsoteerRules = await CosmoteerWorkspaceService.instance.getCosmoteerRules();
        if (!comsoteerRules || !comsoteerRules.content.parsedDocument) return null;
        return await this.navigate(
            path.substring(path.at(0) === '&' ? 2 : 1),
            comsoteerRules.content.parsedDocument,
            comsoteerRules.path,
            cancellationToken
        ).catch(() => null);
    };
}
