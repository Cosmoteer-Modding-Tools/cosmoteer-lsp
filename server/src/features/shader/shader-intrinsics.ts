/**
 * A curated table of the HLSL builtin functions Cosmoteer shaders use, shared by shader completion and
 * shader signature help. It is not the full HLSL standard library, just the intrinsics that actually
 * appear across the game's shaders plus the common maths ones, each with a parameter list and a
 * one-line description. Keyed by the exact (case-sensitive) HLSL name.
 */

/** One HLSL intrinsic's signature. */
export interface Intrinsic {
    /** Ordered parameter names, each rendered into the label so the client can highlight it. */
    readonly params: readonly string[];
    /** One-line description shown in completion detail and the signature-help popup. */
    readonly doc: string;
}

export const HLSL_INTRINSICS: Readonly<Record<string, Intrinsic>> = {
    abs: { params: ['x'], doc: 'Absolute value, component-wise.' },
    acos: { params: ['x'], doc: 'Arccosine of each component, in radians.' },
    all: { params: ['x'], doc: 'True if every component is non-zero.' },
    any: { params: ['x'], doc: 'True if any component is non-zero.' },
    asin: { params: ['x'], doc: 'Arcsine of each component, in radians.' },
    atan: { params: ['x'], doc: 'Arctangent of each component, in radians.' },
    atan2: { params: ['y', 'x'], doc: 'Arctangent of y/x, using the signs to pick the quadrant.' },
    ceil: { params: ['x'], doc: 'Round each component up to an integer.' },
    clamp: { params: ['x', 'min', 'max'], doc: 'Clamp x into the [min, max] range.' },
    cos: { params: ['x'], doc: 'Cosine of each component (radians).' },
    cosh: { params: ['x'], doc: 'Hyperbolic cosine of each component.' },
    cross: { params: ['a', 'b'], doc: 'Cross product of two 3-component vectors.' },
    ddx: { params: ['x'], doc: 'Partial derivative with respect to the screen-space x coordinate.' },
    ddy: { params: ['x'], doc: 'Partial derivative with respect to the screen-space y coordinate.' },
    degrees: { params: ['radians'], doc: 'Convert radians to degrees.' },
    distance: { params: ['a', 'b'], doc: 'Distance between two points.' },
    dot: { params: ['a', 'b'], doc: 'Dot product of two vectors.' },
    exp: { params: ['x'], doc: 'e raised to the power x, component-wise.' },
    exp2: { params: ['x'], doc: '2 raised to the power x, component-wise.' },
    floor: { params: ['x'], doc: 'Round each component down to an integer.' },
    fmod: { params: ['a', 'b'], doc: 'Floating-point remainder of a / b.' },
    frac: { params: ['x'], doc: 'Fractional part of each component.' },
    fwidth: { params: ['x'], doc: 'abs(ddx(x)) + abs(ddy(x)), the screen-space rate of change.' },
    length: { params: ['v'], doc: 'Length (magnitude) of a vector.' },
    lerp: { params: ['a', 'b', 's'], doc: 'Linear interpolation from a to b by s.' },
    log: { params: ['x'], doc: 'Natural logarithm, component-wise.' },
    log2: { params: ['x'], doc: 'Base-2 logarithm, component-wise.' },
    log10: { params: ['x'], doc: 'Base-10 logarithm, component-wise.' },
    mad: { params: ['a', 'b', 'c'], doc: 'Multiply-add: a * b + c.' },
    max: { params: ['a', 'b'], doc: 'Component-wise maximum of a and b.' },
    min: { params: ['a', 'b'], doc: 'Component-wise minimum of a and b.' },
    mul: { params: ['a', 'b'], doc: 'Matrix/vector product (row-vector convention).' },
    normalize: { params: ['v'], doc: 'Return v scaled to unit length.' },
    pow: { params: ['x', 'y'], doc: 'x raised to the power y, component-wise.' },
    radians: { params: ['degrees'], doc: 'Convert degrees to radians.' },
    reflect: { params: ['i', 'n'], doc: 'Reflect incident vector i about normal n.' },
    refract: { params: ['i', 'n', 'eta'], doc: 'Refract incident vector i about normal n with ratio eta.' },
    round: { params: ['x'], doc: 'Round each component to the nearest integer.' },
    rsqrt: { params: ['x'], doc: 'Reciprocal square root, 1 / sqrt(x).' },
    saturate: { params: ['x'], doc: 'Clamp x into the [0, 1] range (equivalent to clamp(x, 0, 1)).' },
    sign: { params: ['x'], doc: 'Sign of each component: -1, 0, or 1.' },
    sin: { params: ['x'], doc: 'Sine of each component (radians).' },
    sincos: { params: ['x', 'out s', 'out c'], doc: 'Compute sine and cosine of x at once.' },
    sinh: { params: ['x'], doc: 'Hyperbolic sine of each component.' },
    smoothstep: { params: ['min', 'max', 'x'], doc: 'Smooth Hermite interpolation between 0 and 1.' },
    sqrt: { params: ['x'], doc: 'Square root of each component.' },
    step: { params: ['edge', 'x'], doc: '0 when x < edge, else 1.' },
    tan: { params: ['x'], doc: 'Tangent of each component (radians).' },
    tanh: { params: ['x'], doc: 'Hyperbolic tangent of each component.' },
    tex2D: { params: ['sampler', 'uv'], doc: 'Sample a 2D texture at uv (legacy DX9 form).' },
    transpose: { params: ['m'], doc: 'Transpose of a matrix.' },
    trunc: { params: ['x'], doc: 'Truncate each component toward zero.' },
};

