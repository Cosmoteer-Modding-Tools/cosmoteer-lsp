import { CancellationToken, Diagnostic, DiagnosticSeverity, DiagnosticTag } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { BlockCommentSpan, lexer } from '../core/lexer/lexer';
import { parser } from '../core/parser/parser';
import { findingSpanOf, ValidationError, Validator } from '../features/diagnostics/validator';
import { warmInheritedClasses } from '../features/completion/inheritance-resolution';
import { validateShaderDocument } from '../features/shader/shader-diagnostics';
import { ModRulesRegistrar } from '../mod/mod-rules.registrar';
import { isActionFragmentDocument } from '../mod/action-parser';
import { DocumentPass, DOCUMENT_PASSES, PassContext } from './document-passes';
import { basenameOf, isDocumentationFileName, isModRules, isShaderDocument } from '../document/document-kind';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { primeParsedFile } from '../workspace/fs-cache';
import { uriToFsPath } from '../workspace/workspace-files';
import { CosmoteerSettings, globalSettings } from '../settings';
import { traceFailure } from '../utils/cancellation';
import { perfCount } from '../utils/perf-counters';
import { hasDiagnosticRelatedInformationCapability } from '../capabilities';
import { getDocumentSettings } from './document-settings';
import { ensureFragmentRooting } from './fragment-rooting';
import { openBufferReadOverride, openParseCache, registerOpenDocument } from './open-documents';
import { shipLayerContext } from './ship-layers';
import { reachableFileFilter } from './validation-scope';
import { gameIndexAvailable, searchFolderPaths, searchFolderUris } from './workspace-folders';

/** Maps a {@link ValidationError} severity (default 'error') to the LSP DiagnosticSeverity. */
const VALIDATION_SEVERITY: Record<NonNullable<ValidationError['severity']>, DiagnosticSeverity> = {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    information: DiagnosticSeverity.Information,
    hint: DiagnosticSeverity.Hint,
};

/** What one validation run reads off the document: the token stream, the comments and the tree. */
interface ParsedDocument {
    readonly tokens: ReturnType<typeof lexer>;
    readonly blockComments: BlockCommentSpan[];
    readonly parserResult: ReturnType<typeof parser>;
}

/**
 * Whether a pass is written for this document. Most passes read any `.rules` file. The manifest
 * ones only run on a `mod.rules`, and the action pass also covers an included fragment that holds a
 * literal `Actions` list, but only once the game tree is indexed.
 *
 * @param pass the pass to judge.
 * @param context the document being validated.
 * @param runsActionFragment whether an included action fragment may be validated right now.
 * @returns true when the pass applies.
 */
const appliesToDocument = (pass: DocumentPass, context: PassContext, runsActionFragment: boolean): boolean => {
    switch (pass.scope ?? 'anyDocument') {
        case 'anyDocument':
            return true;
        case 'modRules':
            return context.isManifest;
        case 'modRulesOrActionFragment':
            return context.isManifest || runsActionFragment;
    }
};

/**
 * Stamp a pass's findings with the rule every report identifies them by, leaving a finding that
 * already named its own rule alone. Called where a pass is invoked, which is the only place the
 * pass a finding came from is known.
 *
 * @param errors the findings one pass produced.
 * @param code the rule id of that pass, from the table in server/src/features/diagnostics/rule-ids.ts.
 * @returns the same findings, now carrying the rule id.
 */
const tagged = (errors: ValidationError[], code: string): ValidationError[] => {
    for (const error of errors) error.code ??= code;
    return errors;
};

/**
 * Wall time of one validation pass, accumulated into a perf counter for the scan bench's per-pass
 * breakdown. Only the bulk scan records, the open-file flow does not.
 *
 * @param persist whether this is the open-file flow, which records nothing.
 * @param counter the counter to add the wall time to, absent for a pass that is not measured.
 * @param run the pass.
 * @returns whatever the pass answered.
 */
