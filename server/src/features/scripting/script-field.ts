import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isValueNode } from '../../core/ast/ast';
import {
    fieldOf,
    isScriptType,
    ScriptValueType,
    scriptFieldNames,
    scriptingSurface,
} from '../../document/schema/schema';
import { memberScopeClassAt } from '../../document/schema/schema-context';
import { assignmentNameOf } from '../../utils/ast.utils';
import { fieldOfValueNode } from '../completion/autocompletion.schema';
import { compileScript, ScriptResult } from './script-compiler';

/** A script value in a document, compiled. Offsets in `result` index the decoded script. */
export interface CompiledScript {
    readonly type: ScriptValueType;
    /** The script as the game reads it, escapes resolved and continued lines joined. */
    readonly script: string;
    readonly result: ScriptResult;
    /** The document span of a span of the decoded script. */
    toDocument(start: number, end: number): { start: number; end: number };
    /** The index into the decoded script of a document offset, or undefined outside the script. */
    fromDocument(offset: number): number | undefined;
}

/** The escapes `StringTools.DeformatString` accepts after a backslash, folded to lower case. */
const ESCAPES: Record<string, string> = {
    '"': '"',
    '\\': '\\',
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '0': '\0',
};

/**
 * The string a value holds as the game reads it, with where each of its characters is written.
 *
 * Mirrors `OTParser.ParseValue` and `StringTools.DeformatString`: quoted segments joined over a line
 * continuation concatenate with nothing between them, a `"…"` segment resolves its escapes and a
 * `@"…"` one its doubled quotes. A value with an unquoted part, or an escape the game refuses, is
 * left alone.
 *
 * @param node the value node.
 * @param text the document text.
 * @returns the decoded script with the document start and end of each character.
 */
const decodeValue = (
    node: AbstractNode,
    text: string
): { script: string; starts: number[]; ends: number[]; end: number } | undefined => {
    if (!isValueNode(node) || node.valueType.type !== 'String' || !node.quoted) return undefined;
    const end = node.position.end;
    let script = '';
    const starts: number[] = [];
    const ends: number[] = [];
    const emit = (c: string, from: number, to: number): void => {
        script += c;
        starts.push(from);
        ends.push(to);
    };
    let i = node.position.start;
    while (i < end) {
        const c = text[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\\') {
            i++;
        } else if (c === '@' && text[i + 1] === '"') {
            i += 2;
            for (;;) {
                if (i >= end) return undefined;
                if (text[i] === '"' && text[i + 1] === '"') {
                    emit('"', i, i + 2);
                    i += 2;
                } else if (text[i] === '"') {
                    i++;
                    break;
                } else {
                    emit(text[i], i, i + 1);
                    i++;
                }
            }
        } else if (c === '"') {
            i++;
            for (;;) {
                if (i >= end) return undefined;
                const d = text[i];
                if (d === '"') {
                    i++;
                    break;
                }
                if (d !== '\\') {
                    emit(d, i, i + 1);
                    i++;
                    continue;
                }
                const e = (text[i + 1] ?? '').toLowerCase();
                if (e === 'u') {
                    const hex = text.slice(i + 2, i + 6);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
                    emit(String.fromCharCode(parseInt(hex, 16)), i, i + 6);
                    i += 6;
                } else if (e in ESCAPES) {
                    emit(ESCAPES[e], i, i + 2);
                    i += 2;
                } else {
                    return undefined;
                }
            }
        } else {
            return undefined;
        }
    }
    return { script, starts, ends, end };
};

const compile = (type: ScriptValueType, node: AbstractNode, text: string): CompiledScript | undefined => {
    const decoded = decodeValue(node, text);
    if (!decoded) return undefined;
    const { script, starts, ends } = decoded;
    // An empty script still has a place: just inside its opening quote.
    const startOf = (index: number): number =>
        index < starts.length ? starts[index] : (ends[ends.length - 1] ?? node.position.start + 1);
    return {
        type,
        script,
        result: compileScript(script, scriptingSurface(), type.context, type.returns),
        toDocument: (start, end) => ({
            start: startOf(start),
            end: end > start ? ends[Math.min(end, ends.length) - 1] : startOf(start),
        }),
        fromDocument: (offset) => {
            for (let i = 0; i < starts.length; i++) if (offset < ends[i]) return offset >= starts[i] ? i : undefined;
            return offset === ends[ends.length - 1] ? starts.length : undefined;
        },
    };
};

/**
 * Compile the script a value holds, finding its field through inheritance.
 *
 * @param node the value node.
 * @param text the document text.
 * @param token cancels the field lookup.
 * @returns the compiled script, or undefined when the value is not a script this server reads.
 */
export const compileScriptAt = async (
    node: AbstractNode,
    text: string,
    token: CancellationToken
): Promise<CompiledScript | undefined> => {
    const name = assignmentNameOf(node)?.toLowerCase();
    if (!name || !scriptFieldNames().has(name) || !isValueNode(node)) return undefined;
    const field = await fieldOfValueNode(node, token).catch(() => undefined);
    return isScriptType(field?.valueType) ? compile(field.valueType, node, text) : undefined;
};

/**
 * The same as {@link compileScriptAt} without the cross-file walk, for the synchronous highlighting
 * pass. A script whose field is only known through a base in another file is not found.
 *
 * @param document the document.
 * @param node the value node.
 * @param text the document text.
 * @returns the compiled script, or undefined.
 */
export const compileScriptAtSync = (
    document: AbstractNodeDocument,
    node: AbstractNode,
    text: string
): CompiledScript | undefined => {
    const name = assignmentNameOf(node);
    if (!name || !scriptFieldNames().has(name.toLowerCase()) || !isValueNode(node)) return undefined;
    const cls = memberScopeClassAt(document, node.position.start);
    const field = cls ? fieldOf(cls, name) : undefined;
    return isScriptType(field?.valueType) ? compile(field.valueType, node, text) : undefined;
};
