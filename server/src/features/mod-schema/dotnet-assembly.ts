/**
 * The object model over {@link readMetadataImage}: types, their serialized members, custom
 * attributes and method bodies, shaped the way the schema extraction consults them.
 *
 * Type references are kept as names rather than resolved definitions. A code mod's assembly
 * references the game's types constantly (every component extends a `*Rules` class from
 * `Cosmoteer.dll`), and resolving those would mean parsing the game assemblies at runtime. The
 * extraction does not need to: the shipped schema already describes every game type by the same
 * FullName, so a name is a complete answer. Only types declared in the mod assembly itself are
 * resolved to definitions here.
 */
import {
    BlobReader,
    MetadataImage,
    TABLE,
    decodeCodedIndex,
    readBlob,
    readColumn,
    readMetadataImage,
    readString,
    readUserString,
    shortestFloat32,
} from './dotnet-metadata';

/** A type as a signature names it. Named types carry the FullName the schema keys types by. */
export type TypeSig =
    | { kind: 'primitive'; fullName: string; name: string }
    | { kind: 'named'; fullName: string; name: string; valueType: boolean; localRow?: number }
    | { kind: 'generic'; fullName: string; name: string; args: TypeSig[]; localRow?: number }
    | { kind: 'array'; element: TypeSig }
    | { kind: 'typeParam'; name: string }
    | { kind: 'unknown'; name: string };

/** A decoded custom-attribute argument. A `Type`-valued argument keeps the referenced type's name. */
export type AttrValue = boolean | number | string | AttrValue[] | { typeName: string } | null | undefined;

/** One custom attribute applied to a type or member. */
export interface CustomAttr {
    /** FullName of the attribute class. */
    readonly typeFullName: string;
    /** Positional constructor arguments, in declaration order. */
    readonly ctorArgs: AttrValue[];
    /** Named field and property arguments. */
    readonly named: ReadonlyMap<string, AttrValue>;
}

/** A field declared by a type. */
export interface FieldInfo {
    readonly name: string;
    readonly isStatic: boolean;
    /** True for a compile-time constant, which is how enum members are stored. */
    readonly isLiteral: boolean;
    readonly isPublic: boolean;
    readonly type: TypeSig;
    readonly attributes: readonly CustomAttr[];
    /** The compile-time constant value, present on literal fields (an enum member's number). */
    readonly constant?: number | string | boolean;
}

/** A property declared by a type. */
export interface PropertyInfo {
    readonly name: string;
    readonly type: TypeSig;
    readonly attributes: readonly CustomAttr[];
}

/** One decoded IL instruction, limited to the operand shapes the extraction reads. */
export interface Instruction {
    /** The opcode, with a two-byte `0xfe` prefix folded into the high byte. */
    readonly opcode: number;
    /** The inline operand, decoded per opcode: a number, a metadata token, or a string literal. */
    readonly operand?: number | string;
}

/** A method declared by a type. */
export interface MethodInfo {
    readonly name: string;
    readonly isConstructor: boolean;
    readonly isStatic: boolean;
    readonly attributes: readonly CustomAttr[];
    readonly parameters: readonly { readonly name: string; readonly type: TypeSig }[];
    readonly returnType: TypeSig;
    /** The method's IL, decoded lazily because most methods are never inspected. */
    body(): readonly Instruction[];
}

/** A type defined in the assembly. */
export interface TypeInfo {
    /** The `TypeDef` row, which is this type's identity within the assembly. */
    readonly row: number;
    /** Cecil-style FullName: `Namespace.Name`, with a nested type joined to its declarer by `/`. */
    readonly fullName: string;
    readonly name: string;
    readonly namespace: string;
    readonly isAbstract: boolean;
    readonly isInterface: boolean;
    readonly isEnum: boolean;
    readonly isValueType: boolean;
    /** The base class as a signature, absent for interfaces and `System.Object`. */
    readonly baseType?: TypeSig;
    readonly interfaces: readonly TypeSig[];
    readonly attributes: readonly CustomAttr[];
    readonly fields: readonly FieldInfo[];
    readonly properties: readonly PropertyInfo[];
    readonly methods: readonly MethodInfo[];
}

/** A parsed mod assembly. */
export interface DotNetAssembly {
    /** The file it was read from. */
    readonly path: string;
    /** The assembly's simple name, as its manifest declares it. */
    readonly name: string;
    readonly types: readonly TypeInfo[];
    /** Every declared type by FullName, so a base reference inside the assembly resolves. */
    readonly typeByFullName: ReadonlyMap<string, TypeInfo>;
    /**
     * The field name a field-access instruction's token points at.
     *
     * @param token the instruction's metadata token.
     * @returns the field's name, or undefined when the token names something else.
     */
    fieldNameOfToken(token: number): string | undefined;
    /**
     * The method a call instruction's token points at.
     *
     * @param token the instruction's metadata token.
     * @returns the method's name, its declaring type's FullName when known, and the generic
     *          arguments a generic call was instantiated with, or undefined for an unreadable token.
     */
    callTargetOfToken(token: number): CallTarget | undefined;
}

/** What a `call` or `callvirt` instruction targets. */
export interface CallTarget {
    readonly name: string;
    readonly declaringType?: string;
    /** The instantiation of a generic method call, empty for a non-generic one. */
    readonly genericArgs: readonly TypeSig[];
}

