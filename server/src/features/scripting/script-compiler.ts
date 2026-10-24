import { ScriptingSurface, ScriptMember } from '../../document/schema/schema.types';

/**
 * A port of the game's rules-script compiler (`Cosmoteer.Scripting.ScriptCompiler`, 0.30.5), which
 * replaced Python in music and codex rules. It tokenizes, parses and type-checks a script the way
 * the game does at load time, and answers with the game's own message for the first error. Along the
 * way it records what every name bound to, which hover, completion and highlighting read.
 *
 * Types are keys into {@link ScriptingSurface.typeInfo}: a FullName, with a `?` suffix for a
 * nullable value. A context the surface does not describe (a mod's own) binds every name to an
 * unknown type that accepts everything, so only the syntax is judged there.
 */

/** One lexical token, with offsets into the written string. */
export interface ScriptToken {
    readonly kind: 'number' | 'string' | 'name' | 'keyword' | 'symbol';
    readonly text: string;
    readonly start: number;
    readonly end: number;
}

/** What a name in the script resolved to. */
export interface ScriptBinding {
    readonly start: number;
    readonly end: number;
    readonly role: 'variable' | 'function' | 'property' | 'method';
    /** The overloads or the single member the name names. */
    readonly members: readonly ScriptMember[];
    /** For a property or method, the type it was read from. */
    readonly owner?: string;
}

/** A `.` the parser met, with the type of what stands left of it, for member completion. */
export interface ScriptMemberAccess {
    /** Where the name after the dot starts. */
    readonly nameStart: number;
    readonly target: string;
}

/** The outcome of compiling one script. */
export interface ScriptResult {
    readonly error?: { readonly start: number; readonly end: number; readonly message: string };
    readonly tokens: readonly ScriptToken[];
    readonly bindings: readonly ScriptBinding[];
    readonly accesses: readonly ScriptMemberAccess[];
}

const INT = 'System.Int32';
const LONG = 'System.Int64';
const FLOAT = 'System.Single';
const DOUBLE = 'System.Double';
const BOOL = 'System.Boolean';
const STRING = 'System.String';
const OBJECT = 'System.Object';
const VOID = 'System.Void';
/** The type of the `None` literal before it meets a nullable type. */
const NONE = 'None';
/** The type of anything bound against a context this server cannot describe. */
const UNKNOWN = '';

const NUMERIC = new Set([
    INT,
    LONG,
    FLOAT,
    DOUBLE,
    'System.Int16',
    'System.UInt16',
    'System.Byte',
    'System.SByte',
    'System.UInt32',
]);
const FLOATING = new Set([FLOAT, DOUBLE]);
const PRIMITIVE_VALUES = new Set([...NUMERIC, BOOL, 'System.UInt64', 'System.Char']);

/** The words the parser reserves. */
export const SCRIPT_KEYWORDS: readonly string[] = ['and', 'not', 'if', 'or', 'is', 'None', 'True', 'False', 'else'];
const KEYWORDS = new Set(SCRIPT_KEYWORDS);

const SYMBOLS = '()<>+-*/%.,';
const TWO_CHAR = new Set(['==', '!=', '<=', '>=']);

class ScriptError extends Error {
    constructor(
        readonly position: number,
        message: string
    ) {
        super(message);
    }
}

const isLetter = (c: string): boolean => /\p{L}/u.test(c);
const isLetterOrDigit = (c: string): boolean => /[\p{L}\p{Nd}]/u.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

const INT_MAX = 2n ** 31n - 1n;
const LONG_MAX = 2n ** 63n - 1n;

/**
 * The name the game's messages give a type: `None`, the short name, or the short name with a `?`.
 *
 * @param surface the scripting surface.
 * @param key the type key.
 * @returns the display name.
 */
export const scriptTypeName = (surface: ScriptingSurface | undefined, key: string): string => {
    if (key === NONE) return 'None';
    if (key === UNKNOWN) return 'unknown';
    if (key.endsWith('?')) return `${scriptTypeName(surface, key.slice(0, -1))}?`;
    const known = surface?.typeInfo[key]?.name;
    if (known) return known;
    const plain = key.split('<')[0];
    return plain.slice(Math.max(plain.lastIndexOf('.'), plain.lastIndexOf('/')) + 1);
};

/** Recursive-descent parser and binder, one per script, mirroring the game's `Parser` class. */
class Compiler {
    readonly tokens: ScriptToken[] = [];
    readonly bindings: ScriptBinding[] = [];
    readonly accesses: ScriptMemberAccess[] = [];
    private index = 0;

