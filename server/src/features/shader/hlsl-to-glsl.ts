/**
 * A focused translator from the constrained HLSL dialect Cosmoteer `.shader` files use into GLSL ES
 * 1.00, the version WebGL1 (and therefore a VS Code webview) compiles. It is best-effort: it covers
 * the constructs the vanilla shaders actually use (structs, `Texture2D.Sample`, the common intrinsics,
 * swizzles, `cbuffer`, scalar-to-vector constructors) and reports failure so the preview can fall back
 * to a generic textured render rather than show a broken result.
 *
 * The input must already have its `#include`s expanded and its preprocessor conditionals resolved
 * (see `expandShaderSource`). This stage is a pure string transform with no file access, which keeps
 * it unit-testable without a GPU.
 *
 * Two GLSL pitfalls shape the translation. GLSL ES forbids mixing `int` and `float` in arithmetic, so
 * integer literals are coerced to floats and the HLSL `f` suffix is stripped. And only `const`,
 * `uniform`, `varying`, or `attribute` may appear at global scope, so file-scope HLSL uniforms and
 * `cbuffer` members are rewritten as `uniform`. Functions unreachable from `pix` are dropped, which
 * removes the parts of `base.shader` the preview cannot honour anyway (render-target sampling, default
 * parameter values) before they reach the compiler.
 */

/** The outcome of a translation: the GLSL on success, or the reason it could not translate. */
export interface GlslTranslation {
    /** True when a GLSL fragment shader was produced. */
    readonly ok: boolean;
    /** The GLSL ES 1.00 fragment shader source, when `ok`. */
    readonly glsl?: string;
    /** A short reason the translation failed, when not `ok`. */
    readonly reason?: string;
}

/** Maps an HLSL scalar/vector/matrix type token to its GLSL spelling. */
const TYPE_MAP: Readonly<Record<string, string>> = {
    float2: 'vec2',
    float3: 'vec3',
    float4: 'vec4',
    half2: 'vec2',
    half3: 'vec3',
    half4: 'vec4',
    float2x2: 'mat2',
    float3x3: 'mat3',
    float4x4: 'mat4',
    matrix: 'mat4',
    uint: 'int',
};

/** The GLSL type names that can open a file-scope declaration. */
const GLSL_TYPES = ['vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'float', 'int', 'bool'];

/** Replaces every whole-word occurrence of `from` with `to`. */
const replaceWord = (src: string, from: string, to: string): string =>
    src.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), to);

/** Removes both line and block comments, so they cannot confuse function or brace scanning. */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');

/** Removes HLSL `[attribute(...)]` annotations (e.g. `[maxvertexcount(4)]`), which GLSL has no use for. */
const stripAttributes = (src: string): string => src.replace(/^\s*\[[A-Za-z_]\w*\s*\([^)]*\)\s*\]\s*$/gm, '');

/** Strips HLSL `: SEMANTIC` annotations from declarations and parameters. */
const stripSemantics = (src: string): string =>
    src.replace(/\s*:\s*(?:SV_)?[A-Za-z_]\w*(?:\d+)?(?=\s*[;,){])/g, '');

/** Translates HLSL vector and matrix type tokens (and their constructors) to GLSL. */
const translateTypes = (src: string): string => {
    let out = src;
    for (const [hlsl, glsl] of Object.entries(TYPE_MAP)) out = replaceWord(out, hlsl, glsl);
    return out;
};

/**
 * Rewrites HLSL C-style integer casts of a parenthesised expression (`(int2)(x)`, `(int)(x)`) into a
 * `floor` call. GLSL ES 1.00 forbids mixing `int` with `float` in arithmetic, and these casts exist to
 * quantise a value that then continues through float maths (pixelation, colour-depth reduction), so
 * flooring keeps the value in the float domain while preserving the truncation intent. The shaders pair
 * the cast with a `+ 0.5` bias, which makes `floor` an exact round-to-nearest for the non-negative
 * inputs involved.
 */
