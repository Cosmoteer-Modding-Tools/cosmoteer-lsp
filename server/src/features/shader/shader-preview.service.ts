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
import { translateToGlsl, type GlslTranslation } from './hlsl-to-glsl';
import { materialConstants, materialShaderNode } from './shader-reference';

/**
 * Assembles everything the live shader preview webview needs to render a material the way the game
 * does: the referenced shader translated to GLSL, the constants the material sets (with their values),
 * every texture the material binds, the resolved blend factors, the colour tint, and the particle
 * system's colour animation. The heavy lifting (parsing, asset resolution, HLSL translation) all
 * happens here on the server so the client stays a thin renderer.
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
    /**
     * The numeric components the material sets, read structurally from the AST (no text offsets).
     * For a colour-typed constant these are already normalized to the 0–1 float space the shader sees.
     */
    readonly components?: readonly number[];
    /**
     * True when the engine treats this constant as a colour. The game classifies a `float4` whose HLSL
     * initializer is `255` as a colour, which makes its written byte values divide by 255 at parse.
     */
    readonly isColor?: boolean;
}

/** The blend factors and operators a material draws with, using the engine's enum spellings. */
export interface ShaderPreviewBlend {
    /** The named engine mode these factors correspond to, or `Custom` for an unmatched factor group. */
    readonly label: string;
    readonly srcRgb: string;
    readonly dstRgb: string;
    readonly rgbOp: string;
    readonly srcAlpha: string;
    readonly dstAlpha: string;
    readonly alphaOp: string;
}

/** The sampler state a texture is drawn with, read from its rules fields (engine defaults when absent). */
export interface ShaderPreviewSampler {
    /** `Point` or `Linear`. The engine default is `Point`; vanilla sets `Linear` on most textures. */
    readonly sampleMode: string;
    /** The horizontal wrap mode, `Clamp` or `Wrap`. */
    readonly uMode: string;
    /** The vertical wrap mode, `Clamp` or `Wrap`. */
    readonly vMode: string;
    /** True when the texture declares more than one mip level (`MipLevels = max`, `8`, …). */
    readonly mips: boolean;
    /** The exact level count when `MipLevels` is numeric (`2`, `8`, …), so the chain can be capped. */
    readonly mipCount?: number;
}

/** A texture the material binds, keyed by the shader uniform it feeds (`_texture` for the base one). */
export interface ShaderPreviewTexture {
    /** The sampler uniform name this texture feeds. */
    readonly name: string;
    /** The `file://` URI of the resolved image, or null when it did not resolve. */
    readonly uri: string | null;
    /** The sampler state the game would create for it. */
    readonly sampler: ShaderPreviewSampler;
}

/**
 * The particle system's colour animation for the material, when it sits inside a particle def. The
 * game computes each particle's vertex colour on the CPU by lerping across the `ColorRamp` updater's
 * colours keyed by normalized lifetime, so the preview replays exactly that.
 */
export interface ShaderPreviewParticleColor {
    /** The particle lifetime in seconds (the mean when the def gives a range). */
    readonly lifetime: number;
    /** True when the ramp is keyed by inverted lifetime. */
    readonly invert: boolean;
    /** The ramp colours in order, each normalized to 0–1 float RGBA (unclamped, HDR values stay >1). */
    readonly colors: readonly (readonly number[])[];
}

/**
 * The particle system's sprite-sheet selection (`Type = UvSprites` initializer or updater): the game
 * renders one cell of the texture, chosen per particle or animated over its lifetime, so the preview
 * must remap its UVs to a cell instead of stretching the whole sheet.
 */
export interface ShaderPreviewSpriteSheet {
    /** The full texture size in pixels. */
    readonly textureSize: readonly number[];
    /** One cell's size in pixels. */
    readonly spriteSize: readonly number[];
    /** The number of cells in the sheet. */
    readonly count: number;
    /** How many cells sit in one row. */
    readonly perRow: number;
    /** The pixel offset of the first cell. */
    readonly offset: readonly number[];
    /** True when the game animates through the cells (an updater, or `Looping = true`). */
    readonly animated: boolean;
}

