/**
 * The payload of the live shader preview: the shader translated to GLSL, the constants the material
 * sets, the textures it binds with their sampler state, the blend factors, and the particle system's
 * colour ramp and sprite sheet. The service assembles it on the server and the webview only draws it.
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
    /**
     * The `file://` URI of every file the expansion read, the shader and its whole `#include` chain.
     * The client watches them all, so editing a base library refreshes the preview of a shader that
     * only includes it.
     */
    readonly sourceUris: readonly string[];
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