/**
 * The full set of HLSL intrinsic function names, for validation. It is a superset of the documented
 * {@link HLSL_INTRINSICS} table (which carries only the curated ones completion and hover explain): a
 * call to any name in here is known-good, so the undeclared-function check never flags it. Kept broad
 * on purpose, an unknown function is only worth reporting when it is neither an intrinsic, a builtin
 * constructor, nor a function the shader or its includes define.
 */
export const HLSL_INTRINSIC_NAMES: ReadonlySet<string> = new Set([
    ...Object.keys(HLSL_INTRINSICS),
    'abort', 'asdouble', 'asfloat', 'asint', 'asuint', 'clip', 'countbits', 'D3DCOLORtoUBYTE4',
    'ddx_coarse', 'ddx_fine', 'ddy_coarse', 'ddy_fine', 'determinant', 'dst', 'errorf',
    'f16tof32', 'f32tof16', 'faceforward', 'firstbithigh', 'firstbitlow', 'fma', 'frexp',
    'isfinite', 'isinf', 'isnan', 'ldexp', 'lit', 'modf', 'msad4', 'noise', 'printf', 'rcp',
    'reversebits', 'AllMemoryBarrier', 'AllMemoryBarrierWithGroupSync', 'DeviceMemoryBarrier',
    'DeviceMemoryBarrierWithGroupSync', 'GroupMemoryBarrier', 'GroupMemoryBarrierWithGroupSync',
    'GetRenderTargetSampleCount', 'GetRenderTargetSamplePosition', 'EvaluateAttributeAtCentroid',
    'EvaluateAttributeAtSample', 'EvaluateAttributeSnapped',
    'tex1D', 'tex1Dbias', 'tex1Dgrad', 'tex1Dlod', 'tex1Dproj', 'tex2Dbias', 'tex2Dgrad', 'tex2Dlod',
    'tex2Dproj', 'tex3D', 'tex3Dbias', 'tex3Dgrad', 'tex3Dlod', 'tex3Dproj', 'texCUBE', 'texCUBEbias',
    'texCUBEgrad', 'texCUBElod', 'texCUBEproj',
]);

/** One texture method, with its call signature, return type, and a one-line explanation. */
export interface TextureMethod {
    readonly signature: string;
    readonly returns: string;
    readonly doc: string;
}

