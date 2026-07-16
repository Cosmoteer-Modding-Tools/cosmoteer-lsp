import { CancellationToken, Location, Position } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    IdentifierNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { listSlotType, resolveGroupClass } from '../../document/schema/schema-context';
import { documentRootClass } from '../../document/schema/document-root';
import { fieldOf, scalarReferenceTargetOf, typeDef } from '../../document/schema/schema';
import { entityDeclarationsOf, REFERENCE_MAP_KEY_FIELDS } from '../../document/schema/entity-schema';
import { definitionLocationOf } from './reference-location';
import { documentsMentioning } from './workspace-files';

/** The class that owns `fieldName` for a member-bearing container (a group, or a whole-file-root document). */
const ownerClassOf = (container: AbstractNode): string | undefined =>
    isDocumentNode(container) ? documentRootClass(container) : isGroupNode(container) ? resolveGroupClass(container) : undefined;

/**
 * The schema `reference` field a string value node belongs to: the target class and the written id.
 *
 * Two value positions are recognized:
 *  - a direct field value: `ResourceType = battery` (field type `reference`), and
 *  - a list element: `Features = [ CanReceivePower ]`, `Prerequisites = [ tech ]`,
 *    `ReceivableBuffs = [ Engine ]` (field type `list<reference>`). The element type carries the
 *    target. The list may be written `Field = [ … ]` (an assignment whose value is the list) or
 *    `Field [ … ]` (a named list member).
 */
export const schemaReferenceFieldOf = (
    node: AbstractNode
): { targetClass: string; value: string; fieldName?: string } | undefined => {
    if (!isValueNode(node) || node.valueType.type !== 'String') return undefined;
    const container = node.parent;
    if (!container) return undefined;
    const value = String(node.valueType.value);

    // List element: the value sits inside a `Field = [ … ]` / `Field [ … ]` whose field is list<reference>.
    if (isListNode(container)) {
        const owner = container.parent;
        if (!owner) return undefined;
        const fieldName = container.identifier?.name ?? assignmentFieldNameOf(owner, container);
        const cls = fieldName ? ownerClassOf(owner) : undefined;
        const field = cls && fieldName ? fieldOf(cls, fieldName) : undefined;
        const vt = field?.valueType;
        if (vt && (vt.kind === 'list' || vt.kind === 'range' || vt.kind === 'interpolated') && vt.element.kind === 'reference') {
            return { targetClass: vt.element.target, value, fieldName };
        }
        // A scalar-form group element (`EditorParentParts = ["cosmoteer.armor"]`): a bare entry of a
        // `list<group>` field reads as the element class's scalar payload.
        if (vt && (vt.kind === 'list' || vt.kind === 'range' || vt.kind === 'interpolated') && vt.element.kind === 'group') {
            const target = scalarReferenceTargetOf(vt.element.ref);
            if (target) return { targetClass: target, value, fieldName };
        }
        // Positional slots. An inheriting list appends after the inherited elements, shifting every
        // index, so positional resolution must stay silent there.
        if (!container.inheritance?.length) {
            const slot = listSlotType(container);
            // Tuple element: the container is a tuple slot (a part's `Resources [ [bullet, 20] ]`
            // entry), so the value's index picks the declared entry type.
            if (slot?.kind === 'tuple') {
                const element = slot.elements[container.elements.indexOf(node)];
                if (element?.kind === 'reference') return { targetClass: element.target, value };
            }
            // A list slot reached without a field name, e.g. the faction list nested inside a
            // career map picker's tuple (`CandidatesClosestToFactions = [3, [faction, …]]`).
            if (
                slot &&
                (slot.kind === 'list' || slot.kind === 'range' || slot.kind === 'interpolated') &&
                slot.element.kind === 'reference'
            ) {
                return { targetClass: slot.element.target, value };
            }
        }
        return undefined;
    }

    // Direct field value: `Field = ref`.
    if (!(isGroupNode(container) || isDocumentNode(container))) return undefined;
    const fieldName = assignmentFieldNameOf(container, node);
    const cls = fieldName ? ownerClassOf(container) : undefined;
    const field = cls && fieldName ? fieldOf(cls, fieldName) : undefined;
    if (field?.valueType.kind === 'reference') return { targetClass: field.valueType.target, value, fieldName };
    // A scalar written for a scalar-form group field (`FireTrigger = Turret`, `Search = some_tag`):
    // the engine reads it into the class's scalar payload, so the value is that payload's reference.
    if (field?.valueType.kind === 'group') {
        const target = scalarReferenceTargetOf(field.valueType.ref);
        if (target) return { targetClass: target, value, fieldName };
    }
    // Entry-form map key: `Key = "structure"` inside a `[{ Key, Value }]` element of a
    // `map<reference X, V>` field (the list spelling of `RenderLayers`, resistances, …).
    if (fieldName?.toLowerCase() === 'key' && isGroupNode(container)) {
        const target = mapEntryKeyTargetOf(container);
        if (target) return { targetClass: target, value };
    }
    return undefined;
};

