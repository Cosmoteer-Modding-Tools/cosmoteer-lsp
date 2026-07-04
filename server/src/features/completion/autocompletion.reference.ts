import { CancellationToken } from 'vscode-languageserver';
import { isGroupNode, isListNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { AutoCompletion } from './autocompletion.service';
import { ReferenceAutoCompletionStrategy } from './strategy/reference.autocompletion-strategy';

const referenceAutoCompletionStrategy = new ReferenceAutoCompletionStrategy();

/**
 * True if `node` is one of its parent group/list's inheritance references (the value after the
 * `:` of `Child : Parent`), whose relative lookups resolve against the group's container.
 */
const isInheritanceReference = (node: ValueNode): boolean =>
    !!node.parent &&
    (isGroupNode(node.parent) || isListNode(node.parent)) &&
    !!node.parent.inheritance?.includes(node);

/**
 * A quoted value node that is a reference and is therefore worth offering reference-path completions for.
 */
export class AutoCompletionReference implements AutoCompletion<ValueNode> {
    public async getCompletions(node: ValueNode, cancellationToken: CancellationToken): Promise<string[]> {
        if (isValueNode(node) && node.valueType.type === 'Reference') {
            return await referenceAutoCompletionStrategy
                .complete({
                    node,
                    isInheritanceNode: isInheritanceReference(node),
                    cancellationToken,
                })
                .catch(() => []);
        }
        // A lone `&`, the moment the user starts a reference, is lexed as a string rather than a
        // reference. Offer the reference-start prefixes (including `&^/N/` caret paths) here so the
        // suggestions appear right away instead of only once a full reference token has formed.
        if (isValueNode(node) && node.valueType.type === 'String' && node.valueType.value === '&') {
            return referenceAutoCompletionStrategy.completeReferenceStart(node);
        }
        return [];
    }
}
