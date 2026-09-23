import { Location, Range } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isListNode, isDocumentNode, isGroupNode } from '../core/ast/ast';
import { assignmentKeyIn, getStartOfAstNode } from '../utils/ast.utils';
import { normalizeUri } from '../utils/uri-path';
import { filePathToUri } from './reference-path';

// `normalizeUri` is pure string work over a path, so it lives in the dependency-free utils layer
// alongside {@link uriToFsPath}. It is re-exported here because the reference index and everything
// keyed like it reach for it next to the location helpers below.
export { normalizeUri };

/** The text a parsed document was produced from, plus the line starts counted in it once. Keyed by
 *  the document node, which ties the text to the exact parse it came from: a re-parse brings its
 *  own entry and the old one dies with its tree. */
const documentSources: WeakMap<AbstractNodeDocument, { text: string; starts?: number[] }> = new WeakMap();

/**
 * Records the text a parsed document came from, so the ranges below can be placed on the lines
 * their offsets really fall on. Every parse that holds the text registers it; a parse that does
 * not only leaves multi-line spans placed the way they were recorded.
 *
 * @param document the parsed document.
 * @param text the text it was parsed from.
 */
export const noteDocumentSource = (document: AbstractNodeDocument, text: string): void => {
    documentSources.set(document, { text });
};

/**
 * Where an offset of a node really sits in its file.
 *
 * An {@link AbstractNode}'s position records one line and two columns, so a value carried across a
 * `\` continuation ends at a column counted from its first line, a column that line does not have,
 * and a verbatim `@"…"` string is stamped with the line it ends on while its start column belongs
 * to the line it began on. The absolute offsets are right in both cases, so the file's own text
 * places them whenever it was registered.
 *
 * @param node the node whose file the offset belongs to.
 * @param offset the node's absolute offset.
 * @param line the line the position records, used when there is no text to count in.
 * @param character the column the position records, used the same way.
 * @returns the position to use.
 */
const placed = (
    node: AbstractNode,
    offset: number,
    line: number,
    character: number
): { line: number; character: number } => {
    const source = documentSources.get(getStartOfAstNode(node));
    if (!source || offset < 0 || offset > source.text.length) return { line, character };
    if (!source.starts) {
        const starts = [0];
        for (let at = source.text.indexOf('\n'); at >= 0; at = source.text.indexOf('\n', at + 1)) starts.push(at + 1);
        source.starts = starts;
    }
    const starts = source.starts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (starts[middle] <= offset) low = middle;
        else high = middle - 1;
    }
    return { line: low, character: offset - starts[low] };
};

/** The span of one node, both ends placed in the file's own text ({@link placed}). */
const spanOf = (node: AbstractNode): Range => {
    const { line, characterStart, characterEnd, start, end } = node.position;
    const from = placed(node, start, line, characterStart);
    const to = placed(node, end, line, characterEnd);
    return Range.create(from.line, from.character, to.line, to.character);
};

/**
 * The range to highlight for a definition target: the identifier of an
 * group/list (so jumping to / listing `Foo {…}` lands on `Foo`), else the
 * node itself. Shared by go-to-definition and the reference index so a
 * reference and the definition it points at key to the exact same range.
 */
export const rangeOf = (node: AbstractNode): Range =>
    spanOf((isGroupNode(node) || isListNode(node)) && node.identifier ? node.identifier : node);

/** The LSP {@link Location} of a definition target node (cross-file uri + identifier range). */
export const definitionLocationOf = (node: AbstractNode): Location => ({
    uri: filePathToUri(getStartOfAstNode(node).uri),
    range: rangeOf(node),
});

/** The LSP {@link Location} of a reference site. The `&…` text itself, for the references list. */
export const referenceSiteLocation = (node: AbstractNode): Location => ({
    uri: filePathToUri(getStartOfAstNode(node).uri),
    range: spanOf(node),
});

/**
 * The name a definition node is known by: an identified `Group`/`List`'s identifier,
 * or the key of the `key = value` whose value this node is. `null` for anonymous nodes
 * (list elements, inheritance values). Used to pre-filter the reference search by name.
 */
export const definitionNameOf = (node: AbstractNode): string | null => {
    if ((isGroupNode(node) || isListNode(node)) && node.identifier) return node.identifier.name;
    const container = node.parent;
    if (container && (isGroupNode(container) || isListNode(container) || isDocumentNode(container))) {
        return assignmentKeyIn(node, container) ?? null;
    }
    return null;
};

/**
 * Whether a folder set covers a file, so the indexes and analyses built over those folders know
 * about it and its siblings. A file outside them would be judged against a set that never saw the
 * files around it.
 *
 * @param uri the document uri to test.
 * @param folderPaths the folders being searched.
 * @returns true when the file lives under one of the folders.
 */
export const isCoveredByFolders = (uri: string, folderPaths: readonly string[]): boolean => {
    const key = normalizeUri(uri);
    return folderPaths.some((folder) => {
        const prefix = normalizeUri(folder).replace(/\/+$/, '');
        return key === prefix || key.startsWith(`${prefix}/`);
    });
};

/**
 * A stable identity string for a {@link Location}: file (spelling-independent) plus
 * range. Two references resolving to the same target produce the same key, which is
 * how the reference index buckets referrers under their shared definition.
 */
export const locationKey = (location: Location): string => {
    const { start, end } = location.range;
    return `${normalizeUri(location.uri)}#${start.line}:${start.character}-${end.line}:${end.character}`;
};

/**
 * Drop duplicate locations (same file + range), keeping the first of each. Go-to-definition
 * and find-all-references both gather from several passes that can land on the same site.
 *
 * @param locations The gathered locations, in the order they should be offered.
 * @returns The same locations minus every repeat of an already seen {@link locationKey}.
 */
export const dedupeLocations = (locations: Location[]): Location[] => {
    const seen = new Set<string>();
    const out: Location[] = [];
    for (const location of locations) {
        const key = locationKey(location);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(location);
    }
    return out;
};
