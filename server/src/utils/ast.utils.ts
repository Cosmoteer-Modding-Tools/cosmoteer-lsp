import { Position } from 'vscode-languageserver';
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
import {
    CosmoteerWorkspaceService,
    File,
    FileTree,
    isFile,
} from '../workspace/cosmoteer-workspace.service';
import { readFile, readdir } from 'fs/promises';
import { lexer } from '../lexer/lexer';
import { parser } from '../parser/parser';
import { Dirent } from 'fs';
import path = require('path');
import { globalSettings } from '../server';

export const parseFile = async (
    file: File & { readonly path: string }
): Promise<AbstractNodeDocument> => {
    const data = await readFile(file.path, { encoding: 'utf-8' });
    const document = parser(lexer(data), file.path).value;
    return document;
};

export const parseFilePath = async (path: string) => {
    const data = await readFile(path, { encoding: 'utf-8' });
    const document = parser(lexer(data), path).value;
    return document;
};

export const addAllInhertinaceToDocument = async (
    document: AbstractNodeDocument
) => {
    const promises: Promise<void>[] = [];
    for (const node of document.elements) {
        promises.push(addInhertinaceToNodeRecursive(node, document, promises));
    }
    await Promise.all(promises);
};

export const addInhertinaceToNode = async (
    node: ArrayNode | ObjectNode,
    recursiveProtection = 0
) => {
    if (recursiveProtection > 10) return null;
    let promises = [];
    if (!node.inheritance) return null;
    for (const inheritance of node.inheritance) {
        if (inheritance.valueType.type === 'Reference') {
            promises.push(
                navigate(
                    inheritance.valueType.value,
                    node,
                    getStartOfAstNode(node).uri
                )
            );
        }
    }
    const nodes = await Promise.all(promises);
    promises = [];
    const filteredNodes = nodes
        .filter((n) => n !== null)
        .filter((n) => n.type !== 'File') as AbstractNode[];
    for (const filteredNode of filteredNodes) {
        if (
            (isObjectNode(filteredNode) || isArrayNode(filteredNode)) &&
            filteredNode.inheritance
        ) {
            promises.push(
                addInhertinaceToNode(filteredNode, recursiveProtection + 1)
            );
        }
    }
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

const addInhertinaceToNodeRecursive = async (
    node: AbstractNode,
    document: AbstractNodeDocument,
    promises: Promise<void>[]
) => {
    if (isArrayNode(node) || isObjectNode(node) || isDocumentNode(node)) {
        for (const element of node.elements) {
            promises.push(
                addInhertinaceToNodeRecursive(element, document, promises)
            );
        }
        if ((isArrayNode(node) || isObjectNode(node)) && node.inheritance) {
            for (const inheritance of node.inheritance) {
                promises.push(
                    addInhertinaceToNodeRecursive(
                        inheritance,
                        document,
                        promises
                    )
                );
            }
        }
    } else if (
        isAssignmentNode(node) &&
        (isObjectNode(node.right) || isArrayNode(node.right))
    ) {
        promises.push(
            addInhertinaceToNodeRecursive(node.right, document, promises)
        );
    } else if (isValueNode(node) && node.valueType.type === 'Reference') {
        const toAdd = await navigate(node.valueType.value, node, document.uri);
        if (
            toAdd &&
            toAdd?.type !== 'File' &&
            (isObjectNode(toAdd) || isArrayNode(toAdd))
        ) {
            node.parent?.elements.push(...toAdd.elements);
        }
    }
};

export const findNodeAtPosition = (
    document: AbstractNodeDocument,
    position: Position
) => {
    for (const node of document.elements) {
        const foundNode = findNodeAtPositionRecursive(node, position);
        if (foundNode) {
            return foundNode;
        }
    }
};

const findNodeAtPositionRecursive = (
    node: AbstractNode,
    position: Position
): AbstractNode | undefined => {
    if (isObjectNode(node)) {
        for (const property of node.elements) {
            if (node.inheritance) {
                for (const inheritance of node.inheritance) {
                    const foundNode = findNodeAtPositionRecursive(
                        inheritance,
                        position
                    );
                    if (foundNode) {
                        return foundNode;
                    }
                }
            }
            const foundNode = findNodeAtPositionRecursive(property, position);
            if (foundNode) {
                return foundNode;
            }
        }
    } else if (isArrayNode(node)) {
        if (node.inheritance) {
            for (const inheritance of node.inheritance) {
                const foundNode = findNodeAtPositionRecursive(
                    inheritance,
                    position
                );
                if (foundNode) {
                    return foundNode;
                }
            }
        }
        for (const element of node.elements) {
            const foundNode = findNodeAtPositionRecursive(element, position);
            if (foundNode) {
                return foundNode;
            }
        }
    } else if (isAssignmentNode(node)) {
        if (
            node.right &&
            position.line === node.right.position.line &&
            position.character <= node.right.position.characterEnd &&
            position.character >= node.right.position.characterStart
        ) {
            return node.right;
        }
    } else {
        if (
            node.position &&
            position.line === node.position.line &&
            position.character <= node.position.characterEnd &&
            position.character >= node.position.characterStart
        ) {
            return node;
        }
    }
    return undefined;
};

export const getStartOfAstNode = (node: AbstractNode): AbstractNodeDocument => {
    if (node.parent) {
        return getStartOfAstNode(node.parent);
    }
    return node as AbstractNodeDocument;
};

export const navigate = async (
    path: string,
    startNode: AbstractNode,
    currentLocation: string
): Promise<AbstractNode | null | File> => {
    if (!path) {
        return null;
    }
    let promise;
    if (path.startsWith('&<') || path.startsWith('<')) {
        promise = navigateRules(
            path.substring(path.startsWith('&') ? 2 : 1),
            currentLocation
        );
    } else if (path.startsWith('&/') || path.startsWith('/')) {
        promise = navigateSuperPath(path);
    } else if (path.startsWith('&') && startNode.parent) {
        promise = navigateReference(path.substring(1), startNode.parent);
    } else {
        promise = navigateReference(path, startNode);
    }
    return await promise;
};

export const navigateReference = async (
    path: string,
    startNode: AbstractNode
): Promise<AbstractNode | null> => {
    const substrings = extractSubstrings(path);
    let node: AbstractNode | null | undefined = startNode;
    let lastNode: AbstractNode | null | undefined = startNode;
    for (const substring of substrings) {
        node = navigateReferenceRecursive(
            substring,
            node,
            substrings.length > 1 &&
                substrings[0] === '^' &&
                substrings[1] === substring
        );
        if (!node) {
            // if the node is not found, try to add inheritance to the last node
            if (
                lastNode.parent &&
                (isObjectNode(lastNode.parent) ||
                    isArrayNode(lastNode.parent)) &&
                lastNode.parent.inheritance
            ) {
                await addInhertinaceToNode(lastNode.parent);
                node = navigateReferenceRecursive(substring, lastNode.parent);
            } else if (
                lastNode &&
                (isObjectNode(lastNode) || isArrayNode(lastNode)) &&
                lastNode.inheritance &&
                !lastNode.inheritance.some(
                    (v) => v.valueType.value === substring
                )
            ) {
                await addInhertinaceToNode(lastNode);
                node = navigateReferenceRecursive(substring, lastNode);
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
            // TODO handle cross references
            const nextNode = await navigate(
                node.valueType.value,
                node,
                getStartOfAstNode(node).uri
            );
            if (!nextNode || isFile(nextNode as FileTree)) return null;
            node = nextNode as AbstractNode;
        }
        lastNode = node;
    }
    return node;
};

const isNumber = (value: string) => {
    return !isNaN(Number(value));
};

export const navigateReferenceRecursive = (
    substring: string,
    node: AbstractNode,
    isInheritance = false
) => {
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
                if (
                    isAssignmentNode(element) &&
                    element.left.name === substring
                ) {
                    return element.right;
                } else if (
                    isObjectNode(element) &&
                    element.identifier?.name === substring
                ) {
                    return element;
                } else if (
                    isArrayNode(element) &&
                    element.identifier?.name === substring
                ) {
                    return element;
                }
            }
        }
    }
    return null;
};

