import { existsSync } from 'fs';
import { DocumentSymbol, Hover, Location, Position, Range, SymbolKind } from 'vscode-languageserver';
import { parseShader } from './shader-parser';
import { resolveInclude } from './shader-source';
import { findShaderDeclaration, ReadOverride } from './shader-index';
import { HLSL_INTRINSICS, TEXTURE_METHODS, ENGINE_UNIFORMS, describeHlslType } from './shader-intrinsics';
import { ENGINE_MACROS } from './shader-completion';
import { HLSL_TYPES } from '../semantic/shader-semantic-tokens';
import { filePathToUri } from '../navigation/navigation-strategy';
import { uriToFsPath } from '../navigation/workspace-files';

/**
 * Editor features for an open `.shader` file itself (as opposed to the shader constants a `.rules`
 * material sets, which `shader-hover.ts` handles). These run straight off the document text with the
 * lexical {@link parseShader} scanner, no OT parse involved.
 */

/** Matches an `#include "path"` directive and captures the quoted path's span. */
const INCLUDE_RE = /#\s*include\s+"([^"]+)"/;

/** The identifier word covering a character offset, with its start, or null when none. */
const wordAt = (text: string, offset: number): { word: string; start: number } | null => {
    if (offset < 0 || offset > text.length) return null;
    const isWord = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
    let start = offset;
    while (start > 0 && isWord(text[start - 1])) start--;
    let end = offset;
    while (end < text.length && isWord(text[end])) end++;
    if (start === end) return null;
    return { word: text.slice(start, end), start };
};

/** The line containing an offset, with the offset of its start (for include-span math). */
const lineAt = (text: string, offset: number): { line: string; lineStart: number } => {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    let lineEnd = text.indexOf('\n', offset);
    if (lineEnd < 0) lineEnd = text.length;
    return { line: text.slice(lineStart, lineEnd), lineStart };
};

/** Wraps a code line and an explanation into a markdown hover. */
const codeHover = (code: string, explanation: string): Hover => ({
    contents: { kind: 'markdown', value: `\`\`\`hlsl\n${code}\n\`\`\`\n\n${explanation}` },
});

/**
 * Hover for a `.shader` file. Explains whatever the cursor is on: a `_`-uniform (its declared type, or
 * that it is engine-provided), an HLSL intrinsic or texture method (its signature and what it does), an
 * HLSL type, or a function the file defines. Returns null for ordinary locals and keywords.
 *
 * @param text the full source of the file being edited.
 * @param offset the cursor byte offset in `text`.
 * @param includeText the concatenated text of the file's `#include` chain, so a uniform or function
 * declared in a base shader is explained too. Empty when the file has no includes.
 */
export const shaderDocumentHover = (text: string, offset: number, includeText = ''): Hover | null => {
    const hit = wordAt(text, offset);
    if (!hit) return null;
    const word = hit.word;
    // Widen the file-symbol lookup (uniforms, functions) to the include chain.
    const shader = parseShader(includeText ? `${text}\n${includeText}` : text);

    // A uniform the file declares — show its declared type and default.
    const constant = shader.constants.find((c) => c.name === word);
    if (constant) {
        const declaration = `${constant.hlslType} ${constant.name}${constant.default ? ` = ${constant.default}` : ''}`;
        return codeHover(declaration, `Shader uniform · \`${constant.kind}\``);
    }
    // An engine-provided uniform (declared in an include the file pulls in, not here).
    if (word in ENGINE_UNIFORMS) {
        const engine = ENGINE_UNIFORMS[word];
        return codeHover(`${engine.type} ${word}`, `Engine uniform — ${engine.doc}`);
    }

    // An HLSL intrinsic function.
    const intrinsic = HLSL_INTRINSICS[word];
    if (intrinsic) return codeHover(`${word}(${intrinsic.params.join(', ')})`, intrinsic.doc);

    // A texture sampling/query method.
    const method = TEXTURE_METHODS[word];
    if (method) return codeHover(`${method.returns} ${method.signature}`, method.doc);

    // An HLSL builtin type.
    if (HLSL_TYPES.has(word)) {
        const description = describeHlslType(word);
        if (description) return codeHover(word, description);
    }

    // A function the file or one of its includes defines.
    if (shader.functions.includes(word)) return codeHover(`${word}(…)`, 'A function defined in this shader or an include.');

    // A preprocessor macro: an engine feature-level gate, a macro defined in scope (shown with its
    // replacement), or a guard an included base shader tests (the defining-before-include pattern).
    const engineMacro = ENGINE_MACROS.find(([name]) => name === word);
    if (engineMacro) return codeHover(word, engineMacro[1]);
    const scopeText = includeText ? `${text}\n${includeText}` : text;
    const definition = new RegExp(`^\\s*#\\s*define\\s+${word}\\b[ \\t]*(.*)$`, 'm').exec(scopeText);
    if (definition) {
        const replacement = definition[1].trim();
        return codeHover(`#define ${word}${replacement ? ` ${replacement}` : ''}`, 'Preprocessor macro defined in this shader or an include.');
    }
    if (new RegExp(`#\\s*(?:ifdef|ifndef)\\s+${word}\\b|\\bdefined\\s*\\(\\s*${word}\\s*\\)`).test(scopeText)) {
        return codeHover(word, 'Preprocessor guard tested in this shader or an include — define it before the `#include` to switch the guarded path on.');
    }

    return null;
};

