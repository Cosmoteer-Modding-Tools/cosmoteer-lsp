import { CancellationToken, Location } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { basenameOf } from '../../document/document-kind';
import { documentRootClass } from '../../document/schema/document-root';
import { entityDeclarationsOf } from '../../document/schema/entity-schema';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { DefinitionService } from './definition.service';
import { enclosingContainerKey, referenceNodesOf } from './reference-index';
import { definitionLocationOf, locationKey } from './reference-location';
import { Position } from 'vscode-languageserver';
import { schemaReferenceFieldOf, isSameOrSubclass, mapKeyReferencesOf, mapKeyReferenceAt } from './schema-id-reference.navigation';
import { stringValueNodesOf } from './schema-reference.navigation';
import { documentsMentioning, uriToFsPath } from './workspace-files';

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

/**
 * What a file-reference sweep is anchored to: the declaration a candidate must resolve to, the
 * declaring file's name that every such reference spells out, and an optional gate the caller applies
 * before anything is resolved.
 */
export interface FileReferenceAnchor {
    /** The {@link locationKey} of the declaration a surviving reference must resolve to. */
    readonly declarationKey: string;
    /** The declaring file's name, extension included, the raw-text pre-filter. */
    readonly fileName: string;
    /** An optional pre-resolution gate, so a caller resolves only the references it could want. */
    readonly accept?: (reference: ValueNode) => boolean;
}

/**
 * The text a reference must spell to point at a file: its name with the extension, exactly as
 * `&<./Data/ships/terran/corridor/corridor.rules>/Part/ID` writes it. Never the id, which does not
 * appear in such a reference at all. This is both the candidate-sweep key and the per-reference
 * pre-filter of {@link fileReferenceSites}, and the extension belongs to it because that is what keeps
 * both selective: keyed on the bare stem, all 18 vanilla files mentioning `armor` are read, parsed and
 * searched to find the one file that references `armor.rules`, measured at 173 ms per query against
 * 98 ms for the full name. The match is case-sensitive, like every mention pre-filter here, and both
 * vanilla and the 44 installed workshop mods write every one of their file references in lower case.
 *
 * @param uriOrPath the declaring file's uri or on-disk path.
 * @returns the file name with its extension, or '' when the path names no file.
 */
export const fileReferenceName = (uriOrPath: string): string => basenameOf(uriToFsPath(uriOrPath));

/**
 * Yields every reference in one document that names an id by pointing at the file that declares it
 * rather than by writing the id, which is how vanilla's own tech tree unlocks a part
 * (`PartsUnlocked = [&<./Data/ships/terran/cannon_med/cannon_med.rules>/Part/ID]`). Such a reference
 * carries no id text at all, so {@link idReferenceSites} can never see it. The candidates are
 * pre-filtered on the declaring file's name instead, and each survivor is resolved with the same
 * {@link DefinitionService} go-to-definition uses and kept when it lands on the declaration itself.
 *
 * A document that repeats one reference (a tech tree naming the same part file from several techs)
 * resolves it once, memoized by the reference text plus the scope it resolves against, since an OT
 * relative path is resolved against its container and therefore identically for its siblings. The
 * container key is a space-free token, so one space joins it to the text unambiguously even when the
 * text itself contains a space (a `<path with spaces.rules>` file reference).
 *
 * @param document the parsed document to scan.
 * @param anchor the declaration to match, its file-name pre-filter, and the caller's optional gate.
 * @param cancellationToken cancels the cross-file resolution, which ends the walk.
 * @returns a generator of every reference node resolving to the anchored declaration.
 */
export async function* fileReferenceSites(
    document: AbstractNodeDocument,
    anchor: FileReferenceAnchor,
    cancellationToken: CancellationToken
): AsyncGenerator<ValueNode> {
    if (!anchor.fileName) return;
    const resolvedByRef = new Map<string, string | null>();
    for (const reference of referenceNodesOf(document)) {
        if (cancellationToken.isCancellationRequested) return;
        const raw = String(reference.valueType.value);
        if (!raw.includes(anchor.fileName)) continue;
        if (anchor.accept && !anchor.accept(reference)) continue;
        const memoKey = `${raw} ${enclosingContainerKey(reference)}`;
        let resolvedKey = resolvedByRef.get(memoKey);
        if (resolvedKey === undefined && !resolvedByRef.has(memoKey)) {
            const resolved = await DefinitionService.instance
                .resolveReferenceLocation(document, reference, cancellationToken)
                .catch(() => null);
            resolvedKey = resolved ? locationKey(resolved) : null;
            resolvedByRef.set(memoKey, resolvedKey);
        }
        if (resolvedKey === anchor.declarationKey) yield reference;
    }
}
