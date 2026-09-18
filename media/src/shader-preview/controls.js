// The live controls beside the stage: the toolbar, the vertex-colour, beam and sprite-sheet rows the
// payload asks for, and one row per shader constant. Every one of them writes straight into the page
// state, so the next frame draws with what the reader just moved.

import { t } from '../shared/strings.js';
import { BLEND_MODES, CLOCK_REPLAY, ENGINE_DEFAULTS } from './constants.js';
import { state } from './state.js';
import { defaultFor, formatNumber, fromHex, normalizeColorFallback, parseValue, toHex } from './values.js';

/**
 * Builds the vertex-colour control. With a particle colour ramp the Animate toggle replays the
 * game's colour-over-lifetime animation; without one a particle still gets a red-channel sweep,
 * and a sprite reads the colour as a plain tint.
 *
 * @param isParticle whether the material sits inside a particle def.
 * @returns the control row.
 */
export function buildVertexColorControl(isParticle) {
    const row = document.createElement('div');
    row.className = 'control';
    const label = document.createElement('label');
    label.textContent = isParticle ? t('Vertex color (anim)') : t('Vertex color');
    label.title = state.particleRamp
        ? t(
              'The particle system animates this colour over each particle’s lifetime (ColorRamp). Uncheck anim to hold a colour.'
          )
        : isParticle
          ? t('A particle drives its effect with per-vertex colour. Red sweeps the animation, alpha is brightness.')
          : t('The material vertex-colour tint.');
    row.appendChild(label);

    const color = document.createElement('input');
    color.type = 'color';
    color.value = toHex(state.vertexColor);
    color.oninput = () => {
        const rgb = fromHex(color.value);
        state.vertexColor = [rgb[0], rgb[1], rgb[2], state.vertexColor[3]];
    };
    row.appendChild(color);
    row.appendChild(slider(0, 1, state.vertexColor[3], (a) => (state.vertexColor[3] = a)));

    if (isParticle) {
        const toggle = document.createElement('label');
        toggle.className = 'animate';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = state.animateVertex;
        box.onchange = () => (state.animateVertex = box.checked);
        toggle.appendChild(box);
        toggle.appendChild(document.createTextNode(' ' + t('anim')));
        row.appendChild(toggle);
    }
    return row;
}

/**
 * Builds the beam control row: the per-vertex intensity and fade the vertex stage would carry.
 *
 * @returns the control row.
 */
export function buildBeamControl() {
    const row = document.createElement('div');
    row.className = 'control';
    const label = document.createElement('label');
    label.textContent = t('Beam');
    label.title = t(
        'The per-vertex beam inputs: intensity scales the effect, fade multiplies alpha over the beam’s life.'
    );
    row.appendChild(label);
    row.appendChild(slider(0, 2, state.beamIntensity, (n) => (state.beamIntensity = n), true));
    row.appendChild(slider(0, 1, state.beamFade, (n) => (state.beamFade = n)));
    return row;
}

/**
 * Builds the sprite-sheet control row: the shown cell, and a cycle toggle replaying the game's
 * animation.
 *
 * @returns the control row.
 */
export function buildSheetControl() {
    const row = document.createElement('div');
    row.className = 'control';
    const label = document.createElement('label');
    label.textContent = t('Sprite cell');
    label.title = t(
        'The particle system picks one cell of the sprite sheet (UvSprites). Cycle replays the animation over the lifetime.'
    );
    row.appendChild(label);
    const cell = slider(
        0,
        state.spriteSheet.count - 1,
        state.sheetCell,
        (n) => (state.sheetCell = Math.round(n)),
        true
    );
    row.appendChild(cell);
    const toggle = document.createElement('label');
    toggle.className = 'animate';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.cycleCells;
    box.onchange = () => (state.cycleCells = box.checked);
    toggle.appendChild(box);
    toggle.appendChild(document.createTextNode(' ' + t('cycle')));
    row.appendChild(toggle);
    return row;
}

/**
 * Builds the editable control row for one constant.
 *
 * @param constant the constant as the server read it.
 * @returns the control row.
 */