/** The payload the webview consumes. File URIs are converted to data URIs on the client. */
export interface ShaderPreviewData {
    /** The shader file name, e.g. `particle_lit.shader`. */
    readonly shaderName: string;
    /** The `file://` URI of the resolved shader, for the "open shader" affordance. */
    readonly shaderUri: string | null;
    /** The translated GLSL ES 1.00 fragment shader, or null when translation failed. */
    readonly glsl: string | null;
    /**
     * The shader's own translated vertex stage with its varying-fed fragment shader, when it defines
     * a `vert` the preview can synthesize inputs for. The webview tries this pair first and falls
     * back to `glsl` on the fixed quad when it does not compile.
     */
    readonly vertexStage: {
        glsl: string;
        fragment: string;
        kind: 'sprite' | 'particle' | 'beam' | 'crew' | 'shipPart';
    } | null;
    /** True when a GLSL shader was produced, false when the preview must fall back to a plain render. */
    readonly translationOk: boolean;
    /** A short reason translation failed, for display. */
    readonly reason?: string;
    /** The shader's settable constants, with the material's values merged in. */
    readonly constants: readonly ShaderPreviewConstant[];
    /** Every texture the material binds: the base `Texture` plus each written texture constant. */
    readonly textures: readonly ShaderPreviewTexture[];
    /** The blend factors the material draws with (the engine's `AlphaBlend` when it sets none). */
    readonly blend: ShaderPreviewBlend;
    /** The material's colour tint (`Color`/`VertexColor`) as written, when set. */
    readonly tint: string | null;
    /** The tint normalized to 0–1 float RGBA with the game's colour parse rules, when it is literal. */
    readonly tintComponents: readonly number[] | null;
    /** True for a particle shader, whose per-vertex colour drives the effect. */
    readonly isParticle: boolean;
    /** True for a beam shader (its vertex stage carries intensity and fade the preview stands in). */
    readonly isBeam: boolean;
    /** The particle system's colour-over-lifetime ramp, when the material sits inside a particle def. */
    readonly particleColor: ShaderPreviewParticleColor | null;
    /** The particle system's sprite-sheet cell selection, when the def uses one. */
    readonly spriteSheet: ShaderPreviewSpriteSheet | null;
    /** The particle's lifetime in seconds, when the def declares one (drives sheet and ramp timing). */
    readonly particleLifetime: number | null;
    /** The particle renderer's `BaseSize` in world units, feeding the `_baseSize` builtin. */
    readonly baseSize: readonly number[] | null;
    /** The material's written `Size` (world units), verbatim. It may contain math the webview evaluates. */
    readonly size: string | null;
}

/**
 * The preprocessor defines the engine passes when compiling a pixel stage on a modern GPU
 * (`D3D11Shader.GetShaderMacros` with feature level 11+): the profile define plus the cumulative
 * `GTE_…` feature gates. Vanilla shaders switch their rich paths on these (`#ifdef
 * GTE_PS_4_0_level_9_3` in the nebula, planet, and fire shaders), so the preview must define them to
 * translate the branch the game actually renders.
 */
export const PREVIEW_SHADER_DEFINES: readonly string[] = [
    'PS_5_0',
    'GTE_PS_4_0_level_9_1',
    'GTE_PS_4_0_level_9_3',
    'GTE_PS_4_0',
    'GTE_PS_4_1',
    'GTE_PS_5_0',
];

/**
 * The `USE_DEFAULT_…` guards the include-library shaders gate their entry points behind
 * (`base.shader`, `base_atlas.shader`, `base_particle.shader`, …). A concrete shader defines the ones
 * it wants before including the base; when a material references a base shader directly (or a mod
 * relies on the defaults), no entry point exists under the normal defines, so translation is retried
 * with all the guards on to preview the default pipeline the engine would run.
 */
