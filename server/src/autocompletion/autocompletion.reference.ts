import {
    isAssignmentNode,
    isIdentifierNode,
    isValueNode,
    ValueNode,
} from '../parser/ast';
import { AutoCompletion } from './autocompletion.service';

export class AutoCompletionReference implements AutoCompletion<ValueNode> {
    public getCompletions(node: ValueNode): string[] {
        if (
            isValueNode(node) &&
            node.valueType === 'Reference' &&
            node.values.toString().startsWith('&')
        ) {
            const value = node.values.toString().slice(1);
            return (
                node.parent?.elements
                    .filter((v) => isIdentifierNode(v) || isAssignmentNode(v))
                    .filter(
                        (v) =>
                            (isIdentifierNode(v) && v.name.startsWith(value)) ||
                            value === '' ||
                            (isAssignmentNode(v) &&
                                v.left.name.startsWith(value))
                    )
                    .map((v) => {
                        if (isIdentifierNode(v)) {
                            return v.name;
                        } else if (isAssignmentNode(v)) {
                            return v.left.name;
                        }
                        return '';
                    }) || []
            );
        }
        return [];
    }
}
