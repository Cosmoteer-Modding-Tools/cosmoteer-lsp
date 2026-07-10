// @ts-nocheck
// The live shader-preview webview runtime. It receives a resolved payload from the extension (the
// material's translated GLSL, its constants and values, its textures with their sampler state, its
// blend factors, and the particle system's colour ramp) and renders the material with WebGL the way
// the game does, exposing each constant as a live control. When the translated GLSL fails to compile,
// it falls back to a plain textured render so something useful still shows. All of this runs sandboxed
// in the webview, the extension only feeds it data.
(function () {
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('gl');
    const statusEl = document.getElementById('status');
    const metaEl = document.getElementById('meta');
    const controlsEl = document.getElementById('controls');
    // Prefer WebGL2: it lifts the power-of-two texture limits, has Min/Max blending in core, and its
    // GLSL ES 3.00 gives real textureLod/textureSize for the decal LOD math. The translated sources
    // stay ES 1.00 and are upgraded textually in link(); WebGL1 remains the fallback.
    const contextOptions = { premultipliedAlpha: false, alpha: true };
    const gl2 = canvas.getContext('webgl2', contextOptions);
    const gl = gl2 || canvas.getContext('webgl', contextOptions);
    const isGL2 = !!gl2;
    // Enable screen-space derivatives (dFdx/dFdy/fwidth) so a translated shader that declares
    // `#extension GL_OES_standard_derivatives` — decals and the distortion shaders — links and runs.
    // Core in WebGL2, an extension in WebGL1.
    if (gl && !isGL2) gl.getExtension('OES_standard_derivatives');
    // Min/Max blend equations are an extension in WebGL1, used by the engine's Min/Max blend modes.
    const minmax = gl && !isGL2 ? gl.getExtension('EXT_blend_minmax') : null;

    // The fixed full-quad geometry the fragment shader draws onto, replacing the game's vertex stage.
    const QUAD = new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]);

    // uUvRect remaps the quad's UVs to one sprite-sheet cell (offset.xy, scale.zw); the full texture
    // is [0, 0, 1, 1]. UVs are top-origin like the game's (D3D convention), see loadTexture.
    const VERTEX_SRC = `
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
    const FALLBACK_SRC = `
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
    const BLEND_MODES = {
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

    let program = null;
    let usingFallback = false;
    // True when the linked program samples an engine screen target with no material-bound image, so
    // the scene stand-in pass must render before the main draw.
    let needsScene = false;
    // The shader's own translated vertex stage ({glsl, fragment, kind}) and whether the linked
    // program runs it, so the world-to-clip _transform can be fitted to the stage's input family.
    let vertexStage = null;
    let usingVertexStage = false;
    // The GLSL error of the last failed compile or link, surfaced in the status line so a translation
    // that WebGL rejects is diagnosable rather than a silent fallback.
    let lastGlError = null;
    // Loaded textures keyed by the sampler uniform they feed ('_texture' plus any texture constants).
    let textures = {};
    let dummyTexture = null;
    let transparentTexture = null;
    // Typed stand-ins for the engine-fed render targets and normal-map atlases (see fallbackTexture).
    let flatNormalTarget = null;
    let flatNormalAtlas = null;
    let transparentBlack = null;
    // The offscreen scene pass standing in for the engine's diffuse target and captured backbuffer:
    // the plain textured material rendered at the same quad transform, so lighting and distortion
    // shaders sample something aligned with what they light or displace.
    let sceneTarget = null;
    let sceneProgram = null;
    let values = {}; // uniform name → number | number[]
    // The material colour (_color in the game), multiplied with the per-vertex colour in the engine's
    // vertex stage. The preview folds both into the vColor varying.
    let materialTint = [1, 1, 1, 1];
    // The manual per-vertex colour, used when the ramp animation is off or there is no ramp.
    let vertexColor = [1, 1, 1, 1];
    let animateVertex = false;
    // The particle system's colour-over-lifetime ramp ({lifetime, invert, colors}) when the material
    // sits inside a particle def, replayed exactly the way the game's ColorRamp updater computes it.
    let particleRamp = null;
    // The particle's lifetime in seconds, the clock for both the ramp and the sprite-sheet cycle.
    let particleLifetime = 1;
    // The particle system's sprite sheet ({textureSize, spriteSize, count, perRow, offset, animated});
    // the preview shows one cell, cycling through them over the lifetime when animated.
    let spriteSheet = null;
    let sheetCell = 0;
    let cycleCells = false;
    // The beam vertex-stage stand-ins the translated shader reads as uPv… uniforms.
    let beamIntensity = 1;
    let beamFade = 1;
    let beamLength = 1;
    // The quad aspect from the material's written Size (world units), preferred over texture shape.
    let sizeAspect = null;
    let emissive = 0;
    // The blend factors the material draws with (an engine mode name sextuple, see BLEND_MODES). The
    // toolbar can override the material's resolved mode.
    let materialBlend = BLEND_MODES.AlphaBlend;
    let blendOverride = null;
    // The aspect ratio (width / height) of the base texture, so a non-square sprite is letterboxed
    // into the square canvas instead of being stretched.
    let textureAspect = 1;
    let paused = false;
    let startTime = Date.now();
    // Wall-clock milliseconds the preview has spent paused, subtracted from the animation clock so a
    // pause freezes time and a resume continues from where it stopped rather than jumping forward.
    let pausedAccum = 0;
    let pauseStartedAt = 0;

    /** Milliseconds of animation time elapsed, holding steady while the preview is paused. */
    function elapsedMs() {
        const frozen = paused ? Date.now() - pauseStartedAt : 0;
        return Date.now() - startTime - pausedAccum - frozen;
    }

    /** The particle's normalized lifetime position this frame, looping so the preview replays it. */
    function lifeT() {
        return (elapsedMs() / 1000 / particleLifetime) % 1;
    }

    /**
     * The active sprite-sheet cell as a UV sub-rect [u, v, w, h] (top-origin, like the game's UVs).
     * Cycles through the cells over the particle lifetime when animating, else holds the picked cell.
     */
    function sheetUvRect() {
        if (!spriteSheet) return [0, 0, 1, 1];
        const index = cycleCells
            ? Math.min(Math.floor(lifeT() * spriteSheet.count), spriteSheet.count - 1)
            : Math.min(sheetCell, spriteSheet.count - 1);
        const col = index % spriteSheet.perRow;
        const row = Math.floor(index / spriteSheet.perRow);
        const [tw, th] = spriteSheet.textureSize;
        const [sw, sh] = spriteSheet.spriteSize;
        const [ox, oy] = spriteSheet.offset;
        return [(ox + col * sw) / tw, (oy + row * sh) / th, sw / tw, sh / th];
    }

    /** Lerps across the ramp colours at a normalized position, the way the game's ColorRamp does. */
    function rampAt(colors, t) {
        const segments = colors.length - 1;
        const s = Math.min(Math.max(t * segments, 0), segments);
        const i = Math.min(Math.floor(s), segments - 1);
        const f = s - i;
        const a = colors[i];
        const b = colors[i + 1];
        return [0, 1, 2, 3].map((c) => (a[c] ?? 1) + ((b[c] ?? 1) - (a[c] ?? 1)) * f);
    }

    /**
     * The vertex colour to feed this frame. With a particle ramp and animation on, it replays the
     * game's colour-over-lifetime lerp (times the material colour, the way the engine's vertex stage
     * multiplies them). Without a ramp, a particle falls back to sweeping the red channel, and a
     * sprite uses the static colour.
     */
    function effectiveVertexColor() {
        if (animateVertex && particleRamp) {
            const cycle = lifeT();
            const t = particleRamp.invert ? 1 - cycle : cycle;
            const ramp = rampAt(particleRamp.colors, t);
            return [
                ramp[0] * materialTint[0],
                ramp[1] * materialTint[1],
                ramp[2] * materialTint[2],
                ramp[3] * materialTint[3],
            ];
        }
        if (!animateVertex) return vertexColor;
        const sweep = (elapsedMs() / 3000) % 1; // 0 → 1 over three seconds
        return [sweep, vertexColor[1], vertexColor[2], vertexColor[3]];
    }

    /**
     * Upgrades a translated GLSL ES 1.00 source to ES 3.00 for a WebGL2 context. The rewrite is
     * mechanical: version header, in/out qualifiers, the texture call rename, a declared fragment
     * output in place of gl_FragColor, and the real textureLod/textureSize bodies swapped into the
     * pvTexLod/pvTexSize helpers whose ES 1.00 fallback bodies the server emits (the exact body
     * strings are a contract with hlsl-to-glsl.ts).
     */
    function upgradeToEs3(source, isVertex) {
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

    /** Compiles a shader, returning it or null, recording and logging the GLSL error. */
    function compile(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, isGL2 ? upgradeToEs3(source, type === gl.VERTEX_SHADER) : source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            lastGlError = String(gl.getShaderInfoLog(shader) || 'unknown compile error').trim();
            console.warn('shader compile failed:', lastGlError);
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    /** Links a vertex/fragment pair into a program, or null on failure. */
    function link(fragmentSrc, vertexSrc) {
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
            lastGlError = String(gl.getProgramInfoLog(prog) || 'unknown link error').trim();
            console.warn('program link failed:', lastGlError);
            return null;
        }
        return prog;
    }

    /** A 1×1 texture of the given RGBA bytes, bound for samplers the preview has no real image for. */
    function makeSolid(r, g, b, a) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
        return tex;
    }

    /** A canvas-sized render target for the scene stand-in pass, or null when incomplete. */
    function createSceneTarget() {
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
     * Renders the scene stand-in the engine-fed screen targets sample: the plain textured material
     * over a dark space tone, drawn at the same quad transform as the main pass so screen-UV lookups
     * (`_diffuseTarget`, `_capturedBackBuffer`) land on the sprite they light or distort.
     */
    function drawScenePass() {
        gl.bindFramebuffer(gl.FRAMEBUFFER, sceneTarget.fbo);
        gl.viewport(0, 0, canvas.width || 512, canvas.height || 512);
        gl.clearColor(0.02, 0.02, 0.05, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.BLEND);
        gl.useProgram(sceneProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, textures._texture || dummyTexture);
        gl.uniform1i(gl.getUniformLocation(sceneProgram, '_texture'), 0);
        gl.uniform1f(gl.getUniformLocation(sceneProgram, 'uEmissive'), emissive);
        gl.uniform4fv(gl.getUniformLocation(sceneProgram, 'uTint'), effectiveVertexColor());
        const s = quadScale();
        gl.uniform2f(gl.getUniformLocation(sceneProgram, 'uQuadScale'), s[0], s[1]);
        gl.uniform4fv(gl.getUniformLocation(sceneProgram, 'uUvRect'), sheetUvRect());
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
     */
    function fallbackTexture(name) {
        if (/unexplored/i.test(name)) return transparentTexture;
        if (name === '_normalsTarget') return flatNormalTarget;
        if (name === '_normalsXYTexture' || name === '_normalsTexture') return flatNormalAtlas;
        if (name === '_stencilTarget') return transparentBlack;
        if (name === '_diffuseTarget' || name === '_capturedBackBuffer' || name === '_ftlBackground') {
            return sceneTarget ? sceneTarget.texture : dummyTexture;
        }
        return dummyTexture;
    }

    /**
     * Loads an image URL into a texture with the sampler state the game would create: Point or Linear
     * filtering, Clamp or Wrap addressing, and a mip chain when the rules declare one. WebGL1 restricts
     * repeat wrapping and mipmaps to power-of-two images, so those fall back gracefully for the rest.
     * Resolves to {texture, aspect} with the dummy texture on any failure.
     */
    function loadTexture(url, sampler) {
        return new Promise((resolve) => {
            if (!url) return resolve({ texture: dummyTexture, aspect: 1 });
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
                const pot =
                    isGL2 ||
                    ((image.width & (image.width - 1)) === 0 && (image.height & (image.height - 1)) === 0);
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
            image.onerror = () => resolve({ texture: dummyTexture, aspect: 1 });
            image.src = url;
        });
    }

    /** Safely evaluates a numeric expression (numbers and arithmetic only), or NaN. */
    function evalNumber(expr) {
        const trimmed = String(expr).trim();
        if (!/^[-+*/().\d\s]+$/.test(trimmed)) return NaN;
        try {
            return Function('"use strict"; return (' + trimmed + ')')();
        } catch {
            return NaN;
        }
    }

    /** Parses a written constant value (`0.2`, `[255, 0, 0, 255]`, `{Rf=1 Gf=0 …}`) into numbers. */
    function parseValue(raw) {
        if (raw == null) return null;
        const text = String(raw).trim();
        let parts;
        if (text.indexOf('=') >= 0) {
            // Group form `{Rf=1 Gf=0 …}` — take the value after each `=`.
            parts = (text.match(/=\s*([-+*/().\d\s]+)/g) || []).map((m) => m.replace('=', ''));
        } else {
            parts = text.replace(/^[[{]|[\]}]$/g, '').split(',');
        }
        const numbers = parts.map(evalNumber).filter((n) => !Number.isNaN(n));
        return numbers.length ? numbers : null;
    }

    /**
     * Normalizes a colour parsed from raw text to the 0–1 float space. Only used as the fallback when
     * the server could not read the value structurally (math or references in the written form); the
     * preferred path is the server's components, already normalized with the game's parse rules.
     */
    function normalizeColorFallback(numbers, isColor) {
        if (!numbers || !isColor) return numbers;
        const max = Math.max.apply(null, numbers);
        // Group text with float channels (`Rf = …`) is already 0–1; byte forms exceed that range.
        if (max > 1.5) return numbers.map((n) => n / 255);
        return numbers;
    }

    /**
     * Starting values for constants the ENGINE feeds at runtime rather than the material (camera and
     * zoom state, parallax, fog-of-war transforms — see Cosmoteer's ShaderConstantIDs). A material
     * never writes these, so without a stand-in their controls would start at zero and blank shaders
     * that divide or gate on them (the nebula LOD and parallax math).
     */
    const ENGINE_DEFAULTS = {
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
    const CLOCK_REPLAY = {
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
    // Which clock constants currently follow the replay (per payload; control checkboxes flip these).
    let clockAuto = {};

    /**
     * The builtin uniform values the engine supplies each frame. The lighting values mirror vanilla's
     * `base_bg.rules` global lights, and the light normal is the engine's default light direction
     * (normalize(-1, -1) at the standard light height).
     */
    function builtins() {
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
     */
    function quadScale() {
        const sheet = spriteSheet ? spriteSheet.spriteSize[0] / spriteSheet.spriteSize[1] : null;
        const aspect = sizeAspect || sheet || textureAspect;
        return aspect >= 1 ? [1, 1 / aspect] : [aspect, 1];
    }

    /**
     * The world-to-clip matrix standing in for the engine's `_transform` when the shader's own
     * vertex stage runs. Each input family is synthesized at a different world span (a sprite's
     * location at ±50 units, a particle quad at ±_baseSize/2, a beam laid out over its length), so
     * the scale maps that span back to the canvas, with the quad aspect folded in.
     */
    function transformMatrix() {
        const s = quadScale();
        let k = 1 / 50;
        if (usingVertexStage && vertexStage && vertexStage.kind === 'particle') {
            const bs = values._baseSize && values._baseSize[0] > 0 ? values._baseSize[0] : 1;
            k = 2 / Math.max(bs, 0.01);
        } else if (usingVertexStage && vertexStage && vertexStage.kind === 'beam') {
            k = 1.8 / Math.max(beamLength, 0.01);
        } else if (usingVertexStage && vertexStage && vertexStage.kind === 'crew') {
            // The crew quad's corner offsets span ±0.5 world units; fill most of the canvas.
            k = 1.8;
        }
        return [s[0] * k, 0, 0, 0, 0, s[1] * k, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    }

    /** Sets every active uniform of the current program from the builtin and constant value maps. */
    function applyUniforms() {
        const merged = Object.assign(builtins(), values);
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        let textureUnit = 0;
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(program, i);
            const name = info.name.replace(/\[0\]$/, '');
            const location = gl.getUniformLocation(program, name);
            if (!location) continue;
            if (info.type === gl.SAMPLER_2D) {
                const unit = textureUnit++;
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, textures[name] || fallbackTexture(name));
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
                gl.uniform1f(location, beamIntensity);
                continue;
            }
            if (name === 'uPvFadeAlpha') {
                gl.uniform1f(location, beamFade);
                continue;
            }
            if (name === 'uPvBeamLength') {
                gl.uniform1f(location, beamLength);
                continue;
            }
            if (name === 'uEmissive') {
                gl.uniform1f(location, emissive);
                continue;
            }
            // Engine clocks follow the replay unless the control's auto toggle is off.
            if (CLOCK_REPLAY[name] && clockAuto[name] !== false) {
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

    /** Maps an engine blend factor name to its GL constant. */
    function glFactor(name) {
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
     */
    function glOperator(name) {
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

    /** The active blend factor sextuple: the toolbar override when set, else the material's. */
    function activeBlend() {
        return blendOverride ? BLEND_MODES[blendOverride] : materialBlend;
    }

    /** Applies the active blend factors with separate colour and alpha channels, like the engine. */
    function setBlend() {
        const spec = activeBlend();
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(glFactor(spec[0]), glFactor(spec[1]), glFactor(spec[3]), glFactor(spec[4]));
        gl.blendEquationSeparate(glOperator(spec[2]), glOperator(spec[5]));
    }

    /** Draws one frame: the material quad composed over the stage backdrop with its blend mode. */
    function draw() {
        if (!program) return;
        if (needsScene && sceneTarget && sceneProgram) drawScenePass();
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        setBlend();
        gl.useProgram(program);
        applyUniforms();
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function loop() {
        draw();
        requestAnimationFrame(loop);
    }

    /**
     * Builds the vertex-colour control. With a particle colour ramp the Animate toggle replays the
     * game's colour-over-lifetime animation; without one a particle still gets a red-channel sweep,
     * and a sprite reads the colour as a plain tint.
     */
    function buildVertexColorControl(isParticle) {
        const row = document.createElement('div');
        row.className = 'control';
        const label = document.createElement('label');
        label.textContent = isParticle ? 'Vertex color (anim)' : 'Vertex color';
        label.title = particleRamp
            ? 'The particle system animates this colour over each particle’s lifetime (ColorRamp). Uncheck anim to hold a colour.'
            : isParticle
              ? 'A particle drives its effect with per-vertex colour. Red sweeps the animation, alpha is brightness.'
              : 'The material vertex-colour tint.';
        row.appendChild(label);

        const color = document.createElement('input');
        color.type = 'color';
        color.value = toHex(vertexColor);
        color.oninput = () => {
            const rgb = fromHex(color.value);
            vertexColor = [rgb[0], rgb[1], rgb[2], vertexColor[3]];
        };
        row.appendChild(color);
        row.appendChild(slider(0, 1, vertexColor[3], (a) => (vertexColor[3] = a)));

        if (isParticle) {
            const toggle = document.createElement('label');
            toggle.className = 'animate';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = animateVertex;
            box.onchange = () => (animateVertex = box.checked);
            toggle.appendChild(box);
            toggle.appendChild(document.createTextNode(' anim'));
            row.appendChild(toggle);
        }
        return row;
    }

    /** Builds the beam control row: the per-vertex intensity and fade the vertex stage would carry. */
    function buildBeamControl() {
        const row = document.createElement('div');
        row.className = 'control';
        const label = document.createElement('label');
        label.textContent = 'Beam';
        label.title = 'The per-vertex beam inputs: intensity scales the effect, fade multiplies alpha over the beam’s life.';
        row.appendChild(label);
        row.appendChild(slider(0, 2, beamIntensity, (n) => (beamIntensity = n), true));
        row.appendChild(slider(0, 1, beamFade, (n) => (beamFade = n)));
        return row;
    }

    /** Builds the sprite-sheet control row: the shown cell, and a cycle toggle replaying the game's animation. */
    function buildSheetControl() {
        const row = document.createElement('div');
        row.className = 'control';
        const label = document.createElement('label');
        label.textContent = 'Sprite cell';
        label.title = 'The particle system picks one cell of the sprite sheet (UvSprites). Cycle replays the animation over the lifetime.';
        row.appendChild(label);
        const cell = slider(0, spriteSheet.count - 1, sheetCell, (n) => (sheetCell = Math.round(n)), true);
        row.appendChild(cell);
        const toggle = document.createElement('label');
        toggle.className = 'animate';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = cycleCells;
        box.onchange = () => (cycleCells = box.checked);
        toggle.appendChild(box);
        toggle.appendChild(document.createTextNode(' cycle'));
        row.appendChild(toggle);
        return row;
    }

    /** Builds the editable control row for one constant. */
    function buildControl(constant) {
        const row = document.createElement('div');
        row.className = 'control';
        const label = document.createElement('label');
        label.textContent = constant.name;
        label.title = `${constant.hlslType}${constant.default ? ' (default ' + constant.default + ')' : ''}`;
        row.appendChild(label);

        // Prefer the components read structurally from the AST (offset-free, and already normalized
        // with the game's colour parse rules for a colour-typed constant), then the raw text, then the
        // shader's declared default, then a neutral default.
        const numbers =
            (constant.components && constant.components.length ? constant.components.slice() : null) ||
            normalizeColorFallback(
                parseValue(constant.value) ||
                    parseValue(constant.default) ||
                    (ENGINE_DEFAULTS[constant.name] && ENGINE_DEFAULTS[constant.name].slice()) ||
                    defaultFor(constant.kind),
                constant.isColor
            );

        if (constant.kind === 'vec3' || constant.kind === 'vec4') {
            values[constant.name] = numbers;
            const color = document.createElement('input');
            color.type = 'color';
            color.value = toHex(numbers);
            color.oninput = () => {
                const rgb = fromHex(color.value);
                const current = values[constant.name];
                values[constant.name] = [rgb[0], rgb[1], rgb[2], current[3] ?? 1];
            };
            row.appendChild(color);
            if (constant.kind === 'vec4') row.appendChild(slider(0, 1, numbers[3] ?? 1, (a) => (values[constant.name][3] = a)));
        } else if (constant.kind === 'float' || constant.kind === 'int') {
            values[constant.name] = numbers[0];
            // Fit the range (and thereby the step) to the written value's magnitude, so a tiny
            // constant like `_midTexScale = 0.0005` stays adjustable at its own scale instead of
            // snapping to a coarse 0..8 grid. Zero-valued constants get a nominal range.
            const magnitude = Math.abs(numbers[0]);
            const max = magnitude > 0 ? magnitude * 4 : /strength|intensity|scale|add/i.test(constant.name) ? 8 : 1;
            const min = Math.min(0, numbers[0] * 4);
            row.appendChild(slider(min, max, numbers[0], (n) => (values[constant.name] = n), true));
            // An engine clock animates by default; unchecking auto hands it to the slider.
            if (CLOCK_REPLAY[constant.name]) {
                clockAuto[constant.name] = true;
                const toggle = document.createElement('label');
                toggle.className = 'animate';
                toggle.title = 'Replay the engine clock driving this constant. Uncheck to set it manually.';
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = true;
                box.onchange = () => (clockAuto[constant.name] = box.checked);
                toggle.appendChild(box);
                toggle.appendChild(document.createTextNode(' auto'));
                row.appendChild(toggle);
            }
        } else if (constant.kind === 'vec2') {
            values[constant.name] = numbers;
            row.appendChild(numberInput(numbers[0] ?? 0, (n) => (values[constant.name][0] = n)));
            row.appendChild(numberInput(numbers[1] ?? 0, (n) => (values[constant.name][1] = n)));
        } else {
            const tag = document.createElement('span');
            tag.className = 'kind';
            tag.textContent = constant.kind;
            row.appendChild(tag);
        }
        return row;
    }

    /** Formats a control value with enough precision for its magnitude (`0.0005` stays `0.0005`). */
    function formatNumber(n) {
        if (n === 0) return '0';
        const abs = Math.abs(n);
        if (abs >= 100) return n.toFixed(0);
        if (abs >= 1) return String(+n.toFixed(2));
        return String(+n.toPrecision(3));
    }

    /** A labelled range slider that mirrors its value into a number box and reports changes. */
    function slider(min, max, value, onChange, showValue) {
        const wrap = document.createElement('span');
        wrap.className = 'slider';
        const range = document.createElement('input');
        range.type = 'range';
        range.min = String(min);
        range.max = String(max);
        range.step = String((max - min) / 200 || 0.01);
        range.value = String(value);
        const out = document.createElement('span');
        out.className = 'num';
        out.textContent = formatNumber(+value);
        range.oninput = () => {
            const n = parseFloat(range.value);
            out.textContent = formatNumber(n);
            onChange(n);
        };
        wrap.appendChild(range);
        if (showValue) wrap.appendChild(out);
        return wrap;
    }

    function numberInput(value, onChange) {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'numinput';
        input.value = String(value);
        input.oninput = () => onChange(parseFloat(input.value) || 0);
        return input;
    }

    function defaultFor(kind) {
        if (kind === 'vec4') return [1, 1, 1, 1];
        if (kind === 'vec3') return [1, 1, 1];
        if (kind === 'vec2') return [1, 1];
        return [0];
    }

    /**
     * Builds the stage toolbar: a backdrop selector (an emissive or additive material reads very
     * differently over dark, light, or the checkerboard), a pause toggle, and a blend-mode override
     * offering the engine's named modes.
     */
    function buildToolbar(initialBackdrop) {
        const bar = document.createElement('div');
        bar.className = 'toolbar';

        const bg = document.createElement('select');
        bg.title = 'Preview backdrop';
        for (const [value, text] of [
            ['checker', 'Checker'],
            ['dark', 'Dark'],
            ['light', 'Light'],
            ['mid', 'Grey'],
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            if (value === initialBackdrop) option.selected = true;
            bg.appendChild(option);
        }
        bg.onchange = () => setBackdrop(bg.value);
        setBackdrop(initialBackdrop);
        bar.appendChild(labelled('Backdrop', bg));

        const blendSel = document.createElement('select');
        blendSel.title = 'Blend mode (the material’s resolved mode, overridable)';
        const fromMaterial = document.createElement('option');
        fromMaterial.value = '';
        fromMaterial.textContent = 'material';
        blendSel.appendChild(fromMaterial);
        for (const mode of Object.keys(BLEND_MODES)) {
            const option = document.createElement('option');
            option.value = mode;
            option.textContent = mode;
            blendSel.appendChild(option);
        }
        blendSel.onchange = () => (blendOverride = blendSel.value || null);
        bar.appendChild(labelled('Blend', blendSel));

        const pause = document.createElement('button');
        pause.textContent = 'Pause';
        pause.onclick = () => {
            paused = !paused;
            if (paused) pauseStartedAt = Date.now();
            else {
                pausedAccum += Date.now() - pauseStartedAt;
            }
            pause.textContent = paused ? 'Play' : 'Pause';
        };
        bar.appendChild(pause);
        return bar;
    }

    /** Wraps a control in a small labelled span for the toolbar. */
    function labelled(text, control) {
        const span = document.createElement('span');
        span.className = 'tool';
        const label = document.createElement('span');
        label.textContent = text;
        span.appendChild(label);
        span.appendChild(control);
        return span;
    }

    /** Switches the stage backdrop the canvas composes over. */
    function setBackdrop(kind) {
        const stage = document.getElementById('stage');
        stage.className = kind === 'checker' ? '' : 'bg-' + kind;
    }

    function toHex(rgb) {
        const h = (n) => ('0' + Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16)).slice(-2);
        return '#' + h(rgb[0]) + h(rgb[1] ?? 0) + h(rgb[2] ?? 0);
    }

    function fromHex(hex) {
        const n = parseInt(hex.slice(1), 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }

    /** Applies a freshly received payload: compiles, loads the textures, and rebuilds the controls. */
    async function render(message) {
        const data = message.data;
        values = {};
        clockAuto = {};
        startTime = Date.now();
        pausedAccum = 0;
        paused = false;
        textureAspect = 1;
        materialBlend = data.blend
            ? [data.blend.srcRgb, data.blend.dstRgb, data.blend.rgbOp, data.blend.srcAlpha, data.blend.dstAlpha, data.blend.alphaOp]
            : BLEND_MODES.AlphaBlend;
        blendOverride = null;
        particleRamp = data.particleColor;
        particleLifetime = data.particleLifetime || (particleRamp && particleRamp.lifetime) || 2;
        spriteSheet = data.spriteSheet;
        sheetCell = 0;
        cycleCells = !!(spriteSheet && spriteSheet.animated);
        beamIntensity = 1;
        beamFade = 1;
        beamLength = 1;
        // The material's world size decides the quad shape (the game stretches the sprite to it); the
        // written value may contain math, which parseValue evaluates.
        const sizeNumbers = parseValue(data.size);
        sizeAspect = sizeNumbers && sizeNumbers.length >= 2 && sizeNumbers[0] > 0 && sizeNumbers[1] > 0
            ? sizeNumbers[0] / sizeNumbers[1]
            : null;
        if (data.baseSize && data.baseSize.length === 2) values._baseSize = data.baseSize.slice();

        // The material colour (the server normalizes it with the game's parse rules; the text parse is
        // the fallback for math or references). The engine multiplies it with the per-vertex colour in
        // the vertex stage, so the preview folds it into vColor.
        const parsedTint = data.tintComponents || normalizeColorFallback(parseValue(data.tint), true);
        materialTint = parsedTint ? parsedTint.concat([1, 1, 1, 1]).slice(0, 4) : [1, 1, 1, 1];
        // With a ramp the animation drives the vertex colour; without one a particle sweeps its red
        // channel (many particle shaders read it as the animation arc) and a sprite holds the tint.
        animateVertex = !!data.isParticle && (!!particleRamp || !parsedTint);
        vertexColor = particleRamp
            ? materialTint
            : parsedTint
              ? materialTint
              : data.isParticle
                ? [0.5, 1, 1, 1]
                : [1, 1, 1, 1];

        // Emissive boost for the fallback path, from any additive/emissive constant the material sets.
        emissive = 0;
        for (const c of data.constants) {
            if (/emissive|additivestrength/i.test(c.name)) {
                const n = (c.components && c.components.length ? c.components : null) || parseValue(c.value);
                if (n) emissive = Math.max(emissive, n[0]);
            }
        }

        dummyTexture = dummyTexture || makeSolid(255, 255, 255, 255);
        transparentTexture = transparentTexture || makeSolid(255, 255, 255, 0);
        // Flat +Z normal in the screen-target encoding (normalsToColor of (0, 0, 1)) and in the
        // inferred-atlas encoding (x in alpha, y in green, both centred); empty stencil coverage.
        flatNormalTarget = flatNormalTarget || makeSolid(127, 127, 255, 255);
        flatNormalAtlas = flatNormalAtlas || makeSolid(127, 127, 127, 127);
        transparentBlack = transparentBlack || makeSolid(0, 0, 0, 0);
        sceneTarget = sceneTarget || createSceneTarget();
        sceneProgram = sceneProgram || link(FALLBACK_SRC);
        // Load every bound texture with its sampler state; the base '_texture' also sets the aspect.
        const textureData = message.textureData || {};
        textures = {};
        for (const entry of data.textures || []) {
            const loaded = await loadTexture(textureData[entry.name], entry.sampler);
            textures[entry.name] = loaded.texture;
            if (entry.name === '_texture') textureAspect = loaded.aspect;
        }

        lastGlError = null;
        // Prefer the shader's own vertex stage; when it will not compile, fall back to the fixed-quad
        // fragment translation, and only then to the plain textured render.
        vertexStage = data.translationOk ? data.vertexStage : null;
        program = vertexStage ? link(vertexStage.fragment, vertexStage.glsl) : null;
        usingVertexStage = !!program;
        if (!program && data.translationOk && data.glsl) program = link(data.glsl);
        usingFallback = !program;
        const glslError = lastGlError;
        if (!program) program = link(FALLBACK_SRC);

        // The scene stand-in pass runs only when the program samples an engine screen target the
        // material did not bind an image for (the lighting and backbuffer-distortion shaders).
        needsScene = false;
        if (program) {
            const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < uniformCount; i++) {
                const name = gl.getActiveUniform(program, i).name.replace(/\[0\]$/, '');
                const isSceneTarget =
                    name === '_diffuseTarget' || name === '_capturedBackBuffer' || name === '_ftlBackground';
                if (isSceneTarget && !textures[name]) needsScene = true;
            }
        }

        // The stage toolbar (backdrop, blend, pause), the vertex-colour control (a particle's animation
        // input), the beam and sprite-sheet controls when they apply, then one control per constant.
        // An additive material starts over the dark backdrop, the way it composes over space in-game.
        const spec = activeBlend();
        const additive = spec[1] === 'One' && spec[2] === 'Add';
        controlsEl.innerHTML = '';
        controlsEl.appendChild(buildToolbar(additive ? 'dark' : 'checker'));
        controlsEl.appendChild(buildVertexColorControl(data.isParticle));
        if (data.isBeam) controlsEl.appendChild(buildBeamControl());
        if (spriteSheet) controlsEl.appendChild(buildSheetControl());
        for (const constant of data.constants) controlsEl.appendChild(buildControl(constant));

        // Status and metadata. A rejected translation shows the first GLSL error line so the failure
        // is diagnosable from the panel instead of only from the webview console.
        const failure = data.translationOk
            ? `shader compile failed${glslError ? ': ' + glslError.split('\n')[0].slice(0, 160) : ''}`
            : data.reason || 'shader not translatable';
        const note = usingFallback ? `Approximate render (${failure}) — texture, tint and blend shown.` : 'Live translated shader.';
        const blendLabel = data.blend && data.blend.label !== 'AlphaBlend' ? data.blend.label : null;
        const tags = [
            usingVertexStage ? `vertex stage (${vertexStage.kind})` : null,
            blendLabel,
            particleRamp ? 'particle: color ramp animated' : data.isParticle ? 'particle: vertex colour animated' : null,
            data.isBeam ? 'beam' : null,
            spriteSheet ? `sprite sheet: ${spriteSheet.count} cells` : null,
            needsScene ? 'scene stand-in' : null,
            isGL2 ? null : 'WebGL1 fallback',
        ].filter(Boolean);
        statusEl.textContent = tags.length ? `${note} · ${tags.join(' · ')}` : note;
        metaEl.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'shadername';
        title.textContent = data.shaderName;
        if (data.shaderUri) {
            const open = document.createElement('button');
            open.textContent = 'Open .shader';
            open.onclick = () => vscode.postMessage({ type: 'openShader', uri: data.shaderUri });
            title.appendChild(open);
        }
        metaEl.appendChild(title);
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'render') render(message);
        else if (message.type === 'empty') {
            statusEl.textContent = 'Place the cursor in a material with a Shader to preview it.';
        }
    });

    if (!gl) {
        statusEl.textContent = 'WebGL is not available in this webview.';
        return;
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    requestAnimationFrame(loop);
    vscode.postMessage({ type: 'ready' });
})();
