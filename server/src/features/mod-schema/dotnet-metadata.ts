/**
 * A minimal reader for the ECMA-335 metadata a .NET assembly carries, enough to recover the
 * schema surface of a Cosmoteer code mod.
 *
 * The shipped `cosmoteer.schema.json` is extracted offline by `tools/schemagen`, a C# tool built on
 * Mono.Cecil. A code mod's assembly is not available offline, so the same extraction has to happen
 * on the user's machine. Requiring a .NET runtime there would be a hard dependency the rest of the
 * language server does not have, so this module reads the assembly's metadata tables directly: PE
 * sections, the CLI header, the `#~` table stream and the `#Strings` / `#Blob` heaps, plus the
 * signature, custom-attribute and IL encodings the extraction consults.
 *
 * This is deliberately not a general-purpose Cecil replacement. It resolves what
 * {@link module:mod-schema/extract} asks for and nothing else: type definitions with their base
 * references, serialized fields and properties, custom attributes with their named arguments,
 * enum members, and the constructor bodies that carry field initializers. Anything it cannot
 * decode surfaces as `undefined` so the extraction degrades to a conservative verdict rather than
 * guessing.
 */

/** The heap and table streams of a parsed assembly, plus the row data every accessor reads. */
export interface MetadataImage {
    /** The whole file, so blob and IL reads can slice it directly. */
    readonly buffer: Buffer;
    /** Row counts per table id, indexed by table id (absent tables are 0). */
    readonly rowCounts: number[];
    /** File offset of each table's first row, indexed by table id. */
    readonly tableOffsets: number[];
    /** Byte width of one row per table id. */
    readonly rowSizes: number[];
    /** Byte width of each column per table id, in declaration order. */
    readonly columnSizes: number[][];
    /** File offset of each column within a row per table id. */
    readonly columnOffsets: number[][];
    /** File offset of the `#Strings` heap. */
    readonly stringsOffset: number;
    /** File offset of the `#Blob` heap. */
    readonly blobOffset: number;
    /** File offset of the `#US` user-string heap, where `ldstr` operands live. */
    readonly userStringsOffset: number;
    /** Maps a relative virtual address to a file offset, or undefined when it is outside every section. */
    rvaToOffset(rva: number): number | undefined;
}

/** Table ids this reader names. Others are only sized so the tables after them can be found. */
export const TABLE = {
    Module: 0x00,
    TypeRef: 0x01,
    TypeDef: 0x02,
    Field: 0x04,
    MethodDef: 0x06,
    Param: 0x08,
    InterfaceImpl: 0x09,
    MemberRef: 0x0a,
    Constant: 0x0b,
    CustomAttribute: 0x0c,
    Property: 0x17,
    PropertyMap: 0x15,
    MethodSemantics: 0x18,
    ModuleRef: 0x1a,
    TypeSpec: 0x1b,
    Assembly: 0x20,
    AssemblyRef: 0x23,
    NestedClass: 0x29,
    GenericParam: 0x2a,
    MethodSpec: 0x2b,
} as const;

/** A column's storage: a fixed width, a heap index, a table index, or a coded index. */
type Column = 'u1' | 'u2' | 'u4' | 'str' | 'guid' | 'blob' | { table: number } | { coded: CodedIndexName };

type CodedIndexName =
    | 'TypeDefOrRef'
    | 'HasConstant'
    | 'HasCustomAttribute'
    | 'HasFieldMarshal'
    | 'HasDeclSecurity'
    | 'MemberRefParent'
    | 'HasSemantics'
    | 'MethodDefOrRef'
    | 'MemberForwarded'
    | 'Implementation'
    | 'CustomAttributeType'
    | 'ResolutionScope'
    | 'TypeOrMethodDef';

/**
 * The tables a coded index can point into, in tag order. A `-1` entry is a tag value the spec
 * reserves but never assigns, which still consumes a tag slot and therefore a tag bit.
 */
