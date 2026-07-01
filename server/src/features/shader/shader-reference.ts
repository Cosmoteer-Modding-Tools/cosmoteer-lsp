import { AbstractNode, GroupNode, isAssignmentNode, isGroupNode, isValueNode, ValueNode } from '../../core/ast/ast';

/**
 * Resolving the shader a material references, and the constants it sets, has to cope with two equally
 * valid syntaxes the deserializer accepts. A material may write its shader as a plain asset path
 * (`Shader = "x.shader"`) or as a group carrying a `File` (`Shader { File = "x.shader" }`), and it may
 * write a constant as an assignment (`_centerColor = [1, 1, 1, 1]`) or as a group (`_centerColor { Rf …
 * }`). These helpers normalize both so every shader feature sees the same thing.
 */

/** A constant a material sets, as either an assignment value or a group, with its name and node. */
export interface MaterialConstant {
    /** The constant name including its leading underscore. */
    readonly name: string;
    /** The identifier node of the key, used as the diagnostic/hover target. */
    readonly key: AbstractNode;
    /** The value node (an assignment's right side, or the group itself for the group form). */
    readonly value: AbstractNode;
}

/**
 * The shader-asset value node a material group references, from either the assignment form
 * (`Shader = "x.shader"`) or the group form (`Shader { File = "x.shader" }`).
 *
 * @param group the material group to read.
 * @returns the `Shader` asset value node, or null when the group references no shader.
 */
export const materialShaderNode = (group: GroupNode): ValueNode | null => {
    for (const element of group.elements) {
        if (
            isAssignmentNode(element) &&
            element.left.name === 'Shader' &&
            isValueNode(element.right) &&
            element.right.valueType.type === 'Shader'
        ) {
            return element.right;
        }
        if (isGroupNode(element) && element.identifier?.name === 'Shader') {
            for (const child of element.elements) {
                if (
                    isAssignmentNode(child) &&
                    child.left.name === 'File' &&
                    isValueNode(child.right) &&
                    child.right.valueType.type === 'Shader'
                ) {
                    return child.right;
                }
            }
        }
    }
    return null;
};

/**
 * The inline `_`-prefixed constants a material group sets, in either form. An assignment
 * (`_x = value`) reports its value node, a group (`_x { … }`) reports the group node itself, which a
 * value parser can read as the written components.
 *
 * @param group the material group to read.
 * @returns every constant the group writes directly.
 */
export const materialConstants = (group: GroupNode): MaterialConstant[] => {
    const out: MaterialConstant[] = [];
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name.startsWith('_') && element.right) {
            out.push({ name: element.left.name, key: element.left, value: element.right });
        } else if (isGroupNode(element) && element.identifier?.name.startsWith('_')) {
            out.push({ name: element.identifier.name, key: element.identifier, value: element });
        }
    }
    return out;
};
