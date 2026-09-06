/**
 * What the shader scanner reads out of a `.shader` file: the file-scope uniforms with their kinds and
 * positions, the functions and their signatures, and the scope of the function a cursor sits in. The
 * scanner itself lives in `shader-parser.ts`.
 */

/** The kind of a parsed uniform, mapped from its HLSL declaration type. */
export type ShaderConstantKind = 'texture' | 'sampler' | 'float' | 'vec2' | 'vec3' | 'vec4' | 'matrix' | 'int' | 'bool';

/** The source position of a declared name, so navigation can jump to it (0-based line and column). */
export interface DeclarationPosition {
    /** The 0-based line the name appears on. */
    readonly line: number;
    /** The 0-based column of the name's first character. */
    readonly column: number;
}

/** A `_`-prefixed uniform declared at file scope in a shader. */
export interface ShaderConstant {
    /** The constant name including its leading underscore, e.g. `_hotColor`. */
    readonly name: string;
    /** The normalized kind derived from the HLSL declaration type. */
    readonly kind: ShaderConstantKind;
    /** The raw HLSL type token as written, e.g. `float3` or `Texture2D`. */
    readonly hlslType: string;
    /** The literal default value text if the declaration has an initializer, else undefined. */
    readonly default?: string;
    /** Where the name is declared in this file, for go-to-definition and the outline. */
    readonly position?: DeclarationPosition;
}

/** A function defined at file scope, with the position of its name for navigation. */
export interface ShaderFunction {
    /** The function name, e.g. `pix` or `vert`. */
    readonly name: string;
    /** Where the name appears in this file. */
    readonly position: DeclarationPosition;
}

/** Everything the scanner pulls out of a single shader file, before includes are followed. */
export interface ParsedShader {
    /** The literal paths of every `#include "…"` directive, in source order. */
    readonly includes: readonly string[];
    /** The `_`-prefixed uniforms declared at file scope in this file alone. */
    readonly constants: readonly ShaderConstant[];
    /** The function names defined at file scope (entry-point candidates such as `vert`/`pix`). */
    readonly functions: readonly string[];
    /** The file-scope functions with the source position of each name, for navigation and the outline. */
    readonly functionDecls: readonly ShaderFunction[];
}

/** One parameter of a shader function, with its HLSL type and name. */
export interface ShaderParam {
    /** The parameter's HLSL type token, e.g. `float2`. */
    readonly type: string;
    /** The parameter name. */
    readonly name: string;
    /** True when the parameter declares a default value (`float limit = 1.0`), so a call may omit it. */
    readonly optional?: boolean;
}

/** A file-scope function's full signature: return type, name, and typed parameter list. */
export interface ShaderFunctionSignature {
    /** The function name. */
    readonly name: string;
    /** The declared return type token, e.g. `float4` or `void`. */
    readonly returnType: string;
    /** The parameters in order (empty for a `()` or `(void)` list). */
    readonly params: readonly ShaderParam[];
}

/** The parameters and body-so-far of the function enclosing a cursor offset. */
export interface FunctionScope {
    /** The enclosing function's parameters, in order. */
    readonly params: readonly ShaderParam[];
    /** The body text from the opening brace up to the cursor, for scanning locals already in scope. */
    readonly bodyBeforeOffset: string;
}