export const DEFAULT_ENTRY_DEFINES: readonly string[] = [
    'USE_DEFAULT_PIX',
    'USE_DEFAULT_VERT',
    'USE_DEFAULT_PIX_ATLAS',
    'USE_DEFAULT_VERT_ATLAS',
    'USE_DEFAULT_VERT_BEAM',
    'USE_DEFAULT_VERT_PARTICLE',
];

/**
 * The engine's named blend modes, decompiled from `Halfling.Graphics.TargetBlendMode`, in constructor
 * order `srcRgb, dstRgb, rgbOp, srcAlpha, dstAlpha, alphaOp`. `AlphaBlend` is the material default.
 * Note the alpha channel of the default accumulates coverage (`InverseDestAlpha, One`) rather than the
 * usual straight-alpha pair.
 */
const BLEND_MODES: Readonly<Record<string, readonly [string, string, string, string, string, string]>> = {
    AlphaBlend: ['SourceAlpha', 'InverseSourceAlpha', 'Add', 'InverseDestAlpha', 'One', 'Add'],
    AlphaBlendPreMultiplied: ['One', 'InverseSourceAlpha', 'Add', 'InverseDestAlpha', 'One', 'Add'],
    ReplaceNoBlend: ['One', 'Zero', 'Add', 'One', 'Zero', 'Add'],
    Add: ['One', 'One', 'Add', 'One', 'One', 'Add'],
    AddAlphaBlend: ['SourceAlpha', 'One', 'Add', 'One', 'One', 'Add'],
    SubtractSourceFromDest: ['One', 'One', 'SubtractSourceFromDest', 'One', 'One', 'SubtractSourceFromDest'],
    SubtractDestFromSource: ['One', 'One', 'SubtractDestFromSource', 'One', 'One', 'SubtractDestFromSource'],
    Multiply: ['DestColor', 'Zero', 'Add', 'DestAlpha', 'Zero', 'Add'],
    Min: ['One', 'One', 'Min', 'One', 'One', 'Min'],
    Max: ['One', 'One', 'Max', 'One', 'One', 'Max'],
};

/** Builds a {@link ShaderPreviewBlend} from a label and a factor sextuple. */
const blendOf = (label: string, spec: readonly [string, string, string, string, string, string]): ShaderPreviewBlend => ({
    label,
    srcRgb: spec[0],
    dstRgb: spec[1],
    rgbOp: spec[2],
    srcAlpha: spec[3],
    dstAlpha: spec[4],
    alphaOp: spec[5],
});

/**
 * Walks up from a node to the material group to preview: the nearest enclosing group whose schema
 * class accepts shader constants, falling back to the nearest group that directly carries a `Shader`.
 * The fallback covers documents whose groups do not resolve to a material class (`planets.rules`,
 * `asteroids.rules`, unrooted mod fragments). A group referencing a shader is a material by
 * construction, whatever the schema knows about it.
 */
const enclosingMaterial = (node: AbstractNode | undefined): GroupNode | null => {
    for (let current: AbstractNode | undefined = node; current; current = current.parent) {
        if (isGroupNode(current)) {
            const cls = resolveGroupClass(current);
            if (cls && acceptsShaderConstants(cls)) return current;
        }
    }
    for (let current: AbstractNode | undefined = node; current; current = current.parent) {
        if (isGroupNode(current) && materialShaderNode(current)) return current;
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

/** A direct child of a group by name: an assignment's value (any node kind) or a named group/list. */
const childNamed = (group: GroupNode, name: string): AbstractNode | null => {
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name === name && element.right) return element.right;
        if ((isGroupNode(element) || isListNode(element)) && element.identifier?.name === name) return element;
    }
    return null;
};

