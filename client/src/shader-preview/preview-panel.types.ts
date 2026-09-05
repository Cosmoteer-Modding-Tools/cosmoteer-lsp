/**
 * The payload shape of the shader preview: what the server's `cosmoteer/shaderPreview` request returns
 * and the panel hands to its webview once the asset paths are rewritten as webview URIs.
 */

/** The preview payload shape returned by the server's `cosmoteer/shaderPreview` request. */
export interface ShaderPreviewData {
    shaderName: string;
    shaderUri: string | null;
    glsl: string | null;
    vertexStage: {
        glsl: string;
        fragment: string;
        kind: 'sprite' | 'particle' | 'beam' | 'crew' | 'shipPart';
    } | null;
    translationOk: boolean;
    reason?: string;
    constants: Array<{
        name: string;
        kind: string;
        hlslType: string;
        default?: string;
        value?: string;
        components?: number[];
        isColor?: boolean;
    }>;
    textures: Array<{
        name: string;
        uri: string | null;
        sampler: { sampleMode: string; uMode: string; vMode: string; mips: boolean; mipCount?: number };
    }>;
    blend: {
        label: string;
        srcRgb: string;
        dstRgb: string;
        rgbOp: string;
        srcAlpha: string;
        dstAlpha: string;
        alphaOp: string;
    };
    tint: string | null;
    tintComponents: number[] | null;
    isParticle: boolean;
    isBeam: boolean;
    particleColor: { lifetime: number; invert: boolean; colors: number[][] } | null;
    spriteSheet: {
        textureSize: number[];
        spriteSize: number[];
        count: number;
        perRow: number;
        offset: number[];
        animated: boolean;
    } | null;
    particleLifetime: number | null;
    baseSize: number[] | null;
    size: string | null;
}
