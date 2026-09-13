/**
 * Occurrence highlighting (`textDocument/documentHighlight`).
 *
 * This is find-all-references narrowed to the one file the reader is looking at: the symbol under the
 * cursor is resolved once, then only this document is searched for the sites that resolve to the same
 * declaration. The protocol asks for a single document, so nothing here sweeps the project, and the
 * editor asks again on every cursor move, so nothing here waits for the game scan either.
 *
 * A position the server does not understand is answered with `null`, never with an empty list. Both
 * editors keep a plain word matcher behind the language server and fall back to it whenever the
 * server declines, so an empty list would replace the reader's word highlighting with nothing at all.
 */
import { CancellationToken, DocumentHighlight, DocumentHighlightKind, Position, Range } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { isShaderDocument } from '../../document/document-kind';
import { warmInheritedClasses } from '../completion/inheritance-resolution';
import { documentRootClass } from '../../document/schema/document-root';
import { entityDeclarationsOf, sameId } from '../../document/schema/entity-schema';
import { onFsInvalidation } from '../../workspace/fs-cache';
import { isReferenceValue } from './definition.service';
import { segmentName, segmentSpans } from './navigation-strategy';
import {
    MEMBER_SEGMENT_NAME,
    segmentNameRange,
    segmentSpanAt,
    segmentTargetKey,
    segmentTargetNode,
} from './reference-segment';
import { ChannelOccurrence, channelOccurrences, channelRangeOf, particleChannelAt } from './particle-channel';
import { enclosingContainerKey, findReferenceTargetAtPosition, referenceNodesOf } from './reference-index';
import { definitionLocationOf, definitionNameOf, locationKey, normalizeUri, rangeOf } from './reference-location';
import {
    isSameOrSubclass,
    mapKeyReferenceAt,
    mapKeyReferencesOf,
    schemaReferenceFieldOf,
} from './schema-id-reference.navigation';
import { resolveSchemaSiblingReference, stringValueNodesOf, valueTextRange } from './schema-reference.navigation';

/** A cross-file id under the cursor: the written id and the class the cursor's site names. */
interface CrossFileIdCursor {
    readonly id: string;
    readonly cls: string;
}

/** A cross-file id this document declares, as the id, the declaring class and the node to light up. */
interface LocalIdDeclaration {
    readonly id: string;
    readonly cls: string;
    readonly node: AbstractNode;
}

/** The symbol a reference or a declaration names: its identity, its spelling, and where it is declared. */
interface HighlightSymbol {
    /** The identity every highlighted site must resolve to, the same key find-all-references buckets by. */
    readonly targetKey: string;
    /** The name the sites spell, which is the cheap text pre-filter before anything is resolved. */
    readonly name: string;
    /** The declaration's own name range, when the declaration lives in this document. */
    readonly declarationRange?: Range;
    /**
     * The range the cursor itself sits on, when it sits on a reference. A member can point at
     * another one (`RecAmmo = &Weapon/AmmoPerSecond`), and the game reads through the whole chain, so
     * a reference to `RecAmmo` names `AmmoPerSecond` and is spelled nothing like it. It is still an
     * occurrence, and the one the reader is looking at, so it is always part of the answer.
     */
    readonly cursorRange?: Range;
}

/** The highlights computed for one document version, keyed by the cursor position that asked for them. */
interface HighlightMemoEntry {
    version: number;
    byPosition: Map<string, DocumentHighlight[] | null>;
}

// Occurrence highlighting is requested on every cursor move, and a reader holding an arrow key down
// asks for the same few positions over and over, so each answer is kept until the buffer changes.
// The cap bounds a long navigation session in one file; dropping the whole entry is enough, the next
// move recomputes.
const highlightMemo = new Map<string, HighlightMemoEntry>();
const HIGHLIGHT_MEMO_POSITION_CAP = 512;

// A reference branch answer depends on the files the reference resolves through, so it goes stale
// when a sibling file changes even though this buffer did not. The fs caches announce exactly that.
onFsInvalidation(() => highlightMemo.clear());