/** The raw source text of a node, sliced from the document by its offsets. */
const rawText = (node: AbstractNode, text: string): string => text.slice(node.position.start, node.position.end).trim();

/** The numeric literal of a value node, or null when it is not a plain number. */
const numberOf = (node: AbstractNode): number | null =>
    isValueNode(node) && node.valueType.type === 'Number' ? (node.valueType.value as number) : null;

/** The string form of a named child's value, or null. */
const childText = (group: GroupNode, name: string): string | null => {
    const node = childNamed(group, name);
    return node && isValueNode(node) ? String(node.valueType.value) : null;
};

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

/**
 * Parses a written colour the way the game's Color deserializer does: byte channels (a scalar, a list,
 * or an `R`/`G`/`B`/`A` group) divide by 255, float channels (`Rf`/`Gf`/`Bf`/`Af`) pass through as
 * written, and out-of-range values stay out of range (the engine's colours are unclamped, vanilla uses
 * HDR ramps like `[500, 0, 0]`). Returns null for math, references, or an HSV group.
 *
 * @param node the written colour value (a number, a list, or a channel group).
 * @returns the normalized RGBA components, or null when they cannot be read structurally.
 */
const colorComponents = (node: AbstractNode): number[] | null => {
    const single = numberOf(node);
    if (single !== null) {
        const c = single / 255;
        return [c, c, c, c];
    }
    if (isListNode(node)) {
        const numbers = node.elements.map(numberOf);
        if (numbers.length < 3 || numbers.some((n) => n === null)) return null;
        const [r, g, b, a] = numbers as number[];
        return [r / 255, g / 255, b / 255, (a ?? 255) / 255];
    }
    if (isGroupNode(node)) {
        const channels = new Map<string, number>();
        for (const element of node.elements) {
            if (!isAssignmentNode(element) || !element.right) continue;
            const n = numberOf(element.right);
            if (n !== null) channels.set(element.left.name, n);
        }
        const channel = (float: string, byte: string): number | null =>
            channels.has(float) ? channels.get(float)! : channels.has(byte) ? channels.get(byte)! / 255 : null;
        const r = channel('Rf', 'R');
        const g = channel('Gf', 'G');
        const b = channel('Bf', 'B');
        if (r === null || g === null || b === null) return null;
        return [r, g, b, channel('Af', 'A') ?? 1];
    }
    return null;
};

/** True when the engine would classify a declared constant as a colour (a `float4` defaulting to 255). */
const isColorConstant = (kind: string, defaultValue: string | undefined): boolean =>
    kind === 'vec4' && defaultValue?.trim() === '255';

/** The engine's texture defaults when a rules texture sets no sampler fields. */
const SAMPLER_DEFAULTS: ShaderPreviewSampler = { sampleMode: 'Point', uMode: 'Clamp', vMode: 'Clamp', mips: false };

/**
 * The sampler state a texture group declares. `UVMode` sets both axes, `UMode`/`VMode` override one.
 * The defaults mirror the engine's `TextureFactory` (`Point`, `Clamp`, a single mip level).
 *
 * @param group the texture group, or null for a bare path (which gets the engine defaults).
 * @returns the resolved sampler state.
 */
const samplerOf = (group: GroupNode | null): ShaderPreviewSampler => {
    if (!group) return SAMPLER_DEFAULTS;
    const uv = childText(group, 'UVMode');
    const mips = childText(group, 'MipLevels');
    // A numeric `MipLevels` builds exactly that many levels in the engine; `max` builds a full chain.
    const mipCount = mips !== null && /^\d+$/.test(mips) ? Number(mips) : undefined;
    return {
        sampleMode: childText(group, 'SampleMode') ?? SAMPLER_DEFAULTS.sampleMode,
        uMode: childText(group, 'UMode') ?? uv ?? SAMPLER_DEFAULTS.uMode,
        vMode: childText(group, 'VMode') ?? uv ?? SAMPLER_DEFAULTS.vMode,
        mips: mips !== null && mips !== '1',
        mipCount: mipCount !== undefined && mipCount > 1 ? mipCount : undefined,
    };
};

