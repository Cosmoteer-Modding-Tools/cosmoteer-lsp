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
            node.valueType.type === 'Reference' &&
            node.valueType.value.startsWith('&')
        ) {
            const value = node.valueType.value.slice(1);
            return (
                node.parent?.elements
                    .filter(
                        (v) =>
                            isIdentifierNode(v) ||
                            (isAssignmentNode(v) && v.right !== node)
                    )
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
