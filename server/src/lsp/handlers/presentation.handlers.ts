import {
    CancellationToken,
    CancellationTokenSource,
    CodeLens,
    CodeLensParams,
    ColorPresentationParams,
    DocumentColorParams,
    DocumentFormattingParams,
    HoverParams,
    InlayHintParams,
    SemanticTokens,
    SemanticTokensDelta,
    SemanticTokensDeltaParams,
    SemanticTokensParams,
    SemanticTokensRangeParams,
    SignatureHelpParams,
    TextDocumentWillSaveEvent,
    TextEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getHover } from '../../features/hover/hover.service';
import { getInlayHints } from '../../features/inlay/inlay-hint.service';
import { documentColors, colorPresentations } from '../../features/color/document-color';
import { markupColors, markupColorPresentations } from '../../features/color/markup-color';
import { warmInheritedClasses } from '../../features/completion/inheritance-resolution';
import { buildSemanticTokens } from '../../features/semantic/semantic-tokens.service';
import { buildShaderSemanticTokens } from '../../features/semantic/shader-semantic-tokens';
import { computeSignatureHelp } from '../../features/signature/signature-help.service';
import { formatRulesDocument } from '../../features/formatting/rules-formatter';
import { formatShaderDocument } from '../../features/formatting/shader-formatter';
import { minimalReplacementEdits } from '../../features/formatting/formatting.service';
import { shaderDocumentHover } from '../../features/shader/shader-document-features';
import { shaderSignatureHelp } from '../../features/shader/shader-signature';
import { codeLensesFor, resolveCodeLens } from '../../features/structure/code-lens.service';
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
        data = parserResult ? buildSemanticTokens(parserResult, documents.get(uri)?.getText()).data : [];
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
const semanticTokensEdits = (
    before: number[],
    after: number[]
): Array<{ start: number; deleteCount: number; data?: number[] }> => {
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
    const formatted = isShaderDocument(uri) ? formatShaderDocument(text, options) : formatRulesDocument(text, options);
    if (formatted === null) return [];
    return minimalReplacementEdits(document, formatted);
};

/**
 * Hover: show what a value resolves to, its computed number and/or reference target.
 *
 * @param params the document and the position the cursor is at.
 * @param cancellationToken cancels the lookup with the request.
 * @returns the hover, or null when the position carries nothing to show.
 */
const handleHover = async (params: HoverParams, cancellationToken: CancellationToken) => {
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
        return await getHover(parserResult, params.position, cancellationToken, await searchFolderUris());
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Code lenses: whether the mod loads this file at all. Emitted as a range and resolved into a
 * sentence only for a lens the editor shows, so opening a file never walks the mod.
 *
 * @param params the document the lenses are for.
 * @param cancellationToken cancels the walk with the request.
 * @returns the lenses, or none when the file has no reachability to report.
 */
const handleCodeLens = async (params: CodeLensParams, cancellationToken: CancellationToken) => {
    if (isShaderDocument(params.textDocument.uri) || !globalSettings.codeLens?.showFileReachability) return [];
    try {
        return await codeLensesFor(params.textDocument.uri, cancellationToken);
    } catch (e) {
        traceFailure(e);
        return [];
    }
};

/**
 * Fills in the sentence of one code lens the editor is about to show. The lens is emitted as a
 * bare range, so this is where the mod is walked, and only for a lens that reached the screen.
 *
 * @param lens the lens the editor is showing.
 * @param cancellationToken cancels the walk with the request.
 * @returns the resolved lens, or the lens unchanged when the walk failed.
 */
const handleCodeLensResolve = async (lens: CodeLens, cancellationToken: CancellationToken) => {
    try {
        return await resolveCodeLens(lens, cancellationToken);
    } catch (e) {
        traceFailure(e);
        return lens;
    }
};

/**
 * Document colours: render an inline swatch for `{ Rf Gf Bf Af }` / `{ R G B A }` colour groups.
 *
 * @param params the document to find colour groups in.
 * @param cancellationToken cancels the walk with the request.
 * @returns every colour the document carries, with the range to draw the swatch over.
 */
const handleDocumentColor = async (params: DocumentColorParams, cancellationToken: CancellationToken) => {
    // Colour swatches come from schema-typed `.rules` colour groups, which a `.shader` has none of.
    if (isShaderDocument(params.textDocument.uri)) return [];
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return [];
    try {
        // A colour slot reached only through a base in another file is typed by the same warm-up
        // hover and definition run, so a `VertexColor` under an inherited sprite gets its swatch.
        await warmInheritedClasses(parserResult, cancellationToken).catch(() => undefined);
        // A language file adds the colours its markup sets (`<color r='250' …>`), which the
        // schema knows nothing about because they live inside a translated string.
        return [...(await documentColors(parserResult, cancellationToken)), ...markupColors(parserResult)];
    } catch (e) {
        traceFailure(e);
        return [];
    }
};

/**
 * Colour picker: rewrite the chosen colour's component values in place (braces/layout untouched).
 *
 * @param params the range the swatch covers and the colour the picker landed on.
 * @param cancellationToken cancels the rewrite with the request.
 * @returns the presentations the editor applies, or none when the range holds no colour.
 */
const handleColorPresentation = async (params: ColorPresentationParams, cancellationToken: CancellationToken) => {
    // A shader is never lexed as ObjectText: `ensureParserResult` caches whatever it parses, so an
    // unguarded call here would leave a nonsense tree behind for that uri.
    if (isShaderDocument(params.textDocument.uri)) return [];
    const parserResult = ensureParserResult(params.textDocument.uri);
    const document = documents.get(params.textDocument.uri);
    if (!parserResult || !document) return [];
    try {
        await warmInheritedClasses(parserResult, cancellationToken).catch(() => undefined);
        const presentations = await colorPresentations(
            parserResult,
            document.getText(),
            params.range,
            params.color,
            cancellationToken
        );
        return presentations.length > 0
            ? presentations
            : markupColorPresentations(parserResult, params.range, params.color);
    } catch (e) {
        traceFailure(e);
        return [];
    }
};

/**
 * The inlay hints of one range, filtered out of a computation that covers the whole document.
 * The whole-document computation is shared per version, so scrolling through a file resolves its
 * expressions once rather than once per viewport.
 *
 * @param params the document and the range the editor is showing.
 * @param cancellationToken drops the answer when the request is already gone, which does not
 * invalidate the shared computation.
 * @returns the hints inside the range, or null when there are none to show.
 */
const handleInlayHint = async (params: InlayHintParams, cancellationToken: CancellationToken) => {
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
            const promise = getInlayHints(parserResult, FULL_DOCUMENT_RANGE, source.token);
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
};

/**
 * The full token array of a document, with the result id a later delta request names.
 *
 * @param params the document to tokenize.
 * @param cancellationToken drops the answer when the request is already gone.
 * @returns the tokens, or none when the document cannot be read.
 */
const handleSemanticTokens = (params: SemanticTokensParams, cancellationToken: CancellationToken): SemanticTokens => {
    if (cancellationToken.isCancellationRequested) return { data: [] };
    try {
        const { resultId, data } = computeSemanticTokens(params.textDocument.uri);
        return { resultId, data };
    } catch (e) {
        traceFailure(e);
        return { data: [] };
    }
};

/**
 * What changed in a document's tokens since the result the client still holds.
 *
 * @param params the document and the result id the client holds.
 * @param cancellationToken drops the answer when the request is already gone.
 * @returns the edits against that result, or a full result when it is no longer known.
 */
const handleSemanticTokensDelta = (
    params: SemanticTokensDeltaParams,
    cancellationToken: CancellationToken
): SemanticTokens | SemanticTokensDelta => {
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
        traceFailure(e);
        return { data: [] };
    }
};