/** True when a position falls inside a range, both ends included, as the cursor sits on a character. */
const rangeCovers = (range: Range, position: Position): boolean =>
    position.line === range.start.line &&
    position.character >= range.start.character &&
    position.character <= range.end.character;

/**
 * The range a declaration is highlighted at: the name a reader sees rather than the value behind it.
 * A group or list shows its identifier, and a `Key = value` shows its key, because that is the text
 * the reference points at even though the reference index buckets by the value's own position.
 */
const declarationNameRange = (node: AbstractNode): Range => {
    const container = node.parent;
    if (container && (isGroupNode(container) || isListNode(container) || isDocumentNode(container))) {
        for (const element of container.elements) {
            if (isAssignmentNode(element) && element.right === node) return rangeOf(element.left);
        }
    }
    return rangeOf(node);
};

/** A stable key for one highlight, so the same text is never decorated twice. */
const highlightKey = (highlight: DocumentHighlight): string => {
    const { start, end } = highlight.range;
    return `${start.line}:${start.character}-${end.line}:${end.character}`;
};

/** Drop duplicate ranges, keeping the strongest kind, so a declaration that is also a use reads as a write. */
const dedupeHighlights = (highlights: DocumentHighlight[]): DocumentHighlight[] => {
    const byRange = new Map<string, DocumentHighlight>();
    for (const highlight of highlights) {
        const key = highlightKey(highlight);
        const existing = byRange.get(key);
        if (!existing || highlight.kind === DocumentHighlightKind.Write) byRange.set(key, highlight);
    }
    return [...byRange.values()];
};

/** True when two classes name the same entity family, which is how one id can be written under either. */
const classesRelated = (a: string, b: string): boolean => isSameOrSubclass(a, b) || isSameOrSubclass(b, a);

// Collecting a document's own id declarations walks the whole file, and the walk is repeated for
// every cursor move that lands on a plain string, so the result is kept per parsed AST. A re-parse
// produces new node identities, which retires the old entry without any explicit invalidation.
const localIdDeclarationsMemo = new WeakMap<AbstractNodeDocument, readonly LocalIdDeclaration[]>();

/**
 * Every cross-file id this document declares: a whole-file root's own top-level `ID`, plus each
 * aggregate entity written in a list the game reads ids from (`Factions [ { ID … } ]`,
 * `PartToggles [ { ToggleID … } ]`, …).
 *
 * @param document the parsed document to collect from.
 * @returns the declarations, memoized per parsed AST.
 */
const localIdDeclarations = (document: AbstractNodeDocument): readonly LocalIdDeclaration[] => {
    const cached = localIdDeclarationsMemo.get(document);
    if (cached) return cached;
    const declarations: LocalIdDeclaration[] = [];
    const rootClass = documentRootClass(document);
    if (rootClass) {
        for (const element of document.elements) {
            if (isAssignmentNode(element) && element.left.name === 'ID' && isValueNode(element.right)) {
                declarations.push({ id: String(element.right.valueType.value), cls: rootClass, node: element.right });
            }
        }
    }
    for (const declaration of entityDeclarationsOf(document)) {
        declarations.push({ id: declaration.id, cls: declaration.elementClass, node: declaration.node });
    }
    localIdDeclarationsMemo.set(document, declarations);
    return declarations;
};

/**
 * The cross-file id the cursor names, whether it sits on a use (`ResourceType = battery`, a map key
 * such as `MaxBuffValues = { Engine = … }`) or on the declaration itself (`ID = battery`).
 *
 * @param document the parsed document the cursor is in.
 * @param position the cursor position.
 * @param cursorNode the node the cursor resolves to, or null when it sits on nothing.
 * @returns the id and the class its site names, or undefined when the cursor is not on an id.
 */
