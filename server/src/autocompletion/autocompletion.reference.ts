import { CancellationToken } from 'vscode-languageserver';
import { isValueNode, ValueNode } from '../parser/ast';
import { AutoCompletion } from './autocompletion.service';
import { ReferenceAutoCompletionStrategy } from './strategy/reference.autocompletion-strategy';

const referenceAutoCompletionStrategy = new ReferenceAutoCompletionStrategy();

export class AutoCompletionReference implements AutoCompletion<ValueNode> {
    public async getCompletions(node: ValueNode, cancellationToken: CancellationToken): Promise<string[]> {
        if (isValueNode(node) && node.valueType.type === 'Reference') {
            return await referenceAutoCompletionStrategy.complete({
                node,
                isInheritanceNode: false,
                cancellationToken,
            });
        }
        return [];
    }
}
