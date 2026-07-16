import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import { GroupNode, isGroupNode } from '../../core/ast/ast';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { TEXTURE_GROUP_CLASS } from '../../document/schema/schema-overlay';
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
            // group (`{ Rf Gf Bf Af }`, 0–1 floats), the form vanilla uses, not a bracketed list.
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

/** The class a `vec4` colour constant's group form resolves to (`{ Rf Gf Bf Af }`). */
const COLOR_GROUP_CLASS = 'Halfling.Graphics.IntColor';

/**
 * The schema class a shader constant written in GROUP form resolves to, so field-name completion
 * works inside it. A `Texture2D` uniform is conventionally written as a texture group
 * (`_waveTex { File = … UVMode = … }`) and a `float4` colour uniform as a colour group
 * (`{ Rf Gf Bf Af }`). Neither is a schema field, so the ordinary slot walk cannot type them and
 * this resolves the class from the material's referenced `.shader` file instead.
 *
 * @param group the `_name { … }` group whose class is wanted.
 * @param documentUri the URI of the document, used to resolve the shader path on disk.
 * @param cancellationToken cancels the asset resolution.
 * @returns the group-form class FullName, or undefined when the group is not a shader constant of the enclosing material.
 */
export const shaderConstantGroupClass = async (
    group: GroupNode,
    documentUri: string,
    cancellationToken: CancellationToken
): Promise<string | undefined> => {
    const name = group.identifier?.name;
    if (!name || !name.startsWith('_')) return undefined;
    const material = group.parent;
    if (!material || !isGroupNode(material)) return undefined;
    const cls = resolveGroupClass(material);
    if (!cls || !acceptsShaderConstants(cls)) return undefined;
    const shaderNode = materialShaderNode(material);
    if (!shaderNode) return undefined;
    const shaderPath = await resolveAssetPath(shaderNode, documentUri, cancellationToken).catch(() => null);
    if (!shaderPath) return undefined;
    const constants = await shaderConstants(shaderPath).catch(() => [] as readonly ShaderConstant[]);
    const constant = constants.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (constant?.kind === 'texture') return TEXTURE_GROUP_CLASS;
    if (constant?.kind === 'vec4') return COLOR_GROUP_CLASS;
    return undefined;
};

/**
 * Shader-constant field-name completions for a group, or an empty array when the group does not accept
 * shader constants, sets no shader, or the shader cannot be resolved. Constants already written in the
 * group are skipped so completion only offers the ones still missing.
 *
 * @param group the enclosing material group the cursor is in.
 * @param documentUri the URI of the document, used to resolve the shader path on disk.
 * @param present the lower-cased field names already written in the group, which are not offered again.
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
        .filter((constant) => !present.has(constant.name.toLowerCase()))
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
