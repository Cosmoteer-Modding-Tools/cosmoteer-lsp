import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { existsSync } from 'fs';
import { join } from 'path';
import { findEnclosingGroup, resolveGroupClass } from '../../document/schema/schema-context';
import { acceptsShaderConstants } from '../../document/schema/schema';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { resolveAssetPath } from '../navigation/asset-resolver';
import { filePathToUri } from '../navigation/navigation-strategy';
import { normalizeDir } from '../diagnostics/asset-base-path';
import { shaderConstants } from './shader-index';
import { expandShaderSource } from './shader-source';
import { translateToGlsl } from './hlsl-to-glsl';
import { materialConstants, materialShaderNode } from './shader-reference';

/**
 * Assembles everything the live shader preview webview needs to render a material the way the game
 * does: the referenced shader translated to GLSL, the constants the material sets (with their values),
 * the base-colour texture, the blend mode, and the colour tint. The heavy lifting (parsing, asset
 * resolution, HLSL translation) all happens here on the server so the client stays a thin renderer.
 */

/** A shader constant the preview exposes, with its declared type and the value the material sets. */
export interface ShaderPreviewConstant {
    /** The constant name including its leading underscore. */
    readonly name: string;
    /** The normalized kind (`float`, `vec3`, `texture`, …). */
    readonly kind: string;
    /** The raw HLSL type token. */
    readonly hlslType: string;
    /** The literal default from the shader declaration, when present. */
    readonly default?: string;
    /** The literal value the material writes for this constant, when present (for display only). */
    readonly value?: string;
    /** The numeric components the material sets, read structurally from the AST (no text offsets). */
    readonly components?: readonly number[];
}

/** The payload the webview consumes. File URIs are converted to webview URIs on the client. */
export interface ShaderPreviewData {
    /** The shader file name, e.g. `particle_lit.shader`. */
    readonly shaderName: string;
    /** The `file://` URI of the resolved shader, for the "open shader" affordance. */
    readonly shaderUri: string | null;
    /** The translated GLSL ES 1.00 fragment shader, or null when translation failed. */
    readonly glsl: string | null;
    /** True when a GLSL shader was produced, false when the preview must fall back to a plain render. */
    readonly translationOk: boolean;
    /** A short reason translation failed, for display. */
    readonly reason?: string;
    /** The shader's settable constants, with the material's values merged in. */
    readonly constants: readonly ShaderPreviewConstant[];
    /** The `file://` URI of the base-colour texture (the material's `Texture.File`), when resolved. */
    readonly textureUri: string | null;
    /** The material's `TargetBlendMode` (e.g. `Normal`, `Additive`), when set. */
    readonly blendMode: string | null;
    /** The material's colour tint (`Color`/`VertexColor`) as written, when set. */
    readonly tint: string | null;
    /** True for a particle shader, whose per-vertex colour drives the effect (so the preview animates it). */
    readonly isParticle: boolean;
}

/** Walks up from a node to the nearest enclosing group whose class accepts shader constants. */
const enclosingMaterial = (node: AbstractNode | undefined): GroupNode | null => {
    let current: AbstractNode | undefined = node;
    while (current) {
        if (isGroupNode(current)) {
            const cls = resolveGroupClass(current);
            if (cls && acceptsShaderConstants(cls)) return current;
        }
        current = current.parent;
    }
    return null;
};

/** The value node of a direct `Name = …` assignment in a group, or null. */
const assignmentValue = (group: GroupNode, name: string): ValueNode | null => {
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name === name && isValueNode(element.right)) {
            return element.right;
        }
    }
    return null;
};

/** The raw source text of a node, sliced from the document by its offsets. */
const rawText = (node: AbstractNode, text: string): string => text.slice(node.position.start, node.position.end).trim();

/** The numeric literal of a value node, or null when it is not a plain number. */
const numberOf = (node: AbstractNode): number | null =>
    isValueNode(node) && node.valueType.type === 'Number' ? (node.valueType.value as number) : null;

/**
 * Reads the numeric components a constant value sets, straight from the AST rather than by slicing
 * source text, so it is immune to line-ending and offset drift between the parse and the live document.
 * Handles a scalar (`_z = 0.2`), a list (`_x = [1, 0, 0, 1]`), and a colour group (`_x { Rf = 1 … }`).
 * Returns null for a value built from math or references, which the webview then reads from the text.
 *
 * @param node the value node of the constant (an assignment's right side or a group).
 * @returns the components in source order, or null when they are not plain numbers.
 */
const valueComponents = (node: AbstractNode): number[] | null => {
    const single = numberOf(node);
    if (single !== null) return [single];
    if (isListNode(node) || isGroupNode(node)) {
        const numbers: number[] = [];
        for (const element of node.elements) {
            if (isAssignmentNode(element) && element.right) {
                const n = numberOf(element.right);
                if (n !== null) numbers.push(n);
            } else {
                const n = numberOf(element);
                if (n !== null) numbers.push(n);
            }
        }
        return numbers.length ? numbers : null;
    }
    return null;
};

/** The raw source text of an assignment's value (any node kind: value, list, or group), or null. */
const assignmentRaw = (group: GroupNode, name: string, text: string): string | null => {
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name === name && element.right) {
            return rawText(element.right, text);
        }
    }
    return null;
};

