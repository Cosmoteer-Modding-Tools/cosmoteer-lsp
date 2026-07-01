/**
 * Bridge AST ⇄ schema: given a `.rules` group node, work out which schema class it represents.
 *
 * A group's concrete class is selected by its own `Type=<disc>` field (the `[SerialBaseType]`
 * dispatch). The containing list/group (e.g. `Components`) is itself custom-deserialized in the
 * engine, so it has no `[Serialize]` field linking it to the registry — instead we infer the
 * registry from any sibling's already-written `Type`, which is robust (a part's `Components` and a
 * bullet's `Components` disambiguate themselves by what their children declare).
 */
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { namedMembersOf } from '../../utils/ast.utils';
import { classByDiscriminator, fieldOf, schema } from './schema';
import { SchemaRegistry, ValueType } from './schema.types';
import { documentRootClass } from './document-root';
import { aliasedMemberType } from './alias-root';
import { TEXTURE_GROUP_CLASS } from './schema-overlay';

/**
 * Top-level group identifiers that anchor a schema root class. The engine deserializes these from
 * a `.rules` file's root by name/convention (a part file's `Part` group → `PartRules`), which the
 * attribute model can't express. Extend as more document kinds get wired up.
 */
export const ROOT_GROUP_CLASSES: Record<string, string> = {
    Part: 'Cosmoteer.Ships.Parts.PartRules',
};

const ELEMENT_KINDS = new Set(['list', 'range', 'interpolated']);

/**
 * The schema value type the engine expects at a group/list node's slot, derived from the field that
 * declares its container. This is what makes nested resolution and collision-disambiguation work:
 * the declaring field names the exact class/registry, so a `Perlin` under a `TextureLayer`-typed
 * `Layers` resolves to TextureLayer, not (the colliding) HeightMapLayer. Returns undefined when the
 * container chain can't be anchored to a known class.
 */
const expectedValueType = (node: GroupNode | ListNode, depth: number): ValueType | undefined => {
    if (depth > 32) return undefined;
    const parent = node.parent;
    if (!parent) return undefined;

    if ((isGroupNode(parent) || isDocumentNode(parent)) && node.identifier) {
        const ownerClass = isDocumentNode(parent)
            ? documentRootClass(parent)
            : resolveGroupClass(parent, depth + 1);
        if (ownerClass) return fieldOf(ownerClass, node.identifier.name)?.valueType;
        // An unrooted top-level member: root it by how the game root aliases this fragment file in.
        if (isDocumentNode(parent)) return aliasedMemberType(parent, node.identifier.name);
        return undefined;
    }

    if (isListNode(parent)) {
        let listType: ValueType | undefined;
        const grandparent = parent.parent;
        if (parent.identifier && grandparent && (isGroupNode(grandparent) || isDocumentNode(grandparent))) {
            const ownerClass = isDocumentNode(grandparent)
                ? documentRootClass(grandparent)
                : resolveGroupClass(grandparent, depth + 1);
            listType = ownerClass ? fieldOf(ownerClass, parent.identifier.name)?.valueType : undefined;
            if (!listType && isDocumentNode(grandparent)) listType = aliasedMemberType(grandparent, parent.identifier.name);
        } else {
            listType = expectedValueType(parent, depth + 1); // nested / inline list
        }
        return listType && ELEMENT_KINDS.has(listType.kind) && 'element' in listType ? listType.element : undefined;
    }
    return undefined;
};

/** Registry FullName hint for a group's `Type=` dispatch, from its container's declared field type. */
export const registryHintFromContainer = (group: GroupNode, depth = 0): string | undefined => {
    const expected = expectedValueType(group, depth);
    return expected?.kind === 'polymorphicGroup' ? expected.ref : undefined;
};

/** The `Type=` discriminator value written in a group, if any. */
export const groupDiscriminator = (group: GroupNode, typeField = 'Type'): string | undefined => {
    for (const [name, value] of namedMembersOf(group)) {
        if (name !== typeField) continue;
        // `value` can be null for an in-progress empty `Type = ` assignment.
        if (value && isValueNode(value) && (value.valueType.type === 'String' || value.valueType.type === 'Reference')) {
            return String(value.valueType.value);
        }
    }
    return undefined;
};

/** The concrete schema class FullName a group represents, resolved from its own `Type` field. */
export const classOfGroup = (group: GroupNode, registryHint?: string): string | undefined => {
    const disc = groupDiscriminator(group);
    return disc ? classByDiscriminator(disc, registryHint) : undefined;
};

/**
 * Infer which polymorphic registry the child groups of `container` belong to, by reading the
 * `Type` of any sibling that already has one. Returns undefined for an empty/typeless container.
 */
export const registryForContainer = (container: GroupNode): SchemaRegistry | undefined => {
    for (const element of container.elements) {
        if (!isGroupNode(element)) continue;
        const disc = groupDiscriminator(element);
        if (!disc) continue;
        for (const registry of Object.values(schema.registries)) {
            if (disc in registry.members) return registry;
        }
    }
    return undefined;
};

/**
 * The polymorphic registry a group belongs to (so we know its `Type=` discriminator set): the slot's
 * declared registry (works for a typed list element too), else inferred from a typed sibling in the
 * same container. The single resolution shared by `Type=` value completion and the field-name
 * completion that suggests writing `Type` first.
 */
