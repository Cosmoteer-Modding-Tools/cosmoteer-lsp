import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    ListNode,
    ValueNode,
} from '../../core/ast/ast';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

const navigation = new FullNavigationStrategy();

/** Depth-first walk yielding every node, so we can seed the cycle search from each group/list. */
function* walkTree(node: AbstractNode): Generator<AbstractNode> {
    yield node;
    if (isGroupNode(node) || isListNode(node) || isDocumentNode(node)) {
        for (const child of node.elements) yield* walkTree(child);
        if ((isGroupNode(node) || isListNode(node)) && node.inheritance) {
            for (const child of node.inheritance) yield* walkTree(child);
        }
    } else if (isAssignmentNode(node)) {
        yield* walkTree(node.right);
    }
}

const inheritanceRefs = (node: GroupNode | ListNode): ValueNode[] =>
    (node.inheritance ?? []).filter((v) => v.valueType.type === 'Reference');

/**
 * Report a diagnostic for every inheritance cycle in the document. A group/list whose inheritance
 * chain eventually leads back to a node already on the resolution path can never resolve — the
 * existing resolver guards this to avoid a hang, but silently yields nothing, so the author gets no
 * feedback. This pass surfaces it.
 *
 * Detection is a DFS over the inheritance graph (edges resolved with the same navigation the resolver
 * uses): a reference whose target is currently on the DFS stack is a back-edge, i.e. a cycle, and is
 * reported once — on the reference that closes the loop. A diamond (the same base reached by two
 * separate paths) is not a cycle and is not flagged.
 */
export const validateInheritanceCycles = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const onStack = new Set<AbstractNode>();
    const finished = new Set<AbstractNode>();

    const resolve = async (ref: ValueNode): Promise<AbstractNode | null> => {
        const target = await navigation
            .navigate(String(ref.valueType.value), ref, getStartOfAstNode(ref).uri, cancellationToken)
            .catch(() => null);
        if (!target || (target as { type?: string }).type === 'File') return null;
        return target as AbstractNode;
    };

    const visit = async (node: GroupNode | ListNode): Promise<void> => {
        if (finished.has(node) || cancellationToken.isCancellationRequested) return;
        onStack.add(node);
        for (const ref of inheritanceRefs(node)) {
            const target = await resolve(ref);
            if (!target) continue;
            if (onStack.has(target)) {
                errors.push({
                    message: l10n.t('Circular inheritance'),
                    node: ref,
                    additionalInfo: l10n.t(
                        'This inheritance chain eventually refers back to itself, so it can never be resolved'
                    ),
                });
            } else if (!finished.has(target) && (isGroupNode(target) || isListNode(target))) {
                await visit(target);
            }
        }
        onStack.delete(node);
        finished.add(node);
    };

    for (const node of walkTree(document)) {
        if ((isGroupNode(node) || isListNode(node)) && inheritanceRefs(node).length > 0 && !finished.has(node)) {
            await visit(node);
        }
    }
    return errors;
};