/** Element type codes of ECMA-335 II.23.1.16 that map to a .NET primitive. */
const PRIMITIVES: Record<number, string> = {
    0x01: 'System.Void',
    0x02: 'System.Boolean',
    0x03: 'System.Char',
    0x04: 'System.SByte',
    0x05: 'System.Byte',
    0x06: 'System.Int16',
    0x07: 'System.UInt16',
    0x08: 'System.Int32',
    0x09: 'System.UInt32',
    0x0a: 'System.Int64',
    0x0b: 'System.UInt64',
    0x0c: 'System.Single',
    0x0d: 'System.Double',
    0x0e: 'System.String',
    0x16: 'System.TypedReference',
    0x18: 'System.IntPtr',
    0x19: 'System.UIntPtr',
    0x1c: 'System.Object',
};

const ELEMENT_PTR = 0x0f;
const ELEMENT_BYREF = 0x10;
const ELEMENT_VALUETYPE = 0x11;
const ELEMENT_CLASS = 0x12;
const ELEMENT_VAR = 0x13;
const ELEMENT_ARRAY = 0x14;
const ELEMENT_GENERICINST = 0x15;
const ELEMENT_FNPTR = 0x1b;
const ELEMENT_SZARRAY = 0x1d;
const ELEMENT_MVAR = 0x1e;
const ELEMENT_CMOD_REQD = 0x1f;
const ELEMENT_CMOD_OPT = 0x20;
const ELEMENT_PINNED = 0x45;

/** The short name of a FullName: the segment after the last `.`, or after a nested-type `/`. */
const shortNameOf = (fullName: string): string => {
    const slash = fullName.lastIndexOf('/');
    const tail = slash >= 0 ? fullName.slice(slash + 1) : fullName;
    const dot = tail.lastIndexOf('.');
    return dot >= 0 ? tail.slice(dot + 1) : tail;
};

/**
 * Read a whole assembly into the object model.
 *
 * @param path the file the buffer came from, kept for diagnostics.
 * @param buffer the assembly's bytes.
 * @returns the parsed assembly, or undefined when the file carries no readable .NET metadata.
 */
export const readAssembly = (path: string, buffer: Buffer): DotNetAssembly | undefined => {
    const image = readMetadataImage(buffer);
    if (!image) return undefined;
    return new AssemblyReader(path, image).read();
};

/**
 * Reads one assembly image. Held as a class only so the table walks can share the cursor state and
 * the token-to-name caches the type, member and attribute passes all consult.
 */
class AssemblyReader {
    /** TypeDef row to FullName, filled before members so a base reference can name a local type. */
    private readonly typeDefNames = new Map<number, string>();
    /** Custom attributes grouped by their parent, keyed as `<table>:<row>`. */
    private readonly attributesByParent = new Map<string, CustomAttr[]>();
    /** Constant values by parent, keyed as `<table>:<row>`. */
    private readonly constantsByParent = new Map<string, number | string | boolean>();
    /** Interfaces implemented per TypeDef row. */
    private readonly interfacesByType = new Map<number, TypeSig[]>();
    /** Property rows owned per TypeDef row. */
    private readonly propertyRowsByType = new Map<number, number[]>();

    constructor(
        private readonly path: string,
        private readonly image: MetadataImage
    ) {}

    /**
     * Parse every table this reader needs and assemble the model.
     *
     * @returns the assembly.
     */
    read(): DotNetAssembly {
        this.indexTypeNames();
        this.indexCustomAttributes();
        this.indexConstants();
        this.indexInterfaces();
        this.indexPropertyMap();
        const types: TypeInfo[] = [];
        const typeByFullName = new Map<string, TypeInfo>();
        const typeCount = this.image.rowCounts[TABLE.TypeDef];
        for (let row = 1; row <= typeCount; row++) {
            const type = this.readType(row);
            // The first TypeDef row is the compiler-generated `<Module>` pseudo-type, which declares
            // no schema surface and would collide with nothing, but is noise in every walk.
            if (type.fullName === '<Module>') continue;
            types.push(type);
            if (!typeByFullName.has(type.fullName)) typeByFullName.set(type.fullName, type);
        }
        return {
            path: this.path,
            name: this.assemblyName(),
            types,
            typeByFullName,
            fieldNameOfToken: (token) => this.fieldNameOfToken(token),
            callTargetOfToken: (token) => this.callTargetOfToken(token),
        };
    }

    /**
     * Name the field a token points at, whether it is declared here or imported.
     *
     * @param token the instruction's metadata token.
     * @returns the field's name, or undefined when the token names no field.
     */
    private fieldNameOfToken(token: number): string | undefined {
        const { table, row } = tokenParts(token);
        if (table === TABLE.Field) return readString(this.image, readColumn(this.image, TABLE.Field, row, 1));
        if (table === TABLE.MemberRef) return readString(this.image, readColumn(this.image, TABLE.MemberRef, row, 1));
        return undefined;
    }