/**
 * Go-to-definition for a `.shader` file: when the cursor is on an `#include "…"` path, resolve it to
 * the included file. Returns null when the cursor is not on an include or the target does not exist.
 *
 * @param text the full shader source.
 * @param offset the cursor byte offset.
 * @param uri the `file://` URI of the shader being edited (the include's base directory).
 * @param dataDir the game `Data` directory, for root-anchored (`./Data/…`) includes.
 */
export const shaderDocumentDefinition = (
    text: string,
    offset: number,
    uri: string,
    dataDir?: string
): Location | null => {
    const { line, lineStart } = lineAt(text, offset);
    const match = INCLUDE_RE.exec(line);
    if (!match) return null;
    // Only resolve when the cursor is actually within the quoted path.
    const pathStart = lineStart + match.index + match[0].indexOf('"') + 1;
    const pathEnd = pathStart + match[1].length;
    if (offset < pathStart || offset > pathEnd) return null;

    const target = resolveInclude(uriToFsPath(uri), match[1], dataDir);
    if (!existsSync(target)) return null;
    const start = Position.create(0, 0);
    return Location.create(filePathToUri(target), Range.create(start, start));
};

/**
 * Go-to-definition for a `_uniform` or a function name under the cursor: resolves it to its declaration
 * in the file itself or anywhere in its `#include` chain. Returns null when the cursor is on a keyword,
 * an intrinsic, a type, a member after a `.`, or any name the chain does not declare (so a builtin does
 * not produce a bogus jump).
 *
 * @param text the full shader source being edited.
 * @param offset the cursor byte offset.
 * @param uri the `file://` URI of the shader being edited (the base for resolving includes).
 * @param dataDir the game `Data` directory, for root-anchored includes.
 * @param readOverride prefers an open buffer's text over disk for an included file.
 */
export const shaderSymbolDefinition = async (
    text: string,
    offset: number,
    uri: string,
    dataDir?: string,
    readOverride?: ReadOverride
): Promise<Location | null> => {
    const hit = wordAt(text, offset);
    if (!hit) return null;
    // A member access (`_tex.Sample`) or a builtin is not a navigable declaration — only file uniforms
    // and file/include functions are. findShaderDeclaration returns null for anything else, but skipping
    // the obvious non-targets avoids walking the include chain for every keyword.
    const isMemberAccess = hit.start > 0 && text[hit.start - 1] === '.';
    if (isMemberAccess || HLSL_TYPES.has(hit.word) || hit.word in HLSL_INTRINSICS || hit.word in TEXTURE_METHODS) {
        return null;
    }
    const found = await findShaderDeclaration(text, uriToFsPath(uri), hit.word, dataDir, readOverride);
    if (!found) return null;
    const start = Position.create(found.line, found.column);
    const end = Position.create(found.line, found.column + found.length);
    return Location.create(filePathToUri(found.path), Range.create(start, end));
};

/**
 * The outline of a `.shader` file: its file-scope `_`-uniforms and its functions, with the position of
 * each so the breadcrumb bar and Outline view can jump to them. Only the file's own declarations are
 * listed (not those pulled in through includes), matching how a document outline works elsewhere.
 *
 * @param text the full shader source.
 * @returns the flat list of uniform and function symbols the file declares.
 */
export const shaderDocumentSymbols = (text: string): DocumentSymbol[] => {
    const shader = parseShader(text);
    const symbols: DocumentSymbol[] = [];

    for (const constant of shader.constants) {
        if (!constant.position) continue;
        const range = Range.create(
            Position.create(constant.position.line, constant.position.column),
            Position.create(constant.position.line, constant.position.column + constant.name.length)
        );
        symbols.push({
            name: constant.name,
            detail: constant.hlslType,
            kind: SymbolKind.Constant,
            range,
            selectionRange: range,
        });
    }
    for (const fn of shader.functionDecls) {
        const range = Range.create(
            Position.create(fn.position.line, fn.position.column),
            Position.create(fn.position.line, fn.position.column + fn.name.length)
        );
        symbols.push({ name: fn.name, kind: SymbolKind.Function, range, selectionRange: range });
    }
    return symbols;
};
