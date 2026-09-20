// The GL objects the page builds: compiling and linking the translated shader, the solid stand-in
// textures, the offscreen scene target, and loading a real image with the sampler state the game
// would have created for it.

import { VERTEX_SRC } from './constants.js';
import { canvas, gl, isGL2 } from './gl-context.js';
import { state } from './state.js';

/**
 * Upgrades a translated GLSL ES 1.00 source to ES 3.00 for a WebGL2 context. The rewrite is
 * mechanical: version header, in/out qualifiers, the texture call rename, a declared fragment
 * output in place of gl_FragColor, and the real textureLod/textureSize bodies swapped into the
 * pvTexLod/pvTexSize helpers whose ES 1.00 fallback bodies the server emits (the exact body
 * strings are a contract with hlsl-to-glsl.ts).
 *
 * @param source the translated ES 1.00 source.
 * @param isVertex whether the source is the vertex stage.
 * @returns the ES 3.00 source.
 */
export function upgradeToEs3(source, isVertex) {
    let src = source.replace(/#extension GL_OES_standard_derivatives : enable\n?/g, '');
    src = src.replace('{ return texture2D(t, uv); }', '{ return textureLod(t, uv, lod); }');
    src = src.replace('{ return vec2(256.0, 256.0); }', '{ return vec2(textureSize(t, 0)); }');
    if (isVertex) {
        src = src.replace(/\battribute\b/g, 'in').replace(/\bvarying\b/g, 'out');
    } else {
        src = src.replace(/\bvarying\b/g, 'in');
        src = src.replace(/\bgl_FragColor\b/g, 'pvFragColor');
        src = src.replace('precision highp float;', 'precision highp float;\nout highp vec4 pvFragColor;');
    }
    src = src.replace(/\btexture2D\s*\(/g, 'texture(');
    return '#version 300 es\n' + src;
}

/**
 * Compiles a shader, returning it or null, recording and logging the GLSL error.
 *
 * @param type the shader stage.
 * @param source the GLSL source.
 * @returns the shader, or null when it did not compile.
 */
export function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, isGL2 ? upgradeToEs3(source, type === gl.VERTEX_SHADER) : source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        state.lastGlError = String(gl.getShaderInfoLog(shader) || 'unknown compile error').trim();
        console.warn('shader compile failed:', state.lastGlError);
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

/**
 * Links a vertex/fragment pair into a program, or null on failure.
 *
 * @param fragmentSrc the fragment source.
 * @param vertexSrc the vertex source, or nothing for the fixed full-quad stage.
 * @returns the program, or null when it did not link.
 */
export function link(fragmentSrc, vertexSrc) {
    const vert = compile(gl.VERTEX_SHADER, vertexSrc || VERTEX_SRC);
    const frag = compile(gl.FRAGMENT_SHADER, fragmentSrc);
    if (!vert || !frag) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aUv');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        state.lastGlError = String(gl.getProgramInfoLog(prog) || 'unknown link error').trim();
        console.warn('program link failed:', state.lastGlError);
        return null;
    }
    return prog;
}

/**
 * A 1×1 texture of the given RGBA bytes, bound for samplers the preview has no real image for.
 *
 * @param r the red byte.
 * @param g the green byte.
 * @param b the blue byte.
 * @param a the alpha byte.
 * @returns the texture.
 */
export function makeSolid(r, g, b, a) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
    return tex;
}

/**
 * A canvas-sized render target for the scene stand-in pass, or null when incomplete.
 *
 * @returns the framebuffer and its texture, or null.
 */
export function createSceneTarget() {
    const width = canvas.width || 512;
    const height = canvas.height || 512;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return complete ? { fbo, texture } : null;
}

/**
 * The stand-in for a sampler with no loaded image, typed by what the engine binds to that name.
 * Most unset samplers get opaque white (a neutral multiplier), with these exceptions:
 * - the fog-of-war texture must read fully explored (its alpha marks the unexplored fraction and
 *   the nebula shaders `discard` where `1 - a` reaches zero),
 * - the screen-space normals target gets a flat +Z normal colour; the engine treats pure white as
 *   "no normals" and the additive-lighting math would multiply the light to black,
 * - the normal-map atlases get the neutral normal encoding their channel layout expects
 *   (`loadRawNormals` reads x from alpha and y from green; the ZA page's neutral IS white),
 * - the ship stencil target reads empty (nothing occludes), so stencil-gated pixels stay visible,
 * - the diffuse target and the captured backbuffer sample the live scene stand-in pass.
 *
 * @param name the sampler uniform's name.
 * @returns the texture to bind to it.
 */
export function fallbackTexture(name) {
    if (/unexplored/i.test(name)) return state.transparentTexture;
    if (name === '_normalsTarget') return state.flatNormalTarget;
    if (name === '_normalsXYTexture' || name === '_normalsTexture') return state.flatNormalAtlas;
    if (name === '_stencilTarget') return state.transparentBlack;
    if (name === '_diffuseTarget' || name === '_capturedBackBuffer' || name === '_ftlBackground') {
        return state.sceneTarget ? state.sceneTarget.texture : state.dummyTexture;
    }
    return state.dummyTexture;
}

/**
 * Loads an image URL into a texture with the sampler state the game would create: Point or Linear
 * filtering, Clamp or Wrap addressing, and a mip chain when the rules declare one. WebGL1 restricts
 * repeat wrapping and mipmaps to power-of-two images, so those fall back gracefully for the rest.
 * Resolves to {texture, aspect} with the dummy texture on any failure.
 *
 * @param url the image's URL.
 * @param sampler the sampler state the rules declare.
 * @returns a promise of the texture and the image's aspect ratio.
 */
export function loadTexture(url, sampler) {
    return new Promise((resolve) => {
        if (!url) return resolve({ texture: state.dummyTexture, aspect: 1 });
        const image = new Image();
        image.onload = () => {
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            // No flip on upload: the quad's UVs are already top-origin (v = 0 at the top, the
            // game's D3D convention), so an unflipped upload samples exactly like the engine. The
            // previous flip cancelled against the quad UVs into a vertically mirrored render.
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            // WebGL2 lifts the power-of-two restriction on repeat wrapping and mipmaps.
            const pot = isGL2 || ((image.width & (image.width - 1)) === 0 && (image.height & (image.height - 1)) === 0);
            const point = sampler && sampler.sampleMode === 'Point';
            const mips = !!(sampler && sampler.mips) && pot;
            if (mips) {
                gl.generateMipmap(gl.TEXTURE_2D);
                // A numeric `MipLevels = N` builds exactly N levels in the engine; WebGL2 can cap
                // the sampled chain to match (WebGL1 always samples the full generated chain).
                if (isGL2 && sampler.mipCount) {
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, sampler.mipCount - 1);
                }
            }
            // The engine's mip filter is linear even in Point mode (MinMagPointMipLinear).
            const minFilter = mips
                ? point
                    ? gl.NEAREST_MIPMAP_LINEAR
                    : gl.LINEAR_MIPMAP_LINEAR
                : point
                  ? gl.NEAREST
                  : gl.LINEAR;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, point ? gl.NEAREST : gl.LINEAR);
            const wrap = (mode) => (mode === 'Wrap' && pot ? gl.REPEAT : gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(sampler && sampler.uMode));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(sampler && sampler.vMode));
            const aspect = image.width > 0 && image.height > 0 ? image.width / image.height : 1;
            resolve({ texture: tex, aspect });
        };
        image.onerror = () => resolve({ texture: state.dummyTexture, aspect: 1 });
        image.src = url;
    });
}
