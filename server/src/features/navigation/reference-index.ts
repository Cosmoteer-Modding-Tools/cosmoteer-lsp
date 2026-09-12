import { CancellationToken, Location, Position, WorkDoneProgressReporter } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isIdentifierNode,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isMathExpressionNode,
    isGroupNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { isModRules } from '../../document/document-kind';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { warmInheritedClasses } from '../completion/inheritance-resolution';
import { isReferenceValue } from './definition.service';
import {
    dedupeLocations,
    definitionLocationOf,
    definitionNameOf,
    locationKey,
    normalizeUri,
    referenceSiteLocation,
} from './reference-location';
import { resolveSchemaSiblingReference, stringValueNodesOf } from './schema-reference.navigation';
import {
    FileReferenceAnchor,
    fileReferenceName,
    fileReferenceSites,
    idReferenceSites,
    idSymbolAt,
    idSymbolAtMapKey,
} from './schema-id-symbol';
import { filePathToUri, SegmentSpan } from './navigation-strategy';
import {
    referenceShapeOf,
    segmentNameRange,
    namedSegmentAt,
    segmentTarget,
    segmentTargetIdentity,
    segmentTargetKey,
    segmentsNamed,
} from './reference-segment';
import { particleChannelAt, channelOccurrences } from './particle-channel';
import { documentsMatching, documentsMentioning } from './workspace-files';

/**
 * Find-all-references via a targeted, name-pre-filtered search.
 *
 * find-all-references is the inverse of go-to-definition (target → all refs). Rather than
 * pre-resolving every reference in the project into a reverse map, which doesn't scale to
 * the whole Cosmoteer `Data` tree (it would parse and cross-file-resolve tens of thousands
 * of references up front), this resolves the symbol under the cursor, then scans only the
 * files whose text mentions that symbol's name ({@link documentsMentioning}), resolving each
 * candidate reference with the same {@link DefinitionService} go-to-def uses and keeping the
 * ones that resolve to the same {@link locationKey}. Bounded by the name's frequency, needs
 * no prebuilt index, and is always fresh (reads current buffers/disk per query).
 *
 * A cross-file id is searched under two spellings rather than one, since the corpus writes the same
 * relation both ways (see {@link idMentionSweeps}), and a file writing only the file-reference
 * spelling never mentions the id at all.
 *
 * Kept as a singleton named `ReferenceIndex` for call-site/test stability.
 */
export class ReferenceIndex {
    private static _instance: ReferenceIndex;

    private constructor() {}

    public static get instance(): ReferenceIndex {
        if (!ReferenceIndex._instance) {
            ReferenceIndex._instance = new ReferenceIndex();
        }
        return ReferenceIndex._instance;
    }