    /**
     * Resolve a call instruction's target, unwrapping a MethodSpec into the method it instantiates
     * plus the generic arguments it was instantiated with.
     *
     * @param token the instruction's metadata token.
     * @returns the call target, or undefined when the token names no method.
     */
    private callTargetOfToken(token: number): CallTarget | undefined {
        let { table, row } = tokenParts(token);
        const genericArgs: TypeSig[] = [];
        if (table === TABLE.MethodSpec) {
            const blob = readBlob(this.image, readColumn(this.image, TABLE.MethodSpec, row, 1));
            const reader = new BlobReader(blob, 0, blob.length);
            reader.byte(); // the 0x0a generic-instantiation calling convention
            const count = reader.compressedUInt();
            for (let i = 0; i < count && reader.hasMore; i++) genericArgs.push(this.readTypeSig(reader));
            const method = decodeCodedIndex('MethodDefOrRef', readColumn(this.image, TABLE.MethodSpec, row, 0));
            if (!method) return undefined;
            table = method.table;
            row = method.row;
        }
        if (table === TABLE.MethodDef) {
            return {
                name: readString(this.image, readColumn(this.image, TABLE.MethodDef, row, 3)),
                declaringType: this.typeDefNames.get(this.declaringTypeOf(row)),
                genericArgs,
            };
        }
        if (table === TABLE.MemberRef) {
            const parent = decodeCodedIndex('MemberRefParent', readColumn(this.image, TABLE.MemberRef, row, 0));
            const declaring = parent ? this.typeRefSig(parent.table, parent.row) : undefined;
            return {
                name: readString(this.image, readColumn(this.image, TABLE.MemberRef, row, 1)),
                declaringType: declaring && 'fullName' in declaring ? declaring.fullName : undefined,
                genericArgs,
            };
        }
        return undefined;
    }

    /** The assembly's simple name from its manifest, or the file's own name when it has none. */
    private assemblyName(): string {
        if (this.image.rowCounts[TABLE.Assembly] < 1) return this.path;
        return readString(this.image, readColumn(this.image, TABLE.Assembly, 1, 7));
    }

    /**
     * Build every TypeDef's FullName up front, joining a nested type to its declarer with `/` the
     * way Cecil spells it, so a signature that names a local type resolves during the member pass.
     */
    private indexTypeNames(): void {
        const nesting = new Map<number, number>();
        const nestedCount = this.image.rowCounts[TABLE.NestedClass];
        for (let row = 1; row <= nestedCount; row++) {
            nesting.set(
                readColumn(this.image, TABLE.NestedClass, row, 0),
                readColumn(this.image, TABLE.NestedClass, row, 1)
            );
        }
        const typeCount = this.image.rowCounts[TABLE.TypeDef];
        const ownName = (row: number): string => {
            const name = readString(this.image, readColumn(this.image, TABLE.TypeDef, row, 1));
            const ns = readString(this.image, readColumn(this.image, TABLE.TypeDef, row, 2));
            return ns ? `${ns}.${name}` : name;
        };
        for (let row = 1; row <= typeCount; row++) {
            const parts: string[] = [];
            let cur: number | undefined = row;
            const guard = new Set<number>();
            while (cur !== undefined && !guard.has(cur)) {
                guard.add(cur);
                const enclosing = nesting.get(cur);
                // A nested type's own row carries only its simple name, and its namespace comes
                // from the outermost declarer, so only the outermost row contributes one.
                parts.unshift(
                    enclosing === undefined
                        ? ownName(cur)
                        : readString(this.image, readColumn(this.image, TABLE.TypeDef, cur, 1))
                );
                cur = enclosing;
            }
            this.typeDefNames.set(row, parts.join('/'));
        }
    }

    /** Group the CustomAttribute table by parent so member reads are a map lookup, not a scan. */
    private indexCustomAttributes(): void {
        const count = this.image.rowCounts[TABLE.CustomAttribute];
        for (let row = 1; row <= count; row++) {
            const parent = decodeCodedIndex('HasCustomAttribute', readColumn(this.image, TABLE.CustomAttribute, row, 0));
            if (!parent) continue;
            const attribute = this.readCustomAttribute(row);
            if (!attribute) continue;
            const key = `${parent.table}:${parent.row}`;
            const list = this.attributesByParent.get(key);
            if (list) list.push(attribute);
            else this.attributesByParent.set(key, [attribute]);
        }
    }

    /** Index the Constant table, which is where an enum member's numeric value lives. */
    private indexConstants(): void {
        const count = this.image.rowCounts[TABLE.Constant];
        for (let row = 1; row <= count; row++) {
            const parent = decodeCodedIndex('HasConstant', readColumn(this.image, TABLE.Constant, row, 2));
            if (!parent) continue;
            const type = readColumn(this.image, TABLE.Constant, row, 0);
            const blob = readBlob(this.image, readColumn(this.image, TABLE.Constant, row, 3));
            const value = this.readConstantValue(type, blob);
            if (value !== undefined) this.constantsByParent.set(`${parent.table}:${parent.row}`, value);
        }
    }

    /**
     * Decode a Constant table value, whose blob holds the raw little-endian bytes of the element
     * type named in the row.
     *
     * @param elementType the row's element type code.
     * @param blob the raw value bytes.
     * @returns the value, or undefined for a type this reader does not decode.
     */
    private readConstantValue(elementType: number, blob: Buffer): number | string | boolean | undefined {
        const reader = new BlobReader(blob, 0, blob.length);
        switch (elementType) {
            case 0x02:
                return reader.byte() !== 0;
            case 0x04:
                return blob.length >= 1 ? blob.readInt8(0) : undefined;
            case 0x05:
                return reader.byte();
            case 0x06:
                return blob.length >= 2 ? blob.readInt16LE(0) : undefined;
            case 0x07:
                return reader.uint16();
            case 0x08:
                return blob.length >= 4 ? blob.readInt32LE(0) : undefined;
            case 0x09:
                return reader.uint32();
            case 0x0a:
            case 0x0b:
                return reader.int64();
            case 0x0c:
                return reader.float32();
            case 0x0d:
                return reader.float64();
            case 0x0e:
                return blob.toString('utf16le');
            default:
                return undefined;
        }
    }

