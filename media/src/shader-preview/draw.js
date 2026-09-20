// The frame: the offscreen scene stand-in pass the engine-fed screen targets sample, the main draw
// of the material quad, and the animation loop that keeps both running.

import { setBlend } from './blend.js';
import { effectiveVertexColor, sheetUvRect } from './clock.js';
import { canvas, gl } from './gl-context.js';
import { state } from './state.js';
import { applyUniforms, quadScale } from './uniforms.js';

/**
 * Renders the scene stand-in the engine-fed screen targets sample: the plain textured material
 * over a dark space tone, drawn at the same quad transform as the main pass so screen-UV lookups
 * (`_diffuseTarget`, `_capturedBackBuffer`) land on the sprite they light or distort.
 */
export function drawScenePass() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.sceneTarget.fbo);
    gl.viewport(0, 0, canvas.width || 512, canvas.height || 512);
    gl.clearColor(0.02, 0.02, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(state.sceneProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.textures._texture || state.dummyTexture);
    gl.uniform1i(gl.getUniformLocation(state.sceneProgram, '_texture'), 0);
    gl.uniform1f(gl.getUniformLocation(state.sceneProgram, 'uEmissive'), state.emissive);
    gl.uniform4fv(gl.getUniformLocation(state.sceneProgram, 'uTint'), effectiveVertexColor());
    const s = quadScale();
    gl.uniform2f(gl.getUniformLocation(state.sceneProgram, 'uQuadScale'), s[0], s[1]);
    gl.uniform4fv(gl.getUniformLocation(state.sceneProgram, 'uUvRect'), sheetUvRect());
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/** Draws one frame: the material quad composed over the stage backdrop with its blend mode. */
export function draw() {
    if (!state.program) return;
    if (state.needsScene && state.sceneTarget && state.sceneProgram) drawScenePass();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    setBlend();
    gl.useProgram(state.program);
    applyUniforms();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/** Draws a frame and asks for the next one. */
export function loop() {
    draw();
    requestAnimationFrame(loop);
}
