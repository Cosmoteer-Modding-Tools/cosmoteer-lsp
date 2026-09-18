// Reading and writing the numbers a control shows: evaluating a written constant, normalizing a
// colour, picking a neutral default for a kind, and the formatting the sliders and colour boxes
// need. Pure arithmetic and text, so nothing here touches the document or the context.

/**
 * Safely evaluates a numeric expression (numbers and arithmetic only), or NaN.
 *
 * @param expr the written expression.
 * @returns the value, or NaN when the text is not arithmetic or does not evaluate.
 */
export function evalNumber(expr) {
    const trimmed = String(expr).trim();
    if (!/^[-+*/().\d\s]+$/.test(trimmed)) return NaN;
    try {
        return Function('"use strict"; return (' + trimmed + ')')();
    } catch {
        return NaN;
    }
}

/**
 * Parses a written constant value (`0.2`, `[255, 0, 0, 255]`, `{Rf=1 Gf=0 …}`) into numbers.
 *
 * @param raw the written value.
 * @returns the numbers, or null when none could be read.
 */
export function parseValue(raw) {
    if (raw == null) return null;
    const text = String(raw).trim();
    let parts;
    if (text.indexOf('=') >= 0) {
        // Group form `{Rf=1 Gf=0 …}`: take the value after each `=`.
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
 *
 * @param numbers the parsed numbers.
 * @param isColor whether the constant is a colour.
 * @returns the numbers in the 0–1 space.
 */
export function normalizeColorFallback(numbers, isColor) {
    if (!numbers || !isColor) return numbers;
    const max = Math.max.apply(null, numbers);
    // Group text with float channels (`Rf = …`) is already 0–1; byte forms exceed that range.
    if (max > 1.5) return numbers.map((n) => n / 255);
    return numbers;
}

/**
 * The neutral starting value of a constant kind.
 *
 * @param kind the constant's kind.
 * @returns the numbers to start its control at.
 */
export function defaultFor(kind) {
    if (kind === 'vec4') return [1, 1, 1, 1];
    if (kind === 'vec3') return [1, 1, 1];
    if (kind === 'vec2') return [1, 1];
    return [0];
}

/**
 * Formats a control value with enough precision for its magnitude (`0.0005` stays `0.0005`).
 *
 * @param n the value.
 * @returns the text to show beside the slider.
 */
export function formatNumber(n) {
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs >= 100) return n.toFixed(0);
    if (abs >= 1) return String(+n.toFixed(2));
    return String(+n.toPrecision(3));
}

/**
 * The hex spelling a colour input takes.
 *
 * @param rgb the colour's channels in the 0–1 space.
 * @returns the `#rrggbb` text.
 */
export function toHex(rgb) {
    const h = (n) => ('0' + Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16)).slice(-2);
    return '#' + h(rgb[0]) + h(rgb[1] ?? 0) + h(rgb[2] ?? 0);
}

/**
 * The channels behind a colour input's hex spelling.
 *
 * @param hex the `#rrggbb` text.
 * @returns the red, green and blue channels in the 0–1 space.
 */
export function fromHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
