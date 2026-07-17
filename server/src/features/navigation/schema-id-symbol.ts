import { CancellationToken, Location } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { documentRootClass } from '../../document/schema/document-root';
import { entityDeclarationsOf } from '../../document/schema/entity-schema';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { definitionLocationOf } from './reference-location';
import { Position } from 'vscode-languageserver';
import { schemaReferenceFieldOf, isSameOrSubclass, mapKeyReferencesOf, mapKeyReferenceAt } from './schema-id-reference.navigation';
import { stringValueNodesOf } from './schema-reference.navigation';
import { documentsMentioning } from './workspace-files';

/** A cross-file id symbol: a whole-file root identified by its `ID`, plus where it's declared. */
export interface IdSymbol {
    readonly id: string;
    /** The declaring file's actual root class (e.g. `…ResourceRules`). */
    readonly rootClass: string;
    /** The `ID = …` declaration location. */
    readonly location: Location;
}

/** The top-level `ID = <value>` value node of a whole-file-root document, if any. */
const topLevelIdNode = (document: AbstractNodeDocument): ValueNode | undefined => {
    for (const element of document.elements) {
        if (isAssignmentNode(element) && element.left.name === 'ID' && isValueNode(element.right)) return element.right;
    }
    return undefined;
};

/** Find the whole-file root that declares `id` as an instance of `targetClass` (or a subclass). */
export const findIdDeclaration = async (
    targetClass: string,
    id: string,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<IdSymbol | undefined> => {
    for await (const document of documentsMentioning(folderPaths, id, cancellationToken)) {
        // Whole-file root keyed by its top-level `ID`.
        const rootClass = documentRootClass(document);
        if (rootClass && isSameOrSubclass(rootClass, targetClass)) {
            const idNode = topLevelIdNode(document);
            if (idNode && String(idNode.valueType.value) === id) {
                return { id, rootClass, location: definitionLocationOf(idNode) };
            }
        }
        // Aggregate list-element entity keyed by its identity field (`ID`/`ColorID`/`ToggleID`/…).
        for (const decl of entityDeclarationsOf(document)) {
            if (decl.id === id && isSameOrSubclass(decl.elementClass, targetClass)) {
                return { id, rootClass: decl.elementClass, location: definitionLocationOf(decl.node) };
            }
        }
    }
    return undefined;
};

/**
 * The cross-file id symbol the cursor identifies, or undefined. The cursor may sit on a usage
 * (a bare-id `ID<X>` reference value, e.g. `ResourceType = battery` → resolve to the declaring file)
 * or on the declaration itself (a whole-file root's own `ID = battery` value).
 */
export const idSymbolAt = async (
    node: AbstractNode | null | undefined,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<IdSymbol | undefined> => {
    if (!node || !isValueNode(node)) return undefined;

    // Usage: a cross-file `ID<X>` reference → its declaration elsewhere.
    const ref = schemaReferenceFieldOf(node);
    if (ref) return await findIdDeclaration(ref.targetClass, ref.value, folderPaths, cancellationToken);

    // Declaration: this document's own top-level `ID = …` (the file is a whole-file root).
    const container = node.parent;
    if (container && isDocumentNode(container)) {
        const rootClass = documentRootClass(container);
        if (rootClass && topLevelIdNode(container) === node && node.valueType.type === 'String') {
            return { id: String(node.valueType.value), rootClass, location: definitionLocationOf(node) };
        }
    }
    // Declaration: an aggregate list-element entity's own id value (`ColorID = "roof_light"`, the
    // `ID = monolith` of a faction, …), identified by walking the document's entity declarations.
    const document = getStartOfAstNode(node);
    for (const decl of entityDeclarationsOf(document)) {
        if (decl.node === node) {
            return { id: decl.id, rootClass: decl.elementClass, location: definitionLocationOf(node) };
        }
    }
    return undefined;
};

/**
 * Resolves the cross-file id symbol for a map-key reference under the cursor, so find-references and
 * rename can start from a map key (`MaxBuffValues = { Engine = … }`) and not only from a value
 * reference or the declaration. The symbol's location is the entity's declaration.
 *
 * @param document the parsed document the cursor is in.
 * @param position the cursor position.
 * @param folderPaths the project folders to search for the declaration.
 * @param cancellationToken cancellation for the cross-file scan.
 * @returns the resolved {@link IdSymbol}, or undefined when the cursor is not on a resolvable map key.
 */
export const idSymbolAtMapKey = async (
    document: AbstractNodeDocument,
    position: Position,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<IdSymbol | undefined> => {
    const key = mapKeyReferenceAt(document, position);
    return key ? findIdDeclaration(key.targetClass, key.value, folderPaths, cancellationToken) : undefined;
};

/**
 * Yields every reference in a document that resolves to a given cross-file id symbol. This covers
 * both value references (`ResourceType = battery`, `ReceivableBuffs = [Engine]`) and map-key
 * references (`MaxBuffValues = { Engine = … }`), so find-all-references and rename reach every use of
 * an entity, not only its value-position uses.
 *
 * @param document the parsed document to scan.
 * @param symbol the cross-file id symbol whose references are wanted.
 * @returns a generator of every matching reference node, a value node or a map-key identifier.
 */
export function* idReferenceSites(document: AbstractNodeDocument, symbol: IdSymbol): Generator<AbstractNode> {
    for (const value of stringValueNodesOf(document)) {
        const ref = schemaReferenceFieldOf(value);
        if (ref && ref.value === symbol.id && isSameOrSubclass(symbol.rootClass, ref.targetClass)) yield value;
    }
    for (const key of mapKeyReferencesOf(document)) {
        if (key.value === symbol.id && isSameOrSubclass(symbol.rootClass, key.targetClass)) yield key.node;
    }
}
