import {
    AbstractNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { registryForGroup, resolveGroupClass } from '../../document/schema/schema-context';
import { documentRootClass } from '../../document/schema/document-root';
import {
    classByDiscriminator,
    fieldOf,
    fieldSignatureMarkdown,
    isShaderConstantField,
} from '../../document/schema/schema';
import { deprecatedDiscriminator } from '../../document/schema/deprecations';

/**
 * Markdown documenting the schema field a hovered node belongs to its value type, whether it's
 * required, its default, and (for enums / references) the legal values or target. Complements the
 * resolved-value hover: that shows what a value *computes to*, this shows what the field *is*.
 *
 * The hovered node is a field's value or its key. The parser links both to the enclosing container
 * (group or whole-file-root document), so we find the field via the sibling assignment.
 */
export const schemaFieldHover = (node: AbstractNode): string | null => {
    const container = node.parent;
    if (!container || !(isGroupNode(container) || isDocumentNode(container))) return null;

    let fieldName: string | undefined;
    // A group- or list-form field (`_centerColor { … }`, `TypeCategories [ … ]`, `Resources [ … ]`,
    // or an overriding `TypeCategories : ^/0/TypeCategories [ … ]`): these are written without an
    // `=`, so hovering the key resolves to the container node itself, whose name is its identifier.
    // There is no sibling assignment to match below.
    if ((isGroupNode(node) || isListNode(node)) && node.identifier) {
        fieldName = node.identifier.name;
    }
    // A valueless field written as a bare key (`Scale2In` with no `= value`, common for optional
    // particle-channel bindings) parses to a standalone Identifier under the group — there is no
    // assignment to match below, so take its name directly and still show the field's type.
    if (!fieldName && isIdentifierNode(node)) {
        fieldName = node.name;
    }
    for (const element of container.elements) {
        if (fieldName) break;
        if (isAssignmentNode(element) && (element.right === node || element.left === node)) {
            fieldName = element.left.name;
            break;
        }
    }
    if (!fieldName) return null;

    const cls = isDocumentNode(container) ? documentRootClass(container) : resolveGroupClass(container);
    if (!cls) return null;
    const field = fieldOf(cls, fieldName);
    if (!field) {
        // An inline shader-constant key (`_hotColor = …`) on a material/sprite. It is not a schema
        // field (its name comes from the referenced shader), so describe it as a shader constant.
        if (isShaderConstantField(cls, fieldName)) {
            return `**${fieldName}** _(shader constant)_ — a uniform passed to this material's shader.`;
        }
        return null;
    }
    return fieldSignatureMarkdown(field, cls);
};

/**
 * Markdown for a `Type = <disc>` discriminator value: the concrete schema class it selects. `Type` is
 * not a `[Serialize]` field (the serializer dispatches on it), so {@link schemaFieldHover} shows
 * nothing for it — this fills that gap, e.g. hovering `Type = TurretWeapon` → `→ TurretWeaponRules`.
 */
export const schemaDiscriminatorHover = (node: AbstractNode): string | null => {
    if (!isValueNode(node) || node.valueType.type !== 'String') return null;
    const group = node.parent;
    if (!group || !isGroupNode(group)) return null;

    let fieldName: string | undefined;
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.right === node) {
            fieldName = element.left.name;
            break;
        }
    }
    const registry = registryForGroup(group);
    if (!registry || fieldName !== registry.typeField) return null;

    const written = String(node.valueType.value);
    const cls = classByDiscriminator(written, registry.name);
    if (cls) return `**${registry.typeField} = ${written}** → \`${cls.split('.').pop()}\``;
    // An unresolved discriminator that is a known rename from an older game version: show what it became.
    const deprecation = deprecatedDiscriminator(written);
    if (deprecation && registry.members[deprecation.replacement]) {
        return `**${registry.typeField} = ${written}** — renamed to \`${deprecation.replacement}\` (${deprecation.note})`;
    }
    return null;
};