export function buildControl(constant) {
    const row = document.createElement('div');
    row.className = 'control';
    const label = document.createElement('label');
    label.textContent = constant.name;
    label.title = constant.default ? t('{0} (default {1})', constant.hlslType, constant.default) : constant.hlslType;
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
        state.values[constant.name] = numbers;
        const color = document.createElement('input');
        color.type = 'color';
        color.value = toHex(numbers);
        color.oninput = () => {
            const rgb = fromHex(color.value);
            const current = state.values[constant.name];
            state.values[constant.name] = [rgb[0], rgb[1], rgb[2], current[3] ?? 1];
        };
        row.appendChild(color);
        if (constant.kind === 'vec4')
            row.appendChild(slider(0, 1, numbers[3] ?? 1, (a) => (state.values[constant.name][3] = a)));
    } else if (constant.kind === 'float' || constant.kind === 'int') {
        state.values[constant.name] = numbers[0];
        // Fit the range (and thereby the step) to the written value's magnitude, so a tiny
        // constant like `_midTexScale = 0.0005` stays adjustable at its own scale instead of
        // snapping to a coarse 0..8 grid. Zero-valued constants get a nominal range.
        const magnitude = Math.abs(numbers[0]);
        const max = magnitude > 0 ? magnitude * 4 : /strength|intensity|scale|add/i.test(constant.name) ? 8 : 1;
        const min = Math.min(0, numbers[0] * 4);
        row.appendChild(slider(min, max, numbers[0], (n) => (state.values[constant.name] = n), true));
        // An engine clock animates by default; unchecking auto hands it to the slider.
        if (CLOCK_REPLAY[constant.name]) {
            state.clockAuto[constant.name] = true;
            const toggle = document.createElement('label');
            toggle.className = 'animate';
            toggle.title = t('Replay the engine clock driving this constant. Uncheck to set it manually.');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = true;
            box.onchange = () => (state.clockAuto[constant.name] = box.checked);
            toggle.appendChild(box);
            toggle.appendChild(document.createTextNode(' ' + t('auto')));
            row.appendChild(toggle);
        }
    } else if (constant.kind === 'vec2') {
        state.values[constant.name] = numbers;
        row.appendChild(numberInput(numbers[0] ?? 0, (n) => (state.values[constant.name][0] = n)));
        row.appendChild(numberInput(numbers[1] ?? 0, (n) => (state.values[constant.name][1] = n)));
    } else {
        const tag = document.createElement('span');
        tag.className = 'kind';
        tag.textContent = constant.kind;
        row.appendChild(tag);
    }
    return row;
}

/**
 * A labelled range slider that mirrors its value into a number box and reports changes.
 *
 * @param min the lowest value.
 * @param max the highest value.
 * @param value the starting value.
 * @param onChange called with the new value on every move.
 * @param showValue whether the number box is shown beside the slider.
 * @returns the slider.
 */
export function slider(min, max, value, onChange, showValue) {
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

/**
 * A plain number box reporting its value as it is typed.
 *
 * @param value the starting value.
 * @param onChange called with the new value on every edit.
 * @returns the number box.
 */
export function numberInput(value, onChange) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'numinput';
    input.value = String(value);
    input.oninput = () => onChange(parseFloat(input.value) || 0);
    return input;
}

/**
 * Builds the stage toolbar: a backdrop selector (an emissive or additive material reads very
 * differently over dark, light, or the checkerboard), a pause toggle, and a blend-mode override
 * offering the engine's named modes.
 *
 * @param initialBackdrop the backdrop the stage starts on.
 * @returns the toolbar.
 */
export function buildToolbar(initialBackdrop) {
    const bar = document.createElement('div');
    bar.className = 'toolbar';

    const bg = document.createElement('select');
    bg.title = t('Preview backdrop');
    for (const [value, text] of [
        ['checker', t('Checker')],
        ['dark', t('Dark')],
        ['light', t('Light')],
        ['mid', t('Grey')],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (value === initialBackdrop) option.selected = true;
        bg.appendChild(option);
    }
    bg.onchange = () => setBackdrop(bg.value);
    setBackdrop(initialBackdrop);
    bar.appendChild(labelled(t('Backdrop'), bg));

    const blendSel = document.createElement('select');
    blendSel.title = t('Blend mode (the material’s resolved mode, overridable)');
    const fromMaterial = document.createElement('option');
    fromMaterial.value = '';
    fromMaterial.textContent = t('material');
    blendSel.appendChild(fromMaterial);
    for (const mode of Object.keys(BLEND_MODES)) {
        const option = document.createElement('option');
        option.value = mode;
        option.textContent = mode;
        blendSel.appendChild(option);
    }
    blendSel.onchange = () => (state.blendOverride = blendSel.value || null);
    bar.appendChild(labelled(t('Blend'), blendSel));

    const pause = document.createElement('button');
    pause.textContent = t('Pause');
    pause.onclick = () => {
        state.paused = !state.paused;
        if (state.paused) state.pauseStartedAt = Date.now();
        else {
            state.pausedAccum += Date.now() - state.pauseStartedAt;
        }
        pause.textContent = state.paused ? t('Play') : t('Pause');
    };
    bar.appendChild(pause);
    return bar;
}

/**
 * Wraps a control in a small labelled span for the toolbar.
 *
 * @param text the label.
 * @param control the control to wrap.
 * @returns the labelled span.
 */
export function labelled(text, control) {
    const span = document.createElement('span');
    span.className = 'tool';
    const label = document.createElement('span');
    label.textContent = text;
    span.appendChild(label);
    span.appendChild(control);
    return span;
}

/**
 * Switches the stage backdrop the canvas composes over.
 *
 * @param kind the backdrop's name.
 */
export function setBackdrop(kind) {
    const stage = document.getElementById('stage');
    stage.className = kind === 'checker' ? '' : 'bg-' + kind;
}
