import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, GroupNode, isAssignmentNode, isGroupNode } from '../../core/ast/ast';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { acceptsShaderConstants, isShaderConstantField } from '../../document/schema/schema';
import { resolveAssetPath } from '../navigation/asset-resolver';
import { shaderConstants } from './shader-index';
import { ShaderConstant } from './shader-parser';
import { materialShaderNode } from './shader-reference';

/**
 * Async hover for an inline `_`-prefixed shader-constant key, enriched from the actual `.shader` file
 * the material references. Where the schema-level hover can only say "this is a shader constant", this
 * resolves the shader and reports the constant's HLSL type and default value, so the modder sees what
 * the uniform expects. Returns null for anything that is not a resolvable shader constant, letting the
 * generic schema hover stand in when the shader cannot be read (e.g. no game install).
 */

/** The enclosing group and the field name a hovered node belongs to, or null when it is not a field. */
const fieldContext = (node: AbstractNode): { group: GroupNode; fieldName: string } | null => {
    const container = node.parent;
    if (!container || !isGroupNode(container)) return null;
    // The group form (`_centerColor { Rf … }`): hovering the key resolves to the group node itself
    // (see findReferenceTargetAtPosition), whose `parent` is the enclosing material group.
    if (isGroupNode(node) && node.identifier) {
        return { group: container, fieldName: node.identifier.name };
    }
    // The assignment form (`_centerColor = …`): the key or value node of a sibling assignment.
    for (const element of container.elements) {
        if (isAssignmentNode(element) && (element.right === node || element.left === node)) {
            return { group: container, fieldName: element.left.name };
        }
    }
    return null;
};

/** Markdown describing a resolved constant, including its HLSL type and any default. */
const describeConstant = (constant: ShaderConstant): string =>
    `**${constant.name}** _(shader constant)_ — a \`${constant.hlslType}\` uniform passed to this material's shader.` +
    (constant.default ? `\n\nDefault: \`${constant.default}\`` : '');

/**
 * Resolves an inline shader-constant key to its declaration in the referenced shader and returns
 * enriched hover markdown.
 *
 * @param node the hovered key or value node of a `_name = …` assignment.
 * @param documentUri the URI of the document, used to resolve the shader on disk.
 * @param cancellationToken cancels the asset resolution.
 * @returns the enriched markdown, or null when the node is not a resolvable shader constant.
 */
export const shaderConstantHover = async (
    node: AbstractNode,
    documentUri: string,
    cancellationToken: CancellationToken
): Promise<string | null> => {
    const context = fieldContext(node);
    if (!context) return null;
    const { group, fieldName } = context;

    const cls = resolveGroupClass(group);
    if (!cls || !acceptsShaderConstants(cls) || !isShaderConstantField(cls, fieldName)) return null;

    const shaderNode = materialShaderNode(group);
    if (!shaderNode) return null;

    const shaderPath = await resolveAssetPath(shaderNode, documentUri, cancellationToken).catch(() => null);
    if (!shaderPath) return null;

    const constants = await shaderConstants(shaderPath).catch(() => []);
    const constant = constants.find((c) => c.name === fieldName);
    return constant ? describeConstant(constant) : null;
};
