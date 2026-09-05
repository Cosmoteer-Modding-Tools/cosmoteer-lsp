import { deflateSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import { crc32, decodePng, encodePng } from '../../src/utils/png';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A chunk in wire shape, so the tests can assemble pictures the encoder never writes.
 *
 * @param type the four-letter chunk type.
 * @param data the payload.
 * @returns the chunk bytes.
 */
const chunk = (type: string, data: Uint8Array): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    out.set(data, 8);
    out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
    return out;
};

/** What a hand-built picture is made of. */
interface Picture {
    width: number;
    height: number;
    colorType: number;
    /** The samples, packed row after row without filter bytes. */
    samples: Uint8Array;
    /** The filter type applied to each row, all zero when absent. */
    filters?: number[];
    palette?: Uint8Array;
    transparency?: Uint8Array;
}

/**
 * Applies the row filters to the samples the way an encoder would, so the decoder has to undo them.
 *
 * @param picture the picture, with the filter to use per row.
 * @param bpp the bytes per pixel.
 * @returns the filtered stream, each row led by its filter byte.
 */
const filterRows = (picture: Picture, bpp: number): Buffer => {
    const { width, height, samples } = picture;
    const stride = width * bpp;
    const out = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        const filter = picture.filters?.[y] ?? 0;
        out[y * (stride + 1)] = filter;
        for (let i = 0; i < stride; i++) {
            const here = samples[y * stride + i];
            const left = i >= bpp ? samples[y * stride + i - bpp] : 0;
            const up = y > 0 ? samples[(y - 1) * stride + i] : 0;
            const upLeft = y > 0 && i >= bpp ? samples[(y - 1) * stride + i - bpp] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = (left + up) >> 1;
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - up);
                const pc = Math.abs(p - upLeft);
                predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            }
            out[y * (stride + 1) + 1 + i] = (here - predictor) & 0xff;
        }
    }
    return out;
};

/**
 * Builds a complete PNG file out of its parts.
 *
 * @param picture the picture.
 * @returns the file bytes.
 */
const buildPng = (picture: Picture): Buffer => {
    const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[picture.colorType] ?? 1;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(picture.width, 0);
    ihdr.writeUInt32BE(picture.height, 4);
    ihdr[8] = 8;
    ihdr[9] = picture.colorType;
    const chunks = [SIGNATURE, chunk('IHDR', ihdr)];
    if (picture.palette) chunks.push(chunk('PLTE', picture.palette));
    if (picture.transparency) chunks.push(chunk('tRNS', picture.transparency));
    chunks.push(chunk('IDAT', deflateSync(filterRows(picture, bpp))), chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(chunks);
};

/**
 * A deterministic RGBA test picture with gradients in every channel, so every filter has something to predict.
 *
 * @param width the width in pixels.
 * @param height the height in pixels.
 * @returns the pixels.
 */
const gradient = (width: number, height: number): Uint8Array => {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            rgba[i] = (x * 37) & 0xff;
            rgba[i + 1] = (y * 53) & 0xff;
            rgba[i + 2] = (x * y * 11) & 0xff;
            rgba[i + 3] = (255 - x - y) & 0xff;
        }
    }
    return rgba;
};