    /** Group implemented interfaces per implementing type. */
    private indexInterfaces(): void {
        const count = this.image.rowCounts[TABLE.InterfaceImpl];
        for (let row = 1; row <= count; row++) {
            const owner = readColumn(this.image, TABLE.InterfaceImpl, row, 0);
            const target = decodeCodedIndex('TypeDefOrRef', readColumn(this.image, TABLE.InterfaceImpl, row, 1));
            if (!target) continue;
            const sig = this.typeRefSig(target.table, target.row);
            const list = this.interfacesByType.get(owner);
            if (list) list.push(sig);
            else this.interfacesByType.set(owner, [sig]);
        }
    }

    /**
     * Resolve each type's property rows. The PropertyMap table gives each type its first property,
     * and the run ends where the next mapped type's run begins, the same list-column convention the
     * TypeDef field and method columns use.
     */
    private indexPropertyMap(): void {
        const count = this.image.rowCounts[TABLE.PropertyMap];
        const propertyCount = this.image.rowCounts[TABLE.Property];
        for (let row = 1; row <= count; row++) {
            const owner = readColumn(this.image, TABLE.PropertyMap, row, 0);
            const first = readColumn(this.image, TABLE.PropertyMap, row, 1);
            const next = row < count ? readColumn(this.image, TABLE.PropertyMap, row + 1, 1) : propertyCount + 1;
            const rows: number[] = [];
            for (let p = first; p < next && p <= propertyCount; p++) rows.push(p);
            this.propertyRowsByType.set(owner, rows);
        }
    }

    /** The attributes recorded for one table row. */
    private attributesOf(table: number, row: number): CustomAttr[] {
        return this.attributesByParent.get(`${table}:${row}`) ?? [];
    }

    /**
     * Read one TypeDef row into the model, including its fields, properties and methods.
     *
     * @param row the 1-based TypeDef row.
     * @returns the type.
     */
    private readType(row: number): TypeInfo {
        const image = this.image;
        const flags = readColumn(image, TABLE.TypeDef, row, 0);
        const fullName = this.typeDefNames.get(row) ?? '';
        const extendsIndex = decodeCodedIndex('TypeDefOrRef', readColumn(image, TABLE.TypeDef, row, 3));
        const baseType = extendsIndex ? this.typeRefSig(extendsIndex.table, extendsIndex.row) : undefined;
        const baseName = baseType && 'fullName' in baseType ? baseType.fullName : undefined;
        const isEnum = baseName === 'System.Enum';
        const isValueType = isEnum || baseName === 'System.ValueType';
        return {
            row,
            fullName,
            name: shortNameOf(fullName),
            namespace: readString(image, readColumn(image, TABLE.TypeDef, row, 2)),
            isAbstract: (flags & 0x80) !== 0,
            isInterface: (flags & 0x20) !== 0,
            isEnum,
            isValueType,
            baseType: baseName === 'System.Object' ? undefined : baseType,
            interfaces: this.interfacesByType.get(row) ?? [],
            attributes: this.attributesOf(TABLE.TypeDef, row),
            fields: this.readFields(row),
            properties: this.readProperties(row),
            methods: this.readMethods(row),
        };
    }

    /**
     * The rows of a list column: a TypeDef points at its first field or method, and the run ends
     * where the next type's run begins.
     *
     * @param row the owning TypeDef row.
     * @param column the TypeDef column holding the first target row.
     * @param targetTable the table the column points into.
     * @returns the owned rows.
     */
    private listRange(row: number, column: number, targetTable: number): number[] {
        const image = this.image;
        const typeCount = image.rowCounts[TABLE.TypeDef];
        const total = image.rowCounts[targetTable];
        const first = readColumn(image, TABLE.TypeDef, row, column);
        const next = row < typeCount ? readColumn(image, TABLE.TypeDef, row + 1, column) : total + 1;
        const rows: number[] = [];
        for (let r = first; r < next && r <= total; r++) rows.push(r);
        return rows;
    }

    /** Read a type's declared fields. */
    private readFields(typeRow: number): FieldInfo[] {
        const image = this.image;
        return this.listRange(typeRow, 4, TABLE.Field).map((row) => {
            const flags = readColumn(image, TABLE.Field, row, 0);
            const blob = readBlob(image, readColumn(image, TABLE.Field, row, 2));
            const reader = new BlobReader(blob, 0, blob.length);
            reader.byte(); // the field signature's leading 0x06 calling convention
            return {
                name: readString(image, readColumn(image, TABLE.Field, row, 1)),
                isStatic: (flags & 0x10) !== 0,
                isLiteral: (flags & 0x40) !== 0,
                isPublic: (flags & 0x07) === 0x06,
                type: this.readTypeSig(reader),
                attributes: this.attributesOf(TABLE.Field, row),
                constant: this.constantsByParent.get(`${TABLE.Field}:${row}`),
            };
        });
    }