/**
 * The key target class of the map an entry group belongs to, when the group is an element of a map
 * serialized as `[{ Key = …; Value = … }]`. The declaring field resolves through the list's owner
 * class where possible, else through the schema-wide field-name table (a fragment's owner class is
 * often unresolvable, but a name like `RenderLayers` names only one map in the whole schema).
 *
 * @param entry the `{ Key = …; Value = … }` entry group.
 * @returns the key target class FullName, or undefined when the entry is not such a map element.
 */
export const mapEntryKeyTargetOf = (entry: GroupNode): string | undefined => {
    const list = entry.parent;
    if (!list || !isListNode(list)) return undefined;
    const owner = list.parent;
    const fieldName = list.identifier?.name ?? (owner ? assignmentFieldNameOf(owner, list) : undefined);
    if (!fieldName) return undefined;
    const cls = owner ? ownerClassOf(owner) : undefined;
    const vt = cls ? fieldOf(cls, fieldName)?.valueType : undefined;
    if (vt?.kind === 'map') return vt.key.kind === 'reference' ? vt.key.target : undefined;
    const candidates = REFERENCE_MAP_KEY_FIELDS.get(fieldName.toLowerCase());
    return candidates?.length === 1 ? candidates[0] : undefined;
};

/** The field name whose assignment value is `child`, among `container`'s elements. */
const assignmentFieldNameOf = (container: AbstractNode, child: AbstractNode): string | undefined => {
    if (!isGroupNode(container) && !isDocumentNode(container)) return undefined;
    for (const element of container.elements) {
        if (isAssignmentNode(element) && element.right === child) return element.left.name;
    }
    return undefined;
};

/** True if `cls` is `target` or extends it (walking the schema's `extends` chain). */
export const isSameOrSubclass = (cls: string, target: string): boolean => {
    let cur: string | undefined = cls;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
        if (cur === target) return true;
        guard.add(cur);
        cur = typeDef(cur)?.extends;
    }
    return false;
};

/**
 * If `group` is a `map<reference X, V>` collection (its declaring field is such a map), the target
 * class `X` its keys reference: e.g. a `MaxBuffValues = { Engine = … }` group keys on `BuffType`, a
 * `StatusResistances { … }` group keys on `StatusType`. Returns undefined otherwise.
 */
export const mapKeyTargetOf = (group: GroupNode): string | undefined => {
    const owner = group.parent;
    if (!owner) return undefined;
    const fieldName = group.identifier?.name ?? assignmentFieldNameOf(owner, group);
    const cls = fieldName ? ownerClassOf(owner) : undefined;
    const field = cls && fieldName ? fieldOf(cls, fieldName) : undefined;
    const vt = field?.valueType;
    return vt?.kind === 'map' && vt.key.kind === 'reference' ? vt.key.target : undefined;
};

/** A map-key reference: the key's identifier node, the class its name references, and that name. */
export interface MapKeyReference {
    readonly node: IdentifierNode;
    readonly targetClass: string;
    readonly value: string;
    /** The map collection's declaring field name (`DamageResistances`, `Stats`, …), when known. */
    readonly fieldName?: string;
}

