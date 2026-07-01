import { Location, Range } from 'vscode-languageserver';
import { AbstractNode, isListNode, isAssignmentNode, isDocumentNode, isGroupNode } from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { filePathToUri } from './navigation-strategy';

/**
 * The range to highlight for a definition target: the identifier of an
 * group/list (so jumping to / listing `Foo {…}` lands on `Foo`), else the
 * node itself. Shared by go-to-definition and the reference index so a
 * reference and the definition it points at key to the exact same range.
 */
export const rangeOf = (node: AbstractNode): Range => {
    const target = (isGroupNode(node) || isListNode(node)) && node.identifier ? node.identifier : node;
    const { line, characterStart, characterEnd } = target.position;
    return Range.create(line, characterStart, line, characterEnd);
};

/** The LSP {@link Location} of a definition target node (cross-file uri + identifier range). */
export const definitionLocationOf = (node: AbstractNode): Location => ({
    uri: filePathToUri(getStartOfAstNode(node).uri),
    range: rangeOf(node),
});

/** The LSP {@link Location} of a reference site. The `&…` text itself, for the references list. */
export const referenceSiteLocation = (node: AbstractNode): Location => {
    const { line, characterStart, characterEnd } = node.position;
    return {
        uri: filePathToUri(getStartOfAstNode(node).uri),
        range: Range.create(line, characterStart, line, characterEnd),
    };
};

/**
 * The name a definition node is known by — an identified `Group`/`List`'s identifier,
 * or the key of the `key = value` whose value this node is. `null` for anonymous nodes
 * (list elements, inheritance values). Used to pre-filter the reference search by name.
 */
export const definitionNameOf = (node: AbstractNode): string | null => {
    if ((isGroupNode(node) || isListNode(node)) && node.identifier) return node.identifier.name;
    const container = node.parent;
    if (container && (isGroupNode(container) || isListNode(container) || isDocumentNode(container))) {
        for (const element of container.elements) {
            if (isAssignmentNode(element) && element.right === node) return element.left.name;
        }
    }
    return null;
};

/** Canonicalize a `file://` URI or OS path for identity comparison (decode, slashes, case). */
export const normalizeUri = (uriOrPath: string): string => {
    let path = uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath;
    try {
        path = decodeURIComponent(path);
    } catch {
        /* leave as-is on malformed escapes */
    }
    return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
};

/**
 * A stable identity string for a {@link Location} — file (spelling-independent) plus
 * range. Two references resolving to the same target produce the same key, which is
 * how the reference index buckets referrers under their shared definition.
 */
export const locationKey = (location: Location): string => {
    const { start, end } = location.range;
    return `${normalizeUri(location.uri)}#${start.line}:${start.character}-${end.line}:${end.character}`;
};