describe('encoding a png', () => {
    it('writes the signature, a header, one data chunk and the end marker', () => {
        const bytes = encodePng(3, 2, gradient(3, 2));
        expect(bytes.subarray(0, 8)).toEqual(SIGNATURE);
        expect(bytes.toString('latin1', 12, 16)).toBe('IHDR');
        expect(bytes.readUInt32BE(16)).toBe(3);
        expect(bytes.readUInt32BE(20)).toBe(2);
        expect(bytes[24]).toBe(8);
        expect(bytes[25]).toBe(6);
        expect(bytes.toString('latin1', 37, 41)).toBe('IDAT');
        expect(bytes.toString('latin1', bytes.length - 8, bytes.length - 4)).toBe('IEND');
    });

    it('checksums every chunk', () => {
        const bytes = encodePng(3, 2, gradient(3, 2));
        let offset = 8;
        const types: string[] = [];
        while (offset < bytes.length) {
            const length = bytes.readUInt32BE(offset);
            const end = offset + 12 + length;
            expect(bytes.readUInt32BE(end - 4)).toBe(crc32(bytes, offset + 4, end - 4));
            types.push(bytes.toString('latin1', offset + 4, offset + 8));
            offset = end;
        }
        expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
    });

    it('agrees with the reference checksum of the IEND chunk', () => {
        // The empty IEND chunk's checksum is a published constant.
        expect(crc32(Buffer.from('IEND', 'latin1'))).toBe(0xae426082);
    });

    it('refuses pixels that do not fit the dimensions', () => {
        expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(RangeError);
        expect(() => encodePng(0, 2, new Uint8Array(0))).toThrow(RangeError);
    });
});