    /** Read a type's declared properties. */
    private readProperties(typeRow: number): PropertyInfo[] {
        const image = this.image;
        return (this.propertyRowsByType.get(typeRow) ?? []).map((row) => {
            const blob = readBlob(image, readColumn(image, TABLE.Property, row, 2));
            const reader = new BlobReader(blob, 0, blob.length);
            reader.byte(); // calling convention
            reader.compressedUInt(); // parameter count, zero for a plain property
            return {
                name: readString(image, readColumn(image, TABLE.Property, row, 1)),
                type: this.readTypeSig(reader),
                attributes: this.attributesOf(TABLE.Property, row),
            };
        });
    }

    /** Read a type's declared methods, with lazily-decoded bodies. */
    private readMethods(typeRow: number): MethodInfo[] {
        const image = this.image;
        return this.listRange(typeRow, 5, TABLE.MethodDef).map((row) => {
            const rva = readColumn(image, TABLE.MethodDef, row, 0);
            const flags = readColumn(image, TABLE.MethodDef, row, 2);
            const name = readString(image, readColumn(image, TABLE.MethodDef, row, 3));
            const blob = readBlob(image, readColumn(image, TABLE.MethodDef, row, 4));
            const signature = this.readMethodSig(blob);
            const paramNames = this.readParamNames(row);
            let decoded: readonly Instruction[] | undefined;
            return {
                name,
                isConstructor: name === '.ctor' || name === '.cctor',
                isStatic: (flags & 0x10) !== 0,
                attributes: this.attributesOf(TABLE.MethodDef, row),
                parameters: signature.params.map((type, index) => ({
                    name: paramNames.get(index + 1) ?? `arg${index}`,
                    type,
                })),
                returnType: signature.returnType,
                body: () => (decoded ??= this.readBody(rva)),
            };
        });
    }

    /** Parameter names by 1-based sequence, so a signature's positional types can be named. */
    private readParamNames(methodRow: number): Map<number, string> {
        const image = this.image;
        const methodCount = image.rowCounts[TABLE.MethodDef];
        const total = image.rowCounts[TABLE.Param];
        const first = readColumn(image, TABLE.MethodDef, methodRow, 5);
        const next = methodRow < methodCount ? readColumn(image, TABLE.MethodDef, methodRow + 1, 5) : total + 1;
        const names = new Map<number, string>();
        for (let row = first; row < next && row <= total; row++) {
            names.set(readColumn(image, TABLE.Param, row, 1), readString(image, readColumn(image, TABLE.Param, row, 2)));
        }
        return names;
    }

    /**
     * Parse a method signature blob into its parameter and return types.
     *
     * @param blob the signature.
     * @returns the return type and positional parameter types.
     */
    private readMethodSig(blob: Buffer): { params: TypeSig[]; returnType: TypeSig } {
        const reader = new BlobReader(blob, 0, blob.length);
        const convention = reader.byte();
        // A generic method's signature declares its arity before the parameter count.
        if (convention & 0x10) reader.compressedUInt();
        const count = reader.compressedUInt();
        const returnType = this.readTypeSig(reader);
        const params: TypeSig[] = [];
        for (let i = 0; i < count && reader.hasMore; i++) params.push(this.readTypeSig(reader));
        return { params, returnType };
    }

    /**
     * Parse one type out of a signature blob.
     *
     * @param reader the cursor, positioned at the type's first byte.
     * @returns the type, `unknown` for an encoding this reader does not model.
     */
    private readTypeSig(reader: BlobReader): TypeSig {
        const code = reader.byte();
        const primitive = PRIMITIVES[code];
        if (primitive) return { kind: 'primitive', fullName: primitive, name: shortNameOf(primitive) };
        switch (code) {
            case ELEMENT_CMOD_REQD:
            case ELEMENT_CMOD_OPT:
                reader.typeDefOrRef();
                return this.readTypeSig(reader);
            case ELEMENT_PINNED:
                return this.readTypeSig(reader);
            case ELEMENT_BYREF:
            case ELEMENT_PTR:
                return this.readTypeSig(reader);
            case ELEMENT_SZARRAY:
                return { kind: 'array', element: this.readTypeSig(reader) };
            case ELEMENT_ARRAY: {
                const element = this.readTypeSig(reader);
                reader.compressedUInt(); // rank
                const sizes = reader.compressedUInt();
                for (let i = 0; i < sizes; i++) reader.compressedUInt();
                const bounds = reader.compressedUInt();
                for (let i = 0; i < bounds; i++) reader.compressedUInt();
                return { kind: 'array', element };
            }
            case ELEMENT_VALUETYPE:
            case ELEMENT_CLASS: {
                const token = reader.typeDefOrRef();
                if (!token) return { kind: 'unknown', name: '' };
                const sig = this.typeRefSig(token.table, token.row);
                return sig.kind === 'named' ? { ...sig, valueType: code === ELEMENT_VALUETYPE } : sig;
            }
            case ELEMENT_GENERICINST: {
                const outer = this.readTypeSig(reader);
                const count = reader.compressedUInt();
                const args: TypeSig[] = [];
                for (let i = 0; i < count && reader.hasMore; i++) args.push(this.readTypeSig(reader));
                if (outer.kind !== 'named') return { kind: 'unknown', name: 'generic' };
                return {
                    kind: 'generic',
                    fullName: outer.fullName,
                    name: outer.name,
                    args,
                    localRow: outer.localRow,
                };
            }
            case ELEMENT_VAR:
            case ELEMENT_MVAR:
                return { kind: 'typeParam', name: `T${reader.compressedUInt()}` };
            case ELEMENT_FNPTR:
                return { kind: 'unknown', name: 'fnptr' };
            default:
                return { kind: 'unknown', name: `0x${code.toString(16)}` };
        }
    }

