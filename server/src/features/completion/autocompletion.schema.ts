import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import {
    AbstractNode,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { namedMembersOf } from '../../utils/ast.utils';
import { AutoCompletion, Completion } from './autocompletion.service';
import { registryForGroup, resolveGroupClass } from '../../document/schema/schema-context';
import { documentRootClass, documentRootRegistry } from '../../document/schema/document-root';
import { enumDef, fieldOf, registryOf } from '../../document/schema/schema';
import { SchemaField, SchemaRegistry, ValueType } from '../../document/schema/schema.types';
import { resolveClassThroughInheritance } from './inheritance-resolution';

/**
 * Schema-driven value completion. When the cursor sits on a field's value inside a typed group,
 * offer the legal values from the extracted Cosmoteer schema:
 *  - `Type = …`  → the polymorphic registry's discriminators (e.g. all `PartComponentRules` types),
 *  - an enum field (e.g. `Mode = …`) → the enum's members,
 *  - a boolean field → `true` / `false`,
 *  - an `ID<…>` reference to a sibling component (e.g. `OperationalToggle = …`) → the names of the
 *    other components in the same container (the killer feature of the `ID<>` value oracle).
 *
 * The group's concrete class is resolved from its own `Type` field. The registry behind a
 * `Type=` completion is inferred from sibling groups in the same container. See {@link classOfGroup}.
 */
export class AutoCompletionSchema implements AutoCompletion<AbstractNode> {
    public async getCompletions(node: AbstractNode, cancellationToken: CancellationToken): Promise<Completion[]> {
        if (!isValueNode(node)) return [];

        // Whole-file root dispatched by its top-level `Type=` (doodad/effect/music): the value's
        // parent is the document, and the registry is known by the canonical folder. Offer its
        // discriminators (e.g. a doodad file's `Type = ` → all DoodadRules types).
        const documentParent = node.parent;
        if (documentParent && isDocumentNode(documentParent)) {
            const registry = documentRootRegistry(documentParent);
            if (!registry) return [];
            const fieldName = fieldNameOf(documentParent.elements, node);
            return fieldName === registry.typeField ? discriminatorCompletions(registry) : [];
        }

        // A value written inside a `[list]` (its parent is the list, not a group): offer the enum
        // members of the field's element type. This covers a plain enum list and the flags enum a map
        // serialized as `[{ Key=…; Value=[Edge, …] }]` uses (e.g. a part's `ExternalWallsByCell`).
        // References inside a list (e.g. `ReceivableBuffs = [Engine]`) are served by the reference
        // completer, so this stays enum/bool only and does not double up.
        const parent = node.parent;
        if (parent && isListNode(parent)) return completeListElementValue(parent);

        // The parser links a value's `parent` to the enclosing group (not its assignment), so the
        // field name comes from the sibling assignment whose right-hand value is this node.
        const group = node.parent;
        if (!group || !isGroupNode(group)) return [];
        const fieldName = fieldNameOf(group.elements, node);
        if (!fieldName) return [];
        // A group that derives via `: base` may not redeclare its `Type`.
        const cls = await resolveClassThroughInheritance(group, cancellationToken);
        return completeFieldValue(group, fieldName, cls);
    }
}

/**
 * The legal values for `group`'s `fieldName`, given its already-resolved concrete class `cls`, shared
 * by value-node completion and the offset-based completion that fires at an empty `key = ` position:
 *  - `Type` → the registry's discriminators (registry resolved via slot or a typed sibling),
 *  - an enum field → its members, a bool field → `true`/`false`,
 *  - an `ID<…>` reference to the container's registry → the sibling component names.
 */
export const completeFieldValue = (group: GroupNode, fieldName: string, cls: string | undefined): Completion[] => {
    // (1) `Type = …` → the registry's discriminators. `registryForGroup` resolves via the slot (works
    // for a typed list element like `Layers [ { Type = … } ]`) or a typed sibling in the same container.
    const container = group.parent;
    const registry = registryForGroup(group);
    if (registry && fieldName === registry.typeField) return discriminatorCompletions(registry);

    // (2) value of a typed field → enum members / booleans, via the group's concrete class.
    if (!cls) return [];
    const field = fieldOf(cls, fieldName);
    if (!field) return [];
    const valueType = field.valueType;
    if (valueType.kind === 'enum') {
        return (enumDef(valueType.ref)?.members ?? []).map((member) => ({
            label: member,
            kind: CompletionItemKind.EnumMember,
            detail: valueType.name,
        }));
    }
    if (valueType.kind === 'bool') {
        return [
            { label: 'true', kind: CompletionItemKind.Value },
            { label: 'false', kind: CompletionItemKind.Value },
        ];
    }
    // `ID<X>` where X is the registry this group's container holds → a reference to a sibling.
    if (
        valueType.kind === 'reference' &&
        container &&
        isGroupNode(container) &&
        registry &&
        registryOf(valueType.target) === registry
    ) {
        const self = group.identifier?.name;
        return namedMembersOf(container)
            .map(([name]) => name)
            .filter((name) => name !== self)
            .map((name) => ({ label: name, kind: CompletionItemKind.Reference, detail: `${registry.name} (sibling)` }));
    }
    return [];
};

/**
 * The schema field whose `key = value` right-hand side is `node`: the field of the enclosing group
 * (its class resolved through inheritance) or, at a whole-file root, of the document's root class.
 * Used to read a value node's declared type (e.g. to tell a localization-key field from a plain string).
 *
 * @param node the value node being completed.
 * @param cancellationToken cancellation for the inheritance walk that resolves the group's class.
 * @returns the field definition, or undefined when the node isn't a typed field value.
 */
export const fieldOfValueNode = async (
    node: AbstractNode,
    cancellationToken: CancellationToken
): Promise<SchemaField | undefined> => {
    if (!isValueNode(node)) return undefined;
    const parent = node.parent;
    if (!parent) return undefined;
    if (isDocumentNode(parent)) {
        const cls = documentRootClass(parent);
        const fieldName = fieldNameOf(parent.elements, node);
        return cls && fieldName ? fieldOf(cls, fieldName) : undefined;
    }
    if (!isGroupNode(parent)) return undefined;
    const fieldName = fieldNameOf(parent.elements, node);
    if (!fieldName) return undefined;
    const cls = await resolveClassThroughInheritance(parent, cancellationToken);
    return cls ? fieldOf(cls, fieldName) : undefined;
};

/**
 * Enum (or bool) completions for a value typed inside `list`, resolving the element type through both
 * a plain list field and a map serialized as a `[{ Key=…; Value=… }]` list. Returns nothing for a
 * reference-element list (handled by the reference completer) or an unresolvable field.
 */
const completeListElementValue = (list: ListNode): Completion[] => {
    const owner = list.parent;
    if (!owner || !isGroupNode(owner)) return [];
    // A list is either an assignment `X = [ … ]` or a named list `X [ … ]`.
    const name = fieldNameOf(owner.elements, list) ?? list.identifier?.name;
    if (!name) return [];
    const valueType = listFieldValueType(owner, name);
    if (!valueType) return [];
    // Unwrap one list level when the field itself is a list of the element type.
    const element = valueType.kind === 'list' ? valueType.element : valueType;
    return enumOrBoolCompletions(element);
};

/**
 * The declared value type of `owner`'s `fieldName`, resolving a map entry's `Key`/`Value`. An entry
 * group of a map serialized as `[{ Key=…; Value=… }]` has no class of its own, so its `Key`/`Value`
 * take the enclosing map field's key/value type.
 */
const listFieldValueType = (owner: GroupNode, fieldName: string): ValueType | undefined => {
    const cls = resolveGroupClass(owner);
    const direct = cls ? fieldOf(cls, fieldName)?.valueType : undefined;
    if (direct) return direct;
    if (fieldName === 'Key' || fieldName === 'Value') {
        const map = enclosingMapType(owner);
        if (map) return fieldName === 'Key' ? map.key : map.value;
    }
    return undefined;
};

/** The `map` value type `entry` is an element of, when `entry` is a `[{ Key=…; Value=… }]` map entry. */
const enclosingMapType = (entry: GroupNode): (ValueType & { kind: 'map' }) | undefined => {
    const outerList = entry.parent;
    if (!outerList || !isListNode(outerList)) return undefined;
    const grandparent = outerList.parent;
    if (!grandparent || !isGroupNode(grandparent)) return undefined;
    const mapFieldName = fieldNameOf(grandparent.elements, outerList) ?? outerList.identifier?.name;
    const cls = resolveGroupClass(grandparent);
    const valueType = cls && mapFieldName ? fieldOf(cls, mapFieldName)?.valueType : undefined;
    return valueType?.kind === 'map' ? valueType : undefined;
};

/** Enum-member or boolean completions for a resolved value type, or nothing for other kinds. */
const enumOrBoolCompletions = (valueType: ValueType): Completion[] => {
    if (valueType.kind === 'enum') {
        return (enumDef(valueType.ref)?.members ?? []).map((member) => ({
            label: member,
            kind: CompletionItemKind.EnumMember,
            detail: valueType.name,
        }));
    }
    if (valueType.kind === 'bool') {
        return [
            { label: 'true', kind: CompletionItemKind.Value },
            { label: 'false', kind: CompletionItemKind.Value },
        ];
    }
    return [];
};

/** The field name whose `key = value` right-hand side is `node`, among a container's elements. */
const fieldNameOf = (elements: AbstractNode[], node: AbstractNode): string | undefined => {
    for (const element of elements) {
        if (isAssignmentNode(element) && element.right === node) return element.left.name;
    }
    return undefined;
};

/** Completion items for a registry's `Type=` discriminators. */
export const discriminatorCompletions = (registry: SchemaRegistry): Completion[] =>
    Object.keys(registry.members).map((disc) => ({
        label: disc,
        kind: CompletionItemKind.EnumMember,
        detail: registry.name,
    }));
