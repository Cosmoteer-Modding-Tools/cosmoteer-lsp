import { readdir } from 'fs/promises';
import {
    AbstractNode,
    AbstractNodeDocument,
    ArrayNode,
    isArrayNode,
    isAssignmentNode,
    isDocumentNode,
    isObjectNode,
    isValueNode,
    ObjectNode,
} from '../parser/ast';
import { getStartOfAstNode, parseFile, parseFilePath } from '../utils/ast.utils';
import {
    CosmoteerFile,
    CosmoteerWorkspaceService,
    FileTree,
    FileWithPath,
    isFile,
} from '../workspace/cosmoteer-workspace.service';
import {
    createDirentPath,
    extractSubstrings,
    filePathToDirectoryPath,
    NavigationStrategy,
} from './navigation-strategy';
import * as path from 'path';
import { globalSettings } from '../server';
import { isNumber } from '../utils/utils';
import { CancellationToken } from 'vscode-languageserver';
import { CancellationError } from '../utils/cancellation';

export class FullNavigationStrategy extends NavigationStrategy<AbstractNode | null | FileWithPath> {
    async navigate(
        path: string,
        startNode: AbstractNode,
        currentLocation: string,
        cancellationToken: CancellationToken
    ): Promise<AbstractNode | null | FileWithPath> {
        if (!path) {
            return null;
        }
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
            promise = this.navigateReference(path.substring(1), startNode.parent, cancellationToken);
        } else {
            promise = this.navigateReference(path, startNode, cancellationToken);
        }
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        return await promise;
    }

    navigateReference = async (
        path: string,
        startNode: AbstractNode,
        cancellationToken: CancellationToken
    ): Promise<AbstractNode | null> => {
        const substrings = extractSubstrings(path);
        let node: AbstractNode | null | undefined = startNode;
        let lastNode: AbstractNode | null | undefined = startNode;
        let index = 0;
        for (const substring of substrings) {
            node = this.navigateReferenceRecursive(
                substring,
                node,
                substrings.length > 1 && index > 0 && substrings[index - 1] === '^' && substrings[index] === substring
            );
            index++;
            if (!node) {
                // if the node is not found, try to add inheritance to the last node
                if (
                    lastNode.parent &&
                    (isObjectNode(lastNode.parent) || isArrayNode(lastNode.parent)) &&
                    lastNode.parent.inheritance
                ) {
                    await this.addInhertinaceToNode(lastNode.parent, 0, cancellationToken);
                    node = this.navigateReferenceRecursive(substring, lastNode.parent);
                } else if (
                    lastNode &&
                    (isObjectNode(lastNode) || isArrayNode(lastNode)) &&
                    lastNode.inheritance &&
                    !lastNode.inheritance.some((v) => v.valueType.value === substring)
                ) {
                    await this.addInhertinaceToNode(lastNode, 0, cancellationToken);
                    node = this.navigateReferenceRecursive(substring, lastNode);
                }
                if (!node) return null;
            }
            if (
                isValueNode(node) &&
                node.valueType.type === 'Reference' &&
                (node.valueType.value.startsWith('&<') ||
                    node.valueType.value.startsWith('&/') ||
                    node.valueType.value.startsWith('<') ||
                    node.valueType.value.startsWith('/'))
            ) {
                const nextNode = await this.navigate(
                    node.valueType.value,
                    node,
                    getStartOfAstNode(node).uri,
                    cancellationToken
                );
                if (!nextNode || isFile(nextNode as unknown as FileTree)) return null;
                node = nextNode as AbstractNode;
            }
            lastNode = node;
        }
        return node;
    };

    navigateRules = async (path: string, currentLocation: string, cancellationToken: CancellationToken) => {
        const pathes = extractSubstrings(path);
        const lastWorkspacePathIndex = pathes.findLastIndex((v) => v.includes('>'));
        if (lastWorkspacePathIndex === -1) return null;
        pathes[lastWorkspacePathIndex] = pathes[lastWorkspacePathIndex].replace('>', '');
        if (pathes[0] === '.' && pathes[1] === 'Data' && pathes[2] !== '..') {
            const file = this.navigateCosmoteerRules(pathes.slice(2, lastWorkspacePathIndex + 1));
            if (file && lastWorkspacePathIndex < pathes.length - 1) {
                const document = file.content.parsedDocument ?? (await parseFile(file));
                file.content.parsedDocument = document;
                return await this.navigate(
                    pathes.slice(lastWorkspacePathIndex + 1).join('/'),
                    document,
                    document.uri,
                    cancellationToken
                );
            }
            return file;
        } else {
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
                                );
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
            if (globalSettings.trace.server !== 'off') {
                console.error(e);
            }
            throw e;
        }
        return null;
    };

    navigateReferenceRecursive = (substring: string, node: AbstractNode, isInheritance = false) => {
        if (isNumber(substring)) {
            const index = Number(substring);
            if (isInheritance && (isArrayNode(node) || isObjectNode(node))) {
                return node.inheritance?.[index];
            }
            if (isArrayNode(node)) {
                return node.elements[index];
            }
        } else if (substring === '..') {
            return node.parent;
        } else if (substring === '^') {
            return node.parent?.parent;
        } else if (substring === '~') {
            return getStartOfAstNode(node);
        } else {
            if (isObjectNode(node) || isDocumentNode(node)) {
                for (const element of node.elements) {
                    if (isAssignmentNode(element) && element.left.name === substring) {
                        return element.right;
                    } else if (isObjectNode(element) && element.identifier?.name === substring) {
                        return element;
                    } else if (isArrayNode(element) && element.identifier?.name === substring) {
                        return element;
                    }
                }
            }
        }
        return null;
    };

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
        );
    };

    addInhertinaceToNode = async (
        node: ArrayNode | ObjectNode,
        recursiveProtection = 0,
        cancellationToken: CancellationToken
    ) => {
        if (recursiveProtection > 10) return null;
        let promises = [];
        if (!node.inheritance) return null;
        for (const inheritance of node.inheritance) {
            if (inheritance.valueType.type === 'Reference') {
                promises.push(
                    this.navigate(inheritance.valueType.value, node, getStartOfAstNode(node).uri, cancellationToken)
                );
            }
        }
        const nodes = await Promise.all(promises);
        promises = [];
        const filteredNodes = nodes.filter((n) => n !== null).filter((n) => n.type !== 'File') as AbstractNode[];
        for (const filteredNode of filteredNodes) {
            if ((isObjectNode(filteredNode) || isArrayNode(filteredNode)) && filteredNode.inheritance) {
                promises.push(this.addInhertinaceToNode(filteredNode, recursiveProtection + 1, cancellationToken));
            }
        }
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        await Promise.all(promises);

        node.elements.push(
            ...filteredNodes
                .map((n) => {
                    if (isObjectNode(n) || isArrayNode(n)) {
                        return n.elements;
                    }
                    return n;
                })
                .flat()
        );
    };

    addInhertinaceToNodeRecursive = async (
        node: AbstractNode,
        document: AbstractNodeDocument,
        promises: Promise<void>[],
        cancellationToken: CancellationToken
    ) => {
        if (isArrayNode(node) || isObjectNode(node) || isDocumentNode(node)) {
            for (const element of node.elements) {
                promises.push(this.addInhertinaceToNodeRecursive(element, document, promises, cancellationToken));
            }
            if ((isArrayNode(node) || isObjectNode(node)) && node.inheritance) {
                for (const inheritance of node.inheritance) {
                    promises.push(
                        this.addInhertinaceToNodeRecursive(inheritance, document, promises, cancellationToken)
                    );
                }
            }
        } else if (isAssignmentNode(node) && (isObjectNode(node.right) || isArrayNode(node.right))) {
            promises.push(this.addInhertinaceToNodeRecursive(node.right, document, promises, cancellationToken));
        } else if (isValueNode(node) && node.valueType.type === 'Reference') {
            const toAdd = await this.navigate(node.valueType.value, node, document.uri, cancellationToken);
            if (toAdd && toAdd?.type !== 'File' && (isObjectNode(toAdd) || isArrayNode(toAdd))) {
                node.parent?.elements.push(...toAdd.elements);
            }
        }
    };
}