export const navigateRules = async (path: string, currentLocation: string) => {
    const pathes = extractSubstrings(path);
    const lastWorkspacePathIndex = pathes.findLastIndex((v) => v.includes('>'));
    if (lastWorkspacePathIndex === -1) return null;
    pathes[lastWorkspacePathIndex] = pathes[lastWorkspacePathIndex].replace(
        '>',
        ''
    );
    if (pathes[0] === '.' && pathes[1] === 'Data' && pathes[2] !== '..') {
        const file = navigateCosmoteerRules(
            pathes.slice(2, lastWorkspacePathIndex + 1)
        );
        if (file && lastWorkspacePathIndex < pathes.length - 1) {
            const document =
                file.content.parsedDocument ?? (await parseFile(file));
            file.content.parsedDocument = document;
            return await navigate(
                pathes.slice(lastWorkspacePathIndex + 1).join('/'),
                document,
                document.uri
            );
        }
        return file;
    } else {
        return await navigateRulesByCurrentLocation(
            pathes,
            currentLocation,
            lastWorkspacePathIndex
        );
    }
};

export const navigateRulesByCurrentLocation = async (
    pathes: string[],
    currentLocation: string,
    lastWorkspacePathIndex: number
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
                dir = await readdir(
                    filePathToDirectoryPath(path.join(currentPath, '..')),
                    {
                        withFileTypes: true,
                    }
                );
                currentPath = path.join(currentPath, '..');
                continue;
            }
            for (const dirent of dir) {
                if (dirent.name === pathes[i]) {
                    if (i === lastWorkspacePathIndex && dirent.isFile()) {
                        const parsed = await parseFilePath(
                            createDirentPath(dirent)
                        );
                        if (pathes.length - 1 > lastWorkspacePathIndex) {
                            return await navigate(
                                pathes
                                    .slice(lastWorkspacePathIndex + 1)
                                    .join('/'),
                                parsed,
                                dirent.path
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
            if (nextPath)
                dir = await readdir(nextPath, { withFileTypes: true });
        }
    } catch (e) {
        if (globalSettings.trace.server !== 'off') {
            console.error(e);
        }
        throw e;
    }
    return null;
};

export const filePathToDirectoryPath = (path: string) => {
    if (path.endsWith('.rules') && path.startsWith('file:///')) {
        const cleanedPath = path
            .replace(`file:///`, '')
            .replace('c%3A', 'C:')
            .replaceAll('%20', ' ')
            .replaceAll('%28', '(')
            .replaceAll('%29', ')');
        return cleanedPath.substring(0, cleanedPath.lastIndexOf('/') + 1);
    }
    if (path.endsWith('.rules')) {
        return path.substring(
            0,
            (path.includes('/')
                ? path.lastIndexOf('/')
                : path.lastIndexOf('\\') - 1) + 1
        );
    }
    return path;
};

export const navigateCosmoteerRules = (pathes: string[]) => {
    const file =
        CosmoteerWorkspaceService.instance.findRulesFile(pathes) ?? null;
    return file;
};

export const navigateSuperPath = async (path: string) => {
    const comsoteerRules =
        await CosmoteerWorkspaceService.instance.getCosmoteerRules();
    if (!comsoteerRules || !comsoteerRules.content.parsedDocument) return null;
    return await navigate(
        path.substring(path.at(0) === '&' ? 2 : 1),
        comsoteerRules.content.parsedDocument,
        comsoteerRules.path
    );
};

const extractSubstrings = (input: string): string[] => {
    const regex = /([^/]+)/g;
    const matches = input.matchAll(regex);
    return Array.from(matches, (match) => match[1]);
};

function createDirentPath(dirent: Dirent) {
    // TODO can this be handled by path.join?
    let nextPath: string;
    if (dirent.path.endsWith('/')) {
        nextPath = dirent.path + dirent.name;
    } else {
        nextPath = dirent.path + '\\' + dirent.name;
    }
    return nextPath;
}

