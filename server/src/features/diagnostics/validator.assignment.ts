import { AssignmentNode } from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { isModRules } from '../../document/document-kind';
import { Validation } from './validator';
import * as l10n from '@vscode/l10n';

export const ValidationForAssignment: Validation<AssignmentNode> = {
    type: 'Assignment',
    callback: async (node: AssignmentNode) => {
        if (isModRules(getStartOfAstNode(node).uri)) return; // We can't validate mod.rules at the moment
        if (node.right && node.right.type === 'Value' && node.right.valueType.type === 'Reference') {
            if (node.right.quoted && node.right.valueType.value.startsWith('&')) {
                return {
                    message: l10n.t('Reference should not be quoted'),
                    node: node.right,
                    additionalInfo: l10n.t('Remove the quotes — a "&" reference is written without quotation marks'),
                };
            } else if (
                node.right.valueType.value.startsWith('<') ||
                node.right.valueType.value.startsWith('..') ||
                node.right.valueType.value.startsWith('~') ||
                node.right.valueType.value.startsWith('^')
            ) {
                return {
                    message: l10n.t('Reference should start with an ampersand'),
                    node: node.right,
                    additionalInfo: l10n.t('Prefix the reference with "&", e.g. "&{0}"', String(node.right.valueType.value)),
                };
            }
        }
    },
};
