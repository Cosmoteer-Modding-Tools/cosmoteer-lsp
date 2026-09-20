// Applying a freshly received payload: resetting the page state to what the material says, creating
// the stand-in textures, loading the real ones, picking the program to run, rebuilding the controls,
// and writing the status and metadata lines.

import { t } from '../shared/strings.js';
import { activeBlend } from './blend.js';
import {
    buildBeamControl,
    buildControl,
    buildSheetControl,
    buildToolbar,
    buildVertexColorControl,
} from './controls.js';
import { BLEND_MODES, FALLBACK_SRC } from './constants.js';
import { controlsEl, gl, isGL2, metaEl, statusEl, vscode } from './gl-context.js';
import { createSceneTarget, link, loadTexture, makeSolid } from './program.js';
import { state } from './state.js';
import { normalizeColorFallback, parseValue } from './values.js';

/**
 * Resets the page state to what the payload's material says: its blend mode, its particle ramp and
 * sprite sheet, the beam inputs, the quad shape, the tint the vertex colour starts from, and the
 * emissive boost the fallback render needs.
 *
 * @param data the payload's material.
 */
function resetForPayload(data) {
    state.values = {};
    state.clockAuto = {};
    state.startTime = Date.now();
    state.pausedAccum = 0;
    state.paused = false;
    state.textureAspect = 1;
    state.materialBlend = data.blend
        ? [
              data.blend.srcRgb,
              data.blend.dstRgb,
              data.blend.rgbOp,
              data.blend.srcAlpha,
              data.blend.dstAlpha,
              data.blend.alphaOp,
          ]
        : BLEND_MODES.AlphaBlend;
    state.blendOverride = null;
    state.particleRamp = data.particleColor;
    state.particleLifetime = data.particleLifetime || (state.particleRamp && state.particleRamp.lifetime) || 2;
    state.spriteSheet = data.spriteSheet;
    state.sheetCell = 0;
    state.cycleCells = !!(state.spriteSheet && state.spriteSheet.animated);
    state.beamIntensity = 1;
    state.beamFade = 1;
    state.beamLength = 1;
    // The material's world size decides the quad shape (the game stretches the sprite to it); the
    // written value may contain math, which parseValue evaluates.
    const sizeNumbers = parseValue(data.size);
    state.sizeAspect =
        sizeNumbers && sizeNumbers.length >= 2 && sizeNumbers[0] > 0 && sizeNumbers[1] > 0
            ? sizeNumbers[0] / sizeNumbers[1]
            : null;
    if (data.baseSize && data.baseSize.length === 2) state.values._baseSize = data.baseSize.slice();

    // The material colour (the server normalizes it with the game's parse rules; the text parse is
    // the fallback for math or references). The engine multiplies it with the per-vertex colour in
    // the vertex stage, so the preview folds it into vColor.
    const parsedTint = data.tintComponents || normalizeColorFallback(parseValue(data.tint), true);
    state.materialTint = parsedTint ? parsedTint.concat([1, 1, 1, 1]).slice(0, 4) : [1, 1, 1, 1];
    // With a ramp the animation drives the vertex colour; without one a particle sweeps its red
    // channel (many particle shaders read it as the animation arc) and a sprite holds the tint.
    state.animateVertex = !!data.isParticle && (!!state.particleRamp || !parsedTint);
    state.vertexColor = state.particleRamp
        ? state.materialTint
        : parsedTint
          ? state.materialTint
          : data.isParticle
            ? [0.5, 1, 1, 1]
            : [1, 1, 1, 1];

    // Emissive boost for the fallback path, from any additive/emissive constant the material sets.
    state.emissive = 0;
    for (const c of data.constants) {
        if (/emissive|additivestrength/i.test(c.name)) {
            const n = (c.components && c.components.length ? c.components : null) || parseValue(c.value);
            if (n) state.emissive = Math.max(state.emissive, n[0]);
        }
    }
}

/** Creates the solid stand-in textures, the scene target and the scene program, once per page. */
function ensureStandIns() {
    state.dummyTexture = state.dummyTexture || makeSolid(255, 255, 255, 255);
    state.transparentTexture = state.transparentTexture || makeSolid(255, 255, 255, 0);
    // Flat +Z normal in the screen-target encoding (normalsToColor of (0, 0, 1)) and in the
    // inferred-atlas encoding (x in alpha, y in green, both centred); empty stencil coverage.
    state.flatNormalTarget = state.flatNormalTarget || makeSolid(127, 127, 255, 255);
    state.flatNormalAtlas = state.flatNormalAtlas || makeSolid(127, 127, 127, 127);
    state.transparentBlack = state.transparentBlack || makeSolid(0, 0, 0, 0);
    state.sceneTarget = state.sceneTarget || createSceneTarget();
    state.sceneProgram = state.sceneProgram || link(FALLBACK_SRC);
}

/**
 * Loads every bound texture with its sampler state; the base '_texture' also sets the aspect.
 *
 * @param data the payload's material.
 * @param textureData the image URL of each bound texture, keyed by its sampler name.
 */
