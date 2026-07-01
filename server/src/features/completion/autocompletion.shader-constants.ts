import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import { GroupNode } from '../../core/ast/ast';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { acceptsShaderConstants } from '../../document/schema/schema';
import { resolveAssetPath } from '../../features/navigation/asset-resolver';
import { ShaderConstant, ShaderConstantKind } from '../../features/shader/shader-parser';
import { shaderConstants } from '../../features/shader/shader-index';
import { materialShaderNode } from '../../features/shader/shader-reference';
import { Completion } from './autocompletion.service';

/**
 * A material group (`Sprite`, `Material`, GUI sprite, …) sets its shader's uniforms as sibling
 * `_name = value` keys, where the legal names come from the `.shader` file the group's `Shader` field
 * points at, not from the schema. This offers those uniforms as field-name completions, resolved by
 * parsing the referenced shader (and its includes) and dropping the constants the engine binds itself.
 */

/** A constant whose name reads as a colour (`_centerColor`, `_edgeColour`, `_color`). */
const isColorName = (name: string): boolean => /colou?r/i.test(name);

/** The snippet inserted for a constant, scaffolding the right value shape for its kind. */
export const constantSnippet = (constant: ShaderConstant): string => {
    switch (constant.kind) {
        case 'vec4':
            // A `float4` colour uniform is conventionally written as a `Halfling.Graphics.Color`
            // group (`{ Rf Gf Bf Af }`, 0–1 floats) — the form vanilla uses — not a bracketed list.
            // A non-colour `float4` stays a list like the other vectors.
            if (isColorName(constant.name)) {
                return `${constant.name}\n{\n\tRf = $1\n\tGf = $2\n\tBf = $3\n\tAf = $4\n}`;
            }
            return `${constant.name} = [$0]`;
        // Other vectors and matrices are written as a bracketed list, e.g. `_offset = [0, 0]`.
        case 'vec2':
        case 'vec3':
        case 'matrix':
            return `${constant.name} = [$0]`;
        default:
            return `${constant.name} = $0`;
    }
};

/** A short human label for a constant kind, shown as the completion detail. */
const KIND_LABEL: Readonly<Record<ShaderConstantKind, string>> = {
    texture: 'texture',
    sampler: 'sampler',
    float: 'number',
    vec2: 'vector2',
    vec3: 'vector3',
    vec4: 'vector4 / color',
    matrix: 'matrix',
    int: 'integer',
    bool: 'bool',
};

/**
 * Shader-constant field-name completions for a group, or an empty array when the group does not accept
 * shader constants, sets no shader, or the shader cannot be resolved. Constants already written in the
 * group are skipped so completion only offers the ones still missing.
 *
 * @param group the enclosing material group the cursor is in.
 * @param documentUri the URI of the document, used to resolve the shader path on disk.
 * @param present the field names already written in the group, which are not offered again.
 * @param cancellationToken cancels the asset resolution.
 * @returns the shader-constant completions for the group's referenced shader.
 */
export const shaderConstantCompletions = async (
    group: GroupNode,
    documentUri: string,
    present: ReadonlySet<string>,
    cancellationToken: CancellationToken
): Promise<Completion[]> => {
    const cls = resolveGroupClass(group);
    if (!cls || !acceptsShaderConstants(cls)) return [];

    const shaderNode = materialShaderNode(group);
    if (!shaderNode) return [];

    const shaderPath = await resolveAssetPath(shaderNode, documentUri, cancellationToken).catch(() => null);
    if (!shaderPath) return [];

    const constants = await shaderConstants(shaderPath).catch(() => []);
    return constants
        .filter((constant) => !present.has(constant.name))
        .map((constant) => ({
            label: constant.name,
            kind: CompletionItemKind.Field,
            detail: `${KIND_LABEL[constant.kind]} · shader constant${constant.default ? ` (default ${constant.default})` : ''}`,
            documentation: `**${constant.name}** _(shader constant)_ — a \`${constant.hlslType}\` uniform passed to this material's shader.`,
            insertText: constantSnippet(constant),
            isSnippet: true,
            // Sort after schema fields (`0_…`/`1_…`) so real fields surface first.
            sortText: `2_${constant.name}`,
        }));
};