/** The sampling/query methods available on a texture object (offered after a `.`, documented on hover). */
export const TEXTURE_METHODS: Readonly<Record<string, TextureMethod>> = {
    Sample: {
        signature: 'Sample(sampler, uv)',
        returns: 'float4',
        doc: "Sample the texture at uv using the sampler's filtering and wrap mode.",
    },
    SampleLevel: {
        signature: 'SampleLevel(sampler, uv, lod)',
        returns: 'float4',
        doc: 'Sample a specific mip level (lod) instead of the automatically computed one.',
    },
    SampleBias: {
        signature: 'SampleBias(sampler, uv, bias)',
        returns: 'float4',
        doc: 'Sample with a bias added to the automatically computed mip level.',
    },
    SampleGrad: {
        signature: 'SampleGrad(sampler, uv, ddx, ddy)',
        returns: 'float4',
        doc: 'Sample using explicit screen-space gradients to choose the mip level.',
    },
    SampleCmp: {
        signature: 'SampleCmp(sampler, uv, compareValue)',
        returns: 'float',
        doc: 'Sample and compare against a reference value, used for shadow maps.',
    },
    Load: {
        signature: 'Load(texelCoord)',
        returns: 'float4',
        doc: 'Read a single texel by integer coordinate, with no filtering.',
    },
    Gather: {
        signature: 'Gather(sampler, uv)',
        returns: 'float4',
        doc: "Fetch the four neighbouring texels' red channel around uv.",
    },
    GetDimensions: {
        signature: 'GetDimensions(out width, out height)',
        returns: 'void',
        doc: "Write the texture's width and height into the output parameters.",
    },
};

/** An engine-provided uniform, with its HLSL type and what it holds. */
export interface EngineUniform {
    readonly type: string;
    readonly doc: string;
}

/**
 * The engine-provided uniforms a Cosmoteer shader reads but a material never sets. They are declared in
 * `base.shader` (an include), so the current file's own scan never sees them. This table lets
 * completion still offer them, type-resolution resolve `_texture.` to the texture methods, and hover
 * explain where each value comes from.
 */
export const ENGINE_UNIFORMS: Readonly<Record<string, EngineUniform>> = {
    _texture: { type: 'Texture2D', doc: 'The material base-colour texture, bound by the engine.' },
    _color: { type: 'float4', doc: 'The per-draw colour tint, supplied by the engine.' },
    _transform: { type: 'float4x4', doc: 'The model-view-projection matrix for the current draw.' },
    _screenSize: { type: 'float2', doc: 'The render target size in pixels.' },
    _viewportScale: { type: 'float2', doc: 'The viewport scale factor.' },
    _time: { type: 'float', doc: 'Seconds elapsed, advanced by the engine each frame.' },
    _gameTime: { type: 'float', doc: 'In-game seconds elapsed, advanced by the engine each frame.' },
    _lightNormal: { type: 'float3', doc: 'The global light direction, in normal space.' },
    _globalAmbientLight: { type: 'float3', doc: 'The scene ambient light colour.' },
    _globalDiffuseLight: { type: 'float3', doc: 'The scene diffuse light colour.' },
    _globalSpecularLight: { type: 'float3', doc: 'The scene specular light colour.' },
};

/** A human description of an HLSL type token (`float3` → a 3-component float vector), or null if unknown. */
export const describeHlslType = (token: string): string | null => {
    const vector = /^(float|half|int|uint|bool|double)([2-4])$/.exec(token);
    if (vector) return `A ${vector[2]}-component \`${vector[1]}\` vector.`;
    const matrix = /^(float|half|double)([2-4])x([2-4])$/.exec(token);
    if (matrix) return `A ${matrix[2]}×${matrix[3]} \`${matrix[1]}\` matrix.`;
    if (/^(float|half|int|uint|bool|double)$/.test(token)) return `An HLSL \`${token}\` scalar.`;
    if (/^Texture(2D|3D|Cube|2DArray)$/.test(token)) return `An HLSL \`${token}\` texture object.`;
    if (token === 'SamplerState') return 'A sampler state controlling texture filtering and addressing.';
    if (token === 'matrix') return 'An HLSL 4×4 matrix.';
    if (token === 'cbuffer') return 'A constant buffer grouping shader uniforms.';
    if (token === 'struct') return 'An HLSL struct type.';
    return null;
};
