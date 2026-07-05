import { CancellationToken, Position, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    IdentifierNode,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    ValueNode,
} from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { DefinitionService, isReferenceValue } from './definition.service';
import { FullNavigationStrategy } from './full.navigation-strategy';
import { filePathToUri } from './navigation-strategy';
import { definitionLocationOf, locationKey, normalizeUri, referenceSiteLocation } from './reference-location';
import { findReferenceTargetAtPosition, referenceNodesOf } from './reference-index';
import { resolveSchemaSiblingReference, stringValueNodesOf, valueTextRange } from './schema-reference.navigation';
import { schemaReferenceFieldOf } from './schema-id-reference.navigation';
import { idReferenceSites, idSymbolAt, idSymbolAtMapKey } from './schema-id-symbol';
import { particleChannelAt, channelOccurrences, channelRangeOf } from './particle-channel';
import { documentRootClass } from '../../document/schema/document-root';
import { isValueNode } from '../../core/ast/ast';
import { documentsMentioning } from './workspace-files';

/** A renameable symbol: the identifier text to rewrite, its name, and the target identity. */
interface RenameSymbol {
    nameNode: IdentifierNode;
    name: string;
    targetKey: string;
}

/** A `/`-delimited path segment and its character span within the reference value string. */
interface SegmentSpan {
    text: string;
    start: number;
    end: number;
}

/** A valid Cosmoteer member name — what a rename target may be renamed to. */
const VALID_NAME = /^[A-Za-z0-9_]+$/;

/**
 * Drop edits to files under `root` (the read-only vanilla Cosmoteer `Data` tree) from a rename's
 * {@link WorkspaceEdit}. Rename searches the whole game (so cross-file references resolve), but must
 * never write to the install, applying those edits would corrupt the base game. The open mod
 * workspace is outside `root`, so its files are kept. A no-op when `root` is unknown.
 */
export const dropEditsUnderRoot = (edit: WorkspaceEdit, root: string | undefined): WorkspaceEdit => {
    if (!root || !edit.changes) return edit;
    const rootNorm = normalizeUri(root);
    const changes: NonNullable<WorkspaceEdit['changes']> = {};
    for (const [uri, edits] of Object.entries(edit.changes)) {
        const norm = normalizeUri(uri);
        if (norm === rootNorm || norm.startsWith(`${rootNorm}/`)) continue; // under the vanilla install
        changes[uri] = edits;
    }
    return { ...edit, changes };
};

/** A valid Cosmoteer ID value like a member name but dotted ids are allowed (`cosmoteer.fire`). */
const VALID_ID = /^[A-Za-z0-9_.]+$/;

/** Split a reference value into its `/`-delimited segments with offsets (mirrors `extractSubstrings`). */
const segmentSpans = (value: string): SegmentSpan[] => {
    const spans: SegmentSpan[] = [];
    const regex = /[^/]+/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
        spans.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    }
    return spans;
};

/** The bare member name of a segment — the leading relative `&` sigil stripped. */
const segmentName = (span: SegmentSpan): string => span.text.replace(/^&/, '');

/** The document range covering a segment's name (excluding any leading `&`). */
const segmentNameRange = (node: ValueNode, span: SegmentSpan): Range => {
    const sigil = span.text.startsWith('&') ? 1 : 0;
    const { line, characterStart } = node.position;
    return Range.create(line, characterStart + span.start + sigil, line, characterStart + span.end);
};

const identifierRange = (node: IdentifierNode): Range => {
    const { line, characterStart, characterEnd } = node.position;
    return Range.create(line, characterStart, line, characterEnd);
};

/**
 * Rename (`textDocument/rename` + `prepareRename`).
 *
 * A Cosmoteer symbol is referred to by the last segment that resolves to it — which can
 * be the endpoint of a reference (`&…/B`) or a mid-path segment (`&…/B/InnerValue` when
 * renaming `B`). So rename can't just rewrite the reference-index buckets (those key only
 * endpoints): for every reference whose path contains a segment textually equal to the
 * name, it resolves that segment's prefix and rewrites it only when the prefix resolves to
 * the exact target. Plus the declaration identifier itself. The result is a
 * {@link WorkspaceEdit} grouping per-file {@link TextEdit}s.
 */
export class RenameService {
    private static _instance: RenameService;
    private readonly navigation = new FullNavigationStrategy();
    private constructor() {}