    /**
     * All references to the definition under `position` (plus the declaration when
     * `includeDeclaration`). The cursor may sit on a reference (→ resolve it to its
     * target) or on the definition itself.
     */
    public async findReferences(
        document: AbstractNodeDocument,
        position: Position,
        includeDeclaration: boolean,
        folderPaths: string[],
        cancellationToken: CancellationToken,
        progress?: WorkDoneProgressReporter
    ): Promise<Location[]> {
        // An id inside a group deriving from a base in another file is a schema symbol only once
        // that group's class is known to the synchronous schema lookups.
        await warmInheritedClasses(document, cancellationToken).catch(() => undefined);
        // A particle data channel (`DataOut = rot_vel` … `BIn = rot_vel`) is a same-file symbol. Every
        // `ParticleDataID` field carrying the name is a site. Detected by cursor position on a channel.
        const channel = particleChannelAt(document, position);
        if (channel) {
            return dedupeLocations(channelOccurrences(document, channel.name).map((c) => referenceSiteLocation(c.node)));
        }

        // A cross-file `ID<X>` symbol (a whole-file root keyed by `ID`, or a bare-id reference to one)
        // is found by id + root class, not by member name. Handle it as its own search.
        const rawNode = findReferenceTargetAtPosition(document, position);
        const idSymbol =
            (await idSymbolAt(rawNode, folderPaths, cancellationToken).catch(() => null)) ??
            (await idSymbolAtMapKey(document, position, folderPaths, cancellationToken).catch(() => null));
        if (idSymbol) {
            // `ID = battery` is itself an `ID<Self>` reference, so the declaration's own ID line is a
            // site. Exclude it from usages (it's re-added only when includeDeclaration).
            const declKey = locationKey(idSymbol.location);
            const anchor: FileReferenceAnchor = {
                declarationKey: declKey,
                fileName: fileReferenceName(idSymbol.location.uri),
            };
            const idSites: Location[] = [];
            const push = (site: AbstractNode): void => {
                const location = referenceSiteLocation(site);
                if (locationKey(location) !== declKey) idSites.push(location);
            };
            const walked = new Set<string>();
            progress?.begin('Searching references', 0, '', false);
            try {
                // Every candidate document is walked once and asked for both spellings, so a file
                // that writes the id and a file reference to it is neither parsed nor scanned twice.
                for (const mention of idMentionSweeps(idSymbol.id, anchor.fileName)) {
                    for await (const doc of documentsMentioning(folderPaths, mention, cancellationToken)) {
                        const key = normalizeUri(doc.uri);
                        if (walked.has(key)) continue;
                        walked.add(key);
                        for (const site of idReferenceSites(doc, idSymbol)) push(site);
                        for await (const site of fileReferenceSites(doc, anchor, cancellationToken)) push(site);
                    }
                }
            } finally {
                progress?.done();
            }
            if (includeDeclaration) idSites.push(idSymbol.location);
            return dedupeLocations(idSites);
        }

        const target = await this.resolveTarget(document, position, cancellationToken);
        if (!target) return [];
        const name = definitionNameOf(target.node);
        if (!name) return [];

        const declaration = definitionLocationOf(target.node);
        const targetKey = target.key;
        const sites: Location[] = [];

        progress?.begin('Searching references', 0, '', false);
        try {
            // A file that only declares the name (a `Components` group of its own) can never refer to
            // this declaration, so the candidate's raw text has to spell the name in a reference
            // position before it is worth parsing at all. On the Star Wars mod that is most of the
            // corpus for a name as common as `Part`.
            const shape = referenceShapeOf(name);
            for await (const doc of documentsMatching(folderPaths, name, cancellationToken, (text) =>
                shape.test(text)
            )) {
                // References resolving against the same scope resolve identically (an OT relative
                // path (`&Name`, `^/N/…`, `..`) is resolved against its container's scope, a `~/…`
                // path against the file root, an absolute one against nothing at all). A document
                // that repeats a reference many times (a big component list, an array of
                // near-identical entries) would otherwise re-run the full cross-file resolution per
                // copy. Memoize the resolved target key per (path prefix, scope) for the current
                // document, so each distinct lookup is resolved once. Correctness is unaffected: the
                // key never merges two references that could resolve differently.
                const resolvedByPrefix = new Map<string, string | null>();
                for (const reference of referenceNodesOf(doc)) {
                    const spans = segmentsNamed(reference, name);
                    if (!spans.length) continue;
                    const value = String(reference.valueType.value);
                    const scope = resolutionScopeKey(doc, reference, value);
                    for (const span of spans) {
                        // The scope key is a space-free token, so one space joins it to the path
                        // unambiguously, even when the path holds a `<name with spaces.rules>` part.
                        const memoKey = `${value.substring(0, span.end)} ${scope}`;
                        let resolvedKey = resolvedByPrefix.get(memoKey);
                        if (resolvedKey === undefined && !resolvedByPrefix.has(memoKey)) {
                            resolvedKey = await segmentTargetKey(doc, reference, span, cancellationToken);
                            resolvedByPrefix.set(memoKey, resolvedKey);
                        }
                        if (resolvedKey === targetKey) sites.push(segmentSiteLocation(reference, span));
                    }
                }
            }
        } finally {
            progress?.done();
        }

        // Schema `ID<>` sibling references (e.g. `OperationalToggle = IsOperational`) are bare strings
        // and always same file, so scan just this document.
        for (const candidate of stringValueNodesOf(document)) {
            if (String(candidate.valueType.value) !== name) continue;
            const target = resolveSchemaSiblingReference(candidate);
            if (target && locationKey(definitionLocationOf(target)) === targetKey) {
                sites.push(referenceSiteLocation(candidate));
            }
        }

        if (includeDeclaration) sites.push(declaration);
        return dedupeLocations(sites);
    }

