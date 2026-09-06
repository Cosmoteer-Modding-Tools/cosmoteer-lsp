import { deflateSync, inflateSync } from 'zlib';

// A minimal PNG codec, enough to write the pictures the server generates itself and to read the
// pictures the game writes (ship files are PNGs). No third-party image library is pulled in for
// this because the two operations needed are small and their format is fully specified: encoding
// always produces the one shape the server needs (8-bit RGBA, no interlace, unfiltered rows) and
// decoding accepts the 8-bit non-interlaced shapes an image editor is likely to save, expanding
// each to RGBA so callers never see the source layout.

/** A decoded picture, always expanded to four bytes per pixel in row-major order. */
export interface RgbaImage {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
}

/** The eight bytes every PNG opens with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The pixels the decoder is willing to expand, so a header claiming a giant image cannot exhaust memory. */
const MAX_PIXELS = 16_777_216;

/** Bytes per sample for each supported color type, indexed by color type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The lookup table of the standard reflected CRC-32 (polynomial 0xedb88320) every chunk is checked with. */
const CRC_TABLE = ((): Uint32Array => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/**
 * The CRC-32 of a byte range, as PNG chunks carry it.
 *
 * @param bytes the bytes to sum.
 * @param start the first byte included.
 * @param end the byte after the last one included.
 * @returns the checksum as an unsigned 32-bit number.
 */
export const crc32 = (bytes: Uint8Array, start = 0, end = bytes.length): number => {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

/**
 * One chunk in wire shape: length, type, data and the checksum over type and data.
 *
 * @param type the four-letter chunk type.
 * @param data the chunk payload.
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

/**
 * Writes an 8-bit RGBA picture as a PNG: one IHDR, one IDAT holding every row unfiltered, one IEND.
 *
 * @param width the picture width in pixels.
 * @param height the picture height in pixels.
 * @param rgba the pixels, four bytes each in row-major order.
 * @returns the file bytes.
 */
export const encodePng = (width: number, height: number, rgba: Uint8Array): Buffer => {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new RangeError(`A PNG needs positive integer dimensions, got ${width}x${height}`);
    }
    const stride = width * 4;
    if (rgba.length !== stride * height) {
        throw new RangeError(`A ${width}x${height} RGBA picture needs ${stride * height} bytes, got ${rgba.length}`);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    // Compression method, filter method and interlace method are all zero, the only values defined.
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        // Every row opens with its filter type byte, zero meaning the bytes are stored as they are.
        raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    return Buffer.concat([
        SIGNATURE,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
};

/** The header fields the decoder needs, plus the palette and transparency chunks when present. */
interface Chunks {
    width: number;
    height: number;
    colorType: number;
    palette?: Uint8Array;
    transparency?: Uint8Array;
    data: Buffer;
}

/**
 * Walks the chunk list, checking each chunk's bounds and checksum, and keeps the ones the decoder uses.
 *
 * @param bytes the file bytes.
 * @returns the gathered chunks, or undefined when the file is not a supported non-interlaced 8-bit PNG.
 */
const readChunks = (bytes: Buffer): Chunks | undefined => {
    if (bytes.length < SIGNATURE.length || !bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return undefined;
    let header: Omit<Chunks, 'data'> | undefined;
    const data: Buffer[] = [];
    let ended = false;
    let offset = SIGNATURE.length;
    while (!ended) {
        if (offset + 12 > bytes.length) return undefined;
        const length = bytes.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > bytes.length) return undefined;
        if (bytes.readUInt32BE(end - 4) !== crc32(bytes, offset + 4, end - 4)) return undefined;
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        const payload = bytes.subarray(offset + 8, end - 4);
        // The header has to come first, and anything but the header before it means a broken file.
        if (!header && type !== 'IHDR') return undefined;
        switch (type) {
            case 'IHDR': {
                if (header || length !== 13) return undefined;
                const width = payload.readUInt32BE(0);
                const height = payload.readUInt32BE(4);
                const [bitDepth, colorType, compression, filter, interlace] = payload.subarray(8, 13);
                if (bitDepth !== 8 || !(colorType in CHANNELS)) return undefined;
                if (compression !== 0 || filter !== 0 || interlace !== 0) return undefined;
                if (width === 0 || height === 0 || width * height > MAX_PIXELS) return undefined;
                header = { width, height, colorType };
                break;
            }
            case 'PLTE':
                if (length === 0 || length % 3 !== 0 || length > 768) return undefined;
                header!.palette = payload;
                break;
            case 'tRNS':
                header!.transparency = payload;
                break;
            case 'IDAT':
                data.push(payload);
                break;
            case 'IEND':
                ended = true;
                break;
            default:
                break;
        }
        offset = end;
    }
    if (!header || data.length === 0) return undefined;
    if (header.colorType === 3 && !header.palette) return undefined;
    return { ...header, data: Buffer.concat(data) };
};

/**
 * Undoes the per-row filters in place, so each row's bytes are the sample values again.
 *
 * @param raw the inflated stream, each row led by its filter type byte.
 * @param stride the bytes per row without the filter byte.
 * @param height the row count.
 * @param bpp the bytes per pixel, the distance the Sub and Paeth filters look back by.
 * @returns the unfiltered samples, rows packed without filter bytes, or undefined on an unknown filter type.
 */
const unfilter = (raw: Uint8Array, stride: number, height: number, bpp: number): Uint8Array | undefined => {
    if (raw.length !== (stride + 1) * height) return undefined;
    const out = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const dst = y * stride;
        const prior = (y - 1) * stride;
        for (let i = 0; i < stride; i++) {
            const left = i >= bpp ? out[dst + i - bpp] : 0;
            const up = y > 0 ? out[prior + i] : 0;
            const upLeft = y > 0 && i >= bpp ? out[prior + i - bpp] : 0;
            let predictor: number;
            switch (filter) {
                case 0:
                    predictor = 0;
                    break;
                case 1:
                    predictor = left;
                    break;
                case 2:
                    predictor = up;
                    break;
                case 3:
                    predictor = (left + up) >> 1;
                    break;
                case 4: {
                    // Paeth picks whichever neighbour is closest to the gradient estimate, ties going left, then up.
                    const p = left + up - upLeft;
                    const pa = Math.abs(p - left);
                    const pb = Math.abs(p - up);
                    const pc = Math.abs(p - upLeft);
                    predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
                    break;
                }
                default:
                    return undefined;
            }
            out[dst + i] = (row[i] + predictor) & 0xff;
        }
    }
    return out;
};

/**
 * Expands unfiltered samples of any supported color type to RGBA.
 *
 * @param chunks the header, palette and transparency the layout is read from.
 * @param samples the unfiltered samples, packed row after row.
 * @returns the RGBA bytes, or undefined when a palette index points past the palette.
 */
const expand = (chunks: Chunks, samples: Uint8Array): Uint8Array | undefined => {
    const { width, height, colorType, palette, transparency } = chunks;
    const count = width * height;
    const rgba = new Uint8Array(count * 4);
    switch (colorType) {
        case 0: {
            // A two-byte tRNS names the one gray level that is fully transparent.
            const key = transparency && transparency.length >= 2 ? transparency[1] : -1;
            for (let i = 0; i < count; i++) {
                const v = samples[i];
                rgba[i * 4] = v;
                rgba[i * 4 + 1] = v;
                rgba[i * 4 + 2] = v;
                rgba[i * 4 + 3] = v === key ? 0 : 255;
            }
            return rgba;
        }
        case 2: {
            const keyed = transparency !== undefined && transparency.length >= 6;
            for (let i = 0; i < count; i++) {
                const r = samples[i * 3];
                const g = samples[i * 3 + 1];
                const b = samples[i * 3 + 2];
                rgba[i * 4] = r;
                rgba[i * 4 + 1] = g;
                rgba[i * 4 + 2] = b;
                const transparent = keyed && r === transparency[1] && g === transparency[3] && b === transparency[5];
                rgba[i * 4 + 3] = transparent ? 0 : 255;
            }
            return rgba;
        }
        case 3: {
            const entries = palette!.length / 3;
            for (let i = 0; i < count; i++) {
                const index = samples[i];
                if (index >= entries) return undefined;
                rgba[i * 4] = palette![index * 3];
                rgba[i * 4 + 1] = palette![index * 3 + 1];
                rgba[i * 4 + 2] = palette![index * 3 + 2];
                // Entries past the end of a short tRNS are opaque, as are all of them without one.
                rgba[i * 4 + 3] = transparency && index < transparency.length ? transparency[index] : 255;
            }
            return rgba;
        }
        case 4:
            for (let i = 0; i < count; i++) {
                const v = samples[i * 2];
                rgba[i * 4] = v;
                rgba[i * 4 + 1] = v;
                rgba[i * 4 + 2] = v;
                rgba[i * 4 + 3] = samples[i * 2 + 1];
            }
            return rgba;
        case 6:
            rgba.set(samples);
            return rgba;
        default:
            return undefined;
    }
};

/**
 * Reads an 8-bit non-interlaced PNG of any of the five color types into RGBA.
 *
 * @param bytes the file bytes.
 * @returns the picture, or undefined for any other format, any unsupported PNG shape, or a damaged file.
 */
export const decodePng = (bytes: Buffer): RgbaImage | undefined => {
    try {
        const chunks = readChunks(bytes);
        if (!chunks) return undefined;
        const bpp = CHANNELS[chunks.colorType];
        const samples = unfilter(inflateSync(chunks.data), chunks.width * bpp, chunks.height, bpp);
        if (!samples) return undefined;
        const rgba = expand(chunks, samples);
        return rgba ? { width: chunks.width, height: chunks.height, rgba } : undefined;
    } catch {
        // A truncated or corrupt deflate stream throws out of zlib, and a damaged file is simply not a picture.
        return undefined;
    }
};
