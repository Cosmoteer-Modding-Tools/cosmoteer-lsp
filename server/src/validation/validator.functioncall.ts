import { FunctionCallNode } from '../parser/ast';
import { Validation } from './validator';

export const ValidationForFunctionCall: Validation<FunctionCallNode> = {
    type: 'FunctionCall',
    callback: (node: FunctionCallNode) => {
        for (const arg of node.arguments) {
            if (arg.type === 'Value' && arg.valueType === 'Reference') {
                if (!(arg.values as string).startsWith('&')) {
                    return {
                        message:
                            'Reference in function calls need to start with an ampersand',
                        node: arg,
                    };
                }
                if (!arg.parenthesized) {
                    return {
                        message:
                            'Reference in function calls need to be parenthesized',
                        node: arg,
                    };
                }
            } else if (
                arg.type === 'Value' &&
                arg.valueType !== 'Reference' &&
                arg.valueType !== 'Number'
            ) {
                return {
                    message:
                        'Invalid argument type, expected Reference(&) or Number',
                    node: arg,
                };
            }
        }
    },
};