/**
 * Resolves one written texture (a bare path or a `{ File = … }` group) to its on-disk URI and sampler
 * state. A mod often references a texture through its virtual `./Data/…` path, which resolves against
 * the vanilla tree and misses the mod's own copy; particle and effect textures usually sit next to
 * their def, so a miss falls back to the file's basename in the document's own directory.
 *
 * @param node the written texture value.
 * @param uniformName the sampler uniform this texture feeds.
 * @param documentUri the document the material lives in, the base for relative paths.
 * @param cancellationToken cancels the asset resolution.
 * @returns the texture entry, with a null URI when nothing resolves.
 */
const resolveTexture = async (
    node: AbstractNode,
    uniformName: string,
    documentUri: string,
    cancellationToken: CancellationToken
): Promise<ShaderPreviewTexture> => {
    const group = isGroupNode(node) ? node : null;
    const sampler = samplerOf(group);
    const fileNode = group ? assignmentValue(group, 'File') : isValueNode(node) ? node : null;
    if (!fileNode) return { name: uniformName, uri: null, sampler };
    const path = await resolveAssetPath(fileNode, documentUri, cancellationToken).catch(() => null);
    if (path) return { name: uniformName, uri: filePathToUri(path), sampler };
    const value = String(fileNode.valueType.value);
    const basename = value.slice(value.replace(/\\/g, '/').lastIndexOf('/') + 1);
    const candidate = join(normalizeDir(documentUri), basename);
    return { name: uniformName, uri: existsSync(candidate) ? filePathToUri(candidate) : null, sampler };
};

/**
 * The material's blend factors. `TargetBlendMode` is written either as a named engine mode
 * (`TargetBlendMode = Add`) or as a full factor group; missing group fields fall back to the
 * `AlphaBlend` defaults, and a factor group matching a named mode reports that mode's label.
 *
 * @param group the material group.
 * @returns the resolved blend (the engine's default `AlphaBlend` when the material sets none).
 */
const resolveBlend = (group: GroupNode): ShaderPreviewBlend => {
    const enumValue = assignmentValue(group, 'TargetBlendMode');
    if (enumValue) {
        const name = String(enumValue.valueType.value);
        if (BLEND_MODES[name]) return blendOf(name, BLEND_MODES[name]);
        // Lenient aliases for labels mods write that are not engine enum names.
        if (/premult/i.test(name)) return blendOf(name, BLEND_MODES.AlphaBlendPreMultiplied);
        if (/add/i.test(name)) return blendOf(name, BLEND_MODES.Add);
        if (/mult/i.test(name)) return blendOf(name, BLEND_MODES.Multiply);
        return blendOf(name, BLEND_MODES.AlphaBlend);
    }
    const blendGroup = group.elements.find(
        (element): element is GroupNode => isGroupNode(element) && element.identifier?.name === 'TargetBlendMode'
    );
    if (!blendGroup) return blendOf('AlphaBlend', BLEND_MODES.AlphaBlend);
    const defaults = BLEND_MODES.AlphaBlend;
    const field = (name: string, fallback: string): string => childText(blendGroup, name) ?? fallback;
    const spec: readonly [string, string, string, string, string, string] = [
        field('SourceRgbFactor', defaults[0]),
        field('DestRgbFactor', defaults[1]),
        field('RgbOperator', defaults[2]),
        field('SourceAlphaFactor', defaults[3]),
        field('DestAlphaFactor', defaults[4]),
        field('AlphaOperator', defaults[5]),
    ];
    const named = Object.entries(BLEND_MODES).find(([, mode]) => mode.every((factor, i) => factor === spec[i]));
    return blendOf(named ? named[0] : 'Custom', spec);
};