/** The base-colour texture URI: the material's `Texture { File = … }` resolved on disk. */
const resolveTextureUri = async (
    group: GroupNode,
    documentUri: string,
    cancellationToken: CancellationToken
): Promise<string | null> => {
    const textureGroup = group.elements.find(
        (element) => isGroupNode(element) && element.identifier?.name === 'Texture'
    );
    if (!textureGroup || !isGroupNode(textureGroup)) return null;
    const fileNode = assignmentValue(textureGroup, 'File');
    if (!fileNode) return null;
    const path = await resolveAssetPath(fileNode, documentUri, cancellationToken).catch(() => null);
    if (path) return filePathToUri(path);
    // A mod often references a texture through its virtual `./Data/…` path, which resolves against the
    // vanilla tree and misses the mod's own copy. Particle and effect textures usually sit next to
    // their def, so fall back to the file's basename in the document's own directory.
    const value = String(fileNode.valueType.value);
    const basename = value.slice(value.replace(/\\/g, '/').lastIndexOf('/') + 1);
    const candidate = join(normalizeDir(documentUri), basename);
    return existsSync(candidate) ? filePathToUri(candidate) : null;
};

/**
 * The material's blend mode as a label the preview understands. `TargetBlendMode` is written either as
 * an enum (`TargetBlendMode = Additive`) or as a group of factors (`{ SourceRgbFactor = One DestRgbFactor
 * = One … }`). A group that adds the source onto the destination (`DestRgbFactor = One`, an additive
 * operator) is reported as `Additive` so the preview blends it the way the game does.
 *
 * @param group the material group.
 * @returns the blend-mode label, or null when the material sets none.
 */
const resolveBlendMode = (group: GroupNode): string | null => {
    const enumValue = assignmentValue(group, 'TargetBlendMode');
    if (enumValue) return String(enumValue.valueType.value);
    const blendGroup = group.elements.find(
        (element) => isGroupNode(element) && element.identifier?.name === 'TargetBlendMode'
    );
    if (!blendGroup || !isGroupNode(blendGroup)) return null;
    const dest = assignmentValue(blendGroup, 'DestRgbFactor');
    const operator = assignmentValue(blendGroup, 'RgbOperator');
    const isAdditive =
        String(dest?.valueType.value) === 'One' && String(operator?.valueType.value ?? 'Add') === 'Add';
    return isAdditive ? 'Additive' : 'Normal';
};

/**
 * Builds the preview payload for the material at a cursor position, or null when the cursor is not in
 * a material that references a shader.
 *
 * @param document the parsed document the cursor is in.
 * @param text the raw document text, used to read constant values verbatim.
 * @param offset the cursor byte offset (resolves a position on a key line, which a node lookup misses).
 * @param cancellationToken cancels the asset resolution.
 * @returns the preview payload, or null when there is no shader material to preview.
 */
export const buildShaderPreview = async (
    document: AbstractNodeDocument,
    text: string,
    offset: number,
    cancellationToken: CancellationToken,
    // Prefers open editor buffers over disk when reading the shader chain, so the live preview reflects
    // unsaved `.shader` edits. Undefined falls back to reading from disk.
    readOverride?: (absPath: string) => string | undefined
): Promise<ShaderPreviewData | null> => {
    const group = enclosingMaterial(findEnclosingGroup(document, offset));
    if (!group) return null;

    const shaderNode = materialShaderNode(group);
    if (!shaderNode) return null;

    const dataDir = CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath;
    const shaderPath = await resolveAssetPath(shaderNode, document.uri, cancellationToken).catch(() => null);
    if (!shaderPath) {
        return {
            shaderName: String(shaderNode.valueType.value),
            shaderUri: null,
            glsl: null,
            translationOk: false,
            reason: 'shader file not found',
            constants: [],
            textureUri: null,
            blendMode: null,
            tint: null,
            isParticle: false,
        };
    }

    const declared = await shaderConstants(shaderPath, dataDir, readOverride).catch(() => []);
    // Merge the material's written values onto the declared constants (assignment or group form). Both
    // the structural components (preferred, offset-free) and the raw text (display / math fallback).
    const written = new Map<string, { text: string; components: number[] | null }>();
    for (const constant of materialConstants(group)) {
        written.set(constant.name, {
            text: rawText(constant.value, text),
            components: valueComponents(constant.value),
        });
    }
    const constants: ShaderPreviewConstant[] = declared.map((constant) => ({
        name: constant.name,
        kind: constant.kind,
        hlslType: constant.hlslType,
        default: constant.default,
        value: written.get(constant.name)?.text,
        components: written.get(constant.name)?.components ?? undefined,
    }));

    const expanded = await expandShaderSource(shaderPath, [], dataDir, readOverride).catch(() => '');
    const translation = expanded ? translateToGlsl(expanded) : { ok: false, reason: 'shader unreadable' };
    // A particle shader reads its per-vertex colour as animation control (arc, brightness, bloom), so
    // the preview drives that colour rather than treating it as a static tint.
    const isParticle = /\bbase_particle\.shader\b|VERT_\w*PARTICLE/.test(expanded);

    return {
        shaderName: String(shaderNode.valueType.value),
        shaderUri: filePathToUri(shaderPath),
        glsl: translation.ok ? translation.glsl! : null,
        translationOk: translation.ok,
        reason: translation.ok ? undefined : translation.reason,
        constants,
        textureUri: await resolveTextureUri(group, document.uri, cancellationToken),
        blendMode: resolveBlendMode(group),
        tint: assignmentRaw(group, 'Color', text) ?? assignmentRaw(group, 'VertexColor', text),
        isParticle,
    };
};
