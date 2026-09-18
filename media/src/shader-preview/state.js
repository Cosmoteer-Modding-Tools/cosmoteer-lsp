// Everything the page changes while it runs, gathered into one object. An ES module cannot write to
// a binding it imported, so the linked program, the loaded textures, the payload's particle and beam
// inputs and the animation clock live as properties here and every reader and writer goes through
// `state`.

import { BLEND_MODES } from './constants.js';

export const state = {
    /** @type {WebGLProgram} */
    program: null,
    usingFallback: false,
    // True when the linked program samples an engine screen target with no material-bound image, so
    // the scene stand-in pass must render before the main draw.
    needsScene: false,
    // The shader's own translated vertex stage ({glsl, fragment, kind}) and whether the linked
    // program runs it, so the world-to-clip _transform can be fitted to the stage's input family.
    /** @type {any} */
    vertexStage: null,
    usingVertexStage: false,
    // The GLSL error of the last failed compile or link, surfaced in the status line so a translation
    // that WebGL rejects is diagnosable rather than a silent fallback.
    /** @type {string} */
    lastGlError: null,
    // Loaded textures keyed by the sampler uniform they feed ('_texture' plus any texture constants).
    /** @type {Record<string, WebGLTexture>} */
    textures: {},
    /** @type {WebGLTexture} */
    dummyTexture: null,
    /** @type {WebGLTexture} */
    transparentTexture: null,
    // Typed stand-ins for the engine-fed render targets and normal-map atlases (see fallbackTexture).
    /** @type {WebGLTexture} */
    flatNormalTarget: null,
    /** @type {WebGLTexture} */
    flatNormalAtlas: null,
    /** @type {WebGLTexture} */
    transparentBlack: null,
    // The offscreen scene pass standing in for the engine's diffuse target and captured backbuffer:
    // the plain textured material rendered at the same quad transform, so lighting and distortion
    // shaders sample something aligned with what they light or displace.
    /** @type {{fbo: WebGLFramebuffer, texture: WebGLTexture}} */
    sceneTarget: null,
    /** @type {WebGLProgram} */
    sceneProgram: null,
    /**
     * The constant values fed to the program, keyed by uniform name.
     *
     * @type {Record<string, any>}
     */
    values: {},
    // The material colour (_color in the game), multiplied with the per-vertex colour in the engine's
    // vertex stage. The preview folds both into the vColor varying.
    materialTint: [1, 1, 1, 1],
    // The manual per-vertex colour, used when the ramp animation is off or there is no ramp.
    vertexColor: [1, 1, 1, 1],
    animateVertex: false,
    // The particle system's colour-over-lifetime ramp ({lifetime, invert, colors}) when the material
    // sits inside a particle def, replayed exactly the way the game's ColorRamp updater computes it.
    /** @type {any} */
    particleRamp: null,
    // The particle's lifetime in seconds, the clock for both the ramp and the sprite-sheet cycle.
    particleLifetime: 1,
    // The particle system's sprite sheet ({textureSize, spriteSize, count, perRow, offset, animated});
    // the preview shows one cell, cycling through them over the lifetime when animated.
    /** @type {any} */
    spriteSheet: null,
    sheetCell: 0,
    cycleCells: false,
    // The beam vertex-stage stand-ins the translated shader reads as uPv… uniforms.
    beamIntensity: 1,
    beamFade: 1,
    beamLength: 1,
    // The quad aspect from the material's written Size (world units), preferred over texture shape.
    /** @type {number} */
    sizeAspect: null,
    emissive: 0,
    // The blend factors the material draws with (an engine mode name sextuple, see BLEND_MODES). The
    // toolbar can override the material's resolved mode.
    /** @type {string[]} */
    materialBlend: BLEND_MODES.AlphaBlend,
    /** @type {string} */
    blendOverride: null,
    // The aspect ratio (width / height) of the base texture, so a non-square sprite is letterboxed
    // into the square canvas instead of being stretched.
    textureAspect: 1,
    paused: false,
    startTime: Date.now(),
    // Wall-clock milliseconds the preview has spent paused, subtracted from the animation clock so a
    // pause freezes time and a resume continues from where it stopped rather than jumping forward.
    pausedAccum: 0,
    pauseStartedAt: 0,
    // Which clock constants currently follow the replay (per payload; control checkboxes flip these).
    /** @type {Record<string, boolean>} */
    clockAuto: {},
};
