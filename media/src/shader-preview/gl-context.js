// The page's handles on its own document, its WebGL context and the host bridge. They are filled in
// by initDom, which only the webview half of the page calls, so importing this module creates no
// context and reaches for no element.

const contextOptions = { premultipliedAlpha: false, alpha: true };

/** @type {HTMLCanvasElement} */
export let canvas;
/** @type {HTMLElement} */
export let statusEl;
/** @type {HTMLElement} */
export let metaEl;
/** @type {HTMLElement} */
export let controlsEl;
// Typed as the second version throughout: the handful of places that reach for a constant only
// the second version has ask `isGL2` first, which no type can narrow on.
/** @type {WebGL2RenderingContext} */
export let gl;
export let isGL2 = false;
/** @type {EXT_blend_minmax} */
export let minmax = null;
/** @type {CosmoteerWebviewApi} */
export let vscode;

/**
 * Acquires the host bridge, looks up the elements the page draws into, and creates the context.
 *
 * WebGL2 is preferred: it lifts the power-of-two texture limits, has Min/Max blending in core, and
 * its GLSL ES 3.00 gives real textureLod/textureSize for the decal LOD math. The translated sources
 * stay ES 1.00 and are upgraded textually in link(); WebGL1 remains the fallback.
 */
export function initDom() {
    vscode = acquireVsCodeApi();
    canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('gl'));
    statusEl = document.getElementById('status');
    metaEl = document.getElementById('meta');
    controlsEl = document.getElementById('controls');
    const gl2 = /** @type {WebGL2RenderingContext | null} */ (canvas.getContext('webgl2', contextOptions));
    gl = /** @type {WebGL2RenderingContext} */ (gl2 || canvas.getContext('webgl', contextOptions));
    isGL2 = !!gl2;
    // Enable screen-space derivatives (dFdx/dFdy/fwidth) so a translated shader that declares
    // `#extension GL_OES_standard_derivatives` (decals and the distortion shaders) links and runs.
    // Core in WebGL2, an extension in WebGL1.
    if (gl && !isGL2) gl.getExtension('OES_standard_derivatives');
    // Min/Max blend equations are an extension in WebGL1, used by the engine's Min/Max blend modes.
    minmax = gl && !isGL2 ? gl.getExtension('EXT_blend_minmax') : null;
}
