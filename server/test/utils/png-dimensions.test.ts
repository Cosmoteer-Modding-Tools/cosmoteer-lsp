import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pngDimensions, clearPngDimensionsCache } from '../../src/utils/png-dimensions';
import { invalidateFsPath } from '../../src/workspace/fs-cache';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A header-only PNG, which is all the reader ever looks at. */
const png = (width: number, height: number): Buffer => {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'latin1');
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([Buffer.concat([SIGNATURE, header.subarray(8)]), ihdr]);
};

let dir = '';

describe('pngDimensions', () => {
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'png-dimensions-'));
        clearPngDimensionsCache();
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('reads the width and height out of the header', async () => {
        const file = join(dir, 'wide.png');
        writeFileSync(file, png(128, 64));
        expect(await pngDimensions(file)).toEqual({ width: 128, height: 64 });
    });

    it('answers nothing for a file that is not there', async () => {
        expect(await pngDimensions(join(dir, 'absent.png'))).toBeNull();
    });

    it('answers nothing for a file too short to hold a header', async () => {
        const file = join(dir, 'short.png');
        writeFileSync(file, SIGNATURE);
        expect(await pngDimensions(file)).toBeNull();
    });

    it('answers nothing for another format carrying a png name', async () => {
        const file = join(dir, 'not_a_png.png');
        writeFileSync(file, Buffer.alloc(64, 0x42));
        expect(await pngDimensions(file)).toBeNull();
    });

    it('answers nothing when the first chunk is not the header', async () => {
        const file = join(dir, 'no_ihdr.png');
        const bytes = png(128, 64);
        bytes.write('IDAT', 12, 'latin1');
        writeFileSync(file, bytes);
        expect(await pngDimensions(file)).toBeNull();
    });

    it('serves the same file from memory until the filesystem caches are dropped', async () => {
        const file = join(dir, 'replaced.png');
        writeFileSync(file, png(64, 64));
        expect(await pngDimensions(file)).toEqual({ width: 64, height: 64 });
        writeFileSync(file, png(256, 128));
        expect(await pngDimensions(file)).toEqual({ width: 64, height: 64 });
        invalidateFsPath(file);
        expect(await pngDimensions(file)).toEqual({ width: 256, height: 128 });
    });
});
