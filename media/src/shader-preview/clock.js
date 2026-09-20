// The animation clock and what it drives: how far into the particle's lifetime the preview is, which
// sprite-sheet cell that lands on, and the colour the ramp has reached.

import { state } from './state.js';

/**
 * Milliseconds of animation time elapsed, holding steady while the preview is paused.
 *
 * @returns the elapsed milliseconds.
 */
export function elapsedMs() {
    const frozen = state.paused ? Date.now() - state.pauseStartedAt : 0;
    return Date.now() - state.startTime - state.pausedAccum - frozen;
}

/**
 * The particle's normalized lifetime position this frame, looping so the preview replays it.
 *
 * @returns the position, from 0 to 1.
 */
export function lifeT() {
    return (elapsedMs() / 1000 / state.particleLifetime) % 1;
}

/**
 * The active sprite-sheet cell as a UV sub-rect [u, v, w, h] (top-origin, like the game's UVs).
 * Cycles through the cells over the particle lifetime when animating, else holds the picked cell.
 *
 * @returns the sub-rect.
 */
export function sheetUvRect() {
    if (!state.spriteSheet) return [0, 0, 1, 1];
    const index = state.cycleCells
        ? Math.min(Math.floor(lifeT() * state.spriteSheet.count), state.spriteSheet.count - 1)
        : Math.min(state.sheetCell, state.spriteSheet.count - 1);
    const col = index % state.spriteSheet.perRow;
    const row = Math.floor(index / state.spriteSheet.perRow);
    const [tw, th] = state.spriteSheet.textureSize;
    const [sw, sh] = state.spriteSheet.spriteSize;
    const [ox, oy] = state.spriteSheet.offset;
    return [(ox + col * sw) / tw, (oy + row * sh) / th, sw / tw, sh / th];
}

/**
 * Lerps across the ramp colours at a normalized position, the way the game's ColorRamp does.
 *
 * @param colors the ramp's colours.
 * @param t the position, from 0 to 1.
 * @returns the colour at that position.
 */
export function rampAt(colors, t) {
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
 *
 * @returns the colour's four channels.
 */
export function effectiveVertexColor() {
    if (state.animateVertex && state.particleRamp) {
        const cycle = lifeT();
        const t = state.particleRamp.invert ? 1 - cycle : cycle;
        const ramp = rampAt(state.particleRamp.colors, t);
        return [
            ramp[0] * state.materialTint[0],
            ramp[1] * state.materialTint[1],
            ramp[2] * state.materialTint[2],
            ramp[3] * state.materialTint[3],
        ];
    }
    if (!state.animateVertex) return state.vertexColor;
    const sweep = (elapsedMs() / 3000) % 1; // 0 → 1 over three seconds
    return [sweep, state.vertexColor[1], state.vertexColor[2], state.vertexColor[3]];
}