const translateCasts = (src: string): string => src.replace(/\(\s*u?int[234]?\s*\)\s*\(/g, 'floor(');

/** Removes the `f`/`F` suffix HLSL allows on float literals (`3.14f` → `3.14`), invalid in GLSL. */
const stripFloatSuffix = (src: string): string => src.replace(/(\d*\.\d+|\d+\.\d*|\d+)[fF]\b/g, '$1');

/**
 * Coerces bare integer literals to floats so GLSL ES never mixes `int` and `float` in arithmetic.
 * Two contexts must stay integer, or the result is invalid GLSL: array subscripts (`arr[0]`) and the
 * control parts of an `int`-typed `for` loop (`for (int i = 0; i < 4; i++)`). Those spans are masked
 * out (each replaced by a single private-use placeholder char, which carries no digits) before the
 * coercion and restored afterwards.
 */
const intLiteralsToFloat = (src: string): string => {
    const masked: string[] = [];
    const mask = (s: string): string => {
        const token = String.fromCharCode(0xe000 + masked.length);
        masked.push(s);
        return token;
    };
    const out = src
        .replace(/\bfor\s*\([^)]*\)/g, (m) => (/\bint\b/.test(m) ? mask(m) : m))
        .replace(/\[[^\]]*\]/g, mask)
        .replace(/(?<![\w.])\d+(?![\w.])/g, '$&.0');
    return out.replace(/[\uE000-\uF8FF]/g, (c) => masked[c.charCodeAt(0) - 0xe000]);
};

/** Translates HLSL intrinsics that differ by name from their GLSL equivalents. */
const translateIntrinsics = (src: string): string => {
    let out = src;
    out = out.replace(/\bsaturate\s*\(/g, 'clamp_0_1(');
    out = replaceWord(out, 'frac', 'fract');
    out = replaceWord(out, 'atan2', 'atan');
    out = replaceWord(out, 'rsqrt', 'inversesqrt');
    out = replaceWord(out, 'fmod', 'mod');
    out = replaceWord(out, 'ddx', 'dFdx');
    out = replaceWord(out, 'ddy', 'dFdy');
    // base.shader defines its own `lerp` overloads, keep them but rename so intent stays clear.
    out = replaceWord(out, 'lerp', 'lerp_');
    // `mul(a, b)` is a matrix/vector product. The pixel stage rarely uses it (the vertex transform is
    // replaced by a fixed quad), so a plain product via a helper is a faithful-enough approximation.
    out = out.replace(/\bmul\s*\(/g, 'mul_(');
    return out;
};

/**
 * Converts `Texture2D _x;` to a sampler uniform, drops the `SamplerState _x_SS;`, and rewrites the
 * sampling intrinsics into `texture2D`. GLSL ES 1.00 has no explicit-LOD sampling in the fragment
 * stage, so `.SampleLevel(_ss, uv, lod)` drops its level argument and samples at the default mip, and
 * `.GetDimensions(w, h)` (which only feeds such LOD maths) is stubbed with a nominal texture size so
 * the surrounding code still compiles. A texture type left in a parameter position becomes `sampler2D`.
 */
const translateTextures = (src: string): string =>
    src
        .replace(/\bSamplerState\s+_[A-Za-z0-9_]+\s*;/g, '')
        .replace(/\b(?:Texture2D|Texture3D|TextureCube)\s+(_[A-Za-z0-9_]+)\s*;/g, 'uniform sampler2D $1;')
        .replace(
            /\b(_[A-Za-z0-9_]+)\s*\.\s*SampleLevel\s*\(\s*_[A-Za-z0-9_]+\s*,([^,]+),[^)]*\)/g,
            'texture2D($1,$2)'
        )
        .replace(/\b(_[A-Za-z0-9_]+)\s*\.\s*Sample\s*\(\s*_[A-Za-z0-9_]+\s*,/g, 'texture2D($1,')
        .replace(
            /\b[A-Za-z_]\w*\s*\.\s*GetDimensions\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)\s*;/g,
            '$1 = 256.0; $2 = 256.0;'
        )
        .replace(/\b(?:Texture2D|Texture3D|TextureCube)\b/g, 'sampler2D');

/** Rewrites `cbuffer Name { … }` blocks into a sequence of `uniform` declarations. */
const translateCbuffers = (src: string): string =>
    src.replace(/\bcbuffer\s+\w+\s*\{([^}]*)\}/g, (_match, body: string) =>
        body
            .split(';')
            .map((decl) => decl.trim())
            .filter(Boolean)
            .map((decl) => `uniform ${decl};`)
            .join('\n')
    );