    constructor(
        private readonly source: string,
        private readonly base: number,
        private readonly surface: ScriptingSurface | undefined,
        private readonly context: string
    ) {}

    private get current(): ScriptToken {
        return this.tokens[this.index];
    }

    /** Positions in the tokens are offsets into the written string, so the parser's are shifted back. */
    private pos(token: ScriptToken): number {
        return token.start - this.base;
    }

    tokenize(): void {
        const s = this.source;
        let i = 0;
        const push = (kind: ScriptToken['kind'], start: number, end: number): void => {
            const text = s.slice(start, end);
            this.tokens.push({
                kind: kind === 'name' && KEYWORDS.has(text) ? 'keyword' : kind,
                text,
                start: start + this.base,
                end: end + this.base,
            });
        };
        while (i < s.length) {
            const c = s[i];
            const start = i;
            if (/\s/.test(c)) {
                i++;
                continue;
            }
            if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
                let floating = false;
                while (i < s.length && (isDigit(s[i]) || s[i] === '.' || s[i] === '_')) {
                    if (s[i] === '.') floating = true;
                    i++;
                }
                if (s[i] === 'e' || s[i] === 'E') {
                    floating = true;
                    i++;
                    if (s[i] === '+' || s[i] === '-') i++;
                    while (isDigit(s[i])) i++;
                }
                const digits = s.slice(start, i).replace(/_/g, '');
                const valid = floating
                    ? !Number.isNaN(Number(digits)) && digits !== '.'
                    : /^\d+$/.test(digits) && BigInt(digits) <= LONG_MAX;
                if (!valid) throw new ScriptError(start, `Invalid number '${s.slice(start, i)}'.`);
                push('number', start, i);
                continue;
            }
            if (c === '"' || c === "'") {
                i++;
                for (;;) {
                    if (i >= s.length) throw new ScriptError(start, 'Unterminated string.');
                    const d = s[i++];
                    if (d === c) break;
                    if (d === '\\') {
                        if (i >= s.length) throw new ScriptError(start, 'Unterminated string.');
                        i++;
                    }
                }
                push('string', start, i);
                continue;
            }
            if (isLetter(c) || c === '_') {
                while (i < s.length && (isLetterOrDigit(s[i]) || s[i] === '_')) i++;
                push('name', start, i);
                continue;
            }
            const two = s.slice(i, i + 2);
            const symbol = TWO_CHAR.has(two) ? two : SYMBOLS.includes(c) ? c : undefined;
            if (!symbol) throw new ScriptError(start, `Unexpected character '${c}'.`);
            i += symbol.length;
            push('symbol', start, i);
        }
        this.tokens.push({ kind: 'symbol', text: '', start: s.length + this.base, end: s.length + this.base });
    }

    private atEnd(): boolean {
        return this.index === this.tokens.length - 1;
    }

    private describe(token: ScriptToken): string {
        return token === this.tokens[this.tokens.length - 1] ? 'end of script' : token.text;
    }

    private acceptSymbol(symbol: string): boolean {
        if (this.atEnd() || this.current.kind !== 'symbol' || this.current.text !== symbol) return false;
        this.index++;
        return true;
    }

    private acceptKeyword(keyword: string): boolean {
        if (this.current.kind !== 'keyword' || this.current.text !== keyword) return false;
        this.index++;
        return true;
    }

    private expectSymbol(symbol: string): void {
        if (!this.acceptSymbol(symbol))
            throw new ScriptError(
                this.pos(this.current),
                `Expected '${symbol}' but found '${this.describe(this.current)}'.`
            );
    }

    private expectKeyword(keyword: string): void {
        if (!this.acceptKeyword(keyword))
            throw new ScriptError(
                this.pos(this.current),
                `Expected '${keyword}' but found '${this.describe(this.current)}'.`
            );
    }

    private expectName(): ScriptToken {
        const token = this.current;
        if (token.kind !== 'name')
            throw new ScriptError(this.pos(token), `Expected a name but found '${this.describe(token)}'.`);
        this.index++;
        return token;
    }

    parseScript(): string {
        if (this.atEnd()) throw new ScriptError(0, 'Script is empty.');
        const type = this.parseConditional();
        if (!this.atEnd()) throw new ScriptError(this.pos(this.current), `Unexpected '${this.current.text}'.`);
        return type;
    }

    private parseConditional(): string {
        const position = this.pos(this.current);
        let type = this.parseOr();
        if (this.acceptKeyword('if')) {
            const testAt = this.pos(this.current);
            this.requireBool(this.parseOr(), testAt);
            this.expectKeyword('else');
            type = this.unify(type, this.parseConditional(), position);
        }
        return type;
    }

    private parseOr(): string {
        const position = this.pos(this.current);
        let type = this.parseAnd();
        while (this.acceptKeyword('or')) {
            const rightAt = this.pos(this.current);
            const right = this.parseAnd();
            this.requireBool(type, position);
            this.requireBool(right, rightAt);
            type = BOOL;
        }
        return type;
    }

    private parseAnd(): string {
        const position = this.pos(this.current);
        let type = this.parseNot();
        while (this.acceptKeyword('and')) {
            const rightAt = this.pos(this.current);
            const right = this.parseNot();
            this.requireBool(type, position);
            this.requireBool(right, rightAt);
            type = BOOL;
        }
        return type;
    }

    private parseNot(): string {
        if (this.acceptKeyword('not')) {
            const position = this.pos(this.current);
            return this.requireBool(this.parseNot(), position);
        }
        return this.parseComparison();
    }

    private parseComparison(): string {
        let type = this.parseAdditive();
        const position = this.pos(this.current);
        const op = this.comparisonOperator();
        if (op) {
            type = this.bindComparison(op, type, this.parseAdditive(), position);
            if (this.comparisonOperator())
                throw new ScriptError(this.pos(this.current), 'Chained comparisons are not supported.');
        }
        return type;
    }

    private comparisonOperator(): string | undefined {
        for (const op of ['==', '!=', '<', '<=', '>', '>=']) if (this.acceptSymbol(op)) return op;
        if (this.acceptKeyword('is')) return this.acceptKeyword('not') ? '!=' : '==';
        return undefined;
    }

    private parseAdditive(): string {
        let type = this.parseMultiplicative();
        for (;;) {
            const position = this.pos(this.current);
            const op = this.acceptSymbol('+') ? '+' : this.acceptSymbol('-') ? '-' : undefined;
            if (!op) return type;
            type = this.bindArithmetic(op, type, this.parseMultiplicative(), position);
        }
    }

    private parseMultiplicative(): string {
        let type = this.parseUnary();
        for (;;) {
            const position = this.pos(this.current);
            const op = ['*', '/', '%'].find((symbol) => this.acceptSymbol(symbol));
            if (!op) return type;
            type = this.bindArithmetic(op, type, this.parseUnary(), position);
        }
    }

    private parseUnary(): string {
        const position = this.pos(this.current);
        for (const op of ['-', '+']) {
            if (!this.acceptSymbol(op)) continue;
            const type = this.parseUnary();
            if (type === UNKNOWN) return UNKNOWN;
            if (!NUMERIC.has(type))
                throw new ScriptError(position, `Operator '${op}' cannot be applied to ${this.name(type)}.`);
            return op === '-' ? promoted(type, type) : type;
        }
        return this.parsePostfix();
    }

    private parsePostfix(): string {
        let type = this.parsePrimary();
        while (this.acceptSymbol('.')) {
            const nameToken = this.current;
            this.accesses.push({ nameStart: nameToken.start, target: type });
            const position = this.pos(nameToken);
            const name = this.expectName();
            type = this.acceptSymbol('(')
                ? this.bindMethodCall(type, name, this.parseArguments(), position)
                : this.bindProperty(type, name, position);
        }
        return type;
    }

    private parsePrimary(): string {
        const token = this.current;
        if (token.kind === 'number') {
            this.index++;
            const digits = token.text.replace(/_/g, '');
            if (/[.eE]/.test(digits)) return DOUBLE;
            return BigInt(digits) <= INT_MAX ? INT : LONG;
        }
        if (token.kind === 'string') {
            this.index++;
            return STRING;
        }
        if (token.kind === 'keyword') {
            if (this.acceptKeyword('True') || this.acceptKeyword('False')) return BOOL;
            if (this.acceptKeyword('None')) return NONE;
        }
        if (token.kind === 'name' || token.kind === 'keyword') {
            const name = this.expectName();
            if (this.acceptSymbol('(')) return this.bindFunctionCall(name, this.parseArguments(), this.pos(token));
            return this.bindVariable(name, this.pos(token));
        }
        if (this.acceptSymbol('(')) {
            const type = this.parseConditional();
            this.expectSymbol(')');
            return type;
        }
        throw new ScriptError(this.pos(token), `Expected an expression but found '${this.describe(token)}'.`);
    }

    private parseArguments(): string[] {
        const args: string[] = [];
        if (this.acceptSymbol(')')) return args;
        do args.push(this.parseConditional());
        while (this.acceptSymbol(','));
        this.expectSymbol(')');
        return args;
    }

    private contextMembers(name: string): ScriptMember[] | undefined {
        const context = this.surface?.contexts[this.context];
        if (!context) return undefined;
        return context.variables.filter((member) => member.name === name);
    }

    private bindVariable(token: ScriptToken, position: number): string {
        const members = this.contextMembers(token.text);
        if (!members) return UNKNOWN;
        if (members.length === 0) throw new ScriptError(position, `Unknown variable '${token.text}'.`);
        const variable = members.find((member) => member.kind === 'variable');
        if (!variable) throw new ScriptError(position, `'${token.text}' is a function and must be called.`);
        this.bindings.push({ start: token.start, end: token.end, role: 'variable', members: [variable] });
        return variable.type ?? UNKNOWN;
    }

    private bindFunctionCall(token: ScriptToken, args: string[], position: number): string {
        const members = this.contextMembers(token.text);
        if (!members) return UNKNOWN;
        if (members.length === 0) throw new ScriptError(position, `Unknown function '${token.text}'.`);
        const functions = members.filter((member) => member.kind === 'function');
        if (functions.length === 0) throw new ScriptError(position, `'${token.text}' is not a function.`);
        this.bindings.push({ start: token.start, end: token.end, role: 'function', members: functions });
        return this.bindCall(functions, token.text, args, position);
    }

    private accessible(type: string, position: number): ReturnType<typeof membersOf> {
        if (!this.surface?.typeInfo[type]?.accessible)
            throw new ScriptError(position, `Cannot access members of ${this.name(type)}.`);
        return membersOf(this.surface, type);
    }

    private bindProperty(target: string, token: ScriptToken, position: number): string {
        if (target === UNKNOWN) return UNKNOWN;
        const { properties, methods } = this.accessible(target, position);
        const property = properties.find((member) => member.name === token.text);
        if (property) {
            this.bindings.push({
                start: token.start,
                end: token.end,
                role: 'property',
                members: [property],
                owner: target,
            });
            return property.type ?? UNKNOWN;
        }
        if (methods.some((member) => member.name === token.text))
            throw new ScriptError(position, `'${token.text}' is a method and must be called.`);
        throw new ScriptError(position, `${this.name(target)} has no property named '${token.text}'.`);
    }

    private bindMethodCall(target: string, token: ScriptToken, args: string[], position: number): string {
        if (target === UNKNOWN) return UNKNOWN;
        const { methods } = this.accessible(target, position);
        const overloads = methods.filter((member) => member.name === token.text);
        if (overloads.length === 0)
            throw new ScriptError(position, `${this.name(target)} has no method named '${token.text}'.`);
        this.bindings.push({ start: token.start, end: token.end, role: 'method', members: overloads, owner: target });
        return this.bindCall(overloads, token.text, args, position);
    }

    private bindCall(overloads: ScriptMember[], name: string, args: string[], position: number): string {
        for (const method of overloads) {
            const params = method.params ?? [];
            if (args.length > params.length) continue;
            const fits = params.every((param, i) =>
                param.type.endsWith('&')
                    ? false
                    : i < args.length
                      ? this.convertible(args[i], param.type)
                      : param.optional === true
            );
            if (fits) return method.returns ?? UNKNOWN;
        }
        throw new ScriptError(
            position,
            `'${name}' cannot be called with arguments (${args.map((arg) => this.name(arg)).join(', ')}).`
        );
    }

    private bindArithmetic(op: string, left: string, right: string, position: number): string {
        if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
        if (!NUMERIC.has(left) || !NUMERIC.has(right))
            throw new ScriptError(
                position,
                `Operator '${op}' cannot be applied to ${this.name(left)} and ${this.name(right)}.`
            );
        const type = promoted(left, right);
        return op === '/' && !FLOATING.has(type) ? DOUBLE : type;
    }

    private bindComparison(op: string, left: string, right: string, position: number): string {
        if (left === UNKNOWN || right === UNKNOWN) return BOOL;
        if (NUMERIC.has(left) && NUMERIC.has(right)) return BOOL;
        if (op === '==' || op === '!=') {
            if (left === NONE || right === NONE) return BOOL;
            if (left === right) return BOOL;
            if (this.assignable(left, right) || this.assignable(right, left)) return BOOL;
        } else if (left === right && this.orderable(left, op)) {
            return BOOL;
        }
        throw new ScriptError(
            position,
            `Operator '${op}' cannot be applied to ${this.name(left)} and ${this.name(right)}.`
        );
    }

    /**
     * Whether an ordering operator applies to two values of one type. The game asks the
     * expression-tree builder, which accepts a lifted number and any type that declares the operator.
     */
    private orderable(type: string, op: string): boolean {
        const inner = type.endsWith('?') ? type.slice(0, -1) : type;
        return NUMERIC.has(inner) || this.surface?.typeInfo[inner]?.ordering?.includes(op) === true;
    }

    private unify(a: string, b: string, position: number): string {
        if (a === b || a === UNKNOWN || b === UNKNOWN) return a === UNKNOWN ? b : a;
        if (NUMERIC.has(a) && NUMERIC.has(b)) return promoted(a, b);
        if (this.convertible(b, a)) return a;
        if (this.convertible(a, b)) return b;
        throw new ScriptError(position, `Cannot combine ${this.name(a)} and ${this.name(b)}.`);
    }

    private requireBool(type: string, position: number): string {
        if (type !== BOOL && type !== UNKNOWN)
            throw new ScriptError(position, `Expected a bool but found ${this.name(type)}.`);
        return BOOL;
    }

    /** The game's `TryConvertTo`: numbers widen except float to integer, `None` meets anything nullable. */
    convertible(from: string, to: string): boolean {
        if (from === to || from === UNKNOWN || to === UNKNOWN) return true;
        if (from === NONE) return !this.nonNullableValue(to);
        if (NUMERIC.has(from) && NUMERIC.has(to)) return !FLOATING.has(from) || FLOATING.has(to);
        if (to.endsWith('?') && this.convertible(from, to.slice(0, -1))) return true;
        return this.assignable(to, from);
    }

    private assignable(to: string, from: string): boolean {
        if (to === from || to === OBJECT) return true;
        if (from === NONE) return false;
        return this.surface?.typeInfo[from]?.bases?.includes(to) === true;
    }

    private nonNullableValue(type: string): boolean {
        if (type.endsWith('?') || type === NONE) return false;
        return PRIMITIVE_VALUES.has(type) || this.surface?.typeInfo[type]?.valueType === true;
    }

    name(type: string): string {
        return scriptTypeName(this.surface, type);
    }
}

