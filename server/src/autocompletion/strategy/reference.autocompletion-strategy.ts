import { CancellationToken } from 'vscode-languageserver';
import { extractSubstrings } from '../../navigation/navigation-strategy';
import {
    AbstractNode,
    isArrayNode,
    isAssignmentNode,
    isDocumentNode,
    isObjectNode,
    isValueNode,
    ValueNode,
} from '../../parser/ast';
import { getStartOfAstNode, parseFile, parseFilePath } from '../../utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { AutoCompletionStrategy } from './autocompletion.strategy';
import { join } from 'path';
import { CancellationError } from '../../utils/cancellation';
import { opendir } from 'fs/promises';
import { existsSync } from 'fs';
import { FullNavigationStrategy } from '../../navigation/full.navigation-strategy';

const navigation = new FullNavigationStrategy();

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
        if (reference === '' && !isInheritanceNode) {
            const completions = ['&', '&<', '&~/', '&../', '&/', '&<./Data/'];
            if (node.parent && (isArrayNode(node.parent) || isObjectNode(node.parent)) && node.parent.inheritance) {
                for (let i = 0; i < node.parent.inheritance.length; i++) {
                    completions.push(`&^/${i}/`);
                }
            }
            return completions;
        } else if (reference === '' && isInheritanceNode) {
            return ['/', '<./Data', '..', '~', '<'];
        }
        if (this.referenceRegex.test(reference)) {
            return getOptionsForParentLevel(reference, node);
        } else {
            return await traversePath(
                reference.startsWith('&') ? reference.substring(1) : reference,
                node,
                cancellationToken
            );
        }
    }
}

const getOptionsForParentLevel = (reference: string, node: AbstractNode): string[] => {
    const value = reference.startsWith('&') ? reference.slice(1) : reference;
    if (isDocumentNode(node) || isObjectNode(node) || isArrayNode(node)) {
        return getOptionsForElement(node, value);
    }
    if (!node.parent) return [];
    return getOptionsForElement(node.parent, value) || [];
};

const getOptionsForElement = (node: AbstractNode, search: string = ''): string[] => {
    if (isObjectNode(node) || isArrayNode(node) || isDocumentNode(node)) {
        return node.elements
            .filter(
                (v) =>
                    ((isObjectNode(v) || isArrayNode(v)) && v.identifier?.name.startsWith(search)) ||
                    search === '' ||
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
                return '';
            });
    }
    return [];
};

const getOptionsForLevel = (node: AbstractNode, search: string = ''): string[] => {
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
    const parts = extractSubstrings(path);
    if (path.endsWith('/')) parts.push('');
    if (path.startsWith('<./Data/')) {
        return await traverseCosmoteerPath(parts, node, cancellationToken);
    } else if (path.startsWith('/')) {
        return await traverseSuperPath(parts, cancellationToken);
    } else if (path.startsWith('^/')) {
        return await traverseInheritancePath(parts, node, cancellationToken);
    } else {
        return await traverseReferencePath(parts, node, cancellationToken);
    }
};

const traverseInheritancePath = async (parts: string[], node: AbstractNode, cancellationToken: CancellationToken) => {
    if (node.parent && (isObjectNode(node.parent) || isArrayNode(node.parent)) && node.parent.inheritance) {
        if (parts.length < 2) return node.parent.inheritance.map((_v, i) => `${i}/`);
        const inheritanceIndex = parseInt(parts[0].substring(1));
        const inheritanceNode = node.parent.inheritance[inheritanceIndex];
        if (!inheritanceNode) return [];
        return await traversePath(parts.slice(2).join('/'), inheritanceNode, cancellationToken);
    }
    return [];
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
        return await getPathOptions(join(CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath, parts.join('/')));
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
        if (path === '..' && currentNode.parent) {
            currentNode = currentNode.parent;
            continue;
        }
        if (path === '~') {
            currentNode = getStartOfAstNode(currentNode);
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
            } else if (node?.type) {
                currentNode = node;
            } else {
                return [];
            }
        }
    }
    return getOptionsForParentLevel(parts[parts.length - 1], currentNode);
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