    /**
     * The symbol the cursor identifies: the node whose name the sites spell, and the identity every
     * site has to resolve to.
     *
     * @param document the parsed document the cursor is in.
     * @param position the cursor position.
     * @param cancellationToken cancels the cross-file resolution.
     * @returns the symbol, or null when the cursor names nothing searchable.
     */
    private async resolveTarget(
        document: AbstractNodeDocument,
        position: Position,
        cancellationToken: CancellationToken
    ): Promise<{ node: AbstractNode; key: string } | null> {
        const found = findReferenceTargetAtPosition(document, position);
        if (!found) return null;
        const identity = (node: AbstractNode) => ({ node, key: locationKey(definitionLocationOf(node)) });
        if (!isReferenceValue(found)) return identity(resolveSchemaSiblingReference(found) ?? found);
        // The cursor names the segment it sits on, not the path's endpoint, so a mid-path name is
        // searched for as itself rather than as whatever the rest of the path lands on.
        const span = namedSegmentAt(found, position);
        if (!span) return null;
        const resolved = await segmentTarget(document, found, span, cancellationToken);
        if (!resolved) return null;
        // `EditorGroups = &<editor_groups.rules>`: the reference names a whole file, which has no
        // declaration to search for, but the key it is assigned to has one, and that is what other
        // files write. The sites reach the file through that key, so the file is what they resolve to.
        if (isFile(resolved as unknown as FileWithPath)) {
            return definitionNameOf(found) ? { node: found, key: segmentTargetIdentity(resolved) } : null;
        }
        return identity(resolved as AbstractNode);
    }
}

/**
 * A key for the scope one reference path is resolved against, so two lookups sharing it are
 * resolved once. An absolute path (`&<file>/…`, `&/…`) depends on nothing, a runtime-rooted `~/…`
 * path on the file it is written in, and every other relative form on its enclosing container.
 *
 * A `mod.rules` manifest is excluded from the wider keys: the same text is resolved as an action
 * target there when it sits in a target field and as an ordinary reference when it does not.
 *
 * @param document the document the reference lives in.
 * @param node the reference node.
 * @param value the reference's path text.
 * @returns the scope key.
 */
const resolutionScopeKey = (document: AbstractNodeDocument, node: AbstractNode, value: string): string => {
    if (isModRules(document.uri)) return enclosingContainerKey(node);
    const path = value.startsWith('&') ? value.slice(1) : value;
    if (path.startsWith('<') || path.startsWith('/')) return 'absolute';
    if (path.startsWith('~')) return 'file';
    return enclosingContainerKey(node);
};

/** The LSP location of one matching segment of a reference, so a long path reports only the part
 *  that names the symbol. */
const segmentSiteLocation = (node: ValueNode, span: SegmentSpan): Location => ({
    uri: filePathToUri(getStartOfAstNode(node).uri),
    range: segmentNameRange(node, span),
});

/**
 * The texts to sweep the project for when searching a cross-file id: the id itself, which finds the
 * bare-id spelling, and the declaring file's name, which finds the file-reference spelling
 * (`PartsUnlocked = [&<./Data/ships/terran/cannon_med/cannon_med.rules>/Part/ID]`). The second sweep
 * is what makes the search complete, because a file writing only that spelling need never mention the
 * id anywhere. When one text contains the other, sweeping the contained one alone already yields
 * every document the other would, so only that sweep runs.
 *
 * @param id the cross-file id being searched.
 * @param fileName the declaring file's name, or '' when there is none.
 * @returns the texts to run {@link documentsMentioning} for, in sweep order.
 */
const idMentionSweeps = (id: string, fileName: string): string[] => {
    if (!fileName || fileName === id) return [id];
    if (id.includes(fileName)) return [fileName];
    if (fileName.includes(id)) return [id];
    return [id, fileName];
};

/**
 * A key for the scope an OT relative reference resolves against: its nearest enclosing group or
 * list (or the document root). Two references with the same text under the same container resolve
 * to the same target, so this keys the per-document resolution memo of every reference search.
 *
 * @param node the reference node whose resolution scope is wanted.
 * @returns the enclosing container's start offset, or 'root' at document level.
 */
export const enclosingContainerKey = (node: AbstractNode): string => {
    let current: AbstractNode | undefined = node.parent;
    while (current && !(isGroupNode(current) || isListNode(current))) current = current.parent;
    return current?.position ? String(current.position.start) : 'root';
};