const timedPass = async <T>(persist: boolean, counter: string | undefined, run: () => Promise<T> | T): Promise<T> => {
    if (persist || !counter) return await run();
    const started = Date.now();
    const result = await run();
    perfCount(counter, Date.now() - started);
    return result;
};

/**
 * Lexes and parses the document, or hands back the parse the open-document flow already did.
 *
 * @param textDocument the document to read.
 * @param cancelToken cancels the parse.
 * @param persist whether this is the open-document flow, which reuses the published parse.
 * @returns the parse, or undefined when there is none to validate.
 */
const parseForValidation = async (
    textDocument: TextDocument,
    cancelToken: CancellationToken,
    persist: boolean
): Promise<ParsedDocument | undefined> => {
    if (persist) {
        // The open-document flow: reuse the parse {@link registerOpenDocument} already did for
        // this version. It also published the AST and marked the project indexes dirty.
        registerOpenDocument(textDocument);
        const cached = openParseCache.get(textDocument.uri);
        if (!cached) return undefined;
        return { tokens: cached.tokens, blockComments: cached.blockComments, parserResult: cached.parserResult };
    }
    perfCount('scan.parse');
    const parseStarted = Date.now();
    const blockComments: BlockCommentSpan[] = [];
    const tokens = lexer(textDocument.getText(), blockComments);
    if (cancelToken.isCancellationRequested) return undefined;
    const parserResult = parser(tokens, textDocument.uri);
    perfCount('scan.parseMs', Date.now() - parseStarted);
    // Seed the fs parse cache with this parse, so other scanned files resolving references
    // into this one hit the cache instead of re-reading and re-parsing it from disk.
    await primeParsedFile(uriToFsPath(textDocument.uri), parserResult.value);
    if (isModRules(textDocument.uri)) {
        // mod.rules diagnostics need the manifest's actions registered to validate them, but we do
        // not invalidate the live mod context for an unopened file (the open buffer owns that).
        ModRulesRegistrar.instance.registerManifest(parserResult.value);
    }
    return { tokens, blockComments, parserResult };
};

/**
 * Runs every enabled pass over the document: the node-level ones the AstType-keyed registry holds,
 * then the whole-document table in the order it declares, which is the order the problem limit cuts
 * the findings at. A pass that throws is traced and ends the run, leaving what the passes before it
 * found.
 *
 * @param context the document being validated.
 * @param settings the settings that decide which passes run.
 * @param runsActionFragment whether an included action fragment may be validated right now.
 * @returns the findings, each stamped with the rule of the pass that produced it.
 */
const runValidationPasses = async (
    context: PassContext,
    settings: CosmoteerSettings,
    runsActionFragment: boolean
): Promise<ValidationError[]> => {
    const { cancelToken, persist } = context;
    let validationErrors: ValidationError[] = [];
    try {
        // The node-level passes, which the AstType-keyed registry holds and which run per element
        // rather than over the whole document.
        validationErrors = await timedPass(persist, 'scan.vElementsMs', async () => {
            const passes = context.document.elements.map((node) => Validator.instance.validate(node, cancelToken));
            return tagged((await Promise.all(passes).catch(() => [])).flat(), 'syntax-and-references');
        });
        for (const pass of DOCUMENT_PASSES) {
            if (cancelToken.isCancellationRequested) break;
            if (!appliesToDocument(pass, context, runsActionFragment)) continue;
            if (pass.setting && !settings.diagnostics?.[pass.setting]) continue;
            if (pass.needsGameIndex && !gameIndexAvailable()) continue;
            const found = await timedPass(persist, pass.counter, async () =>
                Promise.resolve(pass.run(context)).catch((): ValidationError[] => [])
            );
            validationErrors = validationErrors.concat(tagged(found, pass.code));
        }
    } catch (e) {
        traceFailure(e);
    }
    return validationErrors;
};

/**
 * The parse failures of one document, as diagnostics.
 *
 * @param textDocument the document the offsets are measured against.
 * @param errors the failures the parser reported.
 * @param limit how many findings the document may report.
 * @returns the diagnostics, at most `limit` of them.
 */
