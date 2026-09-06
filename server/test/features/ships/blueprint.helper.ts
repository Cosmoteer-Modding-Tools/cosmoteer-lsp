import { deflateSync, gzipSync } from 'zlib';

/**
 * Writes a `.ship.png` the way the game does, for the tests that need a saved ship they control: a
 * real PNG whose colour channels carry an ObjectBits tree in their low bits.
 */

/** The CRC32 a PNG chunk carries, over its type and its body. */
const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
};

/** One PNG chunk, length and checksum included. */
const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([head, typed, tail]);
};

/** The variable-length integer the ObjectBits format counts with, for values these tests write. */
const varint = (value: number): Buffer => {
    // Every count written here is small, which is the one-byte form: the low bit stays clear and the
    // value sits in the upper seven bits.
    if (value >= 128) throw new Error('the tests write only small counts');
    return Buffer.from([value << 1]);
};

/** A string in the length-prefixed form .NET's own writer produces. */
export const netString = (text: string): Buffer => {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length >= 128) throw new Error('the tests write only short strings');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
};

/** A data node holding the given bytes. */
export const dataNode = (body: Buffer): Buffer => Buffer.concat([Buffer.from([1]), varint(body.length), body]);

/** A map node holding the given entries, in order. */
export const mapNode = (entries: Array<[string, Buffer]>): Buffer =>
    Buffer.concat([
        Buffer.from([3]),
        varint(entries.length),
        ...entries.map(([key, node]) => Buffer.concat([netString(key), node])),
    ]);

/** A list node holding the given nodes. */
export const listNode = (items: Buffer[]): Buffer => Buffer.concat([Buffer.from([2]), varint(items.length), ...items]);

/** A part element, in the shape a blueprint writes one. */
export const partNode = (id: string, x: number, y: number, rotation: number, flipX: boolean): Buffer => {
    const location = Buffer.alloc(8);
    location.writeInt32LE(x, 0);
    location.writeInt32LE(y, 4);
    const rotationBytes = Buffer.alloc(4);
    rotationBytes.writeInt32LE(rotation, 0);
    return mapNode([
        ['FlipX', dataNode(Buffer.from([flipX ? 1 : 0]))],
        ['ID', dataNode(netString(id))],
        ['Location', dataNode(location)],
        ['Rotation', dataNode(rotationBytes)],
    ]);
};

/**
 * The bytes of a `.ship.png` hiding the given tree.
 *
 * @param tree the ObjectBits tree to hide.
 * @returns the file's bytes.
 */
export const shipPngBytes = (tree: Buffer): Buffer => {
    const payload = Buffer.concat([Buffer.from('COSMOSHIP', 'ascii'), gzipSync(tree)]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    const stream = Buffer.concat([header, payload]);

    // Three bits per pixel, so the picture has to be big enough to hold the stream.
    const width = 64;
    const height = Math.ceil((stream.length * 8) / 3 / width) + 1;
    const pixels = Buffer.alloc(width * height * 4, 0);
    for (let i = 0; i < pixels.length; i += 4) pixels[i + 3] = 255;
    for (let index = 0; index < stream.length * 8; index++) {
        const bit = (stream[index >> 3] >> (index & 7)) & 1;
        const pixel = Math.floor(index / 3);
        const channel = index % 3;
        pixels[pixel * 4 + channel] = (pixels[pixel * 4 + channel] & 0xfe) | bit;
    }
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
};

/**
 * A whole blueprint tree naming the given parts, with a name, a ship class and a door count, which
 * is everything the assessment reads.
 *
 * @param name the ship's name.
 * @param parts the part ids, one element per placed part.
 * @param doors how many doors to declare.
 * @returns the tree.
 */
export const blueprintTree = (name: string, parts: readonly string[], doors = 0): Buffer =>
    mapNode([
        ['Name', dataNode(netString(name))],
        ['ShipRulesID', dataNode(netString('cosmoteer.terran'))],
        ['Parts', listNode(parts.map((id, index) => partNode(id, index, 0, 0, false)))],
        ['Doors', listNode(Array.from({ length: doors }, () => mapNode([['ID', dataNode(netString('door'))]])))],
    ]);