/**
 * The mean of a written numeric value that may be a plain number, a `[min, max]` list, or a
 * `{ Min = … Max = … }` group, the three forms the particle defs use for randomized scalars.
 */
const meanOf = (node: AbstractNode): number | null => {
    const single = numberOf(node);
    if (single !== null) return single;
    if (isListNode(node)) {
        const numbers = node.elements.map(numberOf).filter((n): n is number => n !== null);
        return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
    }
    if (isGroupNode(node)) {
        const min = childNamed(node, 'Min');
        const max = childNamed(node, 'Max');
        const lo = min ? numberOf(min) : null;
        const hi = max ? numberOf(max) : null;
        if (lo !== null && hi !== null) return (lo + hi) / 2;
        return lo ?? hi;
    }
    return null;
};

/** True unless the updater group writes `Enabled = false`. */
const updaterEnabled = (group: GroupNode): boolean => childText(group, 'Enabled') !== 'false';

/** Reads a written 2D size (an `{X = … Y = …}` group or a two-number list) into `[x, y]`, or null. */
const xyOf = (node: AbstractNode | null): number[] | null => {
    if (!node) return null;
    if (isGroupNode(node)) {
        const x = childNamed(node, 'X');
        const y = childNamed(node, 'Y');
        const xn = x ? numberOf(x) : null;
        const yn = y ? numberOf(y) : null;
        return xn !== null && yn !== null ? [xn, yn] : null;
    }
    if (isListNode(node)) {
        const numbers = node.elements.map(numberOf);
        return numbers.length === 2 && numbers.every((n) => n !== null) ? (numbers as number[]) : null;
    }
    return null;
};

/** The lists a particle def declares its data operators in, in the order the game runs them. */
const OPERATOR_LISTS = ['PreInitializers', 'Initializers', 'PostInitializers', 'Updaters'] as const;

/**
 * Finds the particle system's `UvSprites` sprite-sheet operator for a material, walking the material's
 * ancestors the same way as {@link particleColorOf}. An updater animates through the cells each frame;
 * an initializer picks one cell per particle (still reported, with `animated` false unless it loops).
 *
 * @param material the material group inside the particle def.
 * @returns the sheet geometry, or null when the def selects no sprite cell.
 */
const spriteSheetOf = (material: GroupNode): ShaderPreviewSpriteSheet | null => {
    for (let current: AbstractNode | undefined = material.parent; current; current = current.parent) {
        if (!isGroupNode(current)) continue;
        for (const listName of OPERATOR_LISTS) {
            const list = childNamed(current, listName);
            if (!list || !isListNode(list)) continue;
            for (const element of list.elements) {
                if (!isGroupNode(element) || !updaterEnabled(element)) continue;
                if (childText(element, 'Type') !== 'UvSprites') continue;
                const textureSize = xyOf(childNamed(element, 'TextureSize'));
                const spriteSize = xyOf(childNamed(element, 'SpriteSize'));
                const count = childNamed(element, 'SpriteCount');
                const perRow = childNamed(element, 'SpritesPerRow');
                const countN = count ? numberOf(count) : null;
                const perRowN = perRow ? numberOf(perRow) : null;
                if (!textureSize || !spriteSize || countN === null || perRowN === null || countN < 1 || perRowN < 1) {
                    continue;
                }
                return {
                    textureSize,
                    spriteSize,
                    count: countN,
                    perRow: perRowN,
                    offset: xyOf(childNamed(element, 'PixelOffset')) ?? [0, 0],
                    animated: listName === 'Updaters' || childText(element, 'Looping') === 'true',
                };
            }
        }
    }
    return null;
};