/** Rewrites a file-scope variable (a type at column 0) into a `uniform`, dropping any initializer. */
const globalsToUniforms = (src: string): string => {
    const typeAlternation = GLSL_TYPES.join('|');
    return src.replace(
        new RegExp(`^(${typeAlternation})\\s+(_[A-Za-z0-9_]+)\\s*(?:=[^;]*)?;`, 'gm'),
        'uniform $1 $2;'
    );
};

/** A struct field, with its translated GLSL type. */
interface StructField {
    readonly name: string;
    readonly type: string;
}

/** Parses every `struct Name { … }` block, returning its fields keyed by struct name. */
const parseStructs = (src: string): Map<string, StructField[]> => {
    const structs = new Map<string, StructField[]>();
    const re = /\bstruct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(src))) {
        const fields: StructField[] = [];
        for (const line of match[2].split(';')) {
            const decl = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*$/.exec(line.trim());
            if (decl) fields.push({ type: decl[1], name: decl[2] });
        }
        structs.set(match[1], fields);
    }
    return structs;
};

/** A top-level function definition located in the source by brace balancing. */
interface FunctionDef {
    readonly name: string;
    readonly start: number;
    readonly end: number;
}

/** Finds every top-level function definition (name and source span) by balancing braces. */
const findFunctions = (src: string): FunctionDef[] => {
    const functions: FunctionDef[] = [];
    const sig = /(?:^|\n)\s*[A-Za-z_]\w*(?:\s+(?:in|out|inout))?\s+([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = sig.exec(src))) {
        const open = src.indexOf('{', match.index);
        let depth = 0;
        let i = open;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) {
                i++;
                break;
            }
        }
        functions.push({ name: match[1], start: match.index + (match[0].startsWith('\n') ? 1 : 0), end: i });
        sig.lastIndex = i;
    }
    return functions;
};

/**
 * Removes every function not reachable from `pix`, so the unsupported parts of `base.shader` (render
 * target sampling, default parameter values, the vertex stage) never reach the compiler.
 *
 * @param src the translated source.
 * @returns the source with unreachable functions removed, and the names that were kept.
 */
const pruneUnreachableFunctions = (src: string): { src: string; kept: Set<string> } => {
    const functions = findFunctions(src);
    const byName = new Map(functions.map((fn) => [fn.name, fn]));
    const bodyOf = (fn: FunctionDef): string => src.slice(fn.start, fn.end);

    const reachable = new Set<string>();
    const queue = ['pix'];
    while (queue.length) {
        const name = queue.pop()!;
        if (reachable.has(name) || !byName.has(name)) continue;
        reachable.add(name);
        const body = bodyOf(byName.get(name)!);
        for (const call of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
            if (byName.has(call[1]) && !reachable.has(call[1])) queue.push(call[1]);
        }
    }

    // Rebuild, dropping the spans of unreachable functions.
    let out = '';
    let cursor = 0;
    for (const fn of functions.sort((a, b) => a.start - b.start)) {
        if (reachable.has(fn.name)) continue;
        out += src.slice(cursor, fn.start);
        cursor = fn.end;
    }
    out += src.slice(cursor);
    return { src: out, kept: reachable };
};

/** Sensible stand-in values for the vertex-stage outputs the preview does not compute. */
const FIELD_DEFAULTS: Readonly<Record<string, string>> = {
    uv: 'vUv',
    color: 'vColor',
    location: 'vec4(0.0)',
    tangent: 'vec4(1.0, 0.0, 0.0, 1.0)',
    lightNormal: 'vec3(0.0, 0.0, 1.0)',
    screenUV: 'vUv',
    screenLoc: 'vec4(vUv, 0.0, 1.0)',
    screenCenter: 'vec4(0.5, 0.5, 0.0, 1.0)',
    worldLoc: 'vec4(vUv, 0.0, 1.0)',
    color2: 'vColor',
};

/** The GLSL prelude: precision, the varyings, and the helpers the translated intrinsics rely on. */
const PRELUDE = `precision highp float;

varying vec2 vUv;
varying vec4 vColor;

float clamp_0_1(float x) { return clamp(x, 0.0, 1.0); }
vec2 clamp_0_1(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 clamp_0_1(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 clamp_0_1(vec4 x) { return clamp(x, 0.0, 1.0); }
float mul_(float a, float b) { return a * b; }
vec2 mul_(vec2 v, mat2 m) { return v * m; }
vec3 mul_(vec3 v, mat3 m) { return v * m; }
vec4 mul_(vec4 v, mat4 m) { return v * m; }
`;

