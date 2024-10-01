import { extractSubstrings } from '../../navigation/navigation-strategy';
import {
    AbstractNode,
    isArrayNode,
    isAssignmentNode,
    isDocumentNode,
    isObjectNode,
    ValueNode,
} from '../../parser/ast';
import { parseFile } from '../../utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { AutoCompletionStrategy } from './autocompletion.strategy';

export class ReferenceAutoCompletionStrategy extends AutoCompletionStrategy<
    string[],
    { node: ValueNode; isInheritanceNode: boolean }
> {
    private cachedCompletion!: {
        startPosition: number;
    };
    private readonly referenceRegex = /&[a-zA-Z0-9_]*$/;

    async complete(args: {
        node: ValueNode;
        isInheritanceNode: boolean;
    }): Promise<string[]> {
        const { node, isInheritanceNode } = args;
        if (node.valueType.type !== 'Reference') {
            return [];
        }
        const reference = node.valueType.value;
        if (reference === '' && !isInheritanceNode) {
            const completions = ['&', '&<', '&~/', '&../', '&/', '&<./Data/'];
            if (
                node.parent &&
                (isArrayNode(node.parent) || isObjectNode(node.parent)) &&
                node.parent.inheritance
            ) {
                for (let i = 0; i < node.parent.inheritance.length; i++) {
                    completions.push(`&^/${i}/`);
                }
            }
            return completions;
        } else if (reference === '' && isInheritanceNode) {
            return ['/', '<./Data', '..', '~', '<'];
        }
        if (this.referenceRegex.test(reference)) {
            return getOptionsForSameLevel(reference, node);
        } else {
            return await traversePath(
                reference.startsWith('&') ? reference.substring(1) : reference,
                node
            );
        }
    }
}

const getOptionsForSameLevel = (
    reference: string,
    node: ValueNode
): string[] => {
    const value = reference.slice(1);
    return (
        node.parent?.elements
            .filter(
                (v) =>
                    isObjectNode(v) ||
                    isArrayNode(v) ||
                    (isAssignmentNode(v) && v.right !== node)
            )
            .filter(
                (v) =>
                    ((isArrayNode(v) || isObjectNode(v)) &&
                        v.identifier?.name.startsWith(value)) ||
                    value === '' ||
                    (isAssignmentNode(v) && v.left.name.startsWith(value))
            )
            .map((v) => {
                if ((isObjectNode(v) || isArrayNode(v)) && v.identifier) {
                    return v.identifier.name;
                } else if (isAssignmentNode(v)) {
                    return v.left.name;
                }
                return '';
            }) || []
    );
};

const getOptionsForLevel = (
    node: AbstractNode,
    search: string = ''
): string[] => {
    if (isObjectNode(node) || isArrayNode(node) || isDocumentNode(node)) {
        return node.elements
            .filter(
                (v) =>
                    ((isObjectNode(v) || isArrayNode(v)) &&
                        v.identifier?.name.startsWith(search)) ||
                    search === '' ||
                    (isAssignmentNode(v) && v.left.name.startsWith(search))
            )
            .map((v) => {
                if ((isObjectNode(v) || isArrayNode(v)) && v.identifier) {
                    return v.identifier.name;
                } else if (isAssignmentNode(v)) {
                    return v.left.name;
                }
                return '';
            });
    }
    return [];
};

const traversePath = async (
    path: string,
    node: AbstractNode
): Promise<string[]> => {
    const parts = extractSubstrings(path);
    if (path.startsWith('<./Data/')) {
        return traverseCosmoteerPath(parts, node);
    } else if (path.startsWith('/')) {
        await traverseSuperPath(parts, node);
    } else if (path.startsWith('^/')) {
        traverseInheritancePath(parts, node);
    } else {
        traverseReferencePath(parts, node);
    }
    return [];
};

const traverseInheritancePath = (parts: string[], node: AbstractNode) => {
    return [];
};

const traverseCosmoteerPath = async (parts: string[], _node: AbstractNode) => {
    if (parts[parts.length - 1].endsWith('.rules>')) {
        const cosmoteerRules = CosmoteerWorkspaceService.instance.findFile(
            parts.slice(0, parts.length - 1)
        );
        if (!cosmoteerRules) return [];
        const node = await parseFile(cosmoteerRules);
        cosmoteerRules.content.parsedDocument = node;
        if (node) {
            getOptionsForLevel(node);
        }
    } else if (parts.some((part) => part.endsWith('.rules>'))) {
        const cosmoteerRules = CosmoteerWorkspaceService.instance.findFile(
            parts.slice(0, parts.length - 1)
        );
        if (!cosmoteerRules) return [];
        const node = await parseFile(cosmoteerRules);
        cosmoteerRules.content.parsedDocument = node;
        return await traversePath(
            parts
                .slice(parts.findIndex((part) => part.endsWith('.rules')))
                .join('/'),
            node
        );
    } else {
    }
    return [];
};

const traverseReferencePath = (parts: string[], node: AbstractNode) => {
    return [];
};

const traverseSuperPath = async (parts: string[], node: AbstractNode) => {
    return [];
};