/** The particle's lifetime in seconds from the def's `Lifetime` updater, independent of any ramp. */
const lifetimeOf = (material: GroupNode): number | null => {
    for (let current: AbstractNode | undefined = material.parent; current; current = current.parent) {
        if (!isGroupNode(current)) continue;
        const updaters = childNamed(current, 'Updaters');
        if (!updaters || !isListNode(updaters)) continue;
        for (const element of updaters.elements) {
            if (!isGroupNode(element) || !updaterEnabled(element)) continue;
            if (childText(element, 'Type') !== 'Lifetime') continue;
            const value = childNamed(element, 'Lifetime');
            const mean = value ? meanOf(value) : null;
            if (mean !== null && mean > 0) return mean;
        }
    }
    return null;
};

/** The particle renderer's `BaseSize`, from the `Renderer` group beside the material, or null. */
const baseSizeOf = (material: GroupNode): number[] | null => {
    for (let current: AbstractNode | undefined = material.parent; current; current = current.parent) {
        if (!isGroupNode(current)) continue;
        const renderer = childNamed(current, 'Renderer');
        if (renderer && isGroupNode(renderer)) {
            const baseSize = xyOf(childNamed(renderer, 'BaseSize'));
            if (baseSize) return baseSize;
        }
    }
    return null;
};

/**
 * Finds the particle system's colour-over-lifetime animation for a material. The game's particle
 * updaters run on the CPU: a `Lifetime` updater advances a 0→1 life channel, and a `ColorRamp` updater
 * lerps across its `Colors` list keyed by it, writing the vertex colour the shader multiplies in. The
 * material and the `Updaters` list are siblings inside the particle def, so this walks the material's
 * ancestors and reads the first enabled ramp it finds.
 *
 * @param material the material group inside the particle def.
 * @returns the ramp and lifetime, or null when no enclosing def animates the colour.
 */
const particleColorOf = (material: GroupNode): ShaderPreviewParticleColor | null => {
    for (let current: AbstractNode | undefined = material.parent; current; current = current.parent) {
        if (!isGroupNode(current)) continue;
        const updaters = childNamed(current, 'Updaters');
        if (!updaters || !isListNode(updaters)) continue;
        let lifetime = 1;
        let colors: number[][] | null = null;
        let invert = false;
        for (const element of updaters.elements) {
            if (!isGroupNode(element) || !updaterEnabled(element)) continue;
            const type = childText(element, 'Type');
            if (type === 'Lifetime') {
                const value = childNamed(element, 'Lifetime');
                const mean = value ? meanOf(value) : null;
                if (mean !== null && mean > 0) lifetime = mean;
            } else if (type === 'ColorRamp' && !colors) {
                const list = childNamed(element, 'Colors');
                if (list && isListNode(list)) {
                    const parsed = list.elements.map(colorComponents);
                    if (parsed.length >= 2 && parsed.every((c): c is number[] => c !== null)) {
                        colors = parsed;
                        invert = childText(element, 'Invert') === 'true';
                    }
                }
            }
        }
        if (colors) return { lifetime, invert, colors };
    }
    return null;
};

