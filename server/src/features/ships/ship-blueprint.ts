import { readFile } from 'fs/promises';
import { constants, gunzipSync, inflateSync } from 'zlib';

/**
 * Reading a `.ship.png` blueprint: the ship a player saved, stored in the low bits of the picture
 * of it.
 *
 * The file is a real PNG showing the ship, and the ship itself is hidden in the colour channels, so
 * nothing in an editor could say which parts a blueprint places. That matters to a mod author for
 * one reason above all: a blueprint naming a part the mod has renamed or removed loads as a ship
 * with holes in it, and the only way to find out was to open the game.
 *
 * Every step here is the game's own, read out of `Ship.LoadStream`, `Halfling.IO.TextureDataStream`
 * and `Halfling.ObjectBits.OBNode`:
 *
 * - the picture is decoded to straight RGBA, since the payload is bit-packed over the pixels in
 *   row-major order and any filtering has to be undone first,
 * - one low bit is taken from each of red, green and blue, in that order, filling each byte from its
 *   lowest bit up. The alpha channel carries none,
 * - the first four bytes are the payload's length, most significant byte first, and are not part of
 *   it,
 * - the payload opens with `COSMOSHIP` and continues as gzip,
 * - what that decompresses to is an ObjectBits tree, whose nodes are one type byte and, per type,
 *   a length-prefixed blob, a list, or a map of names to nodes.
 *
 * The format belongs to the game rather than to the file format the rest of this server reads, so a
 * game update can change it. Every read here fails softly for that reason: the caller is told the
 * file could not be read rather than being handed half a ship.
 */

/** One part the blueprint places. */
export interface BlueprintPart {
    /** The part id, as the blueprint stores it. */
    readonly id: string;
    /** The cell the part sits at, in the blueprint's own coordinates. */
    readonly x: number;
    readonly y: number;
    /** The quarter turns it is rotated by. */
    readonly rotation: number;
    readonly flipX: boolean;
}

/** What a blueprint says about itself. */
export interface Blueprint {
    readonly name?: string;
    readonly author?: string;
    readonly description?: string;
    /** The id of the ship class the blueprint was built for, such as `cosmoteer.terran`. */
    readonly shipRulesId?: string;
    readonly parts: readonly BlueprintPart[];
    /** How many decals it carries, across the layers it keeps them in. */
    readonly decals: number;
    /** How many doors it places. */
    readonly doors: number;
}

/** The nine bytes every payload opens with. */
const SAVE_FILE_HEADER = 'COSMOSHIP';

/** An ObjectBits node, in the shape the reader produces. */
type ObNode =
    | { kind: 'data'; data: Buffer }
    | { kind: 'list'; items: (ObNode | null)[] }
    | { kind: 'map'; entries: Map<string, ObNode | null> }
    | { kind: 'other' };

/**
 * The straight RGBA pixels of a PNG, with its row filters undone.
 *
 * @param file the file's bytes.
 * @returns the width, height and pixels, or undefined for anything but the 8-bit RGBA form the game
 *          writes.
 */
const decodePng = (file: Buffer): { width: number; height: number; pixels: Buffer } | undefined => {
    if (file.length < 8 || file.readUInt32BE(0) !== 0x89504e47) return undefined;
    let position = 8;
    let width = 0;
    let height = 0;
    const parts: Buffer[] = [];
    while (position + 8 <= file.length) {
        const length = file.readUInt32BE(position);
        const type = file.toString('ascii', position + 4, position + 8);
        const body = file.subarray(position + 8, position + 8 + length);
        if (type === 'IHDR') {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            // 8 bits per channel, colour type 6 (RGBA), no interlacing: the only form the game saves.
            if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) return undefined;
        } else if (type === 'IDAT') {
            parts.push(Buffer.from(body));
        } else if (type === 'IEND') {
            break;
        }
        position += 12 + length;
    }
    if (width === 0 || height === 0 || parts.length === 0) return undefined;

    let raw: Buffer;
    try {
        raw = inflateSync(Buffer.concat(parts));
    } catch {
        return undefined;
    }
    const stride = width * 4;
    if (raw.length < (stride + 1) * height) return undefined;
    const pixels = Buffer.alloc(stride * height);
    let read = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[read++];
        const line = pixels.subarray(y * stride, (y + 1) * stride);
        raw.copy(line, 0, read, read + stride);
        read += stride;
        const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
        for (let i = 0; i < stride; i++) {
            const left = i >= 4 ? line[i - 4] : 0;
            const up = previous ? previous[i] : 0;
            const upLeft = previous && i >= 4 ? previous[i - 4] : 0;
            switch (filter) {
                case 1:
                    line[i] = (line[i] + left) & 0xff;
                    break;
                case 2:
                    line[i] = (line[i] + up) & 0xff;
                    break;
                case 3:
                    line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
                    break;
                case 4: {
                    const estimate = left + up - upLeft;
                    const dLeft = Math.abs(estimate - left);
                    const dUp = Math.abs(estimate - up);
                    const dUpLeft = Math.abs(estimate - upLeft);
                    const nearest = dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
                    line[i] = (line[i] + nearest) & 0xff;
                    break;
                }
                default:
                    break;
            }
        }
    }
    return { width, height, pixels };
};