    /**
     * Name the type a TypeDef, TypeRef or TypeSpec token points at.
     *
     * @param table the token's table.
     * @param row the token's 1-based row.
     * @returns the type signature, carrying the local TypeDef row when the type is declared here.
     */
    private typeRefSig(table: number, row: number): TypeSig {
        if (table === TABLE.TypeDef) {
            const fullName = this.typeDefNames.get(row) ?? '';
            return { kind: 'named', fullName, name: shortNameOf(fullName), valueType: false, localRow: row };
        }
        if (table === TABLE.TypeRef) {
            const name = readString(this.image, readColumn(this.image, TABLE.TypeRef, row, 1));
            const ns = readString(this.image, readColumn(this.image, TABLE.TypeRef, row, 2));
            const scope = decodeCodedIndex('ResolutionScope', readColumn(this.image, TABLE.TypeRef, row, 0));
            // A TypeRef whose scope is another TypeRef is a nested type, spelled with `/` like Cecil.
            const prefix =
                scope && scope.table === TABLE.TypeRef
                    ? `${(this.typeRefSig(TABLE.TypeRef, scope.row) as { fullName: string }).fullName}/`
                    : '';
            const fullName = prefix ? `${prefix}${name}` : ns ? `${ns}.${name}` : name;
            return { kind: 'named', fullName, name, valueType: false };
        }
        if (table === TABLE.TypeSpec) {
            const blob = readBlob(this.image, readColumn(this.image, TABLE.TypeSpec, row, 0));
            return this.readTypeSig(new BlobReader(blob, 0, blob.length));
        }
        return { kind: 'unknown', name: '' };
    }

    /**
     * Decode one custom attribute row: the attribute class from its constructor's declaring type,
     * then the positional and named arguments from the value blob.
     *
     * @param row the CustomAttribute row.
     * @returns the attribute, or undefined when its constructor cannot be resolved.
     */
    private readCustomAttribute(row: number): CustomAttr | undefined {
        const ctor = decodeCodedIndex('CustomAttributeType', readColumn(this.image, TABLE.CustomAttribute, row, 1));
        if (!ctor) return undefined;
        let typeFullName = '';
        let paramTypes: TypeSig[] = [];
        if (ctor.table === TABLE.MethodDef) {
            typeFullName = this.typeDefNames.get(this.declaringTypeOf(ctor.row)) ?? '';
            paramTypes = this.readMethodSig(readBlob(this.image, readColumn(this.image, TABLE.MethodDef, ctor.row, 4)))
                .params;
        } else if (ctor.table === TABLE.MemberRef) {
            const parent = decodeCodedIndex('MemberRefParent', readColumn(this.image, TABLE.MemberRef, ctor.row, 0));
            if (!parent) return undefined;
            const sig = this.typeRefSig(parent.table, parent.row);
            typeFullName = 'fullName' in sig ? sig.fullName : '';
            paramTypes = this.readMethodSig(readBlob(this.image, readColumn(this.image, TABLE.MemberRef, ctor.row, 2)))
                .params;
        }
        if (!typeFullName) return undefined;
        const blob = readBlob(this.image, readColumn(this.image, TABLE.CustomAttribute, row, 2));
        const { ctorArgs, named } = this.readAttributeBlob(blob, paramTypes);
        return { typeFullName, ctorArgs, named };
    }

    /**
     * The TypeDef row that declares a method, found by locating the method in the type list ranges.
     * Only used for attribute constructors declared in this assembly, which is the rare case.
     *
     * @param methodRow the MethodDef row.
     * @returns the declaring TypeDef row, or 0 when none owns it.
     */
    private declaringTypeOf(methodRow: number): number {
        const typeCount = this.image.rowCounts[TABLE.TypeDef];
        for (let row = typeCount; row >= 1; row--) {
            if (readColumn(this.image, TABLE.TypeDef, row, 5) <= methodRow) return row;
        }
        return 0;
    }

    /**
     * Decode a custom attribute's value blob.
     *
     * @param blob the value blob.
     * @param paramTypes the constructor's parameter types, which fix how the fixed args are read.
     * @returns the positional and named arguments.
     */
    private readAttributeBlob(
        blob: Buffer,
        paramTypes: TypeSig[]
    ): { ctorArgs: AttrValue[]; named: Map<string, AttrValue> } {
        const named = new Map<string, AttrValue>();
        const ctorArgs: AttrValue[] = [];
        if (blob.length < 2) return { ctorArgs, named };
        const reader = new BlobReader(blob, 0, blob.length);
        if (reader.uint16() !== 0x0001) return { ctorArgs, named };
        try {
            for (const type of paramTypes) ctorArgs.push(this.readFixedArg(reader, type));
            if (!reader.hasMore) return { ctorArgs, named };
            const count = reader.uint16();
            for (let i = 0; i < count && reader.hasMore; i++) {
                const kind = reader.byte();
                if (kind !== 0x53 && kind !== 0x54) break;
                const valueType = this.readFieldOrPropType(reader);
                const name = reader.serString();
                const value = this.readElem(reader, valueType);
                if (name) named.set(name, value);
            }
        } catch {
            // A blob shape this reader does not model leaves whatever was decoded so far in place.
            // Extraction treats a missing named argument as an unset one, which is the safe reading.
        }
        return { ctorArgs, named };
    }