const CODED_INDEX_TABLES: Record<CodedIndexName, number[]> = {
    TypeDefOrRef: [0x02, 0x01, 0x1b],
    HasConstant: [0x04, 0x08, 0x17],
    HasCustomAttribute: [
        0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27,
        0x28, 0x2a, 0x2b, 0x2c,
    ],
    HasFieldMarshal: [0x04, 0x08],
    HasDeclSecurity: [0x02, 0x06, 0x20],
    MemberRefParent: [0x02, 0x01, 0x1a, 0x06, 0x1b],
    HasSemantics: [0x14, 0x17],
    MethodDefOrRef: [0x06, 0x0a],
    MemberForwarded: [0x04, 0x06],
    Implementation: [0x26, 0x23, 0x27],
    CustomAttributeType: [-1, -1, 0x06, 0x0a, -1],
    ResolutionScope: [0x00, 0x1a, 0x23, 0x01],
    TypeOrMethodDef: [0x02, 0x06],
};

/** Bits a coded index spends on its tag, which is the width needed to number its table list. */
const tagBits = (name: CodedIndexName): number => Math.ceil(Math.log2(CODED_INDEX_TABLES[name].length));

/**
 * Column layout of every metadata table, indexed by table id. Tables this reader never queries are
 * still declared, because table rows are stored back to back in table-id order, so finding one
 * table means sizing every table before it.
 */
const TABLE_COLUMNS: (Column[] | undefined)[] = [];
TABLE_COLUMNS[0x00] = ['u2', 'str', 'guid', 'guid', 'guid'];
TABLE_COLUMNS[0x01] = [{ coded: 'ResolutionScope' }, 'str', 'str'];
TABLE_COLUMNS[0x02] = ['u4', 'str', 'str', { coded: 'TypeDefOrRef' }, { table: 0x04 }, { table: 0x06 }];
TABLE_COLUMNS[0x03] = [{ table: 0x04 }];
TABLE_COLUMNS[0x04] = ['u2', 'str', 'blob'];
TABLE_COLUMNS[0x05] = [{ table: 0x06 }];
TABLE_COLUMNS[0x06] = ['u4', 'u2', 'u2', 'str', 'blob', { table: 0x08 }];
TABLE_COLUMNS[0x07] = [{ table: 0x08 }];
TABLE_COLUMNS[0x08] = ['u2', 'u2', 'str'];
TABLE_COLUMNS[0x09] = [{ table: 0x02 }, { coded: 'TypeDefOrRef' }];
TABLE_COLUMNS[0x0a] = [{ coded: 'MemberRefParent' }, 'str', 'blob'];
TABLE_COLUMNS[0x0b] = ['u1', 'u1', { coded: 'HasConstant' }, 'blob'];
TABLE_COLUMNS[0x0c] = [{ coded: 'HasCustomAttribute' }, { coded: 'CustomAttributeType' }, 'blob'];
TABLE_COLUMNS[0x0d] = [{ coded: 'HasFieldMarshal' }, 'blob'];
TABLE_COLUMNS[0x0e] = ['u2', { coded: 'HasDeclSecurity' }, 'blob'];
TABLE_COLUMNS[0x0f] = ['u2', 'u4', { table: 0x02 }];
TABLE_COLUMNS[0x10] = ['u4', { table: 0x04 }];
TABLE_COLUMNS[0x11] = ['blob'];
TABLE_COLUMNS[0x12] = [{ table: 0x02 }, { table: 0x14 }];
TABLE_COLUMNS[0x13] = [{ table: 0x14 }];
TABLE_COLUMNS[0x14] = ['u2', 'str', { coded: 'TypeDefOrRef' }];
TABLE_COLUMNS[0x15] = [{ table: 0x02 }, { table: 0x17 }];
TABLE_COLUMNS[0x16] = [{ table: 0x17 }];
TABLE_COLUMNS[0x17] = ['u2', 'str', 'blob'];
TABLE_COLUMNS[0x18] = ['u2', { table: 0x06 }, { coded: 'HasSemantics' }];
TABLE_COLUMNS[0x19] = [{ table: 0x02 }, { coded: 'MethodDefOrRef' }, { coded: 'MethodDefOrRef' }];
TABLE_COLUMNS[0x1a] = ['str'];
TABLE_COLUMNS[0x1b] = ['blob'];
TABLE_COLUMNS[0x1c] = ['u2', { coded: 'MemberForwarded' }, 'str', { table: 0x1a }];
TABLE_COLUMNS[0x1d] = ['u4', { table: 0x04 }];
TABLE_COLUMNS[0x1e] = ['u4', 'u4'];
TABLE_COLUMNS[0x1f] = ['u4'];
TABLE_COLUMNS[0x20] = ['u4', 'u2', 'u2', 'u2', 'u2', 'u4', 'blob', 'str', 'str'];
TABLE_COLUMNS[0x21] = ['u4'];
TABLE_COLUMNS[0x22] = ['u4', 'u4', 'u4'];
TABLE_COLUMNS[0x23] = ['u2', 'u2', 'u2', 'u2', 'u4', 'blob', 'str', 'str', 'blob'];
TABLE_COLUMNS[0x24] = ['u4', { table: 0x23 }];
TABLE_COLUMNS[0x25] = ['u4', 'u4', 'u4', { table: 0x23 }];
TABLE_COLUMNS[0x26] = ['u4', 'str', 'blob'];
TABLE_COLUMNS[0x27] = ['u4', 'u4', 'str', 'str', { coded: 'Implementation' }];
TABLE_COLUMNS[0x28] = ['u4', 'u4', 'str', { coded: 'Implementation' }];
TABLE_COLUMNS[0x29] = [{ table: 0x02 }, { table: 0x02 }];
TABLE_COLUMNS[0x2a] = ['u2', 'u2', { coded: 'TypeOrMethodDef' }, 'str'];
TABLE_COLUMNS[0x2b] = [{ coded: 'MethodDefOrRef' }, 'blob'];
TABLE_COLUMNS[0x2c] = [{ table: 0x2a }, { coded: 'TypeDefOrRef' }];

