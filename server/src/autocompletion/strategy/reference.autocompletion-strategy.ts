import { CancellationToken } from 'vscode-languageserver';
import { extractSubstrings, filePathToDirectoryPath } from '../../navigation/navigation-strategy';
import {
    AbstractNode,
    isArrayNode,
    isAssignmentNode,
    isDocumentNode,
    isObjectNode,
    isValueNode,
    ValueNode,
} from '../../parser/ast';
import { findNodeByIdentifier, getStartOfAstNode, parseFile, parseFilePath } from '../../utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { AutoCompletionStrategy } from './autocompletion.strategy';
import { join } from 'path';
import { CancellationError } from '../../utils/cancellation';
import { opendir } from 'fs/promises';
import { existsSync } from 'fs';
import { FullNavigationStrategy } from '../../navigation/full.navigation-strategy';

const navigation = new FullNavigationStrategy();
const EMPTY_STRING = '';

export class ReferenceAutoCompletionStrategy extends AutoCompletionStrategy<
    string[],
    { node: ValueNode; isInheritanceNode: boolean; cancellationToken: CancellationToken }
> {
    private readonly referenceRegex = /&[a-zA-Z0-9._]*$/;

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
            const completions = ['&', '&<', '&~/', '&../', '&/', '&<./Data/'];
            if (node.parent && (isArrayNode(node.parent) || isObjectNode(node.parent)) && node.parent.inheritance) {
                for (let i = 0; i < node.parent.inheritance.length; i++) {
                    completions.push(`&^/${i}/`);
                }
            }
            return completions;
        } else if (reference === EMPTY_STRING && isInheritanceNode) {
            return ['/', '<./Data', '..', '~', '<'];
        }
        if (this.referenceRegex.test(reference)) {
            return getOptionsForParentLevel(reference, node);
        } else {
            return await traversePath(
                reference.startsWith('&') ? reference.substring(1) : reference,
                node,
                cancellationToken
            ).catch(() => []);
        }
    }
}

const getOptionsForParentLevel = (reference: string, node: AbstractNode, isInheritanceRequested = false): string[] => {
    const value = reference.startsWith('&') ? reference.slice(1) : reference;
    if (isInheritanceRequested) {
        return getOptionsForInheritance(node, value);
    }
    if (isDocumentNode(node) || isObjectNode(node) || isArrayNode(node)) {
        return getOptionsForElement(node, value);
    }
    if (!node.parent) return [];
    return getOptionsForElement(node.parent, value) || [];
};

const getOptionsForInheritance = (node: AbstractNode, search: string = EMPTY_STRING): string[] => {
    if (isObjectNode(node) && node.inheritance) {
        return node.inheritance
            .filter((_, i) => search === EMPTY_STRING || i.toString().startsWith(search))
            .map((_, i) => i.toString() + '/');
    } else if (node.parent && isObjectNode(node.parent) && node.parent.inheritance) {
        return node.parent.inheritance
            .filter((_, i) => search === EMPTY_STRING || i.toString().startsWith(search))
            .map((_, i) => i.toString() + '/');
    }
    return [];
};

const getOptionsForElement = (node: AbstractNode, search: string = EMPTY_STRING): string[] => {
    if (isObjectNode(node) || isArrayNode(node) || isDocumentNode(node)) {
        return node.elements
            .filter(
                (v) =>
                    ((isObjectNode(v) || isArrayNode(v)) && v.identifier?.name.startsWith(search)) ||
                    search === EMPTY_STRING ||
                    (isArrayNode(v) && v.identifier === undefined) ||
                    (isObjectNode(v) && v.identifier === undefined) ||
                    (isAssignmentNode(v) && v.left.name.startsWith(search))
            )
            .map((v) => {
                if ((isArrayNode(v) && v.identifier === undefined) || (isObjectNode(v) && v.identifier === undefined)) {
                    return node.elements.indexOf(v).toString() + '/';
                } else if ((isObjectNode(v) || isArrayNode(v)) && v.identifier) {
                    return v.identifier.name;
                } else if (isAssignmentNode(v)) {
                    return v.left.name;
                }
                return EMPTY_STRING;
            });
    }
    return [];
};

const getOptionsForLevel = (node: AbstractNode, search: string = EMPTY_STRING): string[] => {
    if (isObjectNode(node) || isArrayNode(node) || isDocumentNode(node)) {
        return getOptionsForElement(node, search);
    }
    return [];
};

const traversePath = async (
    path: string,
    node: AbstractNode,
    cancellationToken: CancellationToken
): Promise<string[]> => {
    if (cancellationToken.isCancellationRequested) throw new CancellationError();

    const parts = path === EMPTY_STRING ? [EMPTY_STRING] : extractSubstrings(path);
    if (path.endsWith('/')) parts.push(EMPTY_STRING);
    if (path.startsWith('<./Data/')) {
        return await traverseCosmoteerPath(parts, node, cancellationToken).catch(() => []);
    } else if (path.startsWith('<')) {
        return await traverseOwnPath(parts, node, cancellationToken).catch(() => []);
    } else if (path.startsWith('/')) {
        return await traverseSuperPath(parts, cancellationToken).catch(() => []);
    } else {
        return await traverseReferencePath(parts, node, cancellationToken).catch(() => []);
    }
};