/**
 * The bytes hidden in a picture's low bits.
 *
 * @param pixels the straight RGBA pixels.
 * @returns the payload, or undefined when the length it declares does not fit in the picture.
 */
const hiddenBytes = (pixels: Buffer): Buffer | undefined => {
    const channels = (pixels.length / 4) * 3;
    const byteAt = (index: number): number => {
        let value = 0;
        for (let bit = 0; bit < 8; bit++) {
            const position = index * 8 + bit;
            if (position >= channels) return value;
            const pixel = Math.floor(position / 3);
            const channel = position % 3;
            value |= (pixels[pixel * 4 + channel] & 1) << bit;
        }
        return value;
    };
    const length = (byteAt(0) << 24) | (byteAt(1) << 16) | (byteAt(2) << 8) | byteAt(3);
    if (length <= SAVE_FILE_HEADER.length || (length + 4) * 8 > channels) return undefined;
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i++) out[i] = byteAt(4 + i);
    return out;
};

/** A cursor over the ObjectBits stream. */
class ObReader {
    private position = 0;

    public constructor(private readonly buffer: Buffer) {}

    /**
     * The next byte.
     *
     * @returns the byte.
     */
    public byte(): number {
        if (this.position >= this.buffer.length) throw new Error('end of stream');
        return this.buffer[this.position++];
    }

    /**
     * The variable-length unsigned integer the format counts lengths with: the low bits of the first
     * byte say how many bytes it spans, and the value is what is left after shifting them off.
     *
     * @returns the value.
     */
    public varint(): number {
        const first = this.byte();
        let span = 1;
        if (first & 1) {
            span++;
            if (first & 2) {
                span++;
                if (first & 4) span++;
            }
        }
        let value = first;
        for (let i = 1; i < span; i++) value |= this.byte() << (i * 8);
        return value >>> Math.min(span, 3);
    }

    /**
     * A string, in the length-prefixed form .NET's own `BinaryWriter` writes.
     *
     * @returns the text.
     */
    public string(): string {
        let length = 0;
        let shift = 0;
        for (;;) {
            const byte = this.byte();
            length |= (byte & 0x7f) << shift;
            if (!(byte & 0x80)) break;
            shift += 7;
        }
        const text = this.buffer.toString('utf8', this.position, this.position + length);
        this.position += length;
        return text;
    }

    /**
     * The next `count` bytes.
     *
     * @param count how many to take.
     * @returns the bytes.
     */
    public bytes(count: number): Buffer {
        const out = this.buffer.subarray(this.position, this.position + count);
        this.position += count;
        return out;
    }
}

/**
 * Reads one node and everything under it.
 *
 * @param reader the cursor.
 * @param nodes every node read so far, which a back-reference names by position.
 * @param type the node's type byte, already read.
 * @returns the node.
 */
const readNode = (reader: ObReader, nodes: ObNode[], type: number): ObNode => {
    switch (type) {
        case 1: {
            // The node takes its place in the numbering before its contents are read, which is what
            // makes a back-reference to it line up with the game's own count.
            const node = { kind: 'data' as const, data: Buffer.alloc(0) };
            nodes.push(node);
            node.data = Buffer.from(reader.bytes(reader.varint()));
            return node;
        }
        case 2: {
            const node: ObNode = { kind: 'list', items: [] };
            nodes.push(node);
            const count = reader.varint();
            for (let i = 0; i < count; i++) node.items.push(readChild(reader, nodes));
            return node;
        }
        case 3: {
            const node: ObNode = { kind: 'map', entries: new Map() };
            nodes.push(node);
            const count = reader.varint();
            for (let i = 0; i < count; i++) {
                const key = reader.string();
                node.entries.set(key, readChild(reader, nodes));
            }
            return node;
        }
        case 4: {
            const node: ObNode = { kind: 'other' };
            nodes.push(node);
            readChild(reader, nodes);
            return node;
        }
        default: {
            const node: ObNode = { kind: 'other' };
            nodes.push(node);
            return node;
        }
    }
};

