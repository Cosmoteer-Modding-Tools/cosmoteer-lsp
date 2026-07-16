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
 * removes the parts of `base.shader` the preview cannot honour anyway (render-target sampling)
 * before they reach the compiler, and default parameter values become arity overloads.
 */

/**
 * A translated vertex stage paired with the fragment shader that reads its varyings. Produced when
 * the shader defines its own `vert` whose inputs the preview can synthesize from the quad, so the
 * preview runs the shader's real per-vertex math instead of the generic stand-ins.
 */
export interface GlslVertexStage {
    /** The GLSL ES 1.00 vertex shader source. */
    readonly glsl: string;
    /** The fragment shader reading the vertex stage's varyings instead of the stand-in defaults. */
    readonly fragment: string;
    /** Which input family was synthesized, so the preview picks a fitting world-to-clip transform. */
    readonly kind: 'sprite' | 'particle' | 'beam' | 'crew' | 'shipPart';
}

/** The outcome of a translation: the GLSL on success, or the reason it could not translate. */
export interface GlslTranslation {
    /** True when a GLSL fragment shader was produced. */
    readonly ok: boolean;
    /** The GLSL ES 1.00 fragment shader source, when `ok`. */
    readonly glsl?: string;
    /** A short reason the translation failed, when not `ok`. */
    readonly reason?: string;
    /** The shader's own vertex stage, when it defines a translatable `vert`. */
    readonly vertex?: GlslVertexStage;
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

/** The end offset of the primary expression starting at `start` (identifier/number/paren, with call, index and member suffixes). */
const primaryEnd = (src: string, start: number): number => {
    let i = start;
    while (i < src.length && /[!+\-\s]/.test(src[i])) i++;
    const scanBalanced = (open: string, close: string): void => {
        let depth = 0;
        for (; i < src.length; i++) {
            if (src[i] === open) depth++;
            else if (src[i] === close && --depth === 0) {
                i++;
                return;
            }
        }
    };
    if (src[i] === '(') scanBalanced('(', ')');
    else if (/[\d.]/.test(src[i])) {
        while (i < src.length && /[\d.]/.test(src[i])) i++;
        if (/[eE]/.test(src[i]) && /[-+\d]/.test(src[i + 1])) {
            i += 2;
            while (i < src.length && /\d/.test(src[i])) i++;
        }
        return i;
    } else if (/[A-Za-z_]/.test(src[i])) {
        while (i < src.length && /\w/.test(src[i])) i++;
    } else {
        return start;
    }
    // Call, index, and member/swizzle suffixes extend the primary (`abs(x).y`, `arr[0].rgb`).
    for (;;) {
        let j = i;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === '(') {
            i = j;
            scanBalanced('(', ')');
        } else if (src[j] === '[') {
            i = j;
            scanBalanced('[', ']');
        } else if (src[j] === '.' && /[A-Za-z_]/.test(src[j + 1])) {
            i = j + 1;
            while (i < src.length && /\w/.test(src[i])) i++;
        } else {
            return i;
        }
    }
};

/**
 * Rewrites HLSL C-style integer casts into a `floor` call. GLSL ES 1.00 forbids mixing `int` with
 * `float` in arithmetic, and these casts exist to quantise a value that then continues through float
 * maths (pixelation, colour-depth reduction, the atlas animation frame maths), so flooring keeps the
 * value in the float domain while preserving the truncation intent for the non-negative inputs the
 * shaders pass. Handles both the parenthesised form `(int)(x)` and the call/member form
 * `(int)wrap(...)` or `(int)info.frames.y`, whose span is found by balanced scanning.
 */
const translateCasts = (src: string): string => {
    const cast = /\(\s*u?int[234]?\s*\)\s*/g;
    let out = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = cast.exec(src))) {
        const after = match.index + match[0].length;
        if (src[after] === '(') {
            // `(int)(x)`: the parentheses already delimit the operand, floor replaces the cast.
            out += src.slice(cursor, match.index) + 'floor';
            cursor = after;
        } else if (/[A-Za-z_\d.]/.test(src[after] ?? '')) {
            const end = primaryEnd(src, after);
            if (end === after) continue;
            out += src.slice(cursor, match.index) + 'floor(' + src.slice(after, end) + ')';
            cursor = end;
            cast.lastIndex = end;
        }
    }
    return out + src.slice(cursor);
};

/**
 * Converts local and file-scope `int` declarations to `float`, flooring any initializer so integer
 * creation semantics survive (`int row = frame / framesPerRow` truncates in HLSL). GLSL ES 1.00
 * forbids mixed int/float arithmetic, and the atlas animation maths assigns float expressions into
 * `int` locals, so the whole int domain is lowered to floored floats. `for (int i …)` headers are
 * masked out first, keeping loop indices integer the way {@link intLiteralsToFloat} expects.
 */
const intDeclsToFloat = (src: string): string => {
    const masked: string[] = [];
    const mask = (s: string): string => {
        const token = String.fromCharCode(0xe000 + masked.length);
        masked.push(s);
        return token;
    };
    const out = src
        .replace(/\bfor\s*\([^)]*\)/g, (m) => (/\bint\b/.test(m) ? mask(m) : m))
        .replace(/\bint(\s+[A-Za-z_]\w*\s*;)/g, 'float$1')
        .replace(/\bint\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g, 'float $1 = floor($2);');
    return out.replace(/[\uE000-\uF8FF]/g, (c) => masked[c.charCodeAt(0) - 0xe000]);
};