/** One PE section, enough to translate a relative virtual address into a file offset. */
interface Section {
    virtualAddress: number;
    virtualSize: number;
    rawAddress: number;
    rawSize: number;
}

/**
 * Parse the PE and CLI metadata headers of a .NET assembly into an image the accessors below read.
 *
 * @param buffer the whole assembly file.
 * @returns the parsed image, or undefined when the file is not a managed PE this reader understands
 *          (an unmanaged DLL, a corrupt file, or a metadata version it cannot parse).
 */
export const readMetadataImage = (buffer: Buffer): MetadataImage | undefined => {
    if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return undefined;
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) return undefined;
    const coff = peOffset + 4;
    const sectionCount = buffer.readUInt16LE(coff + 2);
    const optionalHeaderSize = buffer.readUInt16LE(coff + 16);
    const optional = coff + 20;
    if (optional + optionalHeaderSize > buffer.length) return undefined;
    const magic = buffer.readUInt16LE(optional);
    // The data directories sit after the fixed part of the optional header, whose size differs
    // between PE32 and PE32+ because eight of its fields widen to 64 bits.
    const directories = optional + (magic === 0x20b ? 112 : 96);
    const cliDirectory = directories + 14 * 8;
    if (cliDirectory + 8 > buffer.length) return undefined;
    const cliRva = buffer.readUInt32LE(cliDirectory);
    if (cliRva === 0) return undefined;

    const sections: Section[] = [];
    const sectionTable = optional + optionalHeaderSize;
    for (let i = 0; i < sectionCount; i++) {
        const at = sectionTable + i * 40;
        if (at + 40 > buffer.length) return undefined;
        sections.push({
            virtualSize: buffer.readUInt32LE(at + 8),
            virtualAddress: buffer.readUInt32LE(at + 12),
            rawSize: buffer.readUInt32LE(at + 16),
            rawAddress: buffer.readUInt32LE(at + 20),
        });
    }
    const rvaToOffset = (rva: number): number | undefined => {
        for (const section of sections) {
            // A section's virtual size can exceed its raw size (bss-style padding), so the raw span
            // is the bound that matters for reading bytes back out of the file.
            if (rva >= section.virtualAddress && rva < section.virtualAddress + Math.max(section.virtualSize, section.rawSize)) {
                const offset = section.rawAddress + (rva - section.virtualAddress);
                return offset < buffer.length ? offset : undefined;
            }
        }
        return undefined;
    };

    const cliOffset = rvaToOffset(cliRva);
    if (cliOffset === undefined || cliOffset + 16 > buffer.length) return undefined;
    const metadataOffset = rvaToOffset(buffer.readUInt32LE(cliOffset + 8));
    if (metadataOffset === undefined || metadataOffset + 20 > buffer.length) return undefined;
    if (buffer.readUInt32LE(metadataOffset) !== 0x424a5342) return undefined;

    const versionLength = buffer.readUInt32LE(metadataOffset + 12);
    let cursor = metadataOffset + 16 + versionLength;
    cursor += 2; // flags
    const streamCount = buffer.readUInt16LE(cursor);
    cursor += 2;
    const streams = new Map<string, { offset: number; size: number }>();
    for (let i = 0; i < streamCount; i++) {
        if (cursor + 8 > buffer.length) return undefined;
        const offset = buffer.readUInt32LE(cursor);
        const size = buffer.readUInt32LE(cursor + 4);
        cursor += 8;
        let end = cursor;
        while (end < buffer.length && buffer[end] !== 0) end++;
        const name = buffer.toString('ascii', cursor, end);
        // A stream name is null-terminated and then padded to the next four-byte boundary.
        cursor = end + 1;
        cursor = cursor + ((4 - (cursor % 4)) % 4);
        streams.set(name, { offset: metadataOffset + offset, size });
    }
    const tableStream = streams.get('#~') ?? streams.get('#-');
    if (!tableStream) return undefined;
    const strings = streams.get('#Strings');
    const blobs = streams.get('#Blob');
    const userStrings = streams.get('#US');

    let at = tableStream.offset;
    at += 4; // reserved
    at += 2; // major and minor version
    const heapSizes = buffer[at];
    at += 1;
    at += 1; // reserved
    const validLow = buffer.readUInt32LE(at);
    const validHigh = buffer.readUInt32LE(at + 4);
    at += 8;
    at += 8; // sorted mask

    const rowCounts: number[] = new Array(64).fill(0);
    for (let table = 0; table < 64; table++) {
        const present = table < 32 ? (validLow >>> table) & 1 : (validHigh >>> (table - 32)) & 1;
        if (!present) continue;
        rowCounts[table] = buffer.readUInt32LE(at);
        at += 4;
    }

    const stringIndexSize = heapSizes & 0x01 ? 4 : 2;
    const guidIndexSize = heapSizes & 0x02 ? 4 : 2;
    const blobIndexSize = heapSizes & 0x04 ? 4 : 2;
    const tableIndexSize = (table: number): number => (rowCounts[table] >= 1 << 16 ? 4 : 2);
    const codedIndexSize = (name: CodedIndexName): number => {
        const bits = tagBits(name);
        const limit = 1 << (16 - bits);
        for (const table of CODED_INDEX_TABLES[name]) {
            if (table >= 0 && rowCounts[table] >= limit) return 4;
        }
        return 2;
    };
    const columnSize = (column: Column): number => {
        if (column === 'u1') return 1;
        if (column === 'u2') return 2;
        if (column === 'u4') return 4;
        if (column === 'str') return stringIndexSize;
        if (column === 'guid') return guidIndexSize;
        if (column === 'blob') return blobIndexSize;
        return 'table' in column ? tableIndexSize(column.table) : codedIndexSize(column.coded);
    };

    const rowSizes: number[] = new Array(64).fill(0);
    const columnSizes: number[][] = new Array(64).fill(null).map(() => []);
    const columnOffsets: number[][] = new Array(64).fill(null).map(() => []);
    const tableOffsets: number[] = new Array(64).fill(0);
    for (let table = 0; table < 64; table++) {
        const columns = TABLE_COLUMNS[table];
        if (!columns) continue;
        let rowSize = 0;
        for (const column of columns) {
            const size = columnSize(column);
            columnSizes[table].push(size);
            columnOffsets[table].push(rowSize);
            rowSize += size;
        }
        rowSizes[table] = rowSize;
    }
    for (let table = 0; table < 64; table++) {
        if (rowCounts[table] === 0) continue;
        // A present table with no declared layout makes every later table's offset unknowable, so
        // the image is rejected rather than read at a wrong offset.
        if (!TABLE_COLUMNS[table]) return undefined;
        tableOffsets[table] = at;
        at += rowSizes[table] * rowCounts[table];
    }
    if (at > buffer.length) return undefined;

    return {
        buffer,
        rowCounts,
        tableOffsets,
        rowSizes,
        columnSizes,
        columnOffsets,
        stringsOffset: strings ? strings.offset : -1,
        blobOffset: blobs ? blobs.offset : -1,
        userStringsOffset: userStrings ? userStrings.offset : -1,
        rvaToOffset,
    };
};

