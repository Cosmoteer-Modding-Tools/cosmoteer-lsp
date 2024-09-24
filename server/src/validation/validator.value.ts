import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import {
    AbstractNode,
    isArrayNode,
    isObjectNode,
    ValueNode,
} from '../parser/ast';
import { globalSettings } from '../server';
import { getStartOfAstNode } from '../utils/ast.utils';
import { isValidReference } from '../utils/reference.utils';
import { Validation } from './validator';
import * as l10n from '@vscode/l10n';

const navigationStrategy = new FullNavigationStrategy();

export const ValidationForValue: Validation<ValueNode> = {
    type: 'Value',
    callback: async (node: ValueNode) => {
        const reference = await checkReference(node);
        if (!reference) {
            return checkParantheses(node);
        }
        return reference;
    },
};

const checkParantheses = (node: ValueNode) => {
    if (
        node.valueType.type !== 'Number' &&
        node.valueType.type !== 'Reference' &&
        node.parenthesized
    ) {
        return {
            message: l10n.t('Value should not be parenthesized'),
            node: node,
            addditionalInfo: l10n.t(
                'References in function calls need to be parenthesized or math expressions'
            ),
        };
    }
    return undefined;
};

const checkReference = async (node: ValueNode) => {
    if (
        node.valueType.type === 'Reference' &&
        node.valueType.value.length > 1
    ) {
        if (!isValidReference(node.valueType.value)) {
            return {
                message: l10n.t('Reference is not valid'),
                node: node,
                addditionalInfo: l10n.t(
                    'References can be in the following formats: <>, .., ~, /, ^, &<>, &.., &~, &/, &A-Z'
                ),
            };
        } else if (
            // Workaround for mod.rules which can contain references to other files and cosmoteer rules
            !getStartOfAstNode(node).uri.includes('mod.rules') &&
            !ignorePath(node.valueType.value) &&
            (await navigationStrategy.navigate(
                node.valueType.value,
                // safe to assume that the parent is always an AbstractNode because otherwise it could't not be a inheritance
                isInheritanceInSameFile(node)
                    ? ((node.parent as AbstractNode).parent as AbstractNode)
                    : node,
                getStartOfAstNode(node).uri
            )) === null
        ) {
            return {
                message: l10n.t('Reference name is not known'),
                node: node,
                addditionalInfo: l10n.t(
                    'You either reference a non-existing identifier or a identifier that is not in scope'
                ),
            };
        }
    }
    return undefined;
};

const isInheritanceInSameFile = (value: ValueNode) => {
    return (
        value.valueType.type === 'Reference' &&
        value.valueType.value.startsWith('..') &&
        value.parent &&
        (isArrayNode(value.parent) || isObjectNode(value.parent)) &&
        value.parent.inheritance &&
        value.parent.inheritance.some((inheritance) => inheritance === value)
    );
};

const ignorePath = (value: string) => {
    for (const path of globalSettings.ignorePaths) {
        if (value.toLowerCase().includes(path.toLowerCase())) {
            return true;
        }
    }
    return false;
};