/**
 * Lowers the HLSL binary `%` operator, which GLSL ES 1.00 lacks entirely, into a `pvMod(a, b)` helper
 * call with overloads for every operand pairing (see {@link HELPERS}). The left operand is the full
 * multiplicative chain ending at the `%` (matching HLSL precedence, so `a / b % 1` becomes
 * `pvMod(a / b, 1)`), the right operand a single primary expression.
 */
const lowerModulo = (src: string): string => {
    let out = src;
    for (let at = out.indexOf('%'); at >= 0; at = out.indexOf('%', at + 1)) {
        if (out[at + 1] === '=') continue;
        // The right operand: one primary expression forward.
        let right = at + 1;
        while (right < out.length && /\s/.test(out[right])) right++;
        const rightEnd = primaryEnd(out, right);
        if (rightEnd === right) continue;
        // The left operand: primaries joined by multiplicative operators, scanned backwards.
        let left = at;
        for (;;) {
            let i = left - 1;
            while (i >= 0 && /\s/.test(out[i])) i--;
            if (i < 0) break;
            if (out[i] === ')' || out[i] === ']') {
                const close = out[i] === ')' ? ')' : ']';
                const open = out[i] === ')' ? '(' : '[';
                let depth = 0;
                for (; i >= 0; i--) {
                    if (out[i] === close) depth++;
                    else if (out[i] === open && --depth === 0) {
                        i--;
                        break;
                    }
                }
            }
            // The identifier/member chain before a call's `(` (or the bare operand itself).
            while (i >= 0 && /[\w.]/.test(out[i])) i--;
            // A sign is unary (part of this operand) only when nothing bindable precedes it.
            while (i >= 0 && /[-+]/.test(out[i])) {
                let p = i - 1;
                while (p >= 0 && /\s/.test(out[p])) p--;
                if (p >= 0 && /[\w.)\]]/.test(out[p])) break;
                i--;
            }
            left = i + 1;
            while (left < out.length && /\s/.test(out[left])) left++;
            // Extend over a preceding `*` or `/` so the whole multiplicative chain stays the operand.
            let prev = i;
            while (prev >= 0 && /\s/.test(out[prev])) prev--;
            if (prev >= 0 && (out[prev] === '*' || out[prev] === '/')) {
                left = prev;
                continue;
            }
            break;
        }
        if (left >= at) continue;
        const lowered = `pvMod(${out.slice(left, at).trim()}, ${out.slice(right, rightEnd)})`;
        out = out.slice(0, left) + lowered + out.slice(rightEnd);
        at = left + lowered.length - 1;
    }
    return out;
};

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
    // GLSL ES 1.00 has no `isinf`; a helper tests against the float range instead. The helper name
    // avoids colliding with the real ES 3.00 builtin when the webview upgrades the source for WebGL2.
    out = replaceWord(out, 'isinf', 'pvIsInf');
    // base.shader defines its own `lerp` overloads, keep them but rename so intent stays clear.
    out = replaceWord(out, 'lerp', 'lerp_');
    // GLSL's `pow` has only the all-matching-type overload; HLSL also promotes a scalar to a vector
    // for either argument (`pow(col.rgb, 1.85)` is common in vanilla shaders). Route through a helper
    // with the promotion overloads rather than overloading the built-in directly.
    out = replaceWord(out, 'pow', 'pow_');
    // `mul(a, b)` is a matrix/vector product. The pixel stage rarely uses it (the vertex transform is
    // replaced by a fixed quad), so a plain product via a helper is a faithful-enough approximation.
    out = out.replace(/\bmul\s*\(/g, 'mul_(');
    return out;
};

/**
 * Converts `Texture2D _x;` to a sampler uniform, drops the `SamplerState _x_SS;`, and rewrites the
 * sampling intrinsics into `texture2D`. Explicit-LOD sampling and size queries have no GLSL ES 1.00
 * counterpart, so `.SampleLevel` becomes a `pvTexLod` helper call and `.GetDimensions(w, h)` a pair of
 * `pvTexSize` component reads; the helpers carry ES 1.00 fallback bodies (default-mip sample, nominal
 * size) that the webview swaps for real `textureLod`/`textureSize` when it runs on WebGL2 (see
 * {@link HELPERS}). A texture type left in a parameter position becomes `sampler2D`.
 */