describe('decoding a png', () => {
    it('reads back what the encoder wrote', () => {
        const rgba = gradient(17, 9);
        const decoded = decodePng(encodePng(17, 9, rgba));
        expect(decoded?.width).toBe(17);
        expect(decoded?.height).toBe(9);
        expect(decoded?.rgba).toEqual(rgba);
    });

    it.each([0, 1, 2, 3, 4])('undoes filter type %i on every row', (filter) => {
        const rgba = gradient(11, 7);
        const bytes = buildPng({ width: 11, height: 7, colorType: 6, samples: rgba, filters: Array(7).fill(filter) });
        expect(decodePng(bytes)?.rgba).toEqual(rgba);
    });

    it('undoes a different filter on each row', () => {
        const rgba = gradient(8, 10);
        const filters = [0, 1, 2, 3, 4, 4, 3, 2, 1, 0];
        const bytes = buildPng({ width: 8, height: 10, colorType: 6, samples: rgba, filters });
        expect(decodePng(bytes)?.rgba).toEqual(rgba);
    });

    it('expands grayscale to opaque gray', () => {
        const bytes = buildPng({ width: 2, height: 1, colorType: 0, samples: Uint8Array.of(0, 200), filters: [1] });
        expect(decodePng(bytes)?.rgba).toEqual(Uint8Array.of(0, 0, 0, 255, 200, 200, 200, 255));
    });

    it('applies a grayscale colour key', () => {
        const bytes = buildPng({
            width: 2,
            height: 1,
            colorType: 0,
            samples: Uint8Array.of(0, 200),
            transparency: Uint8Array.of(0, 200),
        });
        expect(decodePng(bytes)?.rgba).toEqual(Uint8Array.of(0, 0, 0, 255, 200, 200, 200, 0));
    });

    it('expands rgb to opaque colour', () => {
        const samples = Uint8Array.of(10, 20, 30, 40, 50, 60);
        const bytes = buildPng({ width: 1, height: 2, colorType: 2, samples, filters: [0, 2] });
        expect(decodePng(bytes)?.rgba).toEqual(Uint8Array.of(10, 20, 30, 255, 40, 50, 60, 255));
    });

    it('applies an rgb colour key', () => {
        const samples = Uint8Array.of(10, 20, 30, 40, 50, 60);
        const transparency = Uint8Array.of(0, 40, 0, 50, 0, 60);
        const bytes = buildPng({ width: 2, height: 1, colorType: 2, samples, transparency });
        expect(decodePng(bytes)?.rgba).toEqual(Uint8Array.of(10, 20, 30, 255, 40, 50, 60, 0));
    });

    it('looks palette entries up, with the transparency chunk giving their alpha', () => {
        const palette = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255);
        const bytes = buildPng({
            width: 3,
            height: 1,
            colorType: 3,
            samples: Uint8Array.of(2, 0, 1),
            palette,
            transparency: Uint8Array.of(128),
        });
        expect(decodePng(bytes)?.rgba).toEqual(Uint8Array.of(0, 0, 255, 255, 255, 0, 0, 128, 0, 255, 0, 255));
    });

    it('answers nothing for a palette index past the palette', () => {
        const palette = Uint8Array.of(255, 0, 0);
        const bytes = buildPng({ width: 1, height: 1, colorType: 3, samples: Uint8Array.of(1), palette });
        expect(decodePng(bytes)).toBeUndefined();
    });

    it('expands gray with alpha', () => {
        const bytes = buildPng({ width: 1, height: 1, colorType: 4, samples: Uint8Array.of(77, 99) });
        expect(decodePng(bytes)?.rgba).toEqual(Uint8Array.of(77, 77, 77, 99));
    });

    it('answers nothing for another format', () => {
        expect(decodePng(Buffer.alloc(0))).toBeUndefined();
        expect(decodePng(Buffer.from('not a png at all, just some text'))).toBeUndefined();
    });

    it('answers nothing for a file cut short', () => {
        const bytes = encodePng(5, 5, gradient(5, 5));
        for (const length of [8, 20, 33, bytes.length - 13, bytes.length - 1]) {
            expect(decodePng(bytes.subarray(0, length))).toBeUndefined();
        }
    });

    it('answers nothing when a checksum does not match', () => {
        const bytes = encodePng(5, 5, gradient(5, 5));
        bytes[bytes.length - 1] ^= 0xff;
        expect(decodePng(bytes)).toBeUndefined();
    });

    it('answers nothing for a damaged data stream', () => {
        const bytes = encodePng(5, 5, gradient(5, 5));
        // The IDAT payload starts after the 33 header bytes and its own 8-byte chunk head.
        bytes[43] ^= 0xff;
        const idatEnd = 41 + bytes.readUInt32BE(33);
        bytes.writeUInt32BE(crc32(bytes, 37, idatEnd), idatEnd);
        expect(decodePng(bytes)).toBeUndefined();
    });

    it('answers nothing for a stream holding the wrong number of rows', () => {
        const stream = filterRows({ width: 2, height: 1, colorType: 6, samples: new Uint8Array(8) }, 4);
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(2, 0);
        ihdr.writeUInt32BE(3, 4);
        ihdr[8] = 8;
        ihdr[9] = 6;
        const bytes = Buffer.concat([
            SIGNATURE,
            chunk('IHDR', ihdr),
            chunk('IDAT', deflateSync(stream)),
            chunk('IEND', Buffer.alloc(0)),
        ]);
        expect(decodePng(bytes)).toBeUndefined();
    });

    it('answers nothing for an unknown filter type', () => {
        const bytes = buildPng({ width: 2, height: 1, colorType: 6, samples: new Uint8Array(8), filters: [5] });
        expect(decodePng(bytes)).toBeUndefined();
    });

    it.each([
        ['a sixteen bit depth', (ihdr: Buffer) => (ihdr[8] = 16)],
        ['an interlaced layout', (ihdr: Buffer) => (ihdr[12] = 1)],
        ['a color type it does not know', (ihdr: Buffer) => (ihdr[9] = 5)],
        ['a zero width', (ihdr: Buffer) => ihdr.writeUInt32BE(0, 0)],
    ])('answers nothing for %s', (_, tweak) => {
        const bytes = encodePng(2, 2, gradient(2, 2));
        const ihdr = Buffer.from(bytes.subarray(16, 29));
        tweak(ihdr);
        const rewritten = Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), bytes.subarray(33)]);
        expect(decodePng(rewritten)).toBeUndefined();
    });

    it('answers nothing when the header is not the first chunk', () => {
        const bytes = encodePng(2, 2, gradient(2, 2));
        const swapped = Buffer.concat([SIGNATURE, bytes.subarray(33, bytes.length - 12), bytes.subarray(8, 33)]);
        expect(decodePng(swapped)).toBeUndefined();
    });

    it('answers nothing for a palette picture without a palette', () => {
        const bytes = buildPng({ width: 1, height: 1, colorType: 3, samples: Uint8Array.of(0) });
        expect(decodePng(bytes)).toBeUndefined();
    });
});