    /** The element description a named argument or a boxed value carries before its value bytes. */
    private readFieldOrPropType(reader: BlobReader): { code: number; element?: { code: number } } {
        const code = reader.byte();
        if (code === 0x1d) return { code, element: { code: reader.byte() } };
        // An enum-typed argument names its type, whose underlying width the blob does not state.
        if (code === 0x55) {
            reader.serString();
            return { code: 0x08 };
        }
        return { code };
    }

    /**
     * Read a constructor's positional argument, whose encoding follows the declared parameter type
     * rather than an inline type marker.
     *
     * @param reader the cursor.
     * @param type the parameter's declared type.
     * @returns the value.
     */
    private readFixedArg(reader: BlobReader, type: TypeSig): AttrValue {
        if (type.kind === 'array') {
            const count = reader.uint32();
            if (count === 0xffffffff) return null;
            const values: AttrValue[] = [];
            for (let i = 0; i < count; i++) values.push(this.readFixedArg(reader, type.element));
            return values;
        }
        return this.readElem(reader, { code: this.elementCodeOf(type) });
    }

    /** The element type code a declared signature type is encoded as inside an attribute blob. */
    private elementCodeOf(type: TypeSig): number {
        if (type.kind !== 'primitive' && type.kind !== 'named') return 0x51;
        const byName: Record<string, number> = {
            'System.Boolean': 0x02,
            'System.Char': 0x03,
            'System.SByte': 0x04,
            'System.Byte': 0x05,
            'System.Int16': 0x06,
            'System.UInt16': 0x07,
            'System.Int32': 0x08,
            'System.UInt32': 0x09,
            'System.Int64': 0x0a,
            'System.UInt64': 0x0b,
            'System.Single': 0x0c,
            'System.Double': 0x0d,
            'System.String': 0x0e,
            'System.Object': 0x51,
            'System.Type': 0x50,
        };
        // A named type that is not one of these is an enum argument, stored as its underlying
        // integer. Four bytes is the C# default and the only width the game's attributes use.
        return byName[type.fullName] ?? 0x08;
    }

    /**
     * Read one attribute element of a known type code.
     *
     * @param reader the cursor.
     * @param type the element's type code, with an element code for a single-dimension array.
     * @returns the value.
     */
    private readElem(reader: BlobReader, type: { code: number; element?: { code: number } }): AttrValue {
        switch (type.code) {
            case 0x02:
                return reader.byte() !== 0;
            case 0x03:
                return reader.uint16();
            case 0x04: {
                const value = reader.byte();
                return value > 0x7f ? value - 0x100 : value;
            }
            case 0x05:
                return reader.byte();
            case 0x06: {
                const value = reader.uint16();
                return value > 0x7fff ? value - 0x10000 : value;
            }
            case 0x07:
                return reader.uint16();
            case 0x08:
                return reader.uint32() | 0;
            case 0x09:
                return reader.uint32();
            case 0x0a:
            case 0x0b:
                return reader.int64();
            case 0x0c:
                return reader.float32();
            case 0x0d:
                return reader.float64();
            case 0x0e:
                return reader.serString();
            case 0x50: {
                const typeName = reader.serString();
                return typeName === undefined ? null : { typeName };
            }
            case 0x51: {
                const boxed = this.readFieldOrPropType(reader);
                return this.readElem(reader, boxed);
            }
            case 0x1d: {
                const count = reader.uint32();
                if (count === 0xffffffff) return null;
                const values: AttrValue[] = [];
                for (let i = 0; i < count; i++) values.push(this.readElem(reader, { code: type.element?.code ?? 0x0e }));
                return values;
            }
            default:
                return undefined;
        }
    }

    /**
     * Decode a method body's instruction stream.
     *
     * @param rva the method's relative virtual address, 0 for an abstract or external method.
     * @returns the instructions, empty when the method has no readable body.
     */
    private readBody(rva: number): Instruction[] {
        if (rva === 0) return [];
        const start = this.image.rvaToOffset(rva);
        if (start === undefined) return [];
        const buffer = this.image.buffer;
        const first = buffer[start];
        let codeStart: number;
        let codeSize: number;
        if ((first & 0x03) === 0x02) {
            codeStart = start + 1;
            codeSize = first >> 2;
        } else if ((first & 0x03) === 0x03) {
            const headerSize = (buffer.readUInt16LE(start) >> 12) * 4;
            codeSize = buffer.readUInt32LE(start + 4);
            codeStart = start + headerSize;
        } else {
            return [];
        }
        const end = Math.min(codeStart + codeSize, buffer.length);
        return decodeInstructions(this.image, buffer, codeStart, end);
    }
}