/**
 * Read one column of one row.
 *
 * @param image the parsed assembly.
 * @param table the table id.
 * @param row the 1-based row number, as metadata tokens number rows.
 * @param column the 0-based column index within the row.
 * @returns the raw column value, or 0 when the row or column is out of range.
 */
export const readColumn = (image: MetadataImage, table: number, row: number, column: number): number => {
    if (row < 1 || row > image.rowCounts[table]) return 0;
    const size = image.columnSizes[table][column];
    if (size === undefined) return 0;
    const at = image.tableOffsets[table] + (row - 1) * image.rowSizes[table] + image.columnOffsets[table][column];
    switch (size) {
        case 1:
            return image.buffer[at];
        case 2:
            return image.buffer.readUInt16LE(at);
        default:
            return image.buffer.readUInt32LE(at);
    }
};

/**
 * Decode a coded index column into the table and row it points at. The column's width varies with
 * the image, but the tag encoding inside the value does not, so this needs no image.
 *
 * @param name the coded index kind, which fixes the tag width and table list.
 * @param value the raw column value.
 * @returns the target table id and 1-based row, or undefined for a null or reserved-tag index.
 */
export const decodeCodedIndex = (
    name: CodedIndexName,
    value: number
): { table: number; row: number } | undefined => {
    const bits = tagBits(name);
    const tag = value & ((1 << bits) - 1);
    const row = value >>> bits;
    const table = CODED_INDEX_TABLES[name][tag];
    if (table === undefined || table < 0 || row === 0) return undefined;
    return { table, row };
};