const parseErrorDiagnostics = (
    textDocument: TextDocument,
    errors: ReturnType<typeof parser>['parserErrors'],
    limit: number
): Diagnostic[] => {
    const diagnostics: Diagnostic[] = [];
    let problems = 0;
    for (const error of errors) {
        problems++;
        if (problems > limit) break;
        const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
                start: textDocument.positionAt(error.token.start),
                end: textDocument.positionAt(error.token.end ?? error.token.start),
            },
            message: error.message,
            source: 'cosmoteer-language-server',
            // Every finding names the check behind it, so a report can group by rule and a reader
            // can filter one off. A parse error belongs to no switchable pass, so its id is fixed.
            code: 'parse-error',
        };
        if (hasDiagnosticRelatedInformationCapability && error.additionalInfo) {
            for (const info of error.additionalInfo) {
                diagnostic.relatedInformation = [
                    {
                        location: {
                            uri: textDocument.uri,
                            range: Object.assign({}, diagnostic.range),
                        },
                        message: info.message,
                    },
                ];
            }
        }
        diagnostics.push(diagnostic);
    }
    return diagnostics;
};

/**
 * The validator findings of one document, as diagnostics.
 *
 * @param textDocument the document the offsets are measured against.
 * @param errors the findings the passes produced, in the order the passes ran.
 * @param limit how many findings the document may still report beside its parse errors.
 * @returns the diagnostics, at most `limit` of them.
 */
const findingDiagnostics = (
    textDocument: TextDocument,
    errors: readonly ValidationError[],
    limit: number
): Diagnostic[] => {
    const diagnostics: Diagnostic[] = [];
    let problems = 0;
    for (const error of errors) {
        // A finding the pass could not place is dropped rather than published at the top of the
        // file. Reading a missing span as offset zero would put an underline on a line that has
        // nothing to do with it, and dereferencing one used to end the whole workspace pass.
        const span = findingSpanOf(error);
        if (!span) continue;
        problems++;
        if (problems > limit) break;
        const diagnostic: Diagnostic = {
            severity: VALIDATION_SEVERITY[error.severity ?? 'error'],
            range: {
                start: textDocument.positionAt(span.start),
                end: textDocument.positionAt(span.end),
            },
            message: error.message,
            source: 'cosmoteer-language-server',
        };
        if (error.unnecessary) diagnostic.tags = [DiagnosticTag.Unnecessary];
        // Round-trip quick-fix data (e.g. "did you mean") to the code-action handler.
        if (error.data) diagnostic.data = error.data;
        // The rule the finding belongs to, which the lint reports group by and both editors show
        // beside the message so a reader can filter on it.
        if (error.code) diagnostic.code = error.code;
        if (hasDiagnosticRelatedInformationCapability && error.additionalInfo) {
            diagnostic.relatedInformation = [
                {
                    location: {
                        uri: textDocument.uri,
                        range: Object.assign({}, diagnostic.range),
                    },
                    message: error.additionalInfo,
                },
            ];
        }
        diagnostics.push(diagnostic);
    }
    return diagnostics;
};

/**
 * Lexes, parses and validates one document, running every enabled validator pass over it and
 * mapping the findings onto LSP diagnostics. Serves both the open-document flow and the
 * whole-workspace pass over unopened files, so on-disk files go through the exact same path.
 *
 * @param textDocument the document to validate.
 * @param cancelToken cancels the parse and the validator passes.
 * @param persist when false (the whole-workspace pass over unopened files), the parsed AST is not
 *     cached in ParserResultRegistrar. It is used to produce diagnostics and then discarded so it
 *     can be GC'd. Caching every project file's AST permanently is what exhausted the heap. The
 *     open-file flow keeps `persist: true` because completion/navigation read the live AST back.
 * @param refreshOpenDocument republishes this document once a pass's cross-file work lands. Only
 *     the flow that publishes an open document supplies it, so the whole-workspace pass, which
 *     stores what it publishes, leaves it out and nothing asks for a second round.
 * @returns the document's diagnostics, capped at the configured problem limit.
 */
