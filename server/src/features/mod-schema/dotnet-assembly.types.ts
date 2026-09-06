/**
 * The object model a parsed mod assembly is read through: types, their fields, properties and
 * methods, the custom attributes on each, the signatures that name other types, and the decoded IL
 * instructions a method body yields. The reader that fills it lives in `dotnet-assembly.ts`.
 */

/** A type as a signature names it. Named types carry the FullName the schema keys types by. */
export type TypeSig =
    | { kind: 'primitive'; fullName: string; name: string }
    | { kind: 'named'; fullName: string; name: string; valueType: boolean; localRow?: number }
    | { kind: 'generic'; fullName: string; name: string; args: TypeSig[]; localRow?: number }
    | { kind: 'array'; element: TypeSig }
    | { kind: 'typeParam'; name: string; position: number; ofMethod: boolean }
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
    /** The instruction's byte offset from the start of the body, which is what a branch names. */
    readonly offset: number;
    /**
     * The inline operand, decoded per opcode: a number, a metadata token, or a string literal. A
     * branch carries the absolute offset of its target.
     */
    readonly operand?: number | string;
    /** The absolute target offsets of a `switch`, in case order. */
    readonly targets?: readonly number[];
}

/** What a method body declares around its instructions. */
export interface MethodFrame {
    /** How many locals the body declares. */
    readonly locals: number;
    /** The offsets where an exception handler or filter begins, which are branch targets of their own. */
    readonly handlerStarts: readonly number[];
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
    /** The body's locals and handler entries, decoded together with the instructions. */
    frame(): MethodFrame;
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
     * The field a field-access instruction's token points at, with the type that declares it.
     *
     * @param token the instruction's metadata token.
     * @returns the field, or undefined when the token names something else.
     */
    fieldOfToken(token: number): FieldRef | undefined;
    /**
     * The type a cast or `newarr` instruction's token points at.
     *
     * @param token the instruction's metadata token.
     * @returns the type signature, or undefined when the token names no type.
     */
    typeOfToken(token: number): TypeSig | undefined;
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
    /** The declaring type's FullName, the open type's when the call is made on a generic instance. */
    readonly declaringType?: string;
    /** The arguments the declaring generic type is instantiated with, empty for a plain type. */
    readonly declaringArgs: readonly TypeSig[];
    /** The instantiation of a generic method call, empty for a non-generic one. */
    readonly genericArgs: readonly TypeSig[];
    /** True when the method takes an instance, which is one more value popped than it has parameters. */
    readonly hasThis: boolean;
    /** The parameter types as the signature states them, a declaring type's parameters unsubstituted. */
    readonly parameters: readonly TypeSig[];
    readonly returnType: TypeSig;
}

/** What a field-access instruction targets. */
export interface FieldRef {
    readonly name: string;
    /** The declaring type's FullName, the open type's when the access is made on a generic instance. */
    readonly declaringType?: string;
}
