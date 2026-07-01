// @ts-nocheck
// The live shader-preview webview runtime. It receives a resolved payload from the extension (the
// material's translated GLSL, its constants and values, its texture and blend mode) and renders the
// material with WebGL the way the game does, exposing each constant as a live control. When the
// translated GLSL fails to compile, it falls back to a plain textured render so something useful still
// shows. All of this runs sandboxed in the webview, the extension only feeds it data.
(function () {
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('gl');
    const statusEl = document.getElementById('status');
    const metaEl = document.getElementById('meta');
    const controlsEl = document.getElementById('controls');
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true });
    // Enable screen-space derivatives (dFdx/dFdy/fwidth) so a translated shader that declares
    // `#extension GL_OES_standard_derivatives` — decals and the distortion shaders — links and runs.
    if (gl) gl.getExtension('OES_standard_derivatives');

    // The fixed full-quad geometry the fragment shader draws onto, replacing the game's vertex stage.
    const QUAD = new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]);

    const VERTEX_SRC = `
attribute vec2 aPos;
attribute vec2 aUv;
varying vec2 vUv;
varying vec4 vColor;
uniform vec4 uTint;
uniform vec2 uQuadScale;
void main() {
    vUv = aUv;
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

    let program = null;
    let usingFallback = false;
    let mainTexture = null;
    let dummyTexture = null;
    let values = {}; // uniform name → number | number[]
    // The per-vertex colour fed to the shader. For a sprite this is the material tint; for a particle
    // it is animation control (the red channel sweeps the effect), so it is animated when `animateVertex`.
    let vertexColor = [1, 1, 1, 1];
    let animateVertex = false;
    let emissive = 0;
    // The blend mode the material draws with, one of 'normal' | 'additive' | 'premultiplied' |
    // 'multiply', resolved from the server's `blendMode` label and applied in {@link setBlend}.
    let blend = 'normal';
    // The aspect ratio (width / height) of the loaded texture, so a non-square sprite is letterboxed
    // into the square canvas instead of being stretched the way the previous full-quad render did.
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

    /** The vertex colour to feed this frame, sweeping the red channel when animating a particle. */
    function effectiveVertexColor() {
        if (!animateVertex) return vertexColor;
        const sweep = (elapsedMs() / 3000) % 1; // 0 → 1 over three seconds
        return [sweep, vertexColor[1], vertexColor[2], vertexColor[3]];
    }

    /** Compiles a shader, returning it or null and logging the GLSL error. */
    function compile(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.warn('shader compile failed:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    /** Links a vertex/fragment pair into a program, or null on failure. */
    function link(fragmentSrc) {
        const vert = compile(gl.VERTEX_SHADER, VERTEX_SRC);
        const frag = compile(gl.FRAGMENT_SHADER, fragmentSrc);
        if (!vert || !frag) return null;
        const prog = gl.createProgram();
        gl.attachShader(prog, vert);
        gl.attachShader(prog, frag);
        gl.bindAttribLocation(prog, 0, 'aPos');
        gl.bindAttribLocation(prog, 1, 'aUv');
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.warn('program link failed:', gl.getProgramInfoLog(prog));
            return null;
        }
        return prog;
    }

    /** A 1×1 white texture, bound for any sampler the preview has no real image for. */
    function makeDummy() {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        return tex;
    }

    /** Loads an image URL into a texture, resolving to the dummy texture on any failure. */
    function loadTexture(url) {
        return new Promise((resolve) => {
            if (!url) return resolve(dummyTexture);
            const image = new Image();
            image.onload = () => {
                if (image.width > 0 && image.height > 0) textureAspect = image.width / image.height;
                const tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                resolve(tex);
            };
            image.onerror = () => resolve(dummyTexture);
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

    /** Normalizes a colour-like vector authored in 0–255 to 0–1, leaving scales and small values alone. */
    function normalizeColor(name, numbers) {
        const isColor = /color/i.test(name);
        const max = Math.max.apply(null, numbers);
        if (isColor && max > 1.5) return numbers.map((n) => n / 255);
        return numbers;
    }

    /** The default builtin uniform values the engine supplies each frame. */
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
            _globalAmbientLight: [0.55, 0.55, 0.6],
            _globalDiffuseLight: [0.9, 0.9, 0.85],
            _globalMinDiffuseLight: [0.15, 0.15, 0.2],
            _globalSpecularLight: [0.4, 0.4, 0.4],
            _lightNormal: [0.26, 0.26, 0.93],
        };
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
                gl.bindTexture(gl.TEXTURE_2D, name === '_texture' ? mainTexture : dummyTexture);
                gl.uniform1i(location, unit);
                continue;
            }
            if (name === 'uTint') {
                gl.uniform4fv(location, effectiveVertexColor());
                continue;
            }
            if (name === 'uQuadScale') {
                // Fit the textured quad to the sprite's aspect ratio inside the square canvas.
                const s = textureAspect >= 1 ? [1, 1 / textureAspect] : [textureAspect, 1];
                gl.uniform2f(location, s[0], s[1]);
                continue;
            }
            if (name === 'uEmissive') {
                gl.uniform1f(location, emissive);
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

    /**
     * Sets the GL blend equation for the material's blend mode. `normal` and `additive` keep the
     * straight-alpha functions that match the preview's texture-times-tint output. `premultiplied` (the
     * mode the game uses for sprites and particles whose translated shaders pre-scale colour by alpha)
     * and `multiply` are offered as overrides for when the straight-alpha render reads wrong.
     */
    function setBlend() {
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        if (blend === 'additive') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        else if (blend === 'premultiplied') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        else if (blend === 'multiply') gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
        else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    /** Draws one frame: the material quad composed over the CSS checkerboard with its blend mode. */
    function draw() {
        if (!program) return;
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
     * Builds the vertex-colour control. A particle shader reads this colour as animation control (its
     * red channel sweeps the effect), so it gets an Animate toggle, on by default. A sprite reads it as
     * a plain tint.
     */
    function buildVertexColorControl(isParticle) {
        const row = document.createElement('div');
        row.className = 'control';
        const label = document.createElement('label');
        label.textContent = isParticle ? 'Vertex color (anim)' : 'Vertex color';
        label.title = isParticle
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

    /** Builds the editable control row for one constant. */
    function buildControl(constant) {
        const row = document.createElement('div');
        row.className = 'control';
        const label = document.createElement('label');
        label.textContent = constant.name;
        label.title = `${constant.hlslType}${constant.default ? ' (default ' + constant.default + ')' : ''}`;
        row.appendChild(label);

        // Prefer the components read structurally from the AST (offset-free), then the raw text, then
        // the shader's declared default, then a neutral default.
        const numbers =
            (constant.components && constant.components.length ? constant.components.slice() : null) ||
            parseValue(constant.value) ||
            parseValue(constant.default) ||
            defaultFor(constant.kind);

        if (constant.kind === 'vec3' || constant.kind === 'vec4') {
            const normalized = normalizeColor(constant.name, numbers);
            values[constant.name] = normalized;
            const color = document.createElement('input');
            color.type = 'color';
            color.value = toHex(normalized);
            color.oninput = () => {
                const rgb = fromHex(color.value);
                const current = values[constant.name];
                values[constant.name] = [rgb[0], rgb[1], rgb[2], current[3] ?? 1];
            };
            row.appendChild(color);
            if (constant.kind === 'vec4') row.appendChild(slider(0, 1, normalized[3] ?? 1, (a) => (values[constant.name][3] = a)));
        } else if (constant.kind === 'float' || constant.kind === 'int') {
            values[constant.name] = numbers[0];
            const max = Math.max(1, Math.abs(numbers[0]) * 2 || 1, 8 * (/strength|intensity|scale|add/i.test(constant.name) ? 1 : 0));
            row.appendChild(slider(0, max, numbers[0], (n) => (values[constant.name] = n), true));
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
        out.textContent = (+value).toFixed(2);
        range.oninput = () => {
            const n = parseFloat(range.value);
            out.textContent = n.toFixed(2);
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

    /** Maps the server's blend-mode label to one of the preview's blend modes. */
    function resolveBlend(label) {
        if (!label) return 'normal';
        if (/add/i.test(label)) return 'additive';
        if (/premult/i.test(label)) return 'premultiplied';
        if (/mult/i.test(label)) return 'multiply';
        return 'normal';
    }

    /**
     * Builds the stage toolbar: a backdrop selector (an emissive or additive material reads very
     * differently over dark, light, or the checkerboard), a pause toggle, and a blend-mode override so
     * a render can be matched to the game when the resolved mode is approximate.
     */
    function buildToolbar() {
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
            bg.appendChild(option);
        }
        bg.onchange = () => setBackdrop(bg.value);
        bar.appendChild(labelled('Backdrop', bg));

        const blendSel = document.createElement('select');
        blendSel.title = 'Blend mode';
        for (const mode of ['normal', 'additive', 'premultiplied', 'multiply']) {
            const option = document.createElement('option');
            option.value = mode;
            option.textContent = mode;
            if (mode === blend) option.selected = true;
            blendSel.appendChild(option);
        }
        blendSel.onchange = () => (blend = blendSel.value);
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

    /** Applies a freshly received payload: compiles, loads the texture, and rebuilds the controls. */
    async function render(message) {
        const data = message.data;
        values = {};
        startTime = Date.now();
        pausedAccum = 0;
        paused = false;
        textureAspect = 1;
        blend = resolveBlend(data.blendMode);

        // Vertex colour from the material's Color/VertexColor. A particle has none and drives this
        // colour for animation, so default its red channel to mid (full arc) and animate it; a sprite
        // defaults to white (untinted).
        const tintNumbers = parseValue(data.tint);
        animateVertex = !!data.isParticle && !tintNumbers;
        vertexColor = tintNumbers
            ? normalizeColor('color', tintNumbers.concat([1, 1, 1, 1]).slice(0, 4))
            : data.isParticle
              ? [0.5, 1, 1, 1]
              : [1, 1, 1, 1];

        // Emissive boost for the fallback path, from any additive/emissive constant the material sets.
        emissive = 0;
        for (const c of data.constants) {
            if (/emissive|additivestrength/i.test(c.name)) {
                const n = parseValue(c.value);
                if (n) emissive = Math.max(emissive, n[0]);
            }
        }

        dummyTexture = dummyTexture || makeDummy();
        mainTexture = await loadTexture(message.textureUri);

        program = data.translationOk && data.glsl ? link(data.glsl) : null;
        usingFallback = !program;
        if (!program) program = link(FALLBACK_SRC);

        // The stage toolbar (backdrop, blend, pause), the vertex-colour control (a particle's animation
        // input), then one control per constant.
        controlsEl.innerHTML = '';
        controlsEl.appendChild(buildToolbar());
        controlsEl.appendChild(buildVertexColorControl(data.isParticle));
        for (const constant of data.constants) controlsEl.appendChild(buildControl(constant));

        // Status and metadata.
        const note = usingFallback
            ? `Approximate render (${data.translationOk ? 'shader compile failed' : data.reason || 'shader not translatable'}) — texture, tint and blend shown.`
            : 'Live translated shader.';
        const tags = [blend !== 'normal' ? blend : null, data.isParticle ? 'particle: vertex colour animated' : null].filter(
            Boolean
        );
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