/**
 * The reference value a bare `&…` list element stands for (`&/PARTICLES/Foo` inside `MediaEffects
 * [ … ]`).
 *
 * The parser gives such an element an IdentifierNode rather than a ValueNode whenever the preceding
 * sibling is not a value, which is what happens right after a `}`. The game reads it as a reference
 * all the same, so every reference-shaped feature has to see one. The wrap carries the identifier's
 * own parent and position, so the scope it resolves in and the range it reports are the written
 * element's.
 *
 * @param node the node to inspect.
 * @returns the reference value it stands for, or null when it is not a bare list reference.
 */
export const standaloneReferenceValue = (node: AbstractNode | null | undefined): ValueNode | null => {
    if (!isIdentifierNode(node) || typeof node.name !== 'string' || !node.name.startsWith('&')) return null;
    const parent = node.parent;
    if (!parent || !isListNode(parent) || !parent.elements.includes(node)) return null;
    return {
        type: 'Value',
        valueType: { type: 'Reference', value: node.name },
        parent,
        position: node.position,
    };
};

/** Every reference value node in a document, depth-first across all node shapes. */
export function* referenceNodesOf(node: AbstractNode | null | undefined): Generator<ValueNode> {
    // A document parsed with errors can have null slots (e.g. `Key =` with no value →
    // `right: null`, or a missing list element). Skip them instead of crashing the search.
    if (!node) return;
    if (isGroupNode(node) || isListNode(node)) {
        for (const ref of node.inheritance ?? []) yield* referenceNodesOf(ref);
        for (const child of node.elements) yield* referenceNodesOf(child);
    } else if (isDocumentNode(node)) {
        for (const child of node.elements) yield* referenceNodesOf(child);
    } else if (isAssignmentNode(node)) {
        yield* referenceNodesOf(node.right);
    } else if (isFunctionCallNode(node)) {
        for (const argument of node.arguments) yield* referenceNodesOf(argument);
    } else if (isMathExpressionNode(node)) {
        for (const element of node.elements) yield* referenceNodesOf(element);
    } else if (isValueNode(node) && node.valueType.type === 'Reference') {
        yield node;
    } else {
        const standalone = standaloneReferenceValue(node);
        if (standalone) yield standalone;
    }
}

/**
 * The reference or definition node under `position`. Unlike {@link findNodeAtPosition}
 * this also matches a group/list identifier (→ the container, the natural "click the
 * name I defined" case) and an assignment key (→ its value, where references to a
 * `key = value` actually land), so find-all-references works from the definition side too.
 */
export const findReferenceTargetAtPosition = (
    document: AbstractNodeDocument,
    position: Position
): AbstractNode | null => {
    const within = (node: { position?: AbstractNode['position'] }): boolean => {
        const p = node.position;
        return (
            !!p &&
            position.line === p.line &&
            position.character >= p.characterStart &&
            position.character <= p.characterEnd
        );
    };
    const recurse = (node: AbstractNode | null | undefined): AbstractNode | null => {
        if (!node) return null;
        if (isGroupNode(node) || isListNode(node)) {
            if (node.identifier && within(node.identifier)) return node;
            for (const ref of node.inheritance ?? []) {
                const hit = recurse(ref);
                if (hit) return hit;
            }
            for (const child of node.elements) {
                const hit = recurse(child);
                if (hit) return hit;
            }
            return null;
        }
        if (isAssignmentNode(node)) {
            if (within(node.left)) return node.right;
            return recurse(node.right);
        }
        if (isFunctionCallNode(node)) {
            for (const argument of node.arguments) {
                const hit = recurse(argument);
                if (hit) return hit;
            }
            return null;
        }
        if (isMathExpressionNode(node)) {
            for (const element of node.elements) {
                const hit = recurse(element);
                if (hit) return hit;
            }
            return null;
        }
        if (!within(node)) return null;
        // A bare `&…` list element is an identifier in the tree, so the caret sitting on one is
        // answered with the reference it stands for rather than with a name nothing declares.
        return standaloneReferenceValue(node) ?? node;
    };
    for (const element of document.elements) {
        const hit = recurse(element);
        if (hit) return hit;
    }
    return null;
};