/**
 * Reads a child node, which may instead be nothing or a reference back to a node already read.
 *
 * @param reader the cursor.
 * @param nodes every node read so far.
 * @returns the child, or null where the format writes one explicitly.
 */
const readChild = (reader: ObReader, nodes: ObNode[]): ObNode | null => {
    const type = reader.byte();
    if (type === 255) return nodes[reader.varint()] ?? null;
    if (type === 254) return null;
    return readNode(reader, nodes, type);
};

/**
 * The text a data node holds, when it holds one.
 *
 * @param node the node.
 * @returns the text, or undefined when the node holds something else.
 */
const textOf = (node: ObNode | null | undefined): string | undefined => {
    if (!node || node.kind !== 'data') return undefined;
    try {
        return new ObReader(node.data).string();
    } catch {
        return undefined;
    }
};

/**
 * The whole number a data node holds, which the format writes as four bytes, least significant
 * first.
 *
 * @param node the node.
 * @returns the number, or 0 when the node holds something else.
 */
const intOf = (node: ObNode | null | undefined): number =>
    node && node.kind === 'data' && node.data.length >= 4 ? node.data.readInt32LE(0) : 0;

/**
 * Reads the blueprint a `.ship.png` carries.
 *
 * @param path the file to read.
 * @returns what the blueprint says about itself, or undefined when the file is not one this can read.
 */
export const readShipBlueprint = async (path: string): Promise<Blueprint | undefined> => {
    let file: Buffer;
    try {
        file = await readFile(path);
    } catch {
        return undefined;
    }
    const image = decodePng(file);
    if (!image) return undefined;
    const payload = hiddenBytes(image.pixels);
    if (!payload || payload.toString('ascii', 0, SAVE_FILE_HEADER.length) !== SAVE_FILE_HEADER) return undefined;

    let tree: Buffer;
    try {
        // The payload ends exactly where the declared length does, and the deflate stream inside it
        // does not always announce its own end, so the read is finished rather than refused.
        tree = gunzipSync(payload.subarray(SAVE_FILE_HEADER.length), { finishFlush: constants.Z_SYNC_FLUSH });
    } catch {
        return undefined;
    }

    let root: ObNode;
    try {
        const reader = new ObReader(tree);
        root = readNode(reader, [], reader.byte());
    } catch {
        return undefined;
    }
    if (root.kind !== 'map') return undefined;

    const parts: BlueprintPart[] = [];
    const partsNode = root.entries.get('Parts');
    if (partsNode && partsNode.kind === 'list') {
        for (const element of partsNode.items) {
            if (!element || element.kind !== 'map') continue;
            const id = textOf(element.entries.get('ID'));
            if (!id) continue;
            const location = element.entries.get('Location');
            const x = location && location.kind === 'data' && location.data.length >= 8 ? location.data.readInt32LE(0) : 0;
            const y = location && location.kind === 'data' && location.data.length >= 8 ? location.data.readInt32LE(4) : 0;
            const flip = element.entries.get('FlipX');
            parts.push({
                id,
                x,
                y,
                rotation: intOf(element.entries.get('Rotation')),
                flipX: !!(flip && flip.kind === 'data' && flip.data[0]),
            });
        }
    }

    // Decals are kept one list per layer, and doors in a list of their own. Neither names a part, so
    // both are counted rather than read.
    let decals = 0;
    for (const [key, node] of root.entries) {
        if (/^Decals/i.test(key) && node && node.kind === 'list') decals += node.items.length;
    }
    const doorsNode = root.entries.get('Doors');

    return {
        name: textOf(root.entries.get('Name')),
        author: textOf(root.entries.get('Author')),
        description: textOf(root.entries.get('Description')),
        shipRulesId: textOf(root.entries.get('ShipRulesID')),
        parts,
        decals,
        doors: doorsNode && doorsNode.kind === 'list' ? doorsNode.items.length : 0,
    };
};