const crossFileIdAt = (
    document: AbstractNodeDocument,
    position: Position,
    cursorNode: AbstractNode | null
): CrossFileIdCursor | undefined => {
    if (cursorNode && isValueNode(cursorNode) && cursorNode.valueType.type === 'String') {
        const reference = schemaReferenceFieldOf(cursorNode);
        if (reference) return { id: reference.value, cls: reference.targetClass };
        const declaration = localIdDeclarations(document).find((candidate) => candidate.node === cursorNode);
        if (declaration) return { id: declaration.id, cls: declaration.cls };
    }
    const key = mapKeyReferenceAt(document, position);
    return key ? { id: key.value, cls: key.targetClass } : undefined;
};

/**
 * The highlights for a particle data channel: every `ParticleDataID` field in the file carrying the
 * same name. A channel is a file-scoped symbol, so this needs no resolution and no other file.
 *
 * @param document the parsed particle document.
 * @param channel the channel occurrence under the cursor.
 * @returns one highlight per occurrence, a write for the fields that declare the channel (`…Out`,
 * `…InOut`) and a read for the fields that consume it (`…In`).
 */
const channelHighlights = (document: AbstractNodeDocument, channel: ChannelOccurrence): DocumentHighlight[] =>
    channelOccurrences(document, channel.name).map((occurrence) => ({
        range: channelRangeOf(occurrence),
        kind: occurrence.direction === 'in' ? DocumentHighlightKind.Read : DocumentHighlightKind.Write,
    }));

/**
 * The highlights for a cross-file id, restricted to this document: every reference value and every
 * map key naming the id, plus the declaration when this file is the one that declares it. The game
 * matches ids without regard to case, so `SW.Armor_Wedge` and `sw.armor_wedge` are one symbol here.
 *
 * @param document the parsed document to search.
 * @param cursor the id under the cursor and the class its site names.
 * @returns the doc-local sites, uses as reads and the declaration as a write.
 */
const idHighlights = (document: AbstractNodeDocument, cursor: CrossFileIdCursor): DocumentHighlight[] => {
    const highlights: DocumentHighlight[] = [];
    for (const value of stringValueNodesOf(document)) {
        const reference = schemaReferenceFieldOf(value);
        if (reference && sameId(reference.value, cursor.id) && classesRelated(cursor.cls, reference.targetClass)) {
            highlights.push({ range: valueTextRange(value), kind: DocumentHighlightKind.Read });
        }
    }
    for (const key of mapKeyReferencesOf(document)) {
        if (sameId(key.value, cursor.id) && classesRelated(cursor.cls, key.targetClass)) {
            highlights.push({ range: rangeOf(key.node), kind: DocumentHighlightKind.Read });
        }
    }
    for (const declaration of localIdDeclarations(document)) {
        // An id declaration is lit at the id itself rather than at the `ID` key, because the id is
        // the text every other file spells, and because the game reads that line as a reference to
        // the entity it declares, which would otherwise decorate the same line twice.
        if (sameId(declaration.id, cursor.id) && classesRelated(cursor.cls, declaration.cls)) {
            highlights.push({ range: rangeOf(declaration.node), kind: DocumentHighlightKind.Write });
        }
    }
    return dedupeHighlights(highlights);
};

/**
 * The symbol the cursor names in the generic case: a reference resolves to what its segment points
 * at, a schema `ID<>` sibling value resolves to the component it names, and anything else is its own
 * declaration. A cursor on an inner segment of a path names that segment, not the path's endpoint,
 * which is what keeps the highlight under the reader's cursor.
 *
 * @param document the parsed document the cursor is in.
 * @param position the cursor position.
 * @param cursorNode the node the cursor resolves to.
 * @param cancellationToken cancels the cross-file resolution.
 * @returns the symbol, or null when the cursor names nothing that can be searched for.
 */
