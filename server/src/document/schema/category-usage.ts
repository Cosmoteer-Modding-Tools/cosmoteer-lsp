/**
 * Usage-defined reference targets, currently part categories.
 *
 * A part category (`Cosmoteer.Ships.Parts.PartCategory`) has no declaration file. A category exists
 * simply because some part names it, in a `Category = armor` field or a `TypeCategories = [armor, …]`
 * list. The set of valid categories is therefore the set of category strings used across the project.
 * This module collects those usages so completion can offer them, the same way the id index offers
 * declared ids for classes that do have declarations.
 */
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { schema } from './schema';
import { ValueType } from './schema.types';

export const PART_CATEGORY_CLASS = 'Cosmoteer.Ships.Parts.PartCategory';

/** Returns whether a value type references `PART_CATEGORY_CLASS` directly, as a list element, or as a map key. */
const targetsCategory = (valueType: ValueType): boolean => {
    switch (valueType.kind) {
        case 'reference':
            return valueType.target === PART_CATEGORY_CLASS;
        case 'list':
        case 'range':
        case 'interpolated':
            return targetsCategory(valueType.element);
        case 'map':
            return valueType.key.kind === 'reference' && valueType.key.target === PART_CATEGORY_CLASS;
        default:
            return false;
    }
};

/**
 * The set of field names that, somewhere in the schema, reference a part category (`Category`,
 * `TypeCategories`, `RequiresCategories`, …). Precomputed so a document can be harvested by field
 * name alone, without resolving each value's owning class.
 */
const CATEGORY_FIELD_NAMES: ReadonlySet<string> = (() => {
    const names = new Set<string>();
    for (const type of Object.values(schema.types)) {
        for (const field of type.fields) {
            if (targetsCategory(field.valueType)) names.add(field.name);
        }
    }
    return names;
})();

/** Collects the bare string values written for an assignment that names a category field (direct value, list elements, or map keys). */
function* categoryValuesOfAssignment(value: AbstractNode): Generator<string> {
    if (isValueNode(value) && value.valueType.type === 'String') {
        yield String(value.valueType.value);
    } else if (isListNode(value)) {
        for (const element of value.elements) {
            if (isValueNode(element) && element.valueType.type === 'String') yield String(element.valueType.value);
        }
    } else if (isGroupNode(value)) {
        for (const member of value.elements) {
            if (isAssignmentNode(member)) yield member.left.name; // map-key category (`PartCategoryTileCosts { armor = … }`)
        }
    }
}

/**
 * Yields every part-category name used in a document, found by scanning assignments whose field name
 * is a known category field. Cheap, because it matches by field name and never resolves a class.
 *
 * @param document the parsed document to scan.
 * @returns a generator of the category strings the document uses.
 */
export function* categoryUsagesOf(document: AbstractNodeDocument): Generator<string> {
    function* visit(node: AbstractNode): Generator<string> {
        if (isAssignmentNode(node) && CATEGORY_FIELD_NAMES.has(node.left.name)) {
            yield* categoryValuesOfAssignment(node.right);
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? [node.right]
                  : [];
        for (const child of children) yield* visit(child);
    }
    for (const element of document.elements) yield* visit(element);
}
