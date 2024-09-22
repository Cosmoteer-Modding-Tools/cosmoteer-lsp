import {
    isArrayNode,
    isAssignmentNode,
    isDocumentNode,
    isIdentifierNode,
    isObjectNode,
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
                            isObjectNode(v) ||
                            isArrayNode(v) ||
                            (isAssignmentNode(v) && v.right !== node)
                    )
                    .filter(
                        (v) =>
                            ((isArrayNode(v) || isObjectNode(v)) &&
                                v.identifier?.name.startsWith(value)) ||
                            value === '' ||
                            (isAssignmentNode(v) &&
                                v.left.name.startsWith(value))
                    )
                    .map((v) => {
                        if (
                            (isObjectNode(v) || isArrayNode(v)) &&
                            v.identifier
                        ) {
                            return v.identifier.name;
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