/**
 * Yields every map-key reference in a document. A key is an assignment left or a named group/list
 * identifier whose enclosing group is a `map<reference X, V>` collection, which makes the key name an
 * `ID<X>` reference (a value position that is an identifier rather than a value node, so neither
 * {@link schemaReferenceFieldOf} nor `findNodeAtPosition` covers it). The collection field's own name
 * is not a key, because its parent group is not the map.
 *
 * @param document the parsed document to scan.
 * @returns a generator of every {@link MapKeyReference} found in the document.
 */
export function* mapKeyReferencesOf(document: AbstractNodeDocument): Generator<MapKeyReference> {
    function* visit(node: AbstractNode): Generator<MapKeyReference> {
        const keyId: IdentifierNode | undefined = isAssignmentNode(node)
            ? node.left
            : (isGroupNode(node) || isListNode(node)) && node.identifier
              ? node.identifier
              : undefined;
        const mapGroup = keyId ? node.parent : undefined;
        if (keyId && mapGroup && isGroupNode(mapGroup)) {
            const target = mapKeyTargetOf(mapGroup);
            if (target) {
                const owner = mapGroup.parent;
                const fieldName = mapGroup.identifier?.name ?? (owner ? assignmentFieldNameOf(owner, mapGroup) : undefined);
                yield { node: keyId, targetClass: target, value: keyId.name, fieldName };
            }
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) yield* visit(child);
    }
    for (const element of document.elements) yield* visit(element);
}

/**
 * Finds the map-key reference whose identifier covers a cursor position.
 *
 * @param document the parsed document the cursor is in.
 * @param position the cursor position, in line and character.
 * @returns the {@link MapKeyReference} at that position, or undefined when the cursor is not on a key.
 */
export const mapKeyReferenceAt = (document: AbstractNodeDocument, position: Position): MapKeyReference | undefined => {
    for (const key of mapKeyReferencesOf(document)) {
        const pos = key.node.position;
        if (pos.line === position.line && position.character >= pos.characterStart && position.character <= pos.characterEnd) {
            return key;
        }
    }
    return undefined;
};

/** The top-level `ID = <value>` value node of a whole-file-root document, if any. */
const topLevelIdNode = (document: AbstractNodeDocument): ValueNode | undefined => {
    for (const element of document.elements) {
        if (isAssignmentNode(element) && element.left.name === 'ID' && isValueNode(element.right)) return element.right;
    }
    return undefined;
};

/**
 * Resolve a cross-file `ID<X>` reference written as a bare id (e.g. `ResourceType = battery`,
 * `NebulaID = ion_storm`) to the whole-file root that declares it: the file whose root class is the
 * field's target class (or a subclass) and whose top-level `ID` matches the written value. Unlike a
 * sibling `ID<>` ref (same container, handled in `schema-reference.navigation.ts`), the target lives
 * in another file, so we scan the project for files whose text mentions the id and confirm by root
 * class + `ID`. Returns the `Location` of that file's `ID = …`, or null.
 */
export const resolveSchemaIdReference = async (
    node: AbstractNode | null | undefined,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<Location | null> => {
    if (!node) return null;
    const ref = schemaReferenceFieldOf(node);
    if (!ref) return null;
    return resolveIdReferenceTarget(ref.targetClass, ref.value, folderPaths, cancellationToken);
};

/**
 * Resolve a cross-file `ID<X>` reference given its target class and written id (the core scan shared
 * by value references and map-key references): the whole-file root or aggregate entity declaring it.
 */
export const resolveIdReferenceTarget = async (
    targetClass: string,
    value: string,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<Location | null> => {
    for await (const document of documentsMentioning(folderPaths, value, cancellationToken)) {
        // Whole-file root: the file whose root class is the target and whose top-level `ID` matches.
        const rootClass = documentRootClass(document);
        if (rootClass && isSameOrSubclass(rootClass, targetClass)) {
            const idNode = topLevelIdNode(document);
            if (idNode && String(idNode.valueType.value) === value) return definitionLocationOf(idNode);
        }
        // Aggregate entity: a `Factions [ { ID } ]` / `PartToggles [ { ToggleID } ]` / buff member.
        for (const decl of entityDeclarationsOf(document)) {
            if (decl.id === value && isSameOrSubclass(decl.elementClass, targetClass)) {
                return definitionLocationOf(decl.node);
            }
        }
    }
    return null;
};