    public static get instance(): RenameService {
        if (!RenameService._instance) {
            RenameService._instance = new RenameService();
        }
        return RenameService._instance;
    }

    /** Validate the cursor sits on a renameable name and report its range + current text. */
    public async prepareRename(
        document: AbstractNodeDocument,
        position: Position
    ): Promise<{ range: Range; placeholder: string } | null> {
        const found = findReferenceTargetAtPosition(document, position);
        if (!found) return null;

        if (isReferenceValue(found)) {
            const span = segmentSpans(String(found.valueType.value)).find((s) => {
                const relative = position.character - found.position.characterStart;
                return relative >= s.start && relative <= s.end;
            });
            if (!span) return null;
            const name = segmentName(span);
            // Only a plain member segment is renameable — not a `<file.rules>` part, a
            // super-path sigil, or a `^`/`~`/`..` navigation op.
            if (!VALID_NAME.test(name)) return null;
            return { range: segmentNameRange(found, span), placeholder: name };
        }

        // A schema `ID<>` sibling reference value renames via the component it names (resolve first).
        const sibling = resolveSchemaSiblingReference(found);
        if (sibling) {
            const symbol = deriveRenameSymbol(sibling);
            return symbol ? { range: identifierRange(symbol.nameNode), placeholder: symbol.name } : null;
        }

        // A particle data channel value (`DataOut = rot_vel`) renames the channel file-wide.
        const channel = particleChannelAt(document, position);
        if (channel) return { range: channelRangeOf(channel), placeholder: channel.name };

        // A cross-file `ID<X>` value — a bare-id reference usage, or a whole-file root's own `ID` —
        // renames the id (dotted ids allowed). The cross-file rewrite happens in `rename`.
        const idValue = crossFileIdValue(found);
        if (idValue) {
            const text = String(idValue.valueType.value);
            return VALID_ID.test(text) ? { range: valueTextRange(idValue), placeholder: text } : null;
        }

        const symbol = deriveRenameSymbol(found);
        if (!symbol) return null;
        return { range: identifierRange(symbol.nameNode), placeholder: symbol.name };
    }

