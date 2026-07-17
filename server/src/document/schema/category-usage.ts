/**
 * Usage-defined reference targets, derived from the schema's marker classes.
 *
 * Some `ID<X>` target classes are pure C# markers: the type carries no serialized members and no
 * file ever declares an instance (`PartCategory`, `PartFeature`, `DamageType`, spawn flags, effect
 * buckets, …). Such an id exists simply because some file names it, so every written usage in a
 * value position is also its declaration. Map keys are the exception: a key looks an id up in a
 * relation someone else populates (`DamageResistances { fire = … }` resists the damage types the
 * hit effects deal), so keys stay references and validate against the harvested usages.
 *
 * The marker set is derived mechanically: every reference target the schema mentions that has no
 * extracted type definition. A game update that turns a marker into a real serialized class moves
 * it out of this set through a normal schema regeneration.
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

/** Every reference target class the schema mentions anywhere in a field value type. */
const referenceTargetsOf = (valueType: ValueType, out: Set<string>): void => {
    switch (valueType.kind) {
        case 'reference':
            out.add(valueType.target);
            break;
        case 'list':
        case 'range':
        case 'interpolated':
            referenceTargetsOf(valueType.element, out);
            break;
        case 'map':
            referenceTargetsOf(valueType.key, out);
            referenceTargetsOf(valueType.value, out);
            break;
        case 'tuple':
            for (const element of valueType.elements) referenceTargetsOf(element, out);
            break;
        default:
            break;
    }
};

/** The marker classes: reference targets with no extracted type definition (see the module doc). */
export const MARKER_CLASSES: ReadonlySet<string> = (() => {
    const targets = new Set<string>();
    for (const type of Object.values(schema.types)) {
        for (const field of type.fields) referenceTargetsOf(field.valueType, targets);
    }
    const markers = new Set<string>();
    for (const target of targets) if (!schema.types[target]) markers.add(target);
    return markers;
})();

/** The marker classes a non-key value of the field references (direct value or list element). */
const markerTargetsOf = (valueType: ValueType): Set<string> => {
    const out = new Set<string>();
    if (valueType.kind === 'reference') out.add(valueType.target);
    if (
        (valueType.kind === 'list' || valueType.kind === 'range' || valueType.kind === 'interpolated') &&
        valueType.element.kind === 'reference'
    ) {
        out.add(valueType.element.target);
    }
    for (const target of out) if (!MARKER_CLASSES.has(target)) out.delete(target);
    return out;
};

/**
 * Field name → the marker classes a value written under that name declares. Precomputed across the
 * whole schema so a document is harvested by field name alone, without resolving each value's
 * owning class. A name used for two different marker classes declares under both, which
 * over-includes harmlessly (markers are name vocabularies, and an extra id only ever suppresses).
 */
const MARKER_FIELD_TARGETS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
    const byName = new Map<string, Set<string>>();
    for (const type of Object.values(schema.types)) {
        for (const field of type.fields) {
            const targets = markerTargetsOf(field.valueType);
            if (targets.size === 0) continue;
            const existing = byName.get(field.name) ?? byName.set(field.name, new Set()).get(field.name)!;
            for (const target of targets) existing.add(target);
        }
    }
    return byName;
})();

/** A marker-class usage: the class the position targets and the written id, both declaring it. */
export interface MarkerUsage {
    readonly cls: string;
    readonly id: string;
}

/** Collects the bare string values written for a marker field (a direct value or list elements). */
function* markerValuesOf(value: AbstractNode): Generator<string> {
    if (isValueNode(value) && value.valueType.type === 'String') {
        yield String(value.valueType.value);
    } else if (isListNode(value)) {
        for (const element of value.elements) {
            if (isValueNode(element) && element.valueType.type === 'String') yield String(element.valueType.value);
        }
    }
}

/**
 * Yields every marker-class usage in a document, found by scanning assignments and named containers
 * whose field name targets a marker class. Cheap, because it matches by field name and never
 * resolves a class. Map keys are deliberately not harvested (they are the reference side).
 *
 * @param document the parsed document to scan.
 * @returns a generator of the {@link MarkerUsage} entries the document declares.
 */
export function* markerUsagesOf(document: AbstractNodeDocument): Generator<MarkerUsage> {
    function* usagesAt(fieldName: string, value: AbstractNode): Generator<MarkerUsage> {
        const targets = MARKER_FIELD_TARGETS.get(fieldName);
        if (!targets) return;
        for (const id of markerValuesOf(value)) {
            for (const cls of targets) yield { cls, id };
        }
    }
    function* visit(node: AbstractNode): Generator<MarkerUsage> {
        if (isAssignmentNode(node) && node.right) yield* usagesAt(node.left.name, node.right);
        // The named container spellings: `TypeCategories [ … ]` and the inheriting
        // `TypeCategories : ^/0/TypeCategories [ … ]` carry no assignment node.
        if ((isListNode(node) || isGroupNode(node)) && node.identifier) yield* usagesAt(node.identifier.name, node);
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
 * Yields every part-category name used in a document, the {@link markerUsagesOf} view restricted to
 * `PartCategory` for the category-specific consumers.
 *
 * @param document the parsed document to scan.
 * @returns a generator of the category strings the document uses.
 */
export function* categoryUsagesOf(document: AbstractNodeDocument): Generator<string> {
    for (const usage of markerUsagesOf(document)) {
        if (usage.cls === PART_CATEGORY_CLASS) yield usage.id;
    }
}