const resolveHighlightSymbol = async (
    document: AbstractNodeDocument,
    position: Position,
    cursorNode: AbstractNode,
    cancellationToken: CancellationToken
): Promise<HighlightSymbol | null> => {
    let target: AbstractNode;
    let cursorRange: Range | undefined;
    if (isReferenceValue(cursorNode)) {
        const span = segmentSpanAt(cursorNode, position);
        // Only a plain member name names something to look for. A path sigil, a positional index and
        // the `<file.rules>` part of a path are steps on the way, not symbols in their own right.
        if (!span || !MEMBER_SEGMENT_NAME.test(segmentName(span))) return null;
        const resolved = await segmentTargetNode(document, cursorNode, span, cancellationToken);
        if (!resolved) return null;
        target = resolved;
        cursorRange = segmentNameRange(cursorNode, span);
    } else {
        target = resolveSchemaSiblingReference(cursorNode) ?? cursorNode;
    }

    const name = definitionNameOf(target);
    if (!name) return null;
    const declaration = definitionLocationOf(target);
    const inThisDocument = normalizeUri(declaration.uri) === normalizeUri(document.uri);
    return {
        targetKey: locationKey(declaration),
        name,
        declarationRange: inThisDocument ? declarationNameRange(target) : undefined,
        cursorRange,
    };
};

/**
 * The highlights for a resolved symbol, restricted to this document: every reference segment spelling
 * the name and resolving to the same declaration, every schema `ID<>` sibling value naming it, and the
 * declaration itself when it lives here.
 *
 * @param document the parsed document to search.
 * @param symbol the symbol the cursor named.
 * @param cancellationToken cancels the per-reference resolution, which ends the walk.
 * @returns the doc-local sites, uses as reads and the declaration as a write.
 */
const referenceHighlights = async (
    document: AbstractNodeDocument,
    symbol: HighlightSymbol,
    cancellationToken: CancellationToken
): Promise<DocumentHighlight[]> => {
    const highlights: DocumentHighlight[] = [];
    // Two references with the same text under the same container resolve against the same scope and
    // therefore to the same target, so a file that repeats a reference resolves it once.
    const resolvedBySegment = new Map<string, string | null>();
    for (const reference of referenceNodesOf(document)) {
        if (cancellationToken.isCancellationRequested) return highlights;
        const value = String(reference.valueType.value);
        if (!value.includes(symbol.name)) continue;
        const containerKey = enclosingContainerKey(reference);
        for (const span of segmentSpans(value)) {
            if (segmentName(span) !== symbol.name) continue;
            // The container key is a space-free token, so one space joins it to the path
            // unambiguously even when the path holds a `<file name with spaces.rules>` part.
            const memoKey = `${value.substring(0, span.end)} ${containerKey}`;
            let resolvedKey = resolvedBySegment.get(memoKey);
            if (resolvedKey === undefined && !resolvedBySegment.has(memoKey)) {
                resolvedKey = await segmentTargetKey(document, reference, span, cancellationToken);
                resolvedBySegment.set(memoKey, resolvedKey);
            }
            if (resolvedKey === symbol.targetKey) {
                highlights.push({ range: segmentNameRange(reference, span), kind: DocumentHighlightKind.Read });
            }
        }
    }

    // A schema `ID<>` sibling reference (`OperationalToggle = IsOperational`) is a bare string rather
    // than a `&` reference, and it always names a sibling, so this document is the whole search.
    for (const candidate of stringValueNodesOf(document)) {
        if (String(candidate.valueType.value) !== symbol.name) continue;
        const target = resolveSchemaSiblingReference(candidate);
        if (target && locationKey(definitionLocationOf(target)) === symbol.targetKey) {
            highlights.push({ range: valueTextRange(candidate), kind: DocumentHighlightKind.Read });
        }
    }

    if (symbol.cursorRange) {
        highlights.push({ range: symbol.cursorRange, kind: DocumentHighlightKind.Read });
    }
    if (symbol.declarationRange) {
        highlights.push({ range: symbol.declarationRange, kind: DocumentHighlightKind.Write });
    }
    return dedupeHighlights(highlights);
};