/** The raw source text of an assignment's value (any node kind: value, list, or group), or null. */
const assignmentRaw = (group: GroupNode, name: string, text: string): string | null => {
    const node = childNamed(group, name);
    return node ? rawText(node, text) : null;
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
            vertexStage: null,
            translationOk: false,
            reason: 'shader file not found',
            constants: [],
            textures: [],
            blend: blendOf('AlphaBlend', BLEND_MODES.AlphaBlend),
            tint: null,
            tintComponents: null,
            isParticle: false,
            isBeam: false,
            particleColor: null,
            spriteSheet: null,
            particleLifetime: null,
            baseSize: null,
            size: null,
        };
    }

    const declared = await shaderConstants(shaderPath, dataDir, readOverride).catch(() => []);
    // Merge the material's written values onto the declared constants (assignment or group form),
    // keeping the node so colour-typed constants can be normalized the way the game parses them.
    const written = new Map<string, { node: AbstractNode; text: string }>();
    for (const constant of materialConstants(group)) {
        written.set(constant.name, { node: constant.value, text: rawText(constant.value, text) });
    }
    const constants: ShaderPreviewConstant[] = declared.map((constant) => {
        const value = written.get(constant.name);
        const isColor = isColorConstant(constant.kind, constant.default);
        const components = value
            ? ((isColor ? colorComponents(value.node) : null) ?? valueComponents(value.node) ?? undefined)
            : undefined;
        return {
            name: constant.name,
            kind: constant.kind,
            hlslType: constant.hlslType,
            default: constant.default,
            value: value?.text,
            components,
            isColor: isColor || undefined,
        };
    });

    // Every texture the material binds: the base `Texture` (assignment or group form) plus each written
    // texture-kind constant, so noise, ramp, and dissolve textures render instead of a white dummy.
    const textures: ShaderPreviewTexture[] = [];
    const baseTexture = childNamed(group, 'Texture');
    if (baseTexture) textures.push(await resolveTexture(baseTexture, '_texture', document.uri, cancellationToken));
    for (const constant of declared) {
        if (constant.kind !== 'texture' || constant.name === '_texture') continue;
        const value = written.get(constant.name);
        if (!value) continue;
        textures.push(await resolveTexture(value.node, constant.name, document.uri, cancellationToken));
    }

    let expanded = await expandShaderSource(shaderPath, [...PREVIEW_SHADER_DEFINES], dataDir, readOverride).catch(
        () => ''
    );
    let translation: GlslTranslation = expanded
        ? translateToGlsl(expanded)
        : { ok: false, reason: 'shader unreadable' };
    // An include-library shader keeps its entry points behind USE_DEFAULT_… guards; retry with the
    // guards defined so previewing such a file shows the default pipeline instead of failing.
    if (!translation.ok && translation.reason === 'no recognizable pix entry point') {
        const withDefaults = await expandShaderSource(
            shaderPath,
            [...PREVIEW_SHADER_DEFINES, ...DEFAULT_ENTRY_DEFINES],
            dataDir,
            readOverride
        ).catch(() => '');
        if (withDefaults) {
            const retried = translateToGlsl(withDefaults);
            if (retried.ok) {
                expanded = withDefaults;
                translation = retried;
            }
        }
    }
    // A particle shader's per-vertex colour is the particle system's animated colour channel, a beam
    // shader's vertex stage carries intensity and fade. Both drive how the preview feeds `vColor`.
    // The include filename resolves through the case-insensitive FS (any casing), while the
    // VERT_ macros are preprocessor identifiers and stay case-sensitive.
    const isParticle = /\bbase_particle\.shader\b/i.test(expanded) || /VERT_\w*PARTICLE/.test(expanded);
    const isBeam = /\bbase_beam\.shader\b/i.test(expanded) || /VERT_\w*BEAM\b/.test(expanded);

    const tintNode = childNamed(group, 'Color') ?? childNamed(group, 'VertexColor');

    return {
        shaderName: String(shaderNode.valueType.value),
        shaderUri: filePathToUri(shaderPath),
        glsl: translation.ok ? translation.glsl! : null,
        vertexStage: (translation.ok && translation.vertex) || null,
        translationOk: translation.ok,
        reason: translation.ok ? undefined : translation.reason,
        constants,
        textures,
        blend: resolveBlend(group),
        tint: assignmentRaw(group, 'Color', text) ?? assignmentRaw(group, 'VertexColor', text),
        tintComponents: tintNode ? colorComponents(tintNode) : null,
        isParticle,
        isBeam,
        particleColor: isParticle ? particleColorOf(group) : null,
        spriteSheet: isParticle ? spriteSheetOf(group) : null,
        particleLifetime: isParticle ? lifetimeOf(group) : null,
        baseSize: isParticle ? baseSizeOf(group) : null,
        size: assignmentRaw(group, 'Size', text),
    };
};
