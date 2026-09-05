import { encodePng } from '../../utils/png';

// The game draws a station's stasis icon (ShipRenderer.RefreshIcon with ShipIconType.Indicator) by
// painting every part's footprint white onto a transparent target and blurring the result until the
// edges glow. This module replays that pipeline on the CPU from a saved ship's part list so the
// server can hand out the same picture without the game: the target is 78 pixels requested, scaled
// by 1 / ShipIconGlowShipScale * 2 to 208, the ship's bounding rect is fitted so its larger side
// covers three quarters of the target, and the glow is the game's ship_icon_glow.shader run
// ceil(5/128 * size) times, each time once across and once down.

/** One placed part: its top-left cell, its quarter-turn rotation and its unrotated size in cells. */
export interface IconPart {
    readonly x: number;
    readonly y: number;
    readonly rotation: number;
    readonly width: number;
    readonly height: number;
}

/** A rendered icon, four bytes per pixel in row-major order. */
export interface IconImage {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
}

/** The target size in pixels: 78 requested, divided by the 0.75 glow ship scale and doubled. */
export const STASIS_ICON_SIZE = 208;

/** The share of the target the ship's larger side is stretched to, ShipIconGlowShipScale in the game. */
const SHIP_SCALE = 0.75;

/** The blur's tap weights, the centre first, then the two symmetric offsets. */
const WEIGHTS = [0.227027027, 0.3162162162, 0.0702702703] as const;

/** The blur's tap offsets in pixels, matching the weights above. */
const OFFSETS = [0, 1.3846153846, 3.2307692308] as const;

/** The footprint a part covers in cells, after its rotation. */
interface CellRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/**
 * The cells a part covers, with the size swapped for quarter turns.
 *
 * @param part the placed part.
 * @returns its axis-aligned footprint.
 */
const footprint = (part: IconPart): CellRect => {
    const turned = ((part.rotation % 4) + 4) % 4;
    const swap = turned === 1 || turned === 3;
    return { x: part.x, y: part.y, width: swap ? part.height : part.width, height: swap ? part.width : part.height };
};

/**
 * Paints the parts' footprints as a coverage plane, one where a pixel's centre falls inside a part.
 *
 * @param parts the placed parts.
 * @param size the square target size in pixels.
 * @returns the coverage per pixel in row-major order, or undefined when there is nothing to paint.
 */
export const rasterize = (parts: readonly IconPart[], size: number): Float32Array | undefined => {
    const rects = parts.map(footprint).filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return undefined;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const rect of rects) {
        minX = Math.min(minX, rect.x);
        minY = Math.min(minY, rect.y);
        maxX = Math.max(maxX, rect.x + rect.width);
        maxY = Math.max(maxY, rect.y + rect.height);
    }
    // The bounding rect's larger side spans SHIP_SCALE of the target and its centre sits on the target's centre.
    const pixelsPerCell = (size * SHIP_SCALE) / Math.max(maxX - minX, maxY - minY);
    const originX = size / 2 - ((minX + maxX) / 2) * pixelsPerCell;
    const originY = size / 2 - ((minY + maxY) / 2) * pixelsPerCell;
    const coverage = new Float32Array(size * size);
    for (const rect of rects) {
        const left = originX + rect.x * pixelsPerCell;
        const right = left + rect.width * pixelsPerCell;
        const top = originY + rect.y * pixelsPerCell;
        const bottom = top + rect.height * pixelsPerCell;
        // A pixel is inside when its centre is, so the first pixel is the one whose centre reaches past the edge.
        const x0 = Math.max(0, Math.ceil(left - 0.5));
        const x1 = Math.min(size, Math.ceil(right - 0.5));
        const y0 = Math.max(0, Math.ceil(top - 0.5));
        const y1 = Math.min(size, Math.ceil(bottom - 0.5));
        for (let y = y0; y < y1; y++) coverage.fill(1, y * size + x0, y * size + x1);
    }
    return coverage;
};

/**
 * Reads a plane along one line with linear filtering and clamp-to-edge, as the GPU samples a texture.
 *
 * @param plane the values.
 * @param base the index of the line's first value.
 * @param step the index distance between neighbours on the line.
 * @param length the values on the line.
 * @param position the sample position in pixels, where pixel `i` is centred on `i + 0.5`.
 * @returns the interpolated value.
 */
const sample = (plane: Float32Array, base: number, step: number, length: number, position: number): number => {
    const t = position - 0.5;
    const i0 = Math.floor(t);
    const frac = t - i0;
    const a = plane[base + Math.min(length - 1, Math.max(0, i0)) * step];
    const b = plane[base + Math.min(length - 1, Math.max(0, i0 + 1)) * step];
    return a + (b - a) * frac;
};

/**
 * One pass of the game's five-tap gaussian along one axis, from one plane into another.
 *
 * @param from the plane read.
 * @param to the plane written.
 * @param size the square plane size.
 * @param horizontal whether the taps are spread across a row rather than down a column.
 */
const blurPass = (from: Float32Array, to: Float32Array, size: number, horizontal: boolean): void => {
    const step = horizontal ? 1 : size;
    for (let line = 0; line < size; line++) {
        const base = horizontal ? line * size : line;
        for (let i = 0; i < size; i++) {
            const centre = i + 0.5;
            let value = sample(from, base, step, size, centre) * WEIGHTS[0];
            for (let tap = 1; tap < WEIGHTS.length; tap++) {
                value += sample(from, base, step, size, centre + OFFSETS[tap]) * WEIGHTS[tap];
                value += sample(from, base, step, size, centre - OFFSETS[tap]) * WEIGHTS[tap];
            }
            to[base + i * step] = value;
        }
    }
};

/**
 * Renders the stasis icon: the white silhouette on a transparent ground, blurred into a glow.
 *
 * @param parts the placed parts.
 * @param size the square target size in pixels.
 * @returns the picture, or undefined when there are no parts to draw.
 */
export const renderStasisIcon = (parts: readonly IconPart[], size = STASIS_ICON_SIZE): IconImage | undefined => {
    const silhouette = rasterize(parts, size);
    if (!silhouette) return undefined;
    const alpha = Float32Array.from(silhouette);
    const scratch = new Float32Array(size * size);
    const iterations = Math.ceil((5 / 128) * size);
    for (let i = 0; i < iterations; i++) {
        // Across into the scratch plane, then down and back, so each iteration ends in the alpha plane.
        blurPass(alpha, scratch, size, true);
        blurPass(scratch, alpha, size, false);
    }
    // The game draws the ghost once more over the blurred copy, so the ship itself stays crisp and
    // the blur only shows past its edges as the halo. White over white leaves only the alpha to
    // compose: the silhouette where it is, the halo where it is not.
    // Every pixel is white and only its alpha carries the shape, so the colour channels are constant.
    const rgba = new Uint8Array(size * size * 4).fill(255);
    for (let i = 0; i < alpha.length; i++) {
        const composed = silhouette[i] + alpha[i] * (1 - silhouette[i]);
        rgba[i * 4 + 3] = Math.min(255, Math.max(0, Math.round(composed * 255)));
    }
    return { width: size, height: size, rgba };
};

/**
 * The stasis icon as PNG bytes, the shape the game keeps beside a station's ship file.
 *
 * @param parts the placed parts.
 * @returns the file bytes, or undefined when there are no parts to draw.
 */
export const stasisIconPng = (parts: readonly IconPart[]): Buffer | undefined => {
    const icon = renderStasisIcon(parts);
    return icon ? encodePng(icon.width, icon.height, icon.rgba) : undefined;
};
