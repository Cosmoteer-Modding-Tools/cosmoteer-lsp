import { open } from 'fs/promises';
import { foldPathCase, onFsInvalidation } from '../workspace/fs-cache';

// Sprite art is what the game stretches into the quad a rules file names, so a check on that quad
// has to know how many pixels the art actually has. A PNG says so in its first chunk, which is
// always the IHDR and always sits at the same offset, so the answer costs 24 bytes rather than a
// decode of the whole image. Reading a header is cheap on its own, around 30 microseconds, but a
// whole-workspace pass asks about the same handful of sprites over and over, so the answers are
// remembered until the filesystem caches say something on disk may have moved. Image files are
// watched alongside the rules files, so an edited sprite drops its entry with the rest.

/** The pixel size of an image file. */
export interface PixelSize {
    readonly width: number;
    readonly height: number;
}

/** The eight bytes every PNG opens with, so another format under a `.png` name is not read as one. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Signature, chunk length, chunk type and the two dimensions: everything the header needs. */
const HEADER_BYTES = 24;

/** Upper bound of remembered headers, so a pass over a large art tree cannot grow without end. */
const MEMO_CAP = 8_192;

const memo = new Map<string, PixelSize | null>();

onFsInvalidation(() => memo.clear());

/**
 * Reads the width and height out of a PNG's IHDR chunk.
 * @param fsPath the on-disk path of the image.
 * @returns the pixel size, or null when the file is missing, too short, or not a PNG.
 */
const readHeader = async (fsPath: string): Promise<PixelSize | null> => {
    const handle = await open(fsPath, 'r').catch(() => null);
    if (!handle) return null;
    try {
        const buffer = Buffer.alloc(HEADER_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
        if (bytesRead < HEADER_BYTES) return null;
        if (!buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return null;
        if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return width > 0 && height > 0 ? { width, height } : null;
    } catch {
        return null;
    } finally {
        await handle.close().catch(() => undefined);
    }
};

/**
 * The pixel size of a PNG on disk, remembered between passes.
 * @param fsPath the on-disk path of the image.
 * @returns the pixel size, or null when the file cannot be read as a PNG.
 */
export const pngDimensions = async (fsPath: string): Promise<PixelSize | null> => {
    const key = foldPathCase(fsPath.split('\\').join('/'));
    const remembered = memo.get(key);
    if (remembered !== undefined) return remembered;
    const size = await readHeader(fsPath);
    if (memo.size >= MEMO_CAP) memo.clear();
    memo.set(key, size);
    return size;
};

/** Forgets every remembered header. For tests, and for a workspace root that changed underfoot. */
export const clearPngDimensionsCache = (): void => {
    memo.clear();
};
