import { ValueNode } from '../parser/ast';
import { getStartOfAstNode, navigate } from '../utils/ast.utils';
import { Validation } from './validator';
import * as l10n from '@vscode/l10n';

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
            (await navigate(
                node.valueType.value,
                node,
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

const isValidReference = (value: string) => {
    if (value.startsWith('&')) {
        const valueWithoutAmpersand = value.substring(1);
        if (
            (valueWithoutAmpersand.startsWith('<') &&
                valueWithoutAmpersand.includes('.rules>')) ||
            valueWithoutAmpersand.startsWith('..') ||
            valueWithoutAmpersand.startsWith('~') ||
            valueWithoutAmpersand.startsWith('/') ||
            valueWithoutAmpersand.search(/^[A-Za-z_]/) !== -1
        ) {
            const nextValue = valueWithoutAmpersand.substring(1);
            if (
                nextValue.includes('&') ||
                nextValue.includes('<') ||
                nextValue.includes('~') ||
                nextValue.includes('^')
            ) {
                return false;
            }
            return true;
        }
    } else if (
        (value.startsWith('<') && value.includes('.rules>')) ||
        value.startsWith('..') ||
        value.startsWith('/') ||
        value.startsWith('^') ||
        value.startsWith('~')
    ) {
        const nextValue = value.substring(1);
        if (
            nextValue.includes('&') ||
            nextValue.includes(' ') ||
            nextValue.includes('<') ||
            nextValue.includes('~') ||
            (!value.startsWith('^') && nextValue.startsWith('/')) ||
            nextValue.includes('^')
        ) {
            return false;
        }
        return true;
    }
    return false;
};