/** The game's numeric promotion for two operands. */
const promoted = (a: string, b: string): string => {
    if (a === DOUBLE || b === DOUBLE) return DOUBLE;
    if (a === FLOAT || b === FLOAT) return FLOAT;
    if (a === LONG || b === LONG || a === 'System.UInt32' || b === 'System.UInt32') return LONG;
    return INT;
};

/**
 * The members a script may use on a type.
 *
 * @param surface the scripting surface.
 * @param type the type key.
 * @returns its properties and methods, empty for a type scripts cannot read.
 */
export const membersOf = (
    surface: ScriptingSurface | undefined,
    type: string
): { properties: readonly ScriptMember[]; methods: readonly ScriptMember[] } =>
    surface?.types[type] ?? { properties: [], methods: [] };

/**
 * Compile a script as the game does when it loads the rules.
 *
 * @param written the string as the field holds it, prefix and padding included.
 * @param surface the scripting surface, or undefined for a game without one.
 * @param context the context type key the field compiles against.
 * @param returns the type the script must produce, `System.Void` for an action.
 * @returns the first error, if any, and everything the parse got through before it.
 */
export const compileScript = (
    written: string,
    surface: ScriptingSurface | undefined,
    context: string,
    returns: string
): ScriptResult => {
    // The game trims the script and drops one leading `?` or `>`, the Python-era prefixes.
    let base = written.length - written.trimStart().length;
    let source = written.trim();
    if (source.startsWith('?') || source.startsWith('>')) {
        const rest = source.slice(1);
        base += 1 + rest.length - rest.trimStart().length;
        source = rest.trim();
    }
    const compiler = new Compiler(source, base, surface, context);
    const result = (error?: ScriptError): ScriptResult => {
        if (!error) return { tokens: compiler.tokens, bindings: compiler.bindings, accesses: compiler.accesses };
        const at = error.position + base;
        const token = compiler.tokens.find((candidate) => candidate.start === at && candidate.end > at);
        return {
            error: { start: at, end: token?.end ?? Math.min(at + 1, base + source.length), message: error.message },
            tokens: compiler.tokens,
            bindings: compiler.bindings,
            accesses: compiler.accesses,
        };
    };
    try {
        compiler.tokenize();
        const type = compiler.parseScript();
        if (returns !== VOID && !compiler.convertible(type, returns))
            throw new ScriptError(0, `Cannot convert ${compiler.name(type)} to ${compiler.name(returns)}.`);
        return result();
    } catch (error) {
        if (error instanceof ScriptError) return result(error);
        throw error;
    }
};