/** Operand widths of the single-byte opcodes, by opcode. A `-1` marks the variable-width switch. */
const OPERAND_SIZE = new Int8Array(256).fill(0);
/** Operand widths of the two-byte `0xfe`-prefixed opcodes, by second byte. */
const OPERAND_SIZE_FE = new Int8Array(256).fill(0);
{
    const set = (table: Int8Array, size: number, codes: readonly number[]): void => {
        for (const code of codes) table[code] = size;
    };
    const range = (from: number, to: number): number[] =>
        Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
    // One-byte operands: the short argument and local forms, `ldc.i4.s`, and every short branch.
    set(OPERAND_SIZE, 1, [...range(0x0e, 0x13), 0x1f, ...range(0x2b, 0x37), 0xde]);
    // Four-byte operands: metadata tokens, long branch targets, `ldc.i4` and `ldc.r4`.
    set(OPERAND_SIZE, 4, [
        0x20,
        0x22,
        ...range(0x27, 0x29),
        ...range(0x38, 0x44),
        ...range(0x6f, 0x75),
        0x79,
        ...range(0x7b, 0x81),
        0x8c,
        0x8d,
        0x8f,
        ...range(0xa3, 0xa5),
        0xc2,
        0xc6,
        0xd0,
        0xdd,
    ]);
    // Eight-byte operands: `ldc.i8` and `ldc.r8`.
    set(OPERAND_SIZE, 8, [0x21, 0x23]);
    OPERAND_SIZE[0x45] = -1; // switch, whose operand length depends on its case count
    // The `0xfe`-prefixed opcodes: `ldftn`/`ldvirtftn`/`initobj`/`constrained.`/`sizeof` take a
    // token, the long argument and local forms a 16-bit index, and `unaligned.`/`no.` one byte.
    set(OPERAND_SIZE_FE, 4, [0x06, 0x07, 0x15, 0x16, 0x1c]);
    set(OPERAND_SIZE_FE, 2, [...range(0x09, 0x0e)]);
    set(OPERAND_SIZE_FE, 1, [0x12, 0x19]);
}

/** Opcodes whose 32-bit operand is a metadata token, kept as a number for the caller to decode. */
const TOKEN_OPCODES = new Set([0x28, 0x6f, 0x73, 0x74, 0x75, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f, 0x80, 0x81, 0x8c, 0x8d]);

/** `ldstr`, whose token names a `#US` literal rather than a table row. */
const OPCODE_LDSTR = 0x72;
/** `ldc.i4`, `ldc.i4.s`, `ldc.r4`, `ldc.r8`, the constant loads a field initializer compiles to. */
const OPCODE_LDC_I4 = 0x20;
const OPCODE_LDC_I4_S = 0x1f;
const OPCODE_LDC_R4 = 0x22;
const OPCODE_LDC_R8 = 0x23;
const OPCODE_LDC_I8 = 0x21;

/**
 * Walk an IL stream into instructions, decoding only the operands the extraction reads and skipping
 * the rest at their declared width.
 *
 * @param image the assembly, needed to resolve an `ldstr` literal.
 * @param buffer the file.
 * @param start the first byte of the code.
 * @param end one past the last byte of the code.
 * @returns the decoded instructions in order.
 */
const decodeInstructions = (image: MetadataImage, buffer: Buffer, start: number, end: number): Instruction[] => {
    const out: Instruction[] = [];
    let at = start;
    while (at < end) {
        let opcode = buffer[at++];
        let size: number;
        if (opcode === 0xfe) {
            if (at >= end) break;
            const second = buffer[at++];
            size = OPERAND_SIZE_FE[second];
            opcode = 0xfe00 | second;
        } else {
            size = OPERAND_SIZE[opcode];
        }
        if (size === -1) {
            if (at + 4 > end) break;
            const cases = buffer.readUInt32LE(at);
            at += 4 + cases * 4;
            out.push({ opcode });
            continue;
        }
        let operand: number | string | undefined;
        if (size === 1) operand = buffer[at];
        else if (size === 2) operand = at + 2 <= end ? buffer.readUInt16LE(at) : 0;
        else if (size === 4) {
            const raw = at + 4 <= end ? buffer.readUInt32LE(at) : 0;
            if (opcode === OPCODE_LDSTR) operand = readUserString(image, raw & 0x00ffffff);
            else if (opcode === OPCODE_LDC_R4) operand = shortestFloat32(at + 4 <= end ? buffer.readFloatLE(at) : 0);
            else if (opcode === OPCODE_LDC_I4) operand = raw | 0;
            else operand = raw;
        } else if (size === 8) {
            if (opcode === OPCODE_LDC_R8) operand = at + 8 <= end ? buffer.readDoubleLE(at) : 0;
            else if (opcode === OPCODE_LDC_I8) operand = at + 8 <= end ? Number(buffer.readBigInt64LE(at)) : 0;
        }
        if (opcode === OPCODE_LDC_I4_S && typeof operand === 'number') operand = operand > 0x7f ? operand - 0x100 : operand;
        out.push(size === 0 ? { opcode } : { opcode, operand });
        at += Math.max(0, size);
    }
    return out;
};

/** The opcodes the extraction matches on, exported so callers do not repeat the numbers. */
export const OPCODES = {
    ldc_i4_m1: 0x15,
    ldc_i4_0: 0x16,
    ldc_i4_8: 0x1e,
    ldc_i4_s: OPCODE_LDC_I4_S,
    ldc_i4: OPCODE_LDC_I4,
    ldc_i8: OPCODE_LDC_I8,
    ldc_r4: OPCODE_LDC_R4,
    ldc_r8: OPCODE_LDC_R8,
    ldstr: OPCODE_LDSTR,
    call: 0x28,
    callvirt: 0x6f,
    stfld: 0x7d,
} as const;

/** Whether an opcode's 32-bit operand is a metadata token. */
export const isTokenOpcode = (opcode: number): boolean => TOKEN_OPCODES.has(opcode);

/**
 * Split a metadata token into its table and row.
 *
 * @param token the 32-bit token.
 * @returns the table id and 1-based row.
 */
export const tokenParts = (token: number): { table: number; row: number } => ({
    table: (token >>> 24) & 0xff,
    row: token & 0x00ffffff,
});