const translateTextures = (src: string): string =>
    src
        .replace(/\bSamplerState\s+_[A-Za-z0-9_]+\s*;/g, '')
        .replace(/\b(?:Texture2D|Texture3D|TextureCube)\s+(_[A-Za-z0-9_]+)\s*;/g, 'uniform sampler2D $1;')
        .replace(
            /\b(_[A-Za-z0-9_]+)\s*\.\s*SampleLevel\s*\(\s*_[A-Za-z0-9_]+\s*,([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
            'pvTexLod($1,$2)'
        )
        .replace(/\b(_[A-Za-z0-9_]+)\s*\.\s*Sample\s*\(\s*_[A-Za-z0-9_]+\s*,/g, 'texture2D($1,')
        .replace(
            /\b([A-Za-z_]\w*)\s*\.\s*GetDimensions\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)\s*;/g,
            '$2 = pvTexSize($1).x; $3 = pvTexSize($1).y;'
        )
        .replace(/\b(?:Texture2D|Texture3D|TextureCube)\b/g, 'sampler2D');

/**
 * Lowers HLSL's `sincos(x, s, c)` intrinsic, which has no GLSL counterpart, into the two assignments
 * it stands for. The base beam helpers call it as a statement (`sincos(direction, dir.y, dir.x);`),
 * so the whole statement is rewritten; the angle expression is duplicated into both calls, which is
 * safe for the side-effect-free expressions the shaders pass.
 */
const lowerSincos = (src: string): string => {
    let out = src;
    let at = out.indexOf('sincos');
    while (at >= 0) {
        const open = out.indexOf('(', at + 6);
        const before = at === 0 ? ' ' : out[at - 1];
        if (open < 0 || /\w/.test(before)) {
            at = out.indexOf('sincos', at + 6);
            continue;
        }
        let depth = 0;
        let close = open;
        const commas: number[] = [];
        for (; close < out.length; close++) {
            if (out[close] === '(') depth++;
            else if (out[close] === ')' && --depth === 0) break;
            else if (out[close] === ',' && depth === 1) commas.push(close);
        }
        const semi = out.indexOf(';', close);
        if (close >= out.length || semi < 0 || commas.length !== 2) {
            at = out.indexOf('sincos', at + 6);
            continue;
        }
        const angle = out.slice(open + 1, commas[0]).trim();
        const sinOut = out.slice(commas[0] + 1, commas[1]).trim();
        const cosOut = out.slice(commas[1] + 1, close).trim();
        const lowered = `${sinOut} = sin(${angle}); ${cosOut} = cos(${angle});`;
        out = out.slice(0, at) + lowered + out.slice(semi + 1);
        at = out.indexOf('sincos', at + lowered.length);
    }
    return out;
};

/**
 * Rewrites HLSL default parameter values into GLSL arity overloads. GLSL forbids `= value` in a
 * parameter list, but the game's `base.shader` declares `multiplyAdditiveLightValue(…, float
 * nrmlStrengthLimit = 1.0)` and workshop shaders call it without the trailing argument. The
 * definition loses its initializers and a forwarding overload is emitted per omitted trailing
 * suffix, filling the missing arguments with their defaults, which matches HLSL call resolution.
 *
 * @param src the source after type translation, so the copied defaults are already valid GLSL.
 * @returns the source with initializers stripped and the forwarding overloads appended per function.
 */
const expandDefaultParams = (src: string): string => {
    const sig = /(?:^|\n)[ \t]*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(/g;
    let out = src;
    let match: RegExpExecArray | null;
    while ((match = sig.exec(out))) {
        const [, returnType, name] = match;
        const openParen = match.index + match[0].length - 1;
        let depth = 0;
        let close = openParen;
        for (; close < out.length; close++) {
            if (out[close] === '(') depth++;
            else if (out[close] === ')' && --depth === 0) break;
        }
        if (close >= out.length) break;
        const paramList = out.slice(openParen + 1, close);
        const bodyOpen = close + 1 + out.slice(close + 1).search(/\S/);
        if (bodyOpen <= close || out[bodyOpen] !== '{' || !paramList.includes('=')) continue;

        // Split the parameter list at top-level commas, so a `vec2(0.0, 0.0)` default stays intact.
        const pieces: string[] = [];
        let level = 0;
        let start = 0;
        for (let i = 0; i < paramList.length; i++) {
            if (paramList[i] === '(') level++;
            else if (paramList[i] === ')') level--;
            else if (paramList[i] === ',' && level === 0) {
                pieces.push(paramList.slice(start, i));
                start = i + 1;
            }
        }
        pieces.push(paramList.slice(start));
        const params = pieces.map((piece) =>
            /^\s*((?:in|out|inout)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+?))?\s*$/.exec(piece)
        );
        const firstDefault = params.findIndex((p) => p?.[4] !== undefined);
        if (params.some((p) => !p) || firstDefault < 0) continue;
        if (params.slice(firstDefault).some((p) => p![4] === undefined)) continue;

        let bodyEnd = bodyOpen;
        for (depth = 0; bodyEnd < out.length; bodyEnd++) {
            if (out[bodyEnd] === '{') depth++;
            else if (out[bodyEnd] === '}' && --depth === 0) {
                bodyEnd++;
                break;
            }
        }

        const declOf = (p: RegExpExecArray): string => `${p[1] ? `${p[1].trim()} ` : ''}${p[2]} ${p[3]}`;
        const stripped = params.map((p) => declOf(p!)).join(', ');
        const overloads: string[] = [];
        for (let arity = params.length - 1; arity >= firstDefault; arity--) {
            const kept = params.slice(0, arity);
            const args = [...kept.map((p) => p![3]), ...params.slice(arity).map((p) => p![4]!)];
            const call = `${name}(${args.join(', ')})`;
            const body = returnType === 'void' ? `${call};` : `return ${call};`;
            overloads.push(`\n${returnType} ${name}(${kept.map((p) => declOf(p!)).join(', ')}) { ${body} }`);
        }
        const appended = overloads.join('');
        out = out.slice(0, openParen + 1) + stripped + out.slice(close, bodyEnd) + appended + out.slice(bodyEnd);
        sig.lastIndex = openParen + 1 + stripped.length + (bodyEnd - close) + appended.length;
    }
    return out;
};

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
 * Removes every function not reachable from the given entry point, so the unsupported parts of
 * `base.shader` (render target sampling, the other stage's helpers) never reach the compiler.
 *
 * @param src the translated source.
 * @param entry the entry-point function name reachability starts from (`pix` or `vert`).
 * @returns the source with unreachable functions removed, and the names that were kept.
 */
const pruneUnreachableFunctions = (src: string, entry: string): { src: string; kept: Set<string> } => {
    const functions = findFunctions(src);
    // A name can have several definitions (overloads, including the arity overloads emitted for
    // default parameters), and every definition's body must be scanned for calls, or a helper only
    // the shadowed definition calls would be pruned while its call survives.
    const byName = new Map<string, FunctionDef[]>();
    for (const fn of functions) {
        const list = byName.get(fn.name);
        if (list) list.push(fn);
        else byName.set(fn.name, [fn]);
    }

    const reachable = new Set<string>();
    const queue = [entry];
    while (queue.length) {
        const name = queue.pop()!;
        if (reachable.has(name) || !byName.has(name)) continue;
        reachable.add(name);
        for (const fn of byName.get(name)!) {
            const body = src.slice(fn.start, fn.end);
            for (const call of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
                if (byName.has(call[1]) && !reachable.has(call[1])) queue.push(call[1]);
            }
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

/**
 * Sensible stand-in values for the vertex-stage outputs the preview does not compute, keyed by field
 * name and then by the field's declared GLSL type: the same name is declared with different types
 * across shaders (nebula's `worldLoc` is a `vec2` of world units, a particle's is a `vec4`), and a
 * type-mismatched assignment fails GLSL compilation. The beam fields mirror what `base_beam.shader`'s
 * vertex stage forwards, fed from the preview-only `uPv…` uniforms the prelude declares so the webview
 * can animate the beam time and expose intensity and fade as live controls. World locations scale
 * `vUv` up so world-unit noise math (nebulas) still shows variation across the quad.
 */
const FIELD_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    uv: { vec2: 'vUv', vec4: 'vec4(vUv, 0.0, 1.0)' },
    color: { vec4: 'vColor', vec3: 'vColor.rgb' },
    // The engine tangent is (rightDir.xy, flipX, flipY); an unrotated unflipped sprite is (1, 0, 1, 1).
    // A zero in `z` would wipe the normal's x channel in rotateFlipNormals and kill the lighting.
    tangent: { vec4: 'vec4(1.0, 0.0, 1.0, 1.0)' },
    // The engine's default light direction (BackgroundStyleRules), so lit stand-ins match the game.
    lightNormal: { vec3: 'vec3(-0.67, -0.67, 0.33)', vec2: 'vec2(0.0, 0.0)' },
    screenUV: { vec2: 'vUv' },
    screenLoc: { vec4: 'vec4(vUv, 0.0, 1.0)', vec2: 'vUv' },
    screenCenter: { vec4: 'vec4(0.5, 0.5, 0.0, 1.0)', vec2: 'vec2(0.5, 0.5)' },
    // The additive-lighting center doubles as the light source; a positive z puts it above the plane
    // so the screen-space light direction has a component toward the viewer and the light shows.
    center: { vec4: 'vec4(0.0, 0.0, 0.5, 1.0)', vec3: 'vec3(0.0, 0.0, 0.5)', vec2: 'vec2(0.5, 0.5)' },
    localLoc: { vec4: 'vec4((vUv - 0.5) * 100.0, 0.0, 1.0)', vec2: '(vUv - 0.5) * 100.0' },
    spriteUV: { vec2: 'vUv' },
    // The atlas animation block: frame 0 of a one-frame animation whose cell spans the whole quad,
    // so the animated-UV math resolves to the plain quad UVs (see crew's drop-shadow division).
    animUV: { vec2: 'vec2(0.0, 0.0)' },
    animUVOffsetPerFrame: { vec2: 'vec2(1.0, 1.0)' },
    shirtColor: { vec4: 'vec4(0.2, 0.45, 0.85, 1.0)' },
    skinColor: { vec4: 'vec4(0.87, 0.72, 0.6, 1.0)' },
    hairColor: { vec4: 'vec4(0.35, 0.22, 0.12, 1.0)' },
    powerLevel: { float: '1.0' },
    normalizedLocation: { vec2: 'vUv' },
    normalizedCenter: { vec2: 'vec2(0.5, 0.5)' },
    // The ship-quad geometry stage's per-pixel ship coordinates (heat, scorched, salvage…): a small
    // span matching a part-sized quad, so tile-scaled noise UVs show game-like variation.
    shipLocation: { vec2: '(vUv - 0.5) * 4.0' },
    maskUV: { vec2: 'vUv' },
    roofOpacity: { float: '1.0' },
    worldLoc: { vec4: 'vec4(vUv, 0.0, 1.0)', vec2: 'vUv * 100.0' },
    color2: { vec4: 'vColor' },
    beamTime: { float: 'uPvBeamTime' },
    intensity: { float: 'uPvIntensity' },
    fadeAlpha: { float: 'uPvFadeAlpha' },
    buff: { float: '0.0' },
    length: { float: 'uPvBeamLength' },
    unexploredUV: { vec2: 'vUv' },
};

/**
 * Overloads covering HLSL's implicit scalar promotion in `lerp` calls (`lerp(luminance, rgb, t)`
 * promotes the float to a vector), which GLSL does not perform, plus the vector-interpolant form of
 * the intrinsic. The scalar-promotion forms clamp `t` the way `base.shader`'s own overloads do (in
 * the game those calls resolve to them by promotion); the vector-`t` form has no base overload, so it
 * keeps the unclamped intrinsic semantics via `mix`. None of these signatures collides with
 * `base.shader`'s set, so they are safe to emit alongside it.
 */
const LERP_PROMOTIONS = `
vec2 lerp_(float a, vec2 b, float t) { t = clamp(t, 0.0, 1.0); return vec2(a) + (b - vec2(a)) * t; }
vec3 lerp_(float a, vec3 b, float t) { t = clamp(t, 0.0, 1.0); return vec3(a) + (b - vec3(a)) * t; }
vec4 lerp_(float a, vec4 b, float t) { t = clamp(t, 0.0, 1.0); return vec4(a) + (b - vec4(a)) * t; }
vec2 lerp_(vec2 a, float b, float t) { t = clamp(t, 0.0, 1.0); return a + (vec2(b) - a) * t; }
vec3 lerp_(vec3 a, float b, float t) { t = clamp(t, 0.0, 1.0); return a + (vec3(b) - a) * t; }
vec4 lerp_(vec4 a, float b, float t) { t = clamp(t, 0.0, 1.0); return a + (vec4(b) - a) * t; }
vec2 lerp_(vec2 a, vec2 b, vec2 t) { return mix(a, b, t); }
vec3 lerp_(vec3 a, vec3 b, vec3 t) { return mix(a, b, t); }
vec4 lerp_(vec4 a, vec4 b, vec4 t) { return mix(a, b, t); }
`;

/**
 * The plain `lerp` set for a shader that calls it without including `base.shader` (whose overloads
 * would otherwise define it). Without a user definition the game resolves to the HLSL intrinsic,
 * which does not clamp, so these use `mix` directly.
 */
const LERP_FALLBACK = `
float lerp_(float a, float b, float t) { return mix(a, b, t); }
vec2 lerp_(vec2 a, vec2 b, float t) { return mix(a, b, t); }
vec3 lerp_(vec3 a, vec3 b, float t) { return mix(a, b, t); }
vec4 lerp_(vec4 a, vec4 b, float t) { return mix(a, b, t); }
`;

/**
 * Per-vertex stand-ins for a `vert` function's input struct, keyed by field name and declared GLSL
 * type the way {@link FIELD_DEFAULTS} is. The quad supplies `aPos` (corner, ±1) and `aUv` (0–1,
 * top-origin); everything else comes from the preview uniforms. Sprite locations are scaled into a
 * nominal ±50 world-unit span (the preview transform scales it back) so world-unit noise math still
 * varies across the quad. Beam inputs lay the beam horizontally through the canvas: the start sits
 * half a beam length left of center, `vertexOffset.x` marks which end a corner belongs to and
 * `vertexOffset.y` carries the half-thickness the game's CPU normally supplies. A field with no
 * entry here means the vertex stage cannot be synthesized and the preview keeps the stand-in path.
 */
const VERT_INPUT_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    location: { vec4: 'vec4(aPos * 50.0, 0.0, 1.0)' },
    locationMin: { vec4: 'vec4(aPos * 50.0, 0.0, 1.0)' },
    locationMax: { vec4: 'vec4(aPos * 50.0, 0.0, 1.0)' },
    uv: { vec2: 'uUvRect.xy + aUv * uUvRect.zw' },
    color: { vec4: 'uTint' },
    color2: { vec4: 'uTint' },
    // A particle's center is a vec2 world position; the atlas quad's is a vec4 whose z doubles as the
    // additive light height, kept above the plane so screen-space lights show (see FIELD_DEFAULTS).
    center: { vec2: 'vec2(0.0, 0.0)', vec4: 'vec4(0.0, 0.0, 0.5, 1.0)', vec3: 'vec3(0.0, 0.0, 0.0)' },
    scale: { vec2: 'vec2(1.0, 1.0)' },
    rotation: { float: '0.0' },
    offset: { vec2: 'aPos * 0.5' },
    lightNormal: { vec3: 'vec3(-0.67, -0.67, 0.33)' },
    // The atlas per-quad data (base_atlas.shader): an unrotated, unflipped quad showing frame 0 of a
    // one-frame animation whose cell is the sprite-sheet rect the preview already computes.
    tangent: { vec4: 'vec4(1.0, 0.0, 1.0, 1.0)' },
    spriteUV: { vec2: 'aUv' },
    rotateAround: { vec4: 'vec4(0.0, 0.0, 0.0, 1.0)' },
    rotSpeed: { float: '0.0' },
    uvOffsetPerFrame: { vec2: 'uUvRect.zw' },
    animationInterval: { float: '1.0e38' },
    animationStartTime: { float: '0.0' },
    animationFrames: { vec2: 'vec2(1.0, 1.0)' },
    animationClamp: { float: '1.0' },
    // The crew vertex data (base_crew.shader): a standing crew quad with the engine's default light
    // and the vanilla-ish clothing colours the per-crew streams would carry.
    vertexOffset: {
        vec2: 'vec2(step(0.5, aUv.x), (0.5 - aUv.y) * 0.3 * uPvBeamLength)',
    },
    fromOffset: { vec3: 'vec3(0.0, 0.0, 0.0)' },
    crewTime: { float: '0.0' },
    shirtColor: { vec4: 'vec4(0.2, 0.45, 0.85, 1.0)' },
    skinColor: { vec4: 'vec4(0.87, 0.72, 0.6, 1.0)' },
    hairColor: { vec4: 'vec4(0.35, 0.22, 0.12, 1.0)' },
    beamStart: { vec4: 'vec4(-0.5 * uPvBeamLength, 0.0, 0.0, 1.0)' },
    direction: { float: '0.0' },
    length: { float: 'uPvBeamLength' },
    intensity: { float: 'uPvIntensity' },
    fadeAlpha: { float: 'uPvFadeAlpha' },
    beamTime: { float: 'uPvBeamTime' },
    buff: { float: '0.0' },
    // The remaining per-quad extras across the vanilla vert inputs: star twinkle (background), shield
    // waves at full power, the GUI blur mask, overlay pivots, indicator cycling, and the randomized
    // time offsets the effect quads carry.
    twinkleInterval: { float: '2.0' },
    twinkleOffset: { float: '0.0' },
    twinkleAddColor: { vec4: 'vec4(1.0, 1.0, 1.0, 1.0)' },
    powerLevel: { float: '1.0' },
    randomWaveTimeOffset: { float: '0.0' },
    randomWaveUOffset: { float: '0.0' },
    maskUV: { vec2: 'aUv' },
    pivot: { vec2: 'vec2(0.0, 0.0)' },
    cycleOffset: { float: '0.0' },
    cycleSiblingCount: { float: '1.0' },
    randomTimeOffset: { float: '0.0' },
    roofOpacity: { float: '1.0' },
};

/** The preview-only uniforms standing in for the vertex-stage inputs the engine feeds per frame. */
const PV_UNIFORMS = `uniform float uPvBeamTime;
uniform float uPvIntensity;
uniform float uPvFadeAlpha;
uniform float uPvBeamLength;
`;

/**
 * The helper functions the translated intrinsics rely on, shared by both stages. The `pvTexLod` and
 * `pvTexSize` bodies here are the GLSL ES 1.00 fallbacks (default-mip sample, nominal size); the
 * webview replaces these exact body strings with `textureLod`/`textureSize` when it runs on WebGL2,
 * so their spelling is a contract with `media/shader-preview.js`.
 */
const HELPERS = `float clamp_0_1(float x) { return clamp(x, 0.0, 1.0); }
vec2 clamp_0_1(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 clamp_0_1(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 clamp_0_1(vec4 x) { return clamp(x, 0.0, 1.0); }
float mul_(float a, float b) { return a * b; }
vec2 mul_(vec2 v, mat2 m) { return v * m; }
vec3 mul_(vec3 v, mat3 m) { return v * m; }
vec4 mul_(vec4 v, mat4 m) { return v * m; }
vec2 mul_(mat2 m, vec2 v) { return m * v; }
vec3 mul_(mat3 m, vec3 v) { return m * v; }
vec4 mul_(mat4 m, vec4 v) { return m * v; }
mat4 mul_(mat4 a, mat4 b) { return a * b; }
vec2 mul_(float a, vec2 b) { return a * b; }
vec3 mul_(float a, vec3 b) { return a * b; }
vec4 mul_(float a, vec4 b) { return a * b; }
float pvMod(float a, float b) { return mod(a, b); }
vec2 pvMod(vec2 a, vec2 b) { return mod(a, b); }
vec3 pvMod(vec3 a, vec3 b) { return mod(a, b); }
vec4 pvMod(vec4 a, vec4 b) { return mod(a, b); }
vec2 pvMod(vec2 a, float b) { return mod(a, b); }
vec3 pvMod(vec3 a, float b) { return mod(a, b); }
vec4 pvMod(vec4 a, float b) { return mod(a, b); }
int pvMod(int a, int b) { return int(mod(float(a), float(b))); }
bool pvIsInf(float x) { return abs(x) > 1.0e30; }
vec4 pvTexLod(sampler2D t, vec2 uv, float lod) { return texture2D(t, uv); }
vec2 pvTexSize(sampler2D t) { return vec2(256.0, 256.0); }
float pow_(float x, float y) { return pow(x, y); }
vec2 pow_(vec2 x, vec2 y) { return pow(x, y); }
vec3 pow_(vec3 x, vec3 y) { return pow(x, y); }
vec4 pow_(vec4 x, vec4 y) { return pow(x, y); }
vec2 pow_(vec2 x, float y) { return pow(x, vec2(y)); }
vec3 pow_(vec3 x, float y) { return pow(x, vec3(y)); }
vec4 pow_(vec4 x, float y) { return pow(x, vec4(y)); }
vec2 pow_(float x, vec2 y) { return pow(vec2(x), y); }
vec3 pow_(float x, vec3 y) { return pow(vec3(x), y); }
vec4 pow_(float x, vec4 y) { return pow(vec4(x), y); }
`;

/**
 * The fragment prelude: precision, the varyings the fixed quad supplies, the preview uniforms and
 * the shared helpers.
 */
const PRELUDE = `precision highp float;

varying vec2 vUv;
varying vec4 vColor;

${PV_UNIFORMS}
${HELPERS}`;

/**
 * The vertex-stage prelude: the quad attributes and the preview uniforms the synthesized inputs
 * read, plus the shared helpers for the intrinsics a vertex stage calls.
 */
const VERTEX_PRELUDE = `precision highp float;

attribute vec2 aPos;
attribute vec2 aUv;

uniform vec4 uTint;
uniform vec4 uUvRect;
${PV_UNIFORMS}
${HELPERS}`;

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
        .map((f) => `    vsIn.${f.name} = ${FIELD_DEFAULTS[f.name]?.[f.type] ?? `${f.type}(0.0)`};`)
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

/** The GLSL types a varying may carry; a struct field outside this set rules the vertex stage out. */
const VARYING_TYPES = new Set(['float', 'vec2', 'vec3', 'vec4']);

/**
 * Builds the translated vertex stage and its varying-fed fragment shader, when the source defines
 * its own `vert` the preview can drive. The vertex main synthesizes the input struct from the quad
 * (see {@link VERT_INPUT_DEFAULTS}), runs the real `vert`, forwards every output field to a
 * `vOut_…` varying and takes `gl_Position` from the transformed `location`. The fragment main then
 * reads those varyings instead of the generic stand-ins, so per-vertex math (beam thickness over
 * intensity, scrolling uv setups, screen-space locations) reaches `pix` the way the game computes it.
 *
 * @param src the fully translated source, before pruning.
 * @param pixStruct the struct the `pix` function takes, which `vert` must return.
 * @param structs all parsed structs.
 * @param fragmentBody the pruned fragment source (everything reachable from `pix`).
 * @param lerpHelpers the lerp overload set the fragment shader carries, reused for the vertex stage.
 * @returns the vertex stage, or undefined when no translatable `vert` exists.
 */
const buildVertexStage = (
    src: string,
    pixStruct: string,
    structs: Map<string, StructField[]>,
    fragmentBody: string,
    lerpHelpers: string
): GlslVertexStage | undefined => {
    const vertMatch = /(?:^|\n)\s*([A-Za-z_]\w*)\s+vert\s*\(\s*(?:in\s+)?([A-Za-z_]\w*)\s+[A-Za-z_]\w*\s*\)/.exec(
        src
    );
    if (!vertMatch) return undefined;
    // The vert may return a differently named struct than pix takes (crew_warning_circle pairs its
    // own vert with base.shader's default pix); the engine matches stages by semantic layout, so a
    // field-for-field identical struct is accepted the same way.
    if (vertMatch[1] !== pixStruct) {
        const vertOut = structs.get(vertMatch[1]);
        const pixIn = structs.get(pixStruct);
        const sameLayout =
            !!vertOut &&
            !!pixIn &&
            vertOut.length === pixIn.length &&
            vertOut.every((f, i) => f.name === pixIn[i].name && f.type === pixIn[i].type);
        if (!sameLayout) return undefined;
    }
    const inFields = structs.get(vertMatch[2]);
    const outFields = structs.get(pixStruct);
    if (!inFields?.length || !outFields?.length) return undefined;
    if (!outFields.some((f) => f.name === 'location' && f.type === 'vec4')) return undefined;
    if (outFields.some((f) => f.name !== 'location' && !VARYING_TYPES.has(f.type))) return undefined;

    // The input family decides both the world-to-clip fit and a few family-specific stand-ins: the
    // crew quad's `vertexOffset` is a plain corner offset, not the beam end/thickness encoding the
    // shared table carries for `base_beam.shader`.
    const kind: GlslVertexStage['kind'] = inFields.some((f) => f.name === 'beamStart')
        ? 'beam'
        : inFields.some((f) => f.name === 'crewTime')
          ? 'crew'
          : inFields.some((f) => f.name === 'rotateAround' || structs.has(f.type))
            ? 'shipPart'
            : inFields.some((f) => f.name === 'center' && f.type === 'vec2')
              ? 'particle'
              : 'sprite';
    const overrides: Readonly<Record<string, Readonly<Record<string, string>>>> =
        kind === 'crew' ? { vertexOffset: { vec2: 'aPos * 0.5' } } : {};

    // Synthesizes one assignment per input field, recursing into nested structs (the atlas quads
    // carry a `VERT_ANIMATION_INFO animInfo` block) so `vin.animInfo.uv = …` and friends are emitted.
    const initLines: string[] = [];
    const initField = (path: string, name: string, type: string): boolean => {
        const inner = structs.get(type);
        if (inner) {
            return inner.length > 0 && inner.every((f) => initField(`${path}.${f.name}`, f.name, f.type));
        }
        const expr = overrides[name]?.[type] ?? VERT_INPUT_DEFAULTS[name]?.[type];
        if (!expr) return false;
        initLines.push(`    vin${path} = ${expr};`);
        return true;
    };
    if (!inFields.every((f) => initField(`.${f.name}`, f.name, f.type))) return undefined;

    const pruned = pruneUnreachableFunctions(src, 'vert');
    if (!pruned.kept.has('vert')) return undefined;

    const varyings = outFields
        .filter((f) => f.name !== 'location')
        .map((f) => `varying ${f.type} vOut_${f.name};`)
        .join('\n');
    const vertexMain = `
void main()
{
    ${vertMatch[2]} vin;
${initLines.join('\n')}
    ${pixStruct} vout = vert(vin);
${outFields
    .filter((f) => f.name !== 'location')
    .map((f) => `    vOut_${f.name} = vout.${f.name};`)
    .join('\n')}
    gl_Position = vout.location;
}
`;
    const vertexLerp = /\blerp_\s*\(/.test(pruned.src)
        ? pruned.kept.has('lerp_')
            ? LERP_PROMOTIONS
            : LERP_FALLBACK + LERP_PROMOTIONS
        : '';
    const glsl = VERTEX_PRELUDE + vertexLerp + varyings + '\n' + pruned.src.trim() + '\n' + vertexMain;

    const fragmentMain = `
${varyings}
void main()
{
    ${pixStruct} vsIn;
${outFields
    .filter((f) => f.name !== 'location')
    .map((f) => `    vsIn.${f.name} = vOut_${f.name};`)
    .join('\n')}
    gl_FragColor = pix(vsIn);
}
`;
    const usesDerivatives = /\bdFdx\b|\bdFdy\b|\bfwidth\b/.test(fragmentBody);
    const extension = usesDerivatives ? '#extension GL_OES_standard_derivatives : enable\n' : '';
    const fragment = extension + PRELUDE + lerpHelpers + '\n' + fragmentBody.trim() + '\n' + fragmentMain;
    return { glsl, fragment, kind };
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
    // Interpolation modifiers on struct fields (crew's `nointerpolation float2 animUV`) have no GLSL
    // ES 1.00 spelling and would corrupt the struct parse, so they are dropped.
    src = src.replace(/\b(?:nointerpolation|noperspective)\b/g, '');
    src = stripSemantics(src);
    src = translateTextures(src);
    src = translateTypes(src);
    src = translateCasts(src);
    src = translateCbuffers(src);
    src = globalsToUniforms(src);
    src = intDeclsToFloat(src);
    src = stripFloatSuffix(src);
    src = lowerModulo(src);
    src = intLiteralsToFloat(src);
    src = translateIntrinsics(src);
    src = lowerSincos(src);
    src = expandDefaultParams(src);
    src = src.replace(/\bPIX_OUTPUT\s+pix\s*\(/g, 'vec4 pix(');
    src = replaceWord(src, 'PIX_OUTPUT', 'vec4');
    // `input`, `output` and `half` are reserved for future use in GLSL ES 1.00. Rename the conventional
    // pixel-shader parameter and any identifier that collides with `half` so the translation compiles.
    src = replaceWord(src, 'input', 'vsIn');
    src = replaceWord(src, 'output', 'vsOut');
    src = replaceWord(src, 'half', 'half_');

    const structs = parseStructs(src);
    const pruned = pruneUnreachableFunctions(src, 'pix');
    if (!pruned.kept.has('pix')) return { ok: false, reason: 'pix function could not be isolated' };

    if (/\bTexture2D\b|\bSamplerState\b|\bPIX_OUTPUT\b|\.Sample\s*\(/.test(pruned.src)) {
        return { ok: false, reason: 'unsupported HLSL constructs remain after translation' };
    }

    // Screen-space derivatives (`ddx`/`ddy`/`fwidth`, now `dFdx`/`dFdy`/`fwidth`) are an extension in
    // WebGL1. The directive must precede every other statement, so it is prepended ahead of the prelude.
    const usesDerivatives = /\bdFdx\b|\bdFdy\b|\bfwidth\b/.test(pruned.src);
    const extension = usesDerivatives ? '#extension GL_OES_standard_derivatives : enable\n' : '';
    // A shader calling `lerp` gets the promotion overloads GLSL lacks; one that never included
    // `base.shader` (whose overloads survive pruning when called) also needs the plain set.
    const callsLerp = /\blerp_\s*\(/.test(pruned.src);
    const definesLerp = pruned.kept.has('lerp_');
    const lerpHelpers = callsLerp ? (definesLerp ? LERP_PROMOTIONS : LERP_FALLBACK + LERP_PROMOTIONS) : '';
    const glsl =
        extension + PRELUDE + lerpHelpers + '\n' + pruned.src.trim() + '\n' + buildMain(pixStruct, structs);
    const vertex = buildVertexStage(src, pixStruct, structs, pruned.src, lerpHelpers);
    return { ok: true, glsl, vertex };
};