    public async rename(
        document: AbstractNodeDocument,
        position: Position,
        newName: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<WorkspaceEdit | null> {
        const changes: { [uri: string]: TextEdit[] } = {};
        const add = (uri: string, range: Range, text: string) => {
            (changes[uri] ??= []).push(TextEdit.replace(range, text));
        };

        // Cross-file `ID<X>` rename: rewrite the whole-file root's `ID` declaration and every bare-id
        // reference to it across the project (e.g. rename resource `battery` → all `ResourceType =`).
        const rawFound = findReferenceTargetAtPosition(document, position);
        const idSymbol =
            (await idSymbolAt(rawFound, folderPaths, cancellationToken).catch(() => null)) ??
            (await idSymbolAtMapKey(document, position, folderPaths, cancellationToken).catch(() => null));
        if (idSymbol) {
            if (!VALID_ID.test(newName)) return null;
            const declKey = locationKey(idSymbol.location);
            add(idSymbol.location.uri, idSymbol.location.range, newName); // the ID declaration
            for await (const doc of documentsMentioning(folderPaths, idSymbol.id, cancellationToken)) {
                for (const site of idReferenceSites(doc, idSymbol)) {
                    const location = referenceSiteLocation(site);
                    if (locationKey(location) !== declKey) add(location.uri, location.range, newName);
                }
            }
            dedupeEdits(changes);
            return { changes };
        }

        // A particle data channel rename rewrites every occurrence of the name in the same file.
        const channel = particleChannelAt(document, position);
        if (channel) {
            if (!VALID_NAME.test(newName)) return null;
            for (const occurrence of channelOccurrences(document, channel.name)) {
                add(filePathToUri(getStartOfAstNode(occurrence.node).uri), channelRangeOf(occurrence), newName);
            }
            dedupeEdits(changes);
            return { changes };
        }

        if (!VALID_NAME.test(newName)) return null;
        const symbol = await this.resolveSymbol(document, position, cancellationToken);
        if (!symbol) return null;

        // 1. The declaration itself.
        add(filePathToUri(getStartOfAstNode(symbol.nameNode).uri), identifierRange(symbol.nameNode), newName);

        // 2. Every reference segment that resolves to the target. Only files whose text
        // mentions the name are scanned, so this scales to the whole Cosmoteer Data tree.
        for await (const doc of documentsMentioning(folderPaths, symbol.name, cancellationToken)) {
            for (const reference of referenceNodesOf(doc)) {
                const value = String(reference.valueType.value);
                const spans = segmentSpans(value);
                if (!spans.some((span) => segmentName(span) === symbol.name)) continue;
                const sourceUri = getStartOfAstNode(reference).uri;
                for (const span of spans) {
                    if (segmentName(span) !== symbol.name) continue;
                    const resolved = await this.navigation
                        .navigate(value.substring(0, span.end), reference, sourceUri, cancellationToken)
                        .catch(() => null);
                    if (!resolved || isFile(resolved as unknown as FileWithPath)) continue;
                    if (locationKey(definitionLocationOf(resolved as AbstractNode)) !== symbol.targetKey) continue;
                    add(filePathToUri(sourceUri), segmentNameRange(reference, span), newName);
                }
            }
        }

        // 3. Schema `ID<>` sibling references (bare strings, always same-file) — scan this document.
        for (const candidate of stringValueNodesOf(document)) {
            if (String(candidate.valueType.value) !== symbol.name) continue;
            const target = resolveSchemaSiblingReference(candidate);
            if (!target || locationKey(definitionLocationOf(target)) !== symbol.targetKey) continue;
            add(filePathToUri(getStartOfAstNode(candidate).uri), valueTextRange(candidate), newName);
        }

        dedupeEdits(changes);
        return { changes };
    }

    /** The renameable symbol under the cursor, resolving through a reference if needed. */
    private async resolveSymbol(
        document: AbstractNodeDocument,
        position: Position,
        cancellationToken: CancellationToken
    ): Promise<RenameSymbol | null> {
        const found = findReferenceTargetAtPosition(document, position);
        if (!found) return null;
        if (!isReferenceValue(found)) return deriveRenameSymbol(resolveSchemaSiblingReference(found) ?? found);

        const resolved = await DefinitionService.instance
            .resolveReferenceTarget(document, found, cancellationToken)
            .catch(() => null);
        if (!resolved || isFile(resolved as unknown as FileWithPath)) return null;
        return deriveRenameSymbol(resolved as AbstractNode);
    }
}

/**
 * A cross-file `ID<X>` value node the cursor sits on a bare-id reference usage (a schema reference
 * field's value) or a whole-file root's own top-level `ID` declaration or undefined. Synchronous
 * (no cross-file resolution): just enough to drive `prepareRename`'s range/placeholder. The actual
 * cross-file rewrite happens in `rename` via {@link idSymbolAt}.
 */
const crossFileIdValue = (node: AbstractNode): ValueNode | undefined => {
    if (!isValueNode(node) || node.valueType.type !== 'String') return undefined;
    if (schemaReferenceFieldOf(node)) return node; // a reference usage
    const container = node.parent;
    if (container && isDocumentNode(container) && documentRootClass(container)) {
        for (const element of container.elements) {
            if (isAssignmentNode(element) && element.left.name === 'ID' && element.right === node) return node;
        }
    }
    return undefined;
};

/**
 * Derive the renameable symbol from a definition node: an identified `Group`/`List`
 * renames via its identifier an assignment value renames via its key. Anything else
 * (anonymous element, inheritance value) has no name to rewrite.
 */
const deriveRenameSymbol = (node: AbstractNode): RenameSymbol | null => {
    if ((isGroupNode(node) || isListNode(node)) && node.identifier) {
        return { nameNode: node.identifier, name: node.identifier.name, targetKey: locationKey(definitionLocationOf(node)) };
    }
    // An assignment value's parent is its container, so find the
    // `key = value` whose right-hand side is this node to recover the key to rewrite.
    const container = node.parent;
    if (container && (isGroupNode(container) || isListNode(container) || isDocumentNode(container))) {
        for (const element of container.elements) {
            if (isAssignmentNode(element) && element.right === node) {
                return {
                    nameNode: element.left,
                    name: element.left.name,
                    targetKey: locationKey(definitionLocationOf(node)),
                };
            }
        }
    }
    return null;
};

/** Drop duplicate edits within each file (same range, e.g., a self-reference + declaration). */
const dedupeEdits = (changes: { [uri: string]: TextEdit[] }): void => {
    for (const uri of Object.keys(changes)) {
        const seen = new Set<string>();
        changes[uri] = changes[uri].filter((edit) => {
            const key = `${edit.range.start.line}:${edit.range.start.character}-${edit.range.end.line}:${edit.range.end.character}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
};
