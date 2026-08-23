import { CancellationTokenSource, SemanticTokens, SemanticTokensDelta, TextEdit } from 'vscode-languageserver/node';
import { HoverService } from '../../features/hover/hover.service';
import { InlayHintService } from '../../features/inlay/inlay-hint.service';
import { documentColors, colorPresentations } from '../../features/color/document-color';
import { buildSemanticTokens } from '../../features/semantic/semantic-tokens.service';
import { buildShaderSemanticTokens } from '../../features/semantic/shader-semantic-tokens';
import { computeSignatureHelp } from '../../features/signature/signature-help.service';
import { formatRulesDocument } from '../../features/formatting/rules-formatter';
import { formatShaderDocument } from '../../features/formatting/shader-formatter';
import { minimalReplacementEdits } from '../../features/formatting/formatting.service';
import { shaderDocumentHover } from '../../features/shader/shader-document-features';
import { shaderSignatureHelp } from '../../features/shader/shader-signature';
import { isShaderDocument } from '../../document/document-kind';
import { globalSettings } from '../../settings';
import { traceFailure } from '../../utils/cancellation';
import { connection, documents } from '../context';
import { inlayHintCache, semanticTokensCache } from '../document-caches';
import { ensureParserResult, shaderIncludeTextFor } from '../open-documents';
import { searchFolderUris } from '../workspace-folders';

/** The whole-document range, so one inlay computation covers every later scroll request. */
const FULL_DOCUMENT_RANGE = {
    start: { line: 0, character: 0 },
    end: { line: Number.MAX_SAFE_INTEGER, character: 0 },
};

/** Source of the semantic-tokens `resultId`s, unique across the whole session. */
let semanticTokensResultIdCounter = 0;

/**
 * The full token array of a document, served from the per-version cache when current.
 *
 * @param uri the document to tokenize.
 * @returns the token data and the result id identifying this computation.
 */
const computeSemanticTokens = (uri: string): { resultId: string; data: number[] } => {
    const version = documents.get(uri)?.version;
    const cached = semanticTokensCache.get(uri);
    if (cached && version !== undefined && cached.version === version) return cached;
    let data: number[];
    // `.shader` files are HLSL, scanned lexically straight from text, no OT parse needed.
    if (isShaderDocument(uri)) {
        const document = documents.get(uri);
        data = document ? buildShaderSemanticTokens(document.getText()).data : [];
    } else {
        const parserResult = ensureParserResult(uri);
        data = parserResult ? buildSemanticTokens(parserResult).data : [];
    }
    const entry = { version: version ?? -1, resultId: String(++semanticTokensResultIdCounter), data };
    if (version !== undefined) semanticTokensCache.set(uri, entry);
    return entry;
};

/**
 * The minimal single-edit diff between two token arrays: the differing middle after trimming the
 * common prefix and suffix. What an edit changes is almost always one contiguous run of tokens, so
 * one edit covers it and the client patches its copy in place.
 *
 * @param before the token data the client currently holds.
 * @param after the token data of the current document version.
 * @returns zero edits for identical arrays, otherwise the one covering edit.
 */
const semanticTokensEdits = (before: number[], after: number[]): Array<{ start: number; deleteCount: number; data?: number[] }> => {
    let start = 0;
    const minLength = Math.min(before.length, after.length);
    while (start < minLength && before[start] === after[start]) start++;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
        beforeEnd--;
        afterEnd--;
    }
    if (start === beforeEnd && start === afterEnd) return [];
    return [{ start, deleteCount: beforeEnd - start, data: after.slice(start, afterEnd) }];
};

/**
 * The tokens of `data` whose line falls inside `[startLine, endLine]`, re-encoded so the first
 * kept token's deltas are absolute (its implicit predecessor is the document start). Serving a
 * superset of the requested range is allowed, so the line bounds are inclusive.
 *
 * @param data the full document's delta-encoded token quintuples.
 * @param startLine the first line to include.
 * @param endLine the last line to include.
 * @returns the delta-encoded tokens of the requested lines.
 */
const sliceSemanticTokens = (data: number[], startLine: number, endLine: number): number[] => {
    const out: number[] = [];
    let line = 0;
    let character = 0;
    let previousLine = 0;
    let previousCharacter = 0;
    let first = true;
    for (let i = 0; i + 4 < data.length; i += 5) {
        line += data[i];
        if (data[i] > 0) character = 0;
        character += data[i + 1];
        if (line < startLine) continue;
        if (line > endLine) break;
        if (first) {
            out.push(line, character, data[i + 2], data[i + 3], data[i + 4]);
            first = false;
        } else {
            out.push(
                line - previousLine,
                line === previousLine ? character - previousCharacter : character,
                data[i + 2],
                data[i + 3],
                data[i + 4]
            );
        }
        previousLine = line;
        previousCharacter = character;
    }
    return out;
};

