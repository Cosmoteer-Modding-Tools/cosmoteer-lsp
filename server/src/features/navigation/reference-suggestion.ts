import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, isDocumentNode, isGroupNode, isListNode, isValueNode, ValueNode } from '../../core/ast/ast';
import { extractSubstrings } from './navigation-strategy';
import { FullNavigationStrategy } from './full.navigation-strategy';
import { getStartOfAstNode, namedMembersOf } from '../../utils/ast.utils';
import { closestMatch } from '../../utils/did-you-mean';

type WithElements = AbstractNode & { elements: AbstractNode[] };

const hasElements = (node: AbstractNode | null | undefined): node is WithElements =>
    !!node && (isGroupNode(node) || isListNode(node) || isDocumentNode(node));

/** Narrow a navigation result to an AST node, dropping whole-file (`FileWithPath`) targets. */
const asNode = (result: AbstractNode | { readonly type?: string } | null | undefined): AbstractNode | null =>
    result && (result as { type?: string }).type !== 'File' ? (result as AbstractNode) : null;

/**
 * For an unresolved reference, the closest-named member that would have resolved — a typo
 * suggestion (`&Foo/PrhibitedBy` → `&Foo/ProhibitedBy`). Returns the suggested last segment
 * and the full corrected reference (the typed value with only the final name swapped), or
 * `null` when nothing is close enough.
 *
 * Candidates come from the scope the failing segment is looked up in: the members of the
 * container its prefix resolves to (multi-segment), or — for a bare `&Name` — the members
 * of the nearest enclosing named scope plus the document root.
 */
export const suggestReferenceName = async (
    node: ValueNode,
    startNode: AbstractNode,
    uri: string,
    navigation: FullNavigationStrategy,
    cancellationToken: CancellationToken
): Promise<{ suggestion: string; correctedValue: string } | null> => {
    const value = String(node.valueType.value);
    const body = value.startsWith('&') ? value.slice(1) : value;
    const segments = extractSubstrings(body);
    if (segments.length === 0) return null;
    const failing = segments[segments.length - 1];
    // Only suggest for plain identifier segments never for operators, indices or file tokens.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(failing)) return null;

    const candidates = new Set<string>();
    const lastSlash = value.lastIndexOf('/');
    if (lastSlash > 0) {
        // Multi-segment: the prefix should resolve to a container suggest among its members.
        // A whole-file (`FileWithPath`) target has no `elements` to suggest from treat as none.
        let scope = asNode(await navigation.navigate(value.slice(0, lastSlash), startNode, uri, cancellationToken).catch(() => null));
        if (scope && isValueNode(scope) && scope.valueType.type === 'Reference') {
            scope = asNode(
                await navigation
                    .navigate(String(scope.valueType.value), scope, getStartOfAstNode(scope).uri, cancellationToken)
                    .catch(() => null)
            );
        }
        if (hasElements(scope)) for (const [name] of namedMembersOf(scope)) candidates.add(name);
    } else {
        // Bare relative `&Name`: the nearest enclosing named scope (lists are positional, climb
        // out of them) and the document root — where such a name is actually looked up.
        let scope: AbstractNode | undefined = startNode.parent ?? undefined;
        while (scope && isListNode(scope)) scope = scope.parent ?? undefined;
        if (hasElements(scope)) for (const [name] of namedMembersOf(scope)) candidates.add(name);
        for (const [name] of namedMembersOf(getStartOfAstNode(node))) candidates.add(name);
    }

    const suggestion = closestMatch(failing, candidates);
    if (!suggestion) return null;
    return { suggestion, correctedValue: value.slice(0, value.length - failing.length) + suggestion };
};