/**
 * Builds the `main()` entry point. It reconstructs the pixel shader's input struct from the varyings,
 * substituting stand-ins for the vertex outputs the preview does not produce, then writes the result
 * of the translated `pix` function to `gl_FragColor`.
 *
 * @param pixStruct the struct the `pix` function takes as input.
 * @param structs all parsed structs, used to look up that struct's fields.
 * @returns the GLSL `main` function source.
 */
const buildMain = (pixStruct: string, structs: Map<string, StructField[]>): string => {
    const fields = structs.get(pixStruct) ?? [
        { name: 'uv', type: 'vec2' },
        { name: 'color', type: 'vec4' },
    ];
    const assigns = fields
        .filter((f) => f.name !== 'location')
        .map((f) => `    vsIn.${f.name} = ${FIELD_DEFAULTS[f.name] ?? `${f.type}(0.0)`};`)
        .join('\n');
    return `
void main()
{
    ${pixStruct} vsIn;
${assigns}
    gl_FragColor = pix(vsIn);
}
`;
};

/**
 * Translates an expanded, preprocessed Cosmoteer HLSL shader into a GLSL ES 1.00 fragment shader.
 *
 * @param hlsl the shader source with includes expanded and preprocessor conditionals already resolved.
 * @returns the translation result, with the GLSL on success or a reason on failure.
 */
export const translateToGlsl = (hlsl: string): GlslTranslation => {
    let src = stripComments(hlsl);

    // The pixel entry point can be written `PIX_OUTPUT pix(…)` or `float4 pix(…)`, with or without an
    // explicit `in` on the struct parameter. Its struct drives the generated `main`.
    const pixMatch = /\b(?:PIX_OUTPUT|float4|vec4)\s+pix\s*\(\s*(?:in\s+)?([A-Za-z_]\w*)\s+\w+\s*\)/.exec(src);
    if (!pixMatch) return { ok: false, reason: 'no recognizable pix entry point' };
    const pixStruct = pixMatch[1];

    src = src.replace(/^\s*#.*$/gm, ''); // drop leftover directives
    src = stripAttributes(src);
    src = src.replace(/\btypedef\s+float4\s+PIX_OUTPUT\s*;/g, '');
    src = src.replace(/\bstatic\b/g, '');
    src = stripSemantics(src);
    src = translateTextures(src);
    src = translateTypes(src);
    src = translateCasts(src);
    src = translateCbuffers(src);
    src = globalsToUniforms(src);
    src = stripFloatSuffix(src);
    src = intLiteralsToFloat(src);
    src = translateIntrinsics(src);
    src = src.replace(/\bPIX_OUTPUT\s+pix\s*\(/g, 'vec4 pix(');
    src = replaceWord(src, 'PIX_OUTPUT', 'vec4');
    // `input`, `output` and `half` are reserved for future use in GLSL ES 1.00. Rename the conventional
    // pixel-shader parameter and any identifier that collides with `half` so the translation compiles.
    src = replaceWord(src, 'input', 'vsIn');
    src = replaceWord(src, 'output', 'vsOut');
    src = replaceWord(src, 'half', 'half_');

    const structs = parseStructs(src);
    const pruned = pruneUnreachableFunctions(src);
    if (!pruned.kept.has('pix')) return { ok: false, reason: 'pix function could not be isolated' };
    src = pruned.src;

    if (/\bTexture2D\b|\bSamplerState\b|\bPIX_OUTPUT\b|\.Sample\s*\(/.test(src)) {
        return { ok: false, reason: 'unsupported HLSL constructs remain after translation' };
    }

    // Screen-space derivatives (`ddx`/`ddy`/`fwidth`, now `dFdx`/`dFdy`/`fwidth`) are an extension in
    // WebGL1. The directive must precede every other statement, so it is prepended ahead of the prelude.
    const usesDerivatives = /\bdFdx\b|\bdFdy\b|\bfwidth\b/.test(src);
    const extension = usesDerivatives ? '#extension GL_OES_standard_derivatives : enable\n' : '';
    const glsl = extension + PRELUDE + '\n' + src.trim() + '\n' + buildMain(pixStruct, structs);
    return { ok: true, glsl };
};