export const registryForGroup = (group: GroupNode): SchemaRegistry | undefined => {
    const slot = registryHintFromContainer(group);
    if (slot) return schema.registries[slot];
    const container = group.parent;
    return container && isGroupNode(container) ? registryForContainer(container) : undefined;
};

/**
 * Resolve the schema class a group represents, top-down. A class is known when the group:
 *  1. sits in a slot whose declaring field types it — a concrete `group` field gives the class
 *      directly. A `polymorphicGroup` field gives the registry, and the group's `Type=` picks the
 *      member (disambiguating collisions), or
 *  2. carries its own `Type=` discriminator with no slot hint, or
 *  3. is a known root group (e.g. `Part`).
 */
export const resolveGroupClass = (group: GroupNode, depth = 0): string | undefined => {
    if (depth > 32) return undefined;
    const expected = expectedValueType(group, depth);
    if (expected?.kind === 'group') return expected.ref;
    if (expected?.kind === 'polymorphicGroup') {
        const registry = schema.registries[expected.ref];
        return classOfGroup(group, registry?.name) ?? expected.ref;
    }
    // A scalar value with a group form (a `Modifiable<T>` written as `{ BaseValue = … BuffType = … }`):
    // when the slot is filled with a group, its fields come from the curated group-form class.
    if (
        (expected?.kind === 'number' || expected?.kind === 'int' || expected?.kind === 'float') &&
        expected.groupForm
    ) {
        return expected.groupForm;
    }
    // A `Texture` is dual-form: a bare image path OR a `{ File … SampleMode … }` group. schemagen only
    // captured the scalar form (`asset`), so an image-asset slot written as a group is the group form —
    // the only dual-form image type in the engine — resolved to the overlay's Texture class.
    if (expected?.kind === 'asset' && expected.assetKind === 'image') return TEXTURE_GROUP_CLASS;
    // No slot hint: infer the registry from a typed sibling in the same container so an ambiguous
    // discriminator resolves to the right registry for this context. A bullet's `GlowSprite { Type =
    // Sprite }` and a part's `Sprite { Type = Sprite }` both write `Sprite`, but they belong to
    // different registries (`BulletSpriteRules` vs `PartSpriteRules`) — the container's other
    // components (`Type = CirclePhysics` vs `Type = TurretWeapon`) tell them apart.
    const container = group.parent;
    const containerRegistry = container && isGroupNode(container) ? registryForContainer(container) : undefined;
    const viaType = classOfGroup(group, containerRegistry?.name);
    if (viaType) return viaType;
    const id = group.identifier?.name;
    if (id && ROOT_GROUP_CLASSES[id]) return ROOT_GROUP_CLASSES[id];
    return undefined;
};

/**
 * The deepest node satisfying `matches` whose byte-offset range contains `offset` (where a new child
 * would be typed). A pre-order DFS, so deeper containing nodes overwrite shallower ones.
 */
const findEnclosing = <T extends AbstractNode>(
    document: AbstractNodeDocument,
    offset: number,
    matches: (node: AbstractNode) => node is T
): T | undefined => {
    let best: T | undefined;
    const visit = (node: AbstractNode | null | undefined): void => {
        if (!node) return; // an empty `Key = ` assignment has a null right-hand value
        if (matches(node) && offset >= node.position.start && offset <= node.position.end) {
            best = node;
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? [node.right]
                  : [];
        for (const child of children) visit(child);
    };
    for (const element of document.elements) visit(element);
    return best;
};

/** The deepest group whose byte-offset range contains `offset` (where a new field would be typed). */
export const findEnclosingGroup = (document: AbstractNodeDocument, offset: number): GroupNode | undefined =>
    findEnclosing(document, offset, isGroupNode);

/**
 * Finds the deepest list whose byte-offset range contains a position, which is where a new list
 * element would be typed.
 *
 * @param document the parsed document.
 * @param offset the cursor byte offset.
 * @returns the innermost list node containing the offset, or undefined when the offset is in no list.
 */
export const findEnclosingList = (document: AbstractNodeDocument, offset: number): ListNode | undefined =>
    findEnclosing(document, offset, isListNode);

/**
 * Resolves the reference target class of a list's elements when the list is declared as a
 * `list<reference X>` field, so completion can offer X ids at a list element position.
 *
 * @param list the list node whose element type is wanted.
 * @returns the element reference target class FullName, or undefined when the list is not a list of references.
 */
export const listElementReferenceTarget = (list: ListNode): string | undefined => {
    const owner = list.parent;
    if (!owner) return undefined;
    let fieldName = list.identifier?.name;
    if (!fieldName && (isGroupNode(owner) || isDocumentNode(owner))) {
        for (const element of owner.elements) {
            if (isAssignmentNode(element) && element.right === list) {
                fieldName = element.left.name;
                break;
            }
        }
    }
    if (!fieldName) return undefined;
    const ownerClass = isDocumentNode(owner)
        ? documentRootClass(owner)
        : isGroupNode(owner)
          ? resolveGroupClass(owner)
          : undefined;
    const valueType = ownerClass ? fieldOf(ownerClass, fieldName)?.valueType : undefined;
    if (
        (valueType?.kind === 'list' || valueType?.kind === 'range' || valueType?.kind === 'interpolated') &&
        valueType.element.kind === 'reference'
    ) {
        return valueType.element.target;
    }
    return undefined;
};
