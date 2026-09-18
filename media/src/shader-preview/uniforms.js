// What the preview feeds the linked program each frame: the builtin values the engine would supply,
// the quad's shape, the world-to-clip matrix standing in for the engine's own, and the walk over
// every active uniform that binds them.

import { CLOCK_REPLAY } from './constants.js';
import { canvas, gl } from './gl-context.js';
import { effectiveVertexColor, elapsedMs, sheetUvRect } from './clock.js';
import { fallbackTexture } from './program.js';
import { state } from './state.js';

/**
 * The builtin uniform values the engine supplies each frame. The lighting values mirror vanilla's
 * `base_bg.rules` global lights, and the light normal is the engine's default light direction
 * (normalize(-1, -1) at the standard light height).
 *
 * @returns the builtin values, keyed by uniform name.
 */
export function builtins() {
    const t = elapsedMs() / 1000;
    return {
        _time: t,
        _gameTime: t,
        _screenSize: [canvas.width, canvas.height],
        _viewportScale: [1, 1],
        _color: [1, 1, 1, 1],
        _baseSize: [1, 1],
        _innerRadius: 0,
        _thickness: 0.1,
        _mode: 0,
        _nrmlStrengthLimit: 1,
        _globalAmbientLight: [0.45, 0.45, 0.45],
        _globalDiffuseLight: [1, 1, 1],
        _globalMinDiffuseLight: [0, 0, 0],
        _globalSpecularLight: [1, 1, 1],
        _lightNormal: [-0.67, -0.67, 0.33],
    };
}

/**
 * The x/y scale fitting the quad to the material's world shape inside the square canvas: the
 * written Size, else the sprite-sheet cell shape, else the texture shape.
 *
 * @returns the x and y scale.
 */
export function quadScale() {
    const sheet = state.spriteSheet ? state.spriteSheet.spriteSize[0] / state.spriteSheet.spriteSize[1] : null;
    const aspect = state.sizeAspect || sheet || state.textureAspect;
    return aspect >= 1 ? [1, 1 / aspect] : [aspect, 1];
}

/**
 * The world-to-clip matrix standing in for the engine's `_transform` when the shader's own
 * vertex stage runs. Each input family is synthesized at a different world span (a sprite's
 * location at ±50 units, a particle quad at ±_baseSize/2, a beam laid out over its length), so
 * the scale maps that span back to the canvas, with the quad aspect folded in.
 *
 * @returns the matrix, in column-major order.
 */
export function transformMatrix() {
    const s = quadScale();
    let k = 1 / 50;
    if (state.usingVertexStage && state.vertexStage && state.vertexStage.kind === 'particle') {
        const bs = state.values._baseSize && state.values._baseSize[0] > 0 ? state.values._baseSize[0] : 1;
        k = 2 / Math.max(bs, 0.01);
    } else if (state.usingVertexStage && state.vertexStage && state.vertexStage.kind === 'beam') {
        k = 1.8 / Math.max(state.beamLength, 0.01);
    } else if (state.usingVertexStage && state.vertexStage && state.vertexStage.kind === 'crew') {
        // The crew quad's corner offsets span ±0.5 world units; fill most of the canvas.
        k = 1.8;
    }
    return [s[0] * k, 0, 0, 0, 0, s[1] * k, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Sets every active uniform of the current program from the builtin and constant value maps. */
export function applyUniforms() {
    const merged = Object.assign(builtins(), state.values);
    const count = gl.getProgramParameter(state.program, gl.ACTIVE_UNIFORMS);
    let textureUnit = 0;
    for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(state.program, i);
        const name = info.name.replace(/\[0\]$/, '');
        const location = gl.getUniformLocation(state.program, name);
        if (!location) continue;
        if (info.type === gl.SAMPLER_2D) {
            const unit = textureUnit++;
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, state.textures[name] || fallbackTexture(name));
            gl.uniform1i(location, unit);
            continue;
        }
        if (name === 'uTint') {
            gl.uniform4fv(location, effectiveVertexColor());
            continue;
        }
        if (name === 'uQuadScale') {
            const s = quadScale();
            gl.uniform2f(location, s[0], s[1]);
            continue;
        }
        // The engine's world-to-clip matrix; the preview supplies a fitted diagonal (see
        // transformMatrix). Any other matrix uniform has no sensible stand-in and stays identity.
        if (info.type === gl.FLOAT_MAT4) {
            gl.uniformMatrix4fv(
                location,
                false,
                name === '_transform' ? transformMatrix() : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
            );
            continue;
        }
        if (name === 'uUvRect') {
            gl.uniform4fv(location, sheetUvRect());
            continue;
        }
        if (name === 'uPvBeamTime') {
            gl.uniform1f(location, elapsedMs() / 1000);
            continue;
        }
        if (name === 'uPvIntensity') {
            gl.uniform1f(location, state.beamIntensity);
            continue;
        }
        if (name === 'uPvFadeAlpha') {
            gl.uniform1f(location, state.beamFade);
            continue;
        }
        if (name === 'uPvBeamLength') {
            gl.uniform1f(location, state.beamLength);
            continue;
        }
        if (name === 'uEmissive') {
            gl.uniform1f(location, state.emissive);
            continue;
        }
        // Engine clocks follow the replay unless the control's auto toggle is off.
        if (CLOCK_REPLAY[name] && state.clockAuto[name] !== false) {
            gl.uniform1f(location, CLOCK_REPLAY[name](elapsedMs() / 1000));
            continue;
        }
        const value = merged[name];
        if (value == null) continue;
        const v = Array.isArray(value) ? value : [value];
        if (info.type === gl.FLOAT) gl.uniform1f(location, v[0]);
        else if (info.type === gl.FLOAT_VEC2) gl.uniform2f(location, v[0], v[1] ?? 0);
        else if (info.type === gl.FLOAT_VEC3) gl.uniform3f(location, v[0], v[1] ?? 0, v[2] ?? 0);
        else if (info.type === gl.FLOAT_VEC4) gl.uniform4f(location, v[0], v[1] ?? 0, v[2] ?? 0, v[3] ?? 1);
        else if (info.type === gl.INT) gl.uniform1i(location, Math.round(v[0]));
    }
}