export async function validateTextDocument(
    textDocument: TextDocument,
    cancelToken: CancellationToken,
    persist = true,
    refreshOpenDocument?: () => void
): Promise<Diagnostic[]> {
    // `.shader` files reach the server (for semantic tokens / hover / include navigation) but are HLSL,
    // not OT, so never run the `.rules` lexer/parser/validators on them, which would flag every line as a
    // rules syntax error. Their only diagnostics are the lexical shader checks, which are on by default.
    if (isShaderDocument(textDocument.uri)) {
        const shaderSettings = persist ? await getDocumentSettings(textDocument.uri) : globalSettings;
        if (!shaderSettings.diagnostics.validateShaderCode) return [];
        return validateShaderDocument(
            textDocument.getText(),
            uriToFsPath(textDocument.uri),
            CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
            openBufferReadOverride()
        ).catch(() => []);
    }
    // A readme or a changelog is prose whatever extension it carries, and the game loads neither, so
    // it gets no diagnostics even when it is open in the editor. Parsing one as rules only produces
    // findings about sentences.
    if (isDocumentationFileName(basenameOf(textDocument.uri))) return [];
    // The bulk pass uses the global settings rather than per-file config: a `workspace/configuration`
    // round-trip per file (cached in an unbounded map) would mean thousands of requests + retained
    // entries. Open files keep per-document settings (folder-specific overrides matter there).
    const settings = persist ? await getDocumentSettings(textDocument.uri) : globalSettings;
    // A standalone fragment file is rooted forward through cosmoteer.rules's aliases or in reverse
    // through the field that includes it. Make sure both indexes are built so schema validation and
    // resolution inside a fragment work. This is a no-op once built and when there is no game root.
    await ensureFragmentRooting(cancelToken);
    const parsed = await parseForValidation(textDocument, cancelToken, persist);
    if (!parsed) return [];
    const { tokens, blockComments, parserResult } = parsed;
    if (cancelToken.isCancellationRequested) return [];
    // The validators resolve classes synchronously. A group deriving from a base in another file
    // is classified for them here, once, before any of them looks at the tree.
    await warmInheritedClasses(parserResult.value, cancelToken).catch(() => undefined);
    if (cancelToken.isCancellationRequested) return [];
    if (settings.trace.server === 'verbose') {
        console.dir(parserResult);
    }
    const diagnostics = parseErrorDiagnostics(textDocument, parserResult.parserErrors, settings.maxNumberOfProblems);

    const validateStarted = Date.now();
    const context: PassContext = {
        document: parserResult.value,
        uri: textDocument.uri,
        text: textDocument.getText(),
        tokens,
        blockComments,
        cancelToken,
        persist,
        isManifest: isModRules(textDocument.uri),
        folderUris: searchFolderUris,
        folderPaths: searchFolderPaths,
        shipLayers: shipLayerContext,
        reachableFiles: () => reachableFileFilter(cancelToken),
        // An open file shows its problems now and its cross-file hints once the mod-wide plans
        // exist. The bulk pass waits, since it stores what it publishes.
        refreshOpenDocument: () => refreshOpenDocument,
    };
    // An included action fragment is only validated once the game tree is indexed, since target
    // resolution needs it and an unready tree would flag every real vanilla target as missing.
    const runsActionFragment = gameIndexAvailable() && isActionFragmentDocument(parserResult.value);
    const validationErrors = await runValidationPasses(context, settings, runsActionFragment);
    if (!persist) perfCount('scan.validateMs', Date.now() - validateStarted);

    diagnostics.push(
        ...findingDiagnostics(textDocument, validationErrors, settings.maxNumberOfProblems - diagnostics.length)
    );
    if (cancelToken.isCancellationRequested) return [];
    return diagnostics;
}
