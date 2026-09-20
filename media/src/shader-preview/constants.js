// Everything the shader page tunes: the quad it draws onto, the two stand-in shader sources, the
// engine's blend modes, the starting values for the constants the engine feeds at runtime, and the
// clocks the preview replays. They live here rather than beside their first use, so a value can be
// found and changed without reading the function that happens to read it first.

// The fixed full-quad geometry the fragment shader draws onto, replacing the game's vertex stage.
export const QUAD = new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]);

// uUvRect remaps the quad's UVs to one sprite-sheet cell (offset.xy, scale.zw); the full texture
// is [0, 0, 1, 1]. UVs are top-origin like the game's (D3D convention), see loadTexture.
export const VERTEX_SRC = `
attribute vec2 aPos;
attribute vec2 aUv;
varying vec2 vUv;
varying vec4 vColor;
uniform vec4 uTint;
uniform vec2 uQuadScale;
uniform vec4 uUvRect;
void main() {
    vUv = uUvRect.xy + aUv * uUvRect.zw;
    vColor = uTint;
    gl_Position = vec4(aPos * uQuadScale, 0.0, 1.0);
}`;

// The fallback fragment shader: texture times tint, with a configurable emissive boost so additive
// and emissive materials still read as bright. Used when the translated GLSL will not compile.
export const FALLBACK_SRC = `
precision highp float;
varying vec2 vUv;
varying vec4 vColor;
uniform sampler2D _texture;
uniform float uEmissive;
void main() {
    vec4 c = texture2D(_texture, vUv) * vColor;
    c.rgb *= (1.0 + uEmissive);
    if (c.a <= 0.0) discard;
    gl_FragColor = c;
}`;

// The engine's named blend modes (decompiled from Halfling.Graphics.TargetBlendMode), in the order
// srcRgb, dstRgb, rgbOp, srcAlpha, dstAlpha, alphaOp. AlphaBlend is the material default. The
// toolbar override offers these names, and the server resolves a material's TargetBlendMode to the
// same factor spelling.
export const BLEND_MODES = {
    AlphaBlend: ['SourceAlpha', 'InverseSourceAlpha', 'Add', 'InverseDestAlpha', 'One', 'Add'],
    AlphaBlendPreMultiplied: ['One', 'InverseSourceAlpha', 'Add', 'InverseDestAlpha', 'One', 'Add'],
    ReplaceNoBlend: ['One', 'Zero', 'Add', 'One', 'Zero', 'Add'],
    Add: ['One', 'One', 'Add', 'One', 'One', 'Add'],
    AddAlphaBlend: ['SourceAlpha', 'One', 'Add', 'One', 'One', 'Add'],
    SubtractSourceFromDest: ['One', 'One', 'SubtractSourceFromDest', 'One', 'One', 'SubtractSourceFromDest'],
    SubtractDestFromSource: ['One', 'One', 'SubtractDestFromSource', 'One', 'One', 'SubtractDestFromSource'],
    Multiply: ['DestColor', 'Zero', 'Add', 'DestAlpha', 'Zero', 'Add'],
    Min: ['One', 'One', 'Min', 'One', 'One', 'Min'],
    Max: ['One', 'One', 'Max', 'One', 'One', 'Max'],
};

/**
 * Starting values for constants the engine feeds at runtime rather than the material (camera and
 * zoom state, parallax, fog-of-war transforms. See Cosmoteer's ShaderConstantIDs). A material
 * never writes these, so without a stand-in their controls would start at zero and blank shaders
 * that divide or gate on them (the nebula LOD and parallax math).
 */
export const ENGINE_DEFAULTS = {
    _camScale: [1],
    _percentScale: [0.5],
    _zoomT: [1],
    _parallaxIntensity: [0],
    _parallaxLoc: [0, 0],
    _worldUVOffset: [0, 0],
    _worldLightSource: [-100, -100, 100],
    _pointLightSource: [0, 0, 100],
    // The ship-pipeline constants (Cosmoteer.ShaderConstantIDs): part bounds matching the ±50
    // world span the synthesized vertex inputs use, and fully-opaque roof state.
    _shipBounds: [-50, -50, 50, 50],
    _roofOpacity: [1],
    _roofBaseAlpha: [1],
    _roofBaseTextureScale: [64, 64],
    _roofBaseColor: [1, 1, 1, 1],
    _roofDecalColor1: [1, 1, 1, 1],
    _roofDecalColor2: [1, 1, 1, 1],
    _roofDecalColor3: [1, 1, 1, 1],
    // The lighting shape constants from BackgroundStyleRules the roof/wall shaders read.
    _diffuseDarkness: [0],
    _diffuseDarknessExponent: [1],
    _specularStrength: [0.25],
    _specularShine: [1],
    _camRotation: [0],
    // Interaction and effect clocks the engine feeds; zero is the manual-slider fallback when a
    // clock's auto replay (CLOCK_REPLAY) is toggled off.
    _flickerTime: [0],
    _fluctuationTime: [0],
    _highlightTime: [0],
    _unhighlightTime: [0],
    _clickTime: [0],
    _mouseLoc: [0, 0],
    _intensity: [1],
    _t: [0.5],
    // Planet-generator shape constants: a visible default rotation rate and an untilted axis
    // (cosTilt must be 1, not 0, or the ring and shadow math degenerates).
    _spin: [0.05],
    _sinTilt: [0],
    _cosTilt: [1],
};

/**
 * Engine clocks the preview replays per frame (decompiled setters): the blueprint flicker and
 * redprint fluctuation clocks are `App.Clock.Time` (0 only under the accessibility settings),
 * `_planetTime` advances planet rotation, `_waveT1`/`_waveT2` crossfade the two wave normal maps
 * (`InverseLerp(1, 0.5, phase)` / `InverseLerp(0, 0.5, phase)` over a cycling phase), the GUI
 * highlight/click constants are event TIMESTAMPS compared against `_time` (replayed as a
 * periodic hover+click every few seconds), and `_crewTime` is the crew animation clock. Each
 * gets an `auto` toggle on its control; unchecked falls back to the static slider value.
 */
export const CLOCK_REPLAY = {
    _crewTime: (t) => t,
    _flickerTime: (t) => t,
    _fluctuationTime: (t) => t,
    _planetTime: (t) => t,
    _waveT1: (t) => Math.min(Math.max((1 - ((t / 2) % 1)) / 0.5, 0), 1),
    _waveT2: (t) => Math.min(Math.max(((t / 2) % 1) / 0.5, 0), 1),
    _highlightTime: (t) => Math.floor(t / 3) * 3,
    _unhighlightTime: (t) => Math.floor(t / 3) * 3 + 1.5,
    _clickTime: (t) => Math.floor(t / 3) * 3,
};
