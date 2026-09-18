// The engine's blend modes mapped onto the GL state: one factor name at a time, one operator at a
// time, and the pair of calls that puts the active mode into effect.

import { BLEND_MODES } from './constants.js';
import { gl, isGL2, minmax } from './gl-context.js';
import { state } from './state.js';

/**
 * Maps an engine blend factor name to its GL constant.
 *
 * @param name the engine's factor name.
 * @returns the GL factor.
 */
export function glFactor(name) {
    switch (name) {
        case 'Zero':
            return gl.ZERO;
        case 'One':
            return gl.ONE;
        case 'SourceColor':
            return gl.SRC_COLOR;
        case 'InverseSourceColor':
            return gl.ONE_MINUS_SRC_COLOR;
        case 'SourceAlpha':
            return gl.SRC_ALPHA;
        case 'InverseSourceAlpha':
            return gl.ONE_MINUS_SRC_ALPHA;
        case 'DestColor':
            return gl.DST_COLOR;
        case 'InverseDestColor':
            return gl.ONE_MINUS_DST_COLOR;
        case 'DestAlpha':
            return gl.DST_ALPHA;
        case 'InverseDestAlpha':
            return gl.ONE_MINUS_DST_ALPHA;
        default:
            return gl.ONE;
    }
}

/**
 * Maps an engine blend operator to a GL equation. The engine's SubtractSourceFromDest computes
 * dest − src (the GL reverse subtract) and SubtractDestFromSource computes src − dst. Min and Max
 * need EXT_blend_minmax and fall back to Add when the extension is unavailable.
 *
 * @param name the engine's operator name.
 * @returns the GL blend equation.
 */
export function glOperator(name) {
    switch (name) {
        case 'SubtractSourceFromDest':
            return gl.FUNC_REVERSE_SUBTRACT;
        case 'SubtractDestFromSource':
            return gl.FUNC_SUBTRACT;
        case 'Min':
            return isGL2 ? gl.MIN : minmax ? minmax.MIN_EXT : gl.FUNC_ADD;
        case 'Max':
            return isGL2 ? gl.MAX : minmax ? minmax.MAX_EXT : gl.FUNC_ADD;
        default:
            return gl.FUNC_ADD;
    }
}

/**
 * The active blend factor sextuple: the toolbar override when set, else the material's.
 *
 * @returns the factor and operator names.
 */
export function activeBlend() {
    return state.blendOverride ? BLEND_MODES[state.blendOverride] : state.materialBlend;
}

/** Applies the active blend factors with separate colour and alpha channels, like the engine. */
export function setBlend() {
    const spec = activeBlend();
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(glFactor(spec[0]), glFactor(spec[1]), glFactor(spec[3]), glFactor(spec[4]));
    gl.blendEquationSeparate(glOperator(spec[2]), glOperator(spec[5]));
}