/**
 * Read a `#Strings` heap entry.
 *
 * @param image the parsed assembly.
 * @param index the heap offset held by a string column.
 * @returns the null-terminated UTF-8 string, or the empty string for a null or out-of-range index.
 */
export const readString = (image: MetadataImage, index: number): string => {
    if (image.stringsOffset < 0 || index === 0) return '';
    const start = image.stringsOffset + index;
    if (start >= image.buffer.length) return '';
    let end = start;
    while (end < image.buffer.length && image.buffer[end] !== 0) end++;
    return image.buffer.toString('utf8', start, end);
};

/**
 * Read a `#Blob` heap entry, whose length is a compressed unsigned integer prefix.
 *
 * @param image the parsed assembly.
 * @param index the heap offset held by a blob column.
 * @returns the blob's bytes, empty when the index is null or out of range.
 */
export const readBlob = (image: MetadataImage, index: number): Buffer => {
    if (image.blobOffset < 0 || index === 0) return Buffer.alloc(0);
    const start = image.blobOffset + index;
    if (start >= image.buffer.length) return Buffer.alloc(0);
    const reader = new BlobReader(image.buffer, start);
    const length = reader.compressedUInt();
    const from = reader.offset;
    return image.buffer.subarray(from, Math.min(from + length, image.buffer.length));
};

/**
 * Widen a 32-bit float to the double that prints the way the value was written in source.
 *
 * A `float` literal such as `0.35f` is stored as the nearest 32-bit value, which widens to
 * `0.3499999940395355` as a double. .NET prints a float as the shortest decimal that round-trips
 * back to the same 32-bit value, so `0.35` is what the shipped schema and the C# extractor record.
 * Matching that keeps an extracted default readable in a hover and identical to the oracle.
 *
 * @param value the widened 32-bit value.
 * @returns the shortest double that rounds back to the same 32-bit value.
 */
export const shortestFloat32 = (value: number): number => {
    if (!Number.isFinite(value)) return value;
    for (let precision = 1; precision <= 9; precision++) {
        const candidate = Number(value.toPrecision(precision));
        if (Math.fround(candidate) === value) return candidate;
    }
    return value;
};

