import { FunctionCallNode } from '../parser/ast';
import { Validation } from './validator';
import * as l10n from '@vscode/l10n';

export const ValidationForFunctionCall: Validation<FunctionCallNode> = {
    type: 'FunctionCall',
    callback: (node: FunctionCallNode) => {
        for (const arg of node.arguments) {
            if (arg.type === 'Value' && arg.valueType === 'Reference') {
                if (!(arg.values as string).startsWith('&')) {
                    return {
                        message: l10n.t(
                            'Reference in function calls need to start with an ampersand'
                        ),
                        node: arg,
                    };
                }
                if (!arg.parenthesized) {
                    return {
                        message: l10n.t(
                            'Reference in function calls need to be parenthesized'
                        ),
                        node: arg,
                    };
                }
            } else if (
                arg.type === 'Value' &&
                arg.valueType !== 'Reference' &&
                arg.valueType !== 'Number'
            ) {
                return {
                    message: l10n.t(
                        'Invalid argument type, expected Reference(&) or Number. Got {0}',
                        arg.valueType
                    ),
                    node: arg,
                };
            }
        }
    },
};