/** The highlights for one position, before any memoization. Null wherever the server has no answer. */
const computeHighlights = async (
    document: AbstractNodeDocument,
    position: Position,
    workspaceReady: boolean,
    cancellationToken: CancellationToken
): Promise<DocumentHighlight[] | null> => {
    // A particle data channel (`DataOut = rot_vel` … `BIn = rot_vel`) is a file-scoped symbol the
    // schema recognises outright, so it is answered before anything is resolved.
    const channel = particleChannelAt(document, position);
    if (channel) return channelHighlights(document, channel);

    const cursorNode = findReferenceTargetAtPosition(document, position);

    // A cross-file id names an entity in another file, but the sites in this file are found by id and
    // class alone, so the answer needs neither the project scan nor any disk access.
    const idCursor = crossFileIdAt(document, position, cursorNode);
    if (idCursor) {
        const highlights = idHighlights(document, idCursor);
        return highlights.length ? highlights : null;
    }

    if (!cursorNode) return null;
    // Everything left resolves references, which reads other files. Until the game scan has settled,
    // that resolution would answer from a half-built picture, so the editor keeps its word matcher.
    if (!workspaceReady) return null;

    const symbol = await resolveHighlightSymbol(document, position, cursorNode, cancellationToken);
    if (!symbol) return null;
    const highlights = await referenceHighlights(document, symbol, cancellationToken);
    if (!highlights.length) return null;
    // A single hit that does not cover the cursor means the reader clicked a value nobody refers to,
    // where lighting up its key alone says nothing the reader cannot already see.
    if (highlights.length === 1 && !rangeCovers(highlights[0].range, position)) return null;
    return highlights;
};

/**
 * All occurrences of the symbol under the cursor within one document, for `textDocument/documentHighlight`.
 *
 * @param document the parsed document the cursor is in.
 * @param position the cursor position.
 * @param workspaceReady whether the project scan has settled, which gates the branch that resolves
 * references across files.
 * @param version the open buffer's version, which keys the memo. Undefined computes without caching.
 * @param cancellationToken cancels the cross-file resolution.
 * @returns the highlights, or null when the server has no answer for this position, which is what
 * leaves the editor's own word matching in place.
 */
export const documentHighlightsAt = async (
    document: AbstractNodeDocument,
    position: Position,
    workspaceReady: boolean,
    version: number | undefined,
    cancellationToken: CancellationToken
): Promise<DocumentHighlight[] | null> => {
    // A `.shader` file is HLSL, not Object Text. Parsing one with the Object Text parser yields a
    // nonsense AST, and a word match over a shader is exactly what the editor already does for free.
    if (isShaderDocument(document.uri)) return null;
    // An id inside a group deriving from a base in another file is recognized as a reference only
    // once that group's class is known to the synchronous schema lookups.
    await warmInheritedClasses(document, cancellationToken).catch(() => undefined);

    const uriKey = normalizeUri(document.uri);
    const positionKey = `${position.line}:${position.character}`;
    const entry = version === undefined ? undefined : highlightMemo.get(uriKey);
    if (entry && entry.version === version) {
        const cached = entry.byPosition.get(positionKey);
        if (cached !== undefined) return cached;
    }

    const highlights = await computeHighlights(document, position, workspaceReady, cancellationToken);
    // A cancelled request answers from a partial walk, so its answer must not outlive the request.
    if (version === undefined || cancellationToken.isCancellationRequested) return highlights;

    const fresh = entry && entry.version === version ? entry : { version, byPosition: new Map() };
    if (fresh.byPosition.size >= HIGHLIGHT_MEMO_POSITION_CAP) fresh.byPosition.clear();
    fresh.byPosition.set(positionKey, highlights);
    highlightMemo.set(uriKey, fresh);
    return highlights;
};

/**
 * Drops memoized highlights, for a closed document or wholesale.
 *
 * @param uri the document whose entry to drop, or undefined to drop every entry.
 */
export const clearDocumentHighlightCache = (uri?: string): void => {
    if (uri === undefined) highlightMemo.clear();
    else highlightMemo.delete(normalizeUri(uri));
};