// Document formatting: whitespace-only normalization (indentation, spacing around structural
// punctuation, trailing whitespace). `.rules` formatting is guarded by a lexical-equivalence check
// and returns no edits rather than risk changing what the game reads. `.shader` files get a plain
// brace-depth re-indent. `mod.rules` actions are ordinary ObjectText and format like any `.rules`.
const formattingEdits = (uri: string, options: { tabSize: number; insertSpaces: boolean }): TextEdit[] => {
    const document = documents.get(uri);
    if (!document) return [];
    const text = document.getText();
    const formatted = isShaderDocument(uri)
        ? formatShaderDocument(text, options)
        : formatRulesDocument(text, options);
    if (formatted === null) return [];
    return minimalReplacementEdits(document, formatted);
};
/**
 * Registers everything that renders an already-parsed document: hover, colour swatches, inlay
 * hints, semantic tokens, signature help and formatting. None of these changes project state, and
 * none of them feeds a cache the on-disk scan results are gated on.
 */
export function register(): void {
    // Hover: show what a value resolves to, its computed number and/or reference target.
    connection.onHover(async (params, cancellationToken) => {
        // `.shader` files: explain the symbol under the cursor (uniform, intrinsic, type, function, …).
        if (isShaderDocument(params.textDocument.uri)) {
            const document = documents.get(params.textDocument.uri);
            if (!document) return null;
            const text = document.getText();
            const includeText = await shaderIncludeTextFor(text, params.textDocument.uri);
            return shaderDocumentHover(text, document.offsetAt(params.position), includeText);
        }
        const parserResult = ensureParserResult(params.textDocument.uri);
        if (!parserResult) return null;
        try {
            return await HoverService.instance.getHover(
                parserResult,
                params.position,
                cancellationToken,
                await searchFolderUris()
            );
        } catch (e) {
            traceFailure(e);
            return null;
        }
    });

    // Document colours: render an inline swatch for `{ Rf Gf Bf Af }` / `{ R G B A }` colour groups.
    connection.onDocumentColor((params) => {
        // Colour swatches come from schema-typed `.rules` colour groups, which a `.shader` has none of.
        if (isShaderDocument(params.textDocument.uri)) return [];
        const parserResult = ensureParserResult(params.textDocument.uri);
        if (!parserResult) return [];
        try {
            return documentColors(parserResult);
        } catch (e) {
            if (globalSettings.trace.server === 'messages') console.error(e);
            return [];
        }
    });

    // Colour picker: rewrite the chosen colour's component values in place (braces/layout untouched).
    connection.onColorPresentation((params) => {
        // A shader is never lexed as ObjectText: `ensureParserResult` caches whatever it parses, so an
        // unguarded call here would leave a nonsense tree behind for that uri.
        if (isShaderDocument(params.textDocument.uri)) return [];
        const parserResult = ensureParserResult(params.textDocument.uri);
        const document = documents.get(params.textDocument.uri);
        if (!parserResult || !document) return [];
        try {
            return colorPresentations(parserResult, document.getText(), params.range, params.color);
        } catch (e) {
            if (globalSettings.trace.server === 'messages') console.error(e);
            return [];
        }
    });

    connection.languages.inlayHint.on(async (params, cancellationToken) => {
        const uri = params.textDocument.uri;
        // Inlay hints evaluate Object Text expressions. A `.shader` has none, and parsing it as one is
        // wasted work on a nonsense AST.
        if (isShaderDocument(uri)) return null;
        const parserResult = ensureParserResult(uri);
        if (!parserResult) return null;
        try {
            const version = documents.get(uri)?.version;
            let entry = version !== undefined ? inlayHintCache.get(uri) : undefined;
            if (!entry || entry.version !== version) {
                // The shared computation runs under its own token, cancelled only when a newer
                // version supersedes the entry. Binding it to the first request's token let that
                // request's cancellation truncate the hints every later same-version request served.
                const source = new CancellationTokenSource();
                const promise = InlayHintService.instance.getInlayHints(parserResult, FULL_DOCUMENT_RANGE, source.token);
                if (version !== undefined) {
                    inlayHintCache.get(uri)?.source.cancel();
                    entry = { version, promise, source };
                    inlayHintCache.set(uri, entry);
                } else {
                    entry = { version: -1, promise, source };
                }
            }
            const hints = await entry.promise;
            // A superseded computation returned partial hints, drop it so the next request recomputes.
            if (entry.source.token.isCancellationRequested) {
                if (inlayHintCache.get(uri) === entry) inlayHintCache.delete(uri);
                return null;
            }
            // The requester going away does not invalidate the shared result, so the entry stays.
            if (cancellationToken.isCancellationRequested) return null;
            const { start, end } = params.range;
            return hints.filter((hint) => {
                const { line, character } = hint.position;
                if (line < start.line || line > end.line) return false;
                if (line === start.line && character < start.character) return false;
                if (line === end.line && character > end.character) return false;
                return true;
            });
        } catch (e) {
            if (inlayHintCache.get(uri)?.version === documents.get(uri)?.version) inlayHintCache.delete(uri);
            traceFailure(e);
            return null;
        }
    });

    connection.languages.semanticTokens.on((params, cancellationToken): SemanticTokens => {
        if (cancellationToken.isCancellationRequested) return { data: [] };
        try {
            const { resultId, data } = computeSemanticTokens(params.textDocument.uri);
            return { resultId, data };
        } catch (e) {
            if (globalSettings.trace.server === 'messages') console.error(e);
            return { data: [] };
        }
    });

    connection.languages.semanticTokens.onDelta((params, cancellationToken): SemanticTokens | SemanticTokensDelta => {
        if (cancellationToken.isCancellationRequested) return { data: [] };
        try {
            const uri = params.textDocument.uri;
            // Snapshot the entry the client's `previousResultId` may name before computing the current
            // version replaces it in the cache. When it is gone (document closed and reopened) or the
            // id doesn't match, answer with a full result, which the delta response type allows.
            const previous = semanticTokensCache.get(uri);
            const current = computeSemanticTokens(uri);
            if (!previous || previous.resultId !== params.previousResultId) {
                return { resultId: current.resultId, data: current.data };
            }
            if (current.resultId === previous.resultId) return { resultId: current.resultId, edits: [] };
            return { resultId: current.resultId, edits: semanticTokensEdits(previous.data, current.data) };
        } catch (e) {
            if (globalSettings.trace.server === 'messages') console.error(e);
            return { data: [] };
        }
    });

    connection.languages.semanticTokens.onRange((params, cancellationToken): SemanticTokens => {
        if (cancellationToken.isCancellationRequested) return { data: [] };
        try {
            const { data } = computeSemanticTokens(params.textDocument.uri);
            return { data: sliceSemanticTokens(data, params.range.start.line, params.range.end.line) };
        } catch (e) {
            if (globalSettings.trace.server === 'messages') console.error(e);
            return { data: [] };
        }
    });

    // Signature help: show a math function's parameter list and highlight the active argument while
    // typing inside its parentheses (`Damage = ceil(…)`). Driven by a raw-text scan so it works mid-edit.
    connection.onSignatureHelp(async (params) => {
        const document = documents.get(params.textDocument.uri);
        if (!document) return null;
        try {
            // `.shader` files: signature help for the HLSL intrinsic or file/include function the cursor is in.
            if (isShaderDocument(params.textDocument.uri)) {
                const text = document.getText();
                const includeText = await shaderIncludeTextFor(text, params.textDocument.uri);
                return shaderSignatureHelp(text, document.offsetAt(params.position), includeText);
            }
            return computeSignatureHelp(document.getText(), document.offsetAt(params.position));
        } catch (e) {
            if (globalSettings.trace.server === 'messages') console.error(e);
            return null;
        }
    });

    connection.onDocumentFormatting((params) => {
        if (globalSettings.formatting?.enabled === false) return [];
        try {
            return formattingEdits(params.textDocument.uri, {
                tabSize: params.options.tabSize,
                insertSpaces: params.options.insertSpaces,
            });
        } catch (e) {
            if (globalSettings.trace.server === 'messages') console.error(e);
            return null;
        }
    });

    // Format-on-save (`cosmoteerLSPRules.formatting.formatOnSave`, default off): the edits returned
    // here are applied by the client before the file hits disk. The save event carries no editor
    // indent options, so it formats with tabs, the vanilla `.rules` convention.
    documents.onWillSaveWaitUntil((event) => {
        if (globalSettings.formatting?.enabled === false || globalSettings.formatting?.formatOnSave !== true) {
            return [];
        }
        try {
            return formattingEdits(event.document.uri, { tabSize: 4, insertSpaces: false });
        } catch (e) {
            if (globalSettings.trace.server === 'messages') console.error(e);
            return [];
        }
    });
}
