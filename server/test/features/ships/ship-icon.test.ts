import { describe, expect, it } from 'vitest';
import { decodePng } from '../../../src/utils/png';
import {
    IconPart,
    STASIS_ICON_SIZE,
    rasterize,
    renderStasisIcon,
    stasisIconPng,
} from '../../../src/features/ships/ship-icon';

/**
 * A placed part.
 *
 * @param x the left cell.
 * @param y the top cell.
 * @param width the unrotated width in cells.
 * @param height the unrotated height in cells.
 * @param rotation the quarter turns.
 * @returns the part.
 */
const part = (x: number, y: number, width: number, height: number, rotation = 0): IconPart => ({
    x,
    y,
    rotation,
    width,
    height,
});

/**
 * The pixel bounds of everything painted on a coverage plane.
 *
 * @param coverage the plane.
 * @param size the square plane size.
 * @returns the painted rows and columns, inclusive.
 */
const bounds = (coverage: Float32Array, size: number): { left: number; right: number; top: number; bottom: number } => {
    let left = size;
    let right = -1;
    let top = size;
    let bottom = -1;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (coverage[y * size + x] === 0) continue;
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
        }
    }
    return { left, right, top, bottom };
};

describe('painting the silhouette', () => {
    it('paints nothing for no parts', () => {
        expect(rasterize([], 16)).toBeUndefined();
        expect(renderStasisIcon([])).toBeUndefined();
        expect(stasisIconPng([])).toBeUndefined();
    });

    it('turns a 2x1 part into a 1x2 footprint for a quarter turn', () => {
        // A 16 pixel canvas with a 2 cell bounding side gives 6 pixels per cell, 12 pixels for the footprint.
        const coverage = rasterize([part(0, 0, 2, 1, 1)], 16)!;
        expect(bounds(coverage, 16)).toEqual({ left: 5, right: 10, top: 2, bottom: 13 });
    });

    it('keeps a 2x1 part 2x1 for a half turn', () => {
        const coverage = rasterize([part(0, 0, 2, 1, 2)], 16)!;
        expect(bounds(coverage, 16)).toEqual({ left: 2, right: 13, top: 5, bottom: 10 });
    });

    it('centres the ship and stretches its larger side across three quarters of the canvas', () => {
        const size = STASIS_ICON_SIZE;
        // A ship 8 cells wide and 4 tall, placed away from the origin so the centring is not trivial.
        const coverage = rasterize([part(3, -5, 4, 2), part(7, -5, 4, 2), part(3, -3, 8, 2)], size)!;
        const { left, right, top, bottom } = bounds(coverage, size);
        const width = right - left + 1;
        const height = bottom - top + 1;
        expect(width).toBe(size * 0.75);
        expect(height).toBe(size * 0.375);
        expect(left).toBe(size - 1 - right);
        expect(top).toBe(size - 1 - bottom);
    });

    it('leaves the holes between parts unpainted', () => {
        // Two single cells with a gap between them span three cells, so each pixel lands in one of three bands.
        const coverage = rasterize([part(0, 0, 1, 1), part(2, 0, 1, 1)], 16)!;
        const row = Array.from(coverage.subarray(8 * 16, 9 * 16));
        expect(row.slice(2, 6)).toEqual([1, 1, 1, 1]);
        expect(row.slice(6, 10)).toEqual([0, 0, 0, 0]);
        expect(row.slice(10, 14)).toEqual([1, 1, 1, 1]);
    });
});

describe('rendering the stasis icon', () => {
    const icon = renderStasisIcon([part(0, 0, 4, 4), part(4, 0, 4, 4), part(0, 4, 8, 4)])!;

    it('is the icon size the game renders at', () => {
        expect(icon.width).toBe(208);
        expect(icon.height).toBe(208);
        expect(icon.rgba.length).toBe(208 * 208 * 4);
    });

    it('stays white everywhere, the shape living in the alpha channel', () => {
        for (let i = 0; i < icon.rgba.length; i += 4) {
            if (icon.rgba[i] !== 255 || icon.rgba[i + 1] !== 255 || icon.rgba[i + 2] !== 255) {
                throw new Error(`pixel ${i / 4} is not white`);
            }
        }
    });

    it('is fully opaque at the centre and transparent in the corners', () => {
        const centre = (104 * 208 + 104) * 4 + 3;
        expect(icon.rgba[centre]).toBe(255);
        expect(icon.rgba[3]).toBe(0);
        expect(icon.rgba[(207 * 208 + 207) * 4 + 3]).toBe(0);
    });

    it('glows past the silhouette edge', () => {
        // The silhouette's left edge sits at pixel 26. A few pixels outside it the blur still leaves some alpha.
        const outside = (104 * 208 + 23) * 4 + 3;
        expect(icon.rgba[outside]).toBeGreaterThan(0);
        expect(icon.rgba[outside]).toBeLessThan(255);
    });

    it('writes a png the decoder reads back at the icon size', () => {
        const decoded = decodePng(stasisIconPng([part(0, 0, 2, 2)])!);
        expect(decoded?.width).toBe(208);
        expect(decoded?.height).toBe(208);
        expect(decoded?.rgba[(104 * 208 + 104) * 4 + 3]).toBe(255);
    });
});
