import { CancellationToken, Location, Position, WorkDoneProgressReporter } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isListNode,
    isAssignmentNode,
    isDocumentNode,
    isFunctionCallNode,
    isMathExpressionNode,
    isGroupNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { DefinitionService, isReferenceValue } from './definition.service';
import { definitionLocationOf, definitionNameOf, locationKey, referenceSiteLocation } from './reference-location';
import { resolveSchemaSiblingReference, stringValueNodesOf } from './schema-reference.navigation';
import { idReferenceSites, idSymbolAt, idSymbolAtMapKey } from './schema-id-symbol';
import { particleChannelAt, channelOccurrences } from './particle-channel';
import { documentsMentioning } from './workspace-files';

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
            const idSites: Location[] = [];
            progress?.begin('Searching references', 0, '', false);
            try {
                for await (const doc of documentsMentioning(folderPaths, idSymbol.id, cancellationToken)) {
                    for (const site of idReferenceSites(doc, idSymbol)) {
                        const location = referenceSiteLocation(site);
                        if (locationKey(location) !== declKey) idSites.push(location);
                    }
                }
            } finally {
                progress?.done();
            }
            if (includeDeclaration) idSites.push(idSymbol.location);
            return dedupeLocations(idSites);
        }

        const targetNode = await this.resolveTargetNode(document, position, cancellationToken);
        if (!targetNode) return [];
        const name = definitionNameOf(targetNode);
        if (!name) return [];

        const declaration = definitionLocationOf(targetNode);
        const targetKey = locationKey(declaration);
        const sites: Location[] = [];

        progress?.begin('Searching references', 0, '', false);
        try {
            for await (const doc of documentsMentioning(folderPaths, name, cancellationToken)) {
                for (const reference of referenceNodesOf(doc)) {
                    // The `name` text must appear in the reference for it to possibly point here.
                    if (!String(reference.valueType.value).includes(name)) continue;
                    const resolved = await DefinitionService.instance
                        .resolveReferenceLocation(doc, reference, cancellationToken)
                        .catch(() => null);
                    if (resolved && locationKey(resolved) === targetKey) sites.push(referenceSiteLocation(reference));
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

    /** The definition node the cursor identifies, resolving through a reference if needed. */
    private async resolveTargetNode(
        document: AbstractNodeDocument,
        position: Position,
        cancellationToken: CancellationToken
    ): Promise<AbstractNode | null> {
        const found = findReferenceTargetAtPosition(document, position);
        if (!found) return null;
        if (!isReferenceValue(found)) return resolveSchemaSiblingReference(found) ?? found;
        const resolved = await DefinitionService.instance
            .resolveReferenceTarget(document, found, cancellationToken)
            .catch(() => null);
        if (!resolved || isFile(resolved as unknown as FileWithPath)) return null;
        return resolved as AbstractNode;
    }
}

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
        return within(node) ? node : null;
    };
    for (const element of document.elements) {
        const hit = recurse(element);
        if (hit) return hit;
    }
    return null;
};

/** Drop duplicate locations (same file + range). */
const dedupeLocations = (locations: Location[]): Location[] => {
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