/**
 * Read a `#US` heap entry, the UTF-16 literal an `ldstr` instruction names by token.
 *
 * @param image the parsed assembly.
 * @param index the heap offset carried in the instruction's token.
 * @returns the literal, or the empty string when the heap or index is absent.
 */
export const readUserString = (image: MetadataImage, index: number): string => {
    if (image.userStringsOffset < 0 || index === 0) return '';
    const start = image.userStringsOffset + index;
    if (start >= image.buffer.length) return '';
    const reader = new BlobReader(image.buffer, start);
    const length = reader.compressedUInt();
    // The blob's last byte is a flag saying whether any character needs more than an ASCII byte,
    // so the character data is one byte shorter than the declared length.
    const from = reader.offset;
    const to = Math.min(from + Math.max(0, length - 1), image.buffer.length);
    return image.buffer.toString('utf16le', from, to);
};

/**
 * A cursor over a metadata blob, which encodes lengths and token references as the compressed
 * integers of ECMA-335 II.23.2 rather than fixed-width fields.
 */
export class BlobReader {
    constructor(
        private readonly buffer: Buffer,
        public offset: number,
        private readonly end: number = buffer.length
    ) {}

    /** Whether at least one more byte is readable. */
    get hasMore(): boolean {
        return this.offset < this.end;
    }

    /** Reads one byte, or 0 past the end. */
    byte(): number {
        return this.offset < this.end ? this.buffer[this.offset++] : 0;
    }

    /** Reads a little-endian unsigned 16-bit value. */
    uint16(): number {
        const value = this.offset + 2 <= this.end ? this.buffer.readUInt16LE(this.offset) : 0;
        this.offset += 2;
        return value;
    }

    /** Reads a little-endian unsigned 32-bit value. */
    uint32(): number {
        const value = this.offset + 4 <= this.end ? this.buffer.readUInt32LE(this.offset) : 0;
        this.offset += 4;
        return value;
    }

    /** Reads a little-endian signed 64-bit value, narrowed to a JavaScript number. */
    int64(): number {
        const value = this.offset + 8 <= this.end ? this.buffer.readBigInt64LE(this.offset) : 0n;
        this.offset += 8;
        return Number(value);
    }

    /** Reads a little-endian 32-bit float, in the shortest form that round-trips back to it. */
    float32(): number {
        const value = this.offset + 4 <= this.end ? this.buffer.readFloatLE(this.offset) : 0;
        this.offset += 4;
        return shortestFloat32(value);
    }

    /** Reads a little-endian 64-bit float. */
    float64(): number {
        const value = this.offset + 8 <= this.end ? this.buffer.readDoubleLE(this.offset) : 0;
        this.offset += 8;
        return value;
    }

    /**
     * Reads a compressed unsigned integer: one, two or four bytes selected by the top bits of the
     * first byte.
     *
     * @returns the decoded value.
     */
    compressedUInt(): number {
        const first = this.byte();
        if ((first & 0x80) === 0) return first;
        if ((first & 0xc0) === 0x80) return ((first & 0x3f) << 8) | this.byte();
        return ((first & 0x1f) << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte();
    }

    /**
     * Reads a `TypeDefOrRef` coded token, the compressed form signatures use for a type reference.
     *
     * @returns the target table id and 1-based row, or undefined for a null token.
     */
    typeDefOrRef(): { table: number; row: number } | undefined {
        const value = this.compressedUInt();
        const table = [0x02, 0x01, 0x1b][value & 3];
        const row = value >>> 2;
        return table === undefined || row === 0 ? undefined : { table, row };
    }

    /**
     * Reads a length-prefixed UTF-8 string as custom-attribute blobs encode it.
     *
     * @returns the string, or undefined for the explicit null marker (`0xff`).
     */
    serString(): string | undefined {
        if (this.offset < this.end && this.buffer[this.offset] === 0xff) {
            this.offset++;
            return undefined;
        }
        const length = this.compressedUInt();
        const from = this.offset;
        this.offset = Math.min(from + length, this.end);
        return this.buffer.toString('utf8', from, this.offset);
    }

    /** Advances past `count` bytes. */
    skip(count: number): void {
        this.offset += count;
    }
}