async function loadTextures(data, textureData) {
    state.textures = {};
    for (const entry of data.textures || []) {
        const loaded = await loadTexture(textureData[entry.name], entry.sampler);
        state.textures[entry.name] = loaded.texture;
        if (entry.name === '_texture') state.textureAspect = loaded.aspect;
    }
}

/**
 * Links the program to run and works out whether the scene stand-in pass is needed.
 *
 * The shader's own vertex stage is preferred; when it will not compile, the fixed-quad fragment
 * translation runs, and only then the plain textured render.
 *
 * @param data the payload's material.
 * @returns {{vertexStageError: string, glslError: string}} the GLSL errors behind each downgrade.
 */
function selectProgram(data) {
    state.lastGlError = null;
    state.vertexStage = data.translationOk ? data.vertexStage : null;
    state.program = state.vertexStage ? link(state.vertexStage.fragment, state.vertexStage.glsl) : null;
    state.usingVertexStage = !!state.program;
    // A vertex stage that will not compile is a silent downgrade: the render still looks live but
    // runs the stand-in varyings, so the reason is kept and shown beside the status.
    const vertexStageError = state.vertexStage && !state.program ? state.lastGlError : null;
    if (!state.program && data.translationOk && data.glsl) state.program = link(data.glsl);
    state.usingFallback = !state.program;
    const glslError = state.lastGlError;
    if (!state.program) state.program = link(FALLBACK_SRC);

    // The scene stand-in pass runs only when the program samples an engine screen target the
    // material did not bind an image for (the lighting and backbuffer-distortion shaders).
    state.needsScene = false;
    if (state.program) {
        const uniformCount = gl.getProgramParameter(state.program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < uniformCount; i++) {
            const name = gl.getActiveUniform(state.program, i).name.replace(/\[0\]$/, '');
            const isSceneTarget =
                name === '_diffuseTarget' || name === '_capturedBackBuffer' || name === '_ftlBackground';
            if (isSceneTarget && !state.textures[name]) state.needsScene = true;
        }
    }
    return { vertexStageError, glslError };
}

/**
 * Rebuilds the control column: the stage toolbar (backdrop, blend, pause), the vertex-colour control
 * (a particle's animation input), the beam and sprite-sheet controls when they apply, then one
 * control per constant. An additive material starts over the dark backdrop, the way it composes over
 * space in-game.
 *
 * @param data the payload's material.
 */
function buildControls(data) {
    const spec = activeBlend();
    const additive = spec[1] === 'One' && spec[2] === 'Add';
    controlsEl.innerHTML = '';
    controlsEl.appendChild(buildToolbar(additive ? 'dark' : 'checker'));
    controlsEl.appendChild(buildVertexColorControl(data.isParticle));
    if (data.isBeam) controlsEl.appendChild(buildBeamControl());
    if (state.spriteSheet) controlsEl.appendChild(buildSheetControl());
    for (const constant of data.constants) controlsEl.appendChild(buildControl(constant));
}

/**
 * Writes the status line and the metadata block. A rejected translation shows the first GLSL error
 * line so the failure is diagnosable from the panel instead of only from the webview console.
 *
 * @param data the payload's material.
 * @param errors the GLSL errors behind each downgrade.
 */
function showStatus(data, errors) {
    const failure = data.translationOk
        ? errors.glslError
            ? t('shader compile failed: {0}', errors.glslError.split('\n')[0].slice(0, 160))
            : t('shader compile failed')
        : data.reason || t('shader not translatable');
    const note = state.usingFallback
        ? t('Approximate render ({0}). Texture, tint and blend shown.', failure)
        : t('Live translated shader.');
    const blendLabel = data.blend && data.blend.label !== 'AlphaBlend' ? data.blend.label : null;
    const tags = [
        state.usingVertexStage ? t('vertex stage ({0})', state.vertexStage.kind) : null,
        errors.vertexStageError
            ? t(
                  'vertex stage ({0})',
                  t('shader compile failed: {0}', errors.vertexStageError.split('\n')[0].slice(0, 160))
              )
            : null,
        blendLabel,
        state.particleRamp
            ? t('particle: color ramp animated')
            : data.isParticle
              ? t('particle: vertex colour animated')
              : null,
        data.isBeam ? t('beam') : null,
        state.spriteSheet ? t('sprite sheet: {0} cells', state.spriteSheet.count) : null,
        state.needsScene ? t('scene stand-in') : null,
        isGL2 ? null : t('WebGL1 fallback'),
    ].filter(Boolean);
    statusEl.textContent = tags.length ? `${note} · ${tags.join(' · ')}` : note;
    metaEl.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'shadername';
    title.textContent = data.shaderName;
    if (data.shaderUri) {
        const open = document.createElement('button');
        open.textContent = t('Open .shader');
        open.onclick = () => vscode.postMessage({ type: 'openShader', uri: data.shaderUri });
        title.appendChild(open);
    }
    metaEl.appendChild(title);
}

/**
 * Applies a freshly received payload: compiles, loads the textures, and rebuilds the controls.
 *
 * @param message the payload, with the material and the image URL of each bound texture.
 */
export async function render(message) {
    const data = message.data;
    resetForPayload(data);
    ensureStandIns();
    await loadTextures(data, message.textureData || {});
    const errors = selectProgram(data);
    buildControls(data);
    showStatus(data, errors);
}