/**
 * The tokens of one range, sliced out of the computation that covers the whole document.
 *
 * @param params the document and the range the editor is showing.
 * @param cancellationToken drops the answer when the request is already gone.
 * @returns the tokens of the requested lines.
 */
const handleSemanticTokensRange = (
    params: SemanticTokensRangeParams,
    cancellationToken: CancellationToken
): SemanticTokens => {
    if (cancellationToken.isCancellationRequested) return { data: [] };
    try {
        const { data } = computeSemanticTokens(params.textDocument.uri);
        return { data: sliceSemanticTokens(data, params.range.start.line, params.range.end.line) };
    } catch (e) {
        traceFailure(e);
        return { data: [] };
    }
};

/**
 * Signature help: show a math function's parameter list and highlight the active argument while
 * typing inside its parentheses (`Damage = ceil(…)`). Driven by a raw-text scan so it works mid-edit.
 *
 * @param params the document and the position the cursor is at.
 * @returns the signature and the active argument, or null when the cursor is in no call.
 */
const handleSignatureHelp = async (params: SignatureHelpParams) => {
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
        traceFailure(e);
        return null;
    }
};

/**
 * Formats the whole document with the editor's own indent options.
 *
 * @param params the document and the indent options the editor is configured with.
 * @returns the edits, none when formatting is turned off, or null when it failed.
 */
const handleDocumentFormatting = (params: DocumentFormattingParams) => {
    if (globalSettings.formatting?.enabled === false) return [];
    try {
        return formattingEdits(params.textDocument.uri, {
            tabSize: params.options.tabSize,
            insertSpaces: params.options.insertSpaces,
        });
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Format-on-save (`cosmoteerLSPRules.formatting.formatOnSave`, default off): the edits returned
 * here are applied by the client before the file hits disk. The save event carries no editor
 * indent options, so it formats with tabs, the vanilla `.rules` convention.
 *
 * @param event the document about to be written to disk.
 * @returns the edits the client applies before the write, or none when format-on-save is off.
 */
const handleWillSaveWaitUntil = (event: TextDocumentWillSaveEvent<TextDocument>) => {
    if (globalSettings.formatting?.enabled === false || globalSettings.formatting?.formatOnSave !== true) {
        return [];
    }
    try {
        return formattingEdits(event.document.uri, { tabSize: 4, insertSpaces: false });
    } catch (e) {
        traceFailure(e);
        return [];
    }
};

/**
 * Registers everything that renders an already-parsed document: hover, code lenses, colour
 * swatches, inlay hints, semantic tokens, signature help and formatting. None of these changes
 * project state, and none of them feeds a cache the on-disk scan results are gated on.
 */
export function register(): void {
    connection.onHover(handleHover);
    connection.onCodeLens(handleCodeLens);
    connection.onCodeLensResolve(handleCodeLensResolve);
    connection.onDocumentColor(handleDocumentColor);
    connection.onColorPresentation(handleColorPresentation);
    connection.languages.inlayHint.on(handleInlayHint);
    connection.languages.semanticTokens.on(handleSemanticTokens);
    connection.languages.semanticTokens.onDelta(handleSemanticTokensDelta);
    connection.languages.semanticTokens.onRange(handleSemanticTokensRange);
    connection.onSignatureHelp(handleSignatureHelp);
    connection.onDocumentFormatting(handleDocumentFormatting);
    documents.onWillSaveWaitUntil(handleWillSaveWaitUntil);
}
