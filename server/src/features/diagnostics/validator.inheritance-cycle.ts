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
    } else if (isAssignmentNode(node) && node.right) {
        yield* walkTree(node.right);
    }
}

const inheritanceRefs = (node: GroupNode | ListNode): ValueNode[] =>
    (node.inheritance ?? []).filter((v) => v.valueType.type === 'Reference');

/**
 * A stable identity for a node across re-parses, its document uri plus its position span. Cross-file
 * inheritance edges are resolved by navigation, which re-reads and re-parses the target file every
 * time (there is no shared AST cache for unopened files), so the resolved node is a fresh object on
 * each call. Keying the DFS `onStack`/`finished` sets by object reference would therefore never match
 * a re-resolved target. A cross-file cycle would go undetected, and, worse, a base reached by more
 * than one path (a diamond, or any repeated `&<file>` reference) would be re-descended and re-parsed
 * on every path, which is exponential in the inheritance depth and exhausts the heap on parts with
 * deep cross-file inheritance. A uri and span key collapses those re-parses back to one visit and
 * lets a genuine cross-file cycle close.
 *
 * @param node the AST node to identify.
 * @returns a string key equal for any two nodes at the same span of the same document.
 */
const nodeKey = (node: AbstractNode): string =>
    `${getStartOfAstNode(node).uri}#${node.position.start}:${node.position.end}`;

/**
 * Report a diagnostic for every inheritance cycle in the document. A group/list whose inheritance
 * chain eventually leads back to a node already on the resolution path can never resolve. The
 * existing resolver guards this to avoid a hang, but silently yields nothing, so the author gets no
 * feedback. This pass surfaces it.
 *
 * Detection is a DFS over the inheritance graph (edges resolved with the same navigation the resolver
 * uses). A reference whose target is currently on the DFS stack is a back-edge, i.e. a cycle, and is
 * reported once, on the reference that closes the loop. A diamond (the same base reached by two
 * separate paths) is not a cycle and is not flagged.
 *
 * The DFS crosses file boundaries, so the back-edge reference can live in another document. These
 * errors become diagnostics of the document being validated, whose text maps the node's offsets to
 * positions, so a foreign node's offsets would land on arbitrary lines of the wrong file. Each
 * descent therefore carries the nearest reference belonging to the validated document, and a cycle
 * found deeper in a foreign chain is reported on that local entry reference instead.
 */
export const validateInheritanceCycles = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const onStack = new Set<string>();
    const finished = new Set<string>();
    const reported = new Set<string>();

    const resolve = async (ref: ValueNode): Promise<AbstractNode | null> => {
        const target = await navigation
            .navigate(String(ref.valueType.value), ref, getStartOfAstNode(ref).uri, cancellationToken)
            .catch(() => null);
        if (!target || (target as { type?: string }).type === 'File') return null;
        return target as AbstractNode;
    };

    const visit = async (node: GroupNode | ListNode, entryRef: ValueNode | null): Promise<void> => {
        const key = nodeKey(node);
        if (finished.has(key) || cancellationToken.isCancellationRequested) return;
        onStack.add(key);
        for (const ref of inheritanceRefs(node)) {
            const reportRef = getStartOfAstNode(ref).uri === document.uri ? ref : entryRef;
            const target = await resolve(ref);
            if (!target) continue;
            const targetKey = nodeKey(target);
            if (onStack.has(targetKey)) {
                if (reportRef && !reported.has(nodeKey(reportRef))) {
                    reported.add(nodeKey(reportRef));
                    errors.push({
                        message: l10n.t('Circular inheritance'),
                        node: reportRef,
                        additionalInfo: l10n.t(
                            'This inheritance chain eventually refers back to itself, so it can never be resolved'
                        ),
                    });
                }
            } else if (!finished.has(targetKey) && (isGroupNode(target) || isListNode(target))) {
                await visit(target, reportRef);
            }
        }
        onStack.delete(key);
        finished.add(key);
    };

    for (const node of walkTree(document)) {
        if (
            (isGroupNode(node) || isListNode(node)) &&
            inheritanceRefs(node).length > 0 &&
            !finished.has(nodeKey(node))
        ) {
            await visit(node, null);
        }
    }
    return errors;
};