const traverseOwnPath = async (parts: string[], node: AbstractNode, cancellationToken: CancellationToken) => {
    const currentLocation = getStartOfAstNode(node).uri;
    if (parts.some((part) => part.endsWith('.rules>'))) {
        const ownPath = join(
            filePathToDirectoryPath(currentLocation),
            parts
                .slice(
                    0,
                    parts.findIndex((part) => part.endsWith('.rules'))
                )
                .join('/')
                .replaceAll(/[<>]/g, EMPTY_STRING)
        );
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        const nextNode = await parseFilePath(ownPath, cancellationToken);
        return await traversePath(
            parts.slice(parts.findIndex((part) => part.endsWith('.rules'))).join('/'),
            nextNode,
            cancellationToken
        );
    } else {
        const ownPath = join(
            filePathToDirectoryPath(currentLocation),
            parts.join('/').replaceAll(/[<>]/g, EMPTY_STRING)
        );
        return await getPathOptions(ownPath);
    }
};

const traverseCosmoteerPath = async (parts: string[], _node: AbstractNode, cancellationToken: CancellationToken) => {
    // Case ends with .rules>
    const isWorkshopPath = parts.some((part) => part.startsWith('..'));
    if (parts[parts.length - 1].endsWith('.rules>') && !isWorkshopPath) {
        const cosmoteerRules = CosmoteerWorkspaceService.instance.findFile(parts.slice(0, parts.length - 1));
        if (!cosmoteerRules) return [];

        if (!cosmoteerRules.content.parsedDocument) {
            const node = await parseFile(cosmoteerRules);
            cosmoteerRules.content.parsedDocument = node;
        }

        return getOptionsForLevel(cosmoteerRules.content.parsedDocument);
        // case has some paths after .rules>
    } else if (parts.some((part) => part.endsWith('.rules>')) && !isWorkshopPath) {
        const cosmoteerRules = CosmoteerWorkspaceService.instance.findFile(parts.slice(0, parts.length - 1));
        if (!cosmoteerRules) return [];

        if (!cosmoteerRules.content.parsedDocument) {
            const node = await parseFile(cosmoteerRules);
            cosmoteerRules.content.parsedDocument = node;
        }

        return await traversePath(
            parts.slice(parts.findIndex((part) => part.endsWith('.rules'))).join('/'),
            cosmoteerRules.content.parsedDocument,
            cancellationToken
        );
    } else if (isWorkshopPath) {
        return await tarverseWorkshopPath(parts, cancellationToken);
    } else {
        return await getPathOptions(
            join(CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath, parts.join('/').replace('<./Data/', ''))
        );
    }
};

const tarverseWorkshopPath = async (parts: string[], cancellationToken: CancellationToken) => {
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
            cancellationToken
        );
    } else {
        return await getPathOptions(workshopPath);
    }
};

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

const traverseReferencePath = async (parts: string[], node: AbstractNode, cancellationToken: CancellationToken) => {
    if (parts.length === 1) {
        return getOptionsForParentLevel(parts[0], node);
    }
    let currentNode = node;
    if (!(isObjectNode(currentNode) || isArrayNode(currentNode) || isDocumentNode(currentNode)) && node.parent) {
        currentNode = node.parent;
    }
    for (const path of parts) {
        if (path === EMPTY_STRING) break;

        if (path === '^' && node.parent?.parent) {
            currentNode = node.parent?.parent;
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

        if (isObjectNode(currentNode) && !isNaN(parseInt(path)) && currentNode.inheritance) {
            const nextNode = currentNode.inheritance.find((_, i) => i === parseInt(path));
            if (!nextNode) break;
            currentNode = nextNode;
            continue;
        }

        if (isObjectNode(currentNode) || isArrayNode(currentNode) || isDocumentNode(currentNode)) {
            const nextNode = currentNode.elements.find(
                (v, i) =>
                    ((isObjectNode(v) || isArrayNode(v)) && v.identifier?.name === path) ||
                    (isAssignmentNode(v) && v.left.name === path) ||
                    (isArrayNode(currentNode) && i === parseInt(path))
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
            const node = await navigation.navigate(
                value.valueType.value,
                currentNode,
                getStartOfAstNode(currentNode).uri,
                cancellationToken
            );
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
    if (isAssignmentNode(currentNode) && currentNode.left.name === parts[parts.length - 2]) return [];
    return getOptionsForParentLevel(parts[parts.length - 1], currentNode, parts[parts.length - 2] === '^');
};

const traverseSuperPath = async (parts: string[], cancellationToken: CancellationToken) => {
    const rules = await CosmoteerWorkspaceService.instance.getCosmoteerRules();
    if (!rules) return [];
    if (rules.content.parsedDocument && parts.length === 1) {
        return getOptionsForLevel(rules.content.parsedDocument, parts[0]);
    } else if (rules.content.parsedDocument) {
        return await traversePath(parts.join('/'), rules.content.parsedDocument, cancellationToken);
    }
    return [];
};
