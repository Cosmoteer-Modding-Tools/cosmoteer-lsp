import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    DidChangeWatchedFilesNotification,
    FileChangeType,
    CompletionItem,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    DocumentDiagnosticReportKind,
    type DocumentDiagnosticReport,
    CancellationToken,
    CancellationTokenSource,
    FullDocumentDiagnosticReport,
    CodeAction,
    CodeActionKind,
    WorkspaceFolder,
    TextEdit,
    InlayHint,
} from 'vscode-languageserver/node';

import { readFile } from 'fs/promises';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from './core/lexer/lexer';
import { parser } from './core/parser/parser';
import { AbstractNodeDocument } from './core/ast/ast';
import { ParserResultRegistrar } from './registrar/parser-result-registrar';
import { findNodeAtPosition } from './utils/ast.utils';
import { extractValueCodeAction } from './features/refactor/extract-value';
import { AutoCompletionService, Completion } from './features/completion/autocompletion.service';
import { DefinitionService } from './features/navigation/definition.service';
import { computeDocumentLinks, resolveDocumentLink } from './features/navigation/document-links';
import { DocumentSymbolService } from './features/navigation/document-symbol.service';
import { ReferenceIndex } from './features/navigation/reference-index';
import { WorkspaceSymbolService } from './features/navigation/workspace-symbol.service';
import { SchemaIdIndex } from './features/completion/schema-id.index';
import { RenameService, dropEditsUnderRoot } from './features/navigation/rename.service';
import { InlayHintService } from './features/inlay/inlay-hint.service';
import { HoverService } from './features/hover/hover.service';
import { ValidationError, ValidationErrorData, Validator } from './features/diagnostics/validator';
import { ValidationForValue } from './features/diagnostics/validator.value';
import { ValidationForFunctionCall } from './features/diagnostics/validator.functioncall';

import * as l10n from '@vscode/l10n';
import { CosmoteerWorkspaceService } from './workspace/cosmoteer-workspace.service';
import { ValidationForAssignment } from './features/diagnostics/validator.assignment';
import { validateRedundantSeparators } from './features/diagnostics/validator.separator';
import { ValidationForMath } from './features/diagnostics/validator.math';
import { ValidationForDocumentDuplicates, ValidationForGroupDuplicates } from './features/diagnostics/validator.duplicate-key';
import { validateInheritanceCycles } from './features/diagnostics/validator.inheritance-cycle';
import { CancellationError } from './utils/cancellation';
import { WorkspaceTokenManager } from './workspace/token-manager';
import { CosmoteerSettings, defaultSettings, globalSettings, setGlobalSettings } from './settings';
import { basenameOf, isModRules } from './document/document-kind';
import { ModRulesRegistrar } from './mod/mod-rules.registrar';
import { computeModReachability, reachabilityKey } from './mod/mod-reachability';
import { generateModOverview } from './mod/mod-overview';
import { findModRoot } from './mod/mod-root';
import { join } from 'path';
import { validateModActions } from './features/diagnostics/validator.mod-action';
import { invalidateModContext } from './mod/mod-context';
import { modRulesOffsetCompletions } from './features/completion/autocompletion.mod-rules';
import { mathFunctionCompletionsAtLinePrefix } from './features/completion/autocompletion.math-function';
import {
    crossFileReferenceTargetAtOffset,
    isLocalizationKeyFieldAtOffset,
    schemaFieldNameCompletions,
    schemaValueCompletionsAtOffset,
} from './features/completion/autocompletion.schema-fields';
import { LocalizationKeyIndex } from './features/completion/localization-key.index';
import { validateSchema } from './features/diagnostics/validator.schema';
import { validateRequiredFields } from './features/diagnostics/validator.required-fields';
import { TemplateBaseIndex } from './features/diagnostics/template-base.index';
import { validateSchemaSiblingReferences } from './features/diagnostics/validator.schema-sibling';
import { validateCrossFileIdReferences } from './features/diagnostics/validator.schema-id-reference';
import { validateLocalizationKeys } from './features/diagnostics/validator.localization-key';
import { buildInsertLocalizationKeyEdit } from './features/diagnostics/localization-key-insert';
import { mapKeyTargetOf } from './features/navigation/schema-id-reference.navigation';
import { buildShaderPreview } from './features/shader/shader-preview.service';
import { collectIncludeText } from './features/shader/shader-index';
import { validateShaderConstants } from './features/diagnostics/validator.shader-constants';
import { particleChannelCompletionsAtOffset } from './features/navigation/particle-channel';
import { documentColors, colorPresentations } from './features/color/document-color';
import {
    findEnclosingGroup,
    findEnclosingList,
    invalidateSchemaContextCache,
    listElementReferenceTarget,
} from './document/schema/schema-context';
import { toCompletionItem } from './features/completion/completion-item';
import { collectRulesFiles, uriToFsPath } from './features/navigation/workspace-files';
import {
    beginFsTrustWindow,
    clearFsCaches,
    endFsTrustWindow,
    invalidateFsPath,
    primeParsedFile,
} from './workspace/fs-cache';
import { clearNavigationMemo } from './features/navigation/full.navigation-strategy';
import { perfCount, perfReset, perfSampleMemory, perfSnapshot } from './utils/perf-counters';
import { startScanCpuProfile, stopScanCpuProfile } from './utils/cpu-profile';
import { filePathToUri } from './features/navigation/navigation-strategy';
import { normalizeUri } from './features/navigation/reference-location';
import { computeSignatureHelp } from './features/signature/signature-help.service';
import { ensureAliasRootIndex } from './features/navigation/alias-root-builder';
import { WatchedDocumentIndex } from './features/navigation/watched-document-index';
import { aliasRootIndex } from './document/schema/alias-root';
import { ReverseIncludeIndex } from './features/navigation/reverse-include.index';
import { MentionIndex } from './features/navigation/mention.index';
import { buildSemanticTokens } from './features/semantic/semantic-tokens.service';
import { buildShaderSemanticTokens } from './features/semantic/shader-semantic-tokens';
import { semanticTokensLegend } from './features/semantic/legend';
import { isShaderDocument } from './document/document-kind';
import {
    shaderDocumentDefinition,
    shaderDocumentHover,
    shaderDocumentSymbols,
    shaderSymbolDefinition,
} from './features/shader/shader-document-features';
import { validateShaderDocument } from './features/shader/shader-diagnostics';
import { shaderCompletions } from './features/shader/shader-completion';
import { shaderSignatureHelp } from './features/shader/shader-signature';
import { formatRulesDocument } from './features/formatting/rules-formatter';
import { formatShaderDocument } from './features/formatting/shader-formatter';
import { minimalReplacementEdits } from './features/formatting/formatting.service';

// Re-exported for backwards compatibility with modules that imported these from './server'.
export { MAX_NUMBER_OF_PROBLEMS, globalSettings } from './settings';

if (process.env['EXTENSION_BUNDLE_PATH']) {
    l10n.config({
        fsPath: process.env['EXTENSION_BUNDLE_PATH'],
    });
}

const connection = createConnection(ProposedFeatures.all);
CosmoteerWorkspaceService.instance.setConnection(connection);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const tokenSourceManager = new WorkspaceTokenManager();

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
let hasDidChangeWatchedFilesCapability = false;
let hasSnippetCapability = false;
let hasPullDiagnosticsCapability = false;

/** The cached `workspace/workspaceFolders` answer, `undefined` until (re)fetched. */
let workspaceFoldersCache: WorkspaceFolder[] | null | undefined;

/** Resolves {@link workspaceInitialized} once `onInitialized` settled the game-tree scan. */
let resolveWorkspaceInitialized: () => void;
/**
 * Settles once `onInitialized` finished initializing the Cosmoteer workspace (successfully or
 * not). A `didOpen` validation of an already-open file can arrive while that scan is still
 * running, and building the project indexes at that moment would bake in a folder set without the
 * game `Data` root — every index would then silently lack the vanilla tree for the whole session.
 * {@link ensureFragmentRooting} awaits this before any index build.
 */
const workspaceInitialized = new Promise<void>((resolve) => {
    resolveWorkspaceInitialized = resolve;
});

/**
 * The client's workspace folders, fetched once and cached. Nearly every feature request needs the
 * folder list (through {@link searchFolderUris}), and asking the client each time made every
 * completion, hover, and validation pay a client round-trip. Never asks a client that did not
 * advertise the capability, since the request would go unanswered on such a client and pend the
 * feature forever. The cache is invalidated when the folder set changes.
 *
 * @returns the workspace folders, or null when the client has none (or doesn't support them).
 */
async function getWorkspaceFoldersCached(): Promise<WorkspaceFolder[] | null> {
    if (!hasWorkspaceFolderCapability) return null;
    if (workspaceFoldersCache !== undefined) return workspaceFoldersCache;
    workspaceFoldersCache = (await connection.workspace.getWorkspaceFolders()) ?? null;
    return workspaceFoldersCache;
}

connection.onInitialize(async (params: InitializeParams) => {
    const capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
    // Does the client render snippet (`$1`/`${1:…}`) insert text in completions?
    hasSnippetCapability = !!capabilities.textDocument?.completion?.completionItem?.snippetSupport;
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );
    hasDidChangeWatchedFilesCapability = !!capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
    // A pull-capable client requests diagnostics itself (`textDocument/diagnostic`) after each
    // change. Pushing from `onDidChangeContent` as well would validate every edit twice.
    hasPullDiagnosticsCapability = !!capabilities.textDocument?.diagnostic;
    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: {
                openClose: true,
                change: TextDocumentSyncKind.Full,
                // Lets the format-on-save setting return edits right before the client writes the file.
                willSaveWaitUntil: true,
            },
            completionProvider: {
                resolveProvider: true,
                // '.' drives `.shader` member/swizzle completion; '"' pops value completion (localization
                // keys, assets, references) the moment a quote opens; the rest are `.rules` reference sigils.
                triggerCharacters: ['<', '&', '/', '^', '~', '..', '=', '.', '"'],
            },
            diagnosticProvider: {
                interFileDependencies: true,
                workspaceDiagnostics: false,
            },
            definitionProvider: true,
            documentLinkProvider: {
                resolveProvider: true,
            },
            documentSymbolProvider: true,
            referencesProvider: true,
            workspaceSymbolProvider: true,
            renameProvider: {
                prepareProvider: true,
            },
            inlayHintProvider: true,
            hoverProvider: true,
            colorProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ['(', ','],
                retriggerCharacters: [','],
            },
            documentFormattingProvider: true,
            codeActionProvider: {
                codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.RefactorExtract],
            },
            semanticTokensProvider: {
                legend: semanticTokensLegend,
                full: true,
            },
        },
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true,
            },
        };
    }

    return result;
});

connection.onInitialized(async (_params) => {
    Validator.instance.registerValidation(ValidationForValue);
    Validator.instance.registerValidation(ValidationForFunctionCall);
    Validator.instance.registerValidation(ValidationForAssignment);
    Validator.instance.registerValidation(ValidationForMath);
    Validator.instance.registerValidation(ValidationForGroupDuplicates);
    const workspaceFolders = await getWorkspaceFoldersCached();

    if (workspaceFolders) {
        const settings = (await connection.workspace.getConfiguration({
            scopeUri: workspaceFolders[0].uri,
            section: 'cosmoteerLSPRules',
        })) as CosmoteerSettings;
        setGlobalSettings(settings ?? defaultSettings);
        if (settings?.cosmoteerPath) {
            await CosmoteerWorkspaceService.instance.initialize(
                settings.cosmoteerPath,
                await connection.window.createWorkDoneProgress()
            );
        } else {
            if (
                !(await CosmoteerWorkspaceService.instance.initializeWithoutPath(
                    await connection.window.createWorkDoneProgress()
                ))
            )
                connection.window
                    .showErrorMessage(
                        l10n.t(
                            'Cosmoteer path not set, please set it in the extensions settings for Cosmoteer Rules Configuration. If you dont see this setting, than please restart vscode. This is required for the language server to work correctly.'
                        ),
                        {
                            title: 'Open Settings',
                            command: 'workbench.action.openSettings',
                        }
                    )
                    .then(() => {
                        connection.sendRequest('cosmoteer/openSettings', {
                            items: [
                                {
                                    scopeUri: workspaceFolders[0].uri,
                                    section: 'cosmoteerLSPRules',
                                },
                            ],
                        });
                    });
        }
    }
    // The game-tree scan (or the decision that there is none) is settled. Index builds that were
    // waiting on it may now resolve the folder set, with the Data root included when it exists.
    resolveWorkspaceInitialized();

    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasDidChangeWatchedFilesCapability) {
        // Let the client watch `.rules` files on disk so the reference index stays correct
        // across changes it can't see as editor edits — git pull/checkout, external tools,
        // file creation/deletion. This is the cache-safe alternative to re-walking the tree.
        connection.client.register(DidChangeWatchedFilesNotification.type, {
            watchers: [{ globPattern: '**/*.rules' }],
        });
        // With the watcher in place, the mention index no longer needs its per-query stat sweep
        // over the whole tree. Disk changes arrive as dirty marks instead.
        MentionIndex.instance.enableWatcherDrivenSync();
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(async (_event) => {
            if (globalSettings.trace.server === 'verbose') {
                connection.console.log('Workspace folder change event received.');
            }
            // Multi-root: the set of folders changed. Refetch the cached folder list, drop the
            // cached symbol table (it is folder-scoped), and re-run whole-workspace diagnostics
            // over the new folder set — clearing first so diagnostics for removed folders don't
            // linger.
            workspaceFoldersCache = undefined;
            WorkspaceSymbolService.instance.reset();
            SchemaIdIndex.instance.reset();
            TemplateBaseIndex.instance.reset();
            LocalizationKeyIndex.instance.reset();
            ReverseIncludeIndex.instance.reset();
            MentionIndex.instance.reset();
            clearFsCaches();
            invalidateSchemaContextCache();
            if (wholeWorkspaceEnabled()) {
                await clearWorkspaceDiagnostics();
                await runWorkspaceValidation();
            }
        });
    }

    // The mod context resolves mod additions against the effective game tree. If a `.rules` file was
    // already open when the extension activated, its validation can race the async workspace scan
    // above and build the context against a not-yet-loaded game tree — caching an empty result that
    // never recovers (every `&/INDICATORS/SWX`-style override ref then false-flags). Drop it now that
    // the scan is done so the next resolve rebuilds against the fully-loaded tree.
    invalidateModContext();

    // Warm the project indexes in the background so the first completion, hover, or validation
    // finds them already built instead of paying the whole-project walk itself. Deliberately not
    // awaited, since the first feature request would coalesce onto the same in-flight build anyway.
    // The mention index (find-all-references pre-filter) warms afterwards so the two builds don't
    // compete for the disk.
    void ensureFragmentRooting(CancellationToken.None)
        .then(async () => MentionIndex.instance.ensureBuilt(await searchFolderUris(), CancellationToken.None))
        .catch(() => undefined);

    // Opt-in: validate every file in the workspace, not just the open ones.
    await runWorkspaceValidation();
});

// documents.onDidChangeContent((change) => {
//     validateTextDocument(change.document);
// });

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<CosmoteerSettings>> = new Map();

connection.onDidChangeConfiguration(async (change) => {
    if (hasConfigurationCapability) {
        documentSettings.clear();
    }
    const wasWholeWorkspace = wholeWorkspaceEnabled();
    const previousScope = globalSettings.diagnostics?.workspaceValidationScope ?? 'allFiles';
    const previousCosmoteerPath = globalSettings.cosmoteerPath;

    const workspaceFolders = await getWorkspaceFoldersCached();
    // With the pull model (the client advertises `workspace/configuration`), the change
    // notification carries no payload — `change.settings` is null — so we must re-pull the
    // settings here. Only fall back to the pushed payload when the client uses the push model.
    // (Without this, toggling a setting like `diagnostics.validateWholeWorkspace` did nothing,
    // because `globalSettings` was never refreshed.)
    let settings: CosmoteerSettings | undefined;
    if (hasConfigurationCapability) {
        settings =
            ((await connection.workspace.getConfiguration({
                scopeUri: workspaceFolders?.[0]?.uri,
                section: 'cosmoteerLSPRules',
            })) as CosmoteerSettings) ?? defaultSettings;
    } else if (change.settings?.cosmoteerLSPRules) {
        settings = change.settings.cosmoteerLSPRules as CosmoteerSettings;
    }
    if (settings) setGlobalSettings(settings);

    const cosmoteerPathChanged = !!settings?.cosmoteerPath && settings.cosmoteerPath !== previousCosmoteerPath;
    if (cosmoteerPathChanged && workspaceFolders) {
        const workDoneProgress = await connection.window.createWorkDoneProgress();
        workDoneProgress.begin('Initializing workspace', 0, 'Initializing workspace', false);
        await CosmoteerWorkspaceService.instance.initialize(settings!.cosmoteerPath, workDoneProgress);
        // The Cosmoteer root changed where references resolve to — drop the cached symbol
        // table (find-all-references / rename are stateless and re-resolve per query).
        WorkspaceSymbolService.instance.reset();
        SchemaIdIndex.instance.reset();
        TemplateBaseIndex.instance.reset();
        LocalizationKeyIndex.instance.reset();
        ReverseIncludeIndex.instance.reset();
        MentionIndex.instance.reset();
        clearFsCaches();
        invalidateSchemaContextCache();
    }
    connection.languages.diagnostics.refresh();

    // React to the whole-workspace diagnostics toggle (and to a Cosmoteer-path or scope change while
    // it's on, since those change how every reference resolves / which files are covered). A scope
    // change clears first, so diagnostics published for now-out-of-scope files don't linger.
    const nowWholeWorkspace = wholeWorkspaceEnabled();
    const nowScope = globalSettings.diagnostics?.workspaceValidationScope ?? 'allFiles';
    const scopeChanged = nowScope !== previousScope;
    if (nowWholeWorkspace && (!wasWholeWorkspace || cosmoteerPathChanged || scopeChanged)) {
        if (scopeChanged && wasWholeWorkspace) await clearWorkspaceDiagnostics();
        await runWorkspaceValidation();
    } else if (!nowWholeWorkspace && wasWholeWorkspace) {
        await clearWorkspaceDiagnostics();
    }
});

function getDocumentSettings(resource: string): Thenable<CosmoteerSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'cosmoteerLSPRules',
        });
        documentSettings.set(resource, result);
    }
    return result;
}

/**
 * The parsed AST for an open document, parsing the live buffer on demand when the validation
 * pipeline hasn't cached it yet. `validateTextDocument` only calls `setResult` after awaiting the
 * settings round-trip and the (potentially slow) alias-root index, so on a freshly-started server
 * the first already-open file has no cached result for a while. Read-only providers that need only
 * the AST — most visibly the colour provider, which the editor does not re-request once it has been
 * answered with an empty result — would otherwise return nothing until the file is edited or
 * reopened. Parsing here is pure and cheap (lex + parse, no settings, no indexing) and the result is
 * cached so the subsequent validate pass just overwrites it with an identical AST.
 *
 * @param uri the open document's uri.
 * @returns the parsed AST, or `undefined` when no document is open for that uri.
 */
function ensureParserResult(uri: string): AbstractNodeDocument | undefined {
    const cached = ParserResultRegistrar.instance.getResult(uri);
    if (cached) return cached;
    const document = documents.get(uri);
    if (!document) return undefined;
    const result = parser(lexer(document.getText()), uri).value;
    ParserResultRegistrar.instance.setResult(uri, result);
    return result;
}

/** How long to sit out further keystrokes before a push-model validation runs. */
const VALIDATION_DEBOUNCE_MS = 250;

/** Per-uri debounce timers of the push-diagnostics flow (clients without pull support). */
const pushValidationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/**
 * The last lex+parse of each open document. {@link registerOpenDocument} fills it on every edit so
 * the validation that follows (push or pull) reuses the parse instead of lexing and parsing the
 * same text a second time. Entries live only as long as the document is open.
 */
const openParseCache: Map<string, { version: number; tokens: ReturnType<typeof lexer>; parserResult: ReturnType<typeof parser> }> =
    new Map();

/**
 * The in-flight or settled diagnostics of each open document, keyed by uri and valid for one
 * document version. The push flow and the pull handler share one validation per version through
 * this map instead of racing two independent full passes over the same text.
 */
const diagnosticsCache: Map<string, { version: number; promise: Promise<Diagnostic[]> }> = new Map();

/**
 * Lexes and parses an open document once per version and publishes the result to every consumer:
 * the parser-result registrar (completion/hover/navigation read the live AST back), the project
 * indexes (marked dirty for their next query), and the mod-manifest registrar. Validation used to
 * do all of this inline; it lives here so the AST is current the moment an edit arrives, even when
 * a pull-model client runs the actual validation later.
 *
 * @param document the open document to parse and register.
 */
function registerOpenDocument(document: TextDocument): void {
    // `.shader` files are HLSL, the rules lexer/parser would flag every line.
    if (isShaderDocument(document.uri)) return;
    const cached = openParseCache.get(document.uri);
    if (cached && cached.version === document.version) return;
    const tokens = lexer(document.getText());
    const parserResult = parser(tokens, document.uri);
    openParseCache.set(document.uri, { version: document.version, tokens, parserResult });
    ParserResultRegistrar.instance.setResult(document.uri, parserResult.value);
    // The edit changes what absolute references into this file resolve to, and the disk watcher
    // never sees open-buffer edits, so drop the navigation memo here.
    clearNavigationMemo();
    // An edit changes which symbols this file contributes. Re-index it lazily at the next
    // workspace-symbol query. (find-all-references is stateless, it re-reads per query.)
    WorkspaceSymbolService.instance.markDirty(document.uri);
    SchemaIdIndex.instance.markDirty(document.uri);
    TemplateBaseIndex.instance.markDirty(document.uri);
    LocalizationKeyIndex.instance.markDirty(document.uri);
    ReverseIncludeIndex.instance.markDirty(document.uri);
    if (isModRules(document.uri)) {
        // Parse the manifest's actions. A mod.rules edit changes the effective game tree.
        ModRulesRegistrar.instance.registerManifest(parserResult.value);
        invalidateModContext();
    } else if (basenameOf(document.uri).toLowerCase() === 'cosmoteer.rules') {
        // The mod's own cosmoteer.rules contributes convenience globals to the effective tree.
        invalidateModContext();
        // Its aliases drive fragment rooting, rebuild that index on the next feature use.
        aliasRootIndex.invalidate();
    }
}

/**
 * Returns the diagnostics of an open document, computing them at most once per document version.
 * A newer version cancels the previous run through the per-uri token source; a run that was
 * cancelled mid-way drops its (partial) cache entry so the next request recomputes.
 *
 * @param document the open document to validate.
 * @returns the document's diagnostics.
 */
function computeDiagnosticsCached(document: TextDocument): Promise<Diagnostic[]> {
    const uri = document.uri;
    const cached = diagnosticsCache.get(uri);
    if (cached && cached.version === document.version) return cached.promise;
    const token = tokenSourceManager.createToken(uri);
    const version = document.version;
    const dropOwnEntry = (): void => {
        const entry = diagnosticsCache.get(uri);
        if (entry && entry.version === version && entry.promise === promise) diagnosticsCache.delete(uri);
    };
    const promise: Promise<Diagnostic[]> = validateTextDocument(document, token).then(
        (diagnostics) => {
            // A cancelled run resolves with partial results, never serve them to a later request.
            if (token.isCancellationRequested) dropOwnEntry();
            return diagnostics;
        },
        (e) => {
            dropOwnEntry();
            throw e;
        }
    );
    diagnosticsCache.set(uri, { version, promise });
    return promise;
}

/**
 * Debounced push validation for clients without pull-diagnostics support. The first diagnostics of
 * a freshly opened document go out immediately; while typing, each keystroke resets a short timer
 * so only the settled text is validated.
 *
 * @param document the open document whose validation to schedule.
 */
function schedulePushValidation(document: TextDocument): void {
    const uri = document.uri;
    const existing = pushValidationTimers.get(uri);
    if (existing !== undefined) clearTimeout(existing);
    const run = async (): Promise<void> => {
        pushValidationTimers.delete(uri);
        const current = documents.get(uri);
        if (!current) return;
        try {
            const diagnostics = await computeDiagnosticsCached(current);
            await connection.sendDiagnostics({ uri, version: current.version, diagnostics });
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        }
    };
    if (!diagnosticsCache.has(uri)) {
        void run();
        return;
    }
    pushValidationTimers.set(
        uri,
        setTimeout(() => void run(), VALIDATION_DEBOUNCE_MS)
    );
}

// Only keep settings for open documents
documents.onDidClose(async (e) => {
    // The registrar entry this drops was what resolution saw for the file; back to disk state.
    clearNavigationMemo();
    documentSettings.delete(e.document.uri);
    const timer = pushValidationTimers.get(e.document.uri);
    if (timer !== undefined) {
        clearTimeout(timer);
        pushValidationTimers.delete(e.document.uri);
    }
    tokenSourceManager.cancelToken(e.document.uri);
    openParseCache.delete(e.document.uri);
    diagnosticsCache.delete(e.document.uri);
    inlayHintCache.delete(e.document.uri);
    semanticTokensCache.delete(e.document.uri);
    ParserResultRegistrar.instance.removeResult(e.document.uri);
    if (wholeWorkspaceEnabled()) {
        // Whole-workspace mode: the file's problems should persist after closing. Clear the
        // editor-uri diagnostics, then re-validate from disk under the canonical (`filePathToUri`)
        // uri the full pass uses — so the file isn't tracked twice under different uri encodings.
        const path = uriToFsPath(e.document.uri);
        const canonicalUri = filePathToUri(path);
        if (normalizeUri(canonicalUri) !== normalizeUri(e.document.uri)) {
            await connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
        }
        await validateWorkspaceFile(path, openDocumentNorms(), CancellationToken.None);
        return;
    }
    await connection.sendDiagnostics({
        uri: e.document.uri,
        version: e.document.version,
        diagnostics: [],
    });
});

// documents.onDidOpen(
//     async (e) => {
//         try {
//             await connection.sendDiagnostics({
//                 uri: e.document.uri,
//                 version: e.document.version,
//                 diagnostics: await validateTextDocument(e.document, tokenSourceManager.createToken(e.document.uri)),
//             });
//         } catch (e) {
//             if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
//         }
//     },
//     null,
//     [tokenSourceManager]
// );

documents.onDidChangeContent(
    (e) => {
        try {
            // Parse and publish the AST immediately, completion/hover/navigation read it between
            // keystrokes. Validation is scheduled separately below.
            registerOpenDocument(e.document);
        } catch (err) {
            if (globalSettings.trace.server === 'messages' && !(err instanceof CancellationError)) console.error(err);
        }
        // A pull-capable client requests `textDocument/diagnostic` itself after the change; pushing
        // here as well would run the whole validation twice per edit.
        if (hasPullDiagnosticsCapability) return;
        schedulePushValidation(e.document);
    },
    null,
    [tokenSourceManager]
);

connection.languages.diagnostics.on(async (params, _cancelToken) => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) {
        // We don't know the document. We can either try to read it from disk
        // or we don't report problems for it.
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: [],
        } satisfies DocumentDiagnosticReport;
    }
    // If the whole-workspace pass pushed diagnostics for this file before it was opened, retract
    // them. The pull result replaces them, and keeping both would double every entry.
    const norm = normalizeUri(params.textDocument.uri);
    for (const stored of workspaceDiagnosticUris) {
        if (normalizeUri(stored) !== norm) continue;
        workspaceDiagnosticUris.delete(stored);
        await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
    }
    return {
        kind: DocumentDiagnosticReportKind.Full,
        items: await computeDiagnosticsCached(document),
    } satisfies FullDocumentDiagnosticReport;
});

/** Maps a {@link ValidationError} severity (default 'error') to the LSP DiagnosticSeverity. */
const VALIDATION_SEVERITY: Record<NonNullable<ValidationError['severity']>, DiagnosticSeverity> = {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    information: DiagnosticSeverity.Information,
    hint: DiagnosticSeverity.Hint,
};

async function validateTextDocument(
    textDocument: TextDocument,
    cancelToken: CancellationToken,
    // When false (the whole-workspace pass over unopened files), the parsed AST is not cached in
    // ParserResultRegistrar — it is used to produce diagnostics and then discarded so it can be
    // GC'd. Caching every project file's AST permanently is what exhausted the heap. The open-file
    // flow keeps `persist: true` because completion/navigation read the live AST back.
    persist = true
): Promise<Diagnostic[]> {
    // `.shader` files reach the server (for semantic tokens / hover / include navigation) but are HLSL,
    // not OT — never run the `.rules` lexer/parser/validators on them, which would flag every line as a
    // rules syntax error. Their only diagnostics are the opt-in lexical shader checks.
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
    // The bulk pass uses the global settings rather than per-file config: a `workspace/configuration`
    // round-trip per file (cached in an unbounded map) would mean thousands of requests + retained
    // entries. Open files keep per-document settings (folder-specific overrides matter there).
    const settings = persist ? await getDocumentSettings(textDocument.uri) : globalSettings;
    // A standalone fragment file is rooted forward through cosmoteer.rules's aliases or in reverse
    // through the field that includes it. Make sure both indexes are built so schema validation and
    // resolution inside a fragment work. This is a no-op once built and when there is no game root.
    await ensureFragmentRooting(cancelToken);
    let tokens: ReturnType<typeof lexer>;
    let parserResult: ReturnType<typeof parser>;
    if (persist) {
        // The open-document flow: reuse the parse {@link registerOpenDocument} already did for
        // this version. It also published the AST and marked the project indexes dirty.
        registerOpenDocument(textDocument);
        const cached = openParseCache.get(textDocument.uri);
        if (!cached) return [];
        tokens = cached.tokens;
        parserResult = cached.parserResult;
    } else {
        perfCount('scan.parse');
        const parseStarted = Date.now();
        tokens = lexer(textDocument.getText());
        if (cancelToken.isCancellationRequested) return [];
        parserResult = parser(tokens, textDocument.uri);
        perfCount('scan.parseMs', Date.now() - parseStarted);
        // Seed the fs parse cache with this parse, so other scanned files resolving references
        // into this one hit the cache instead of re-reading and re-parsing it from disk.
        await primeParsedFile(uriToFsPath(textDocument.uri), parserResult.value);
        if (isModRules(textDocument.uri)) {
            // mod.rules diagnostics need the manifest's actions registered to validate them, but we do
            // not invalidate the live mod context for an unopened file (the open buffer owns that).
            ModRulesRegistrar.instance.registerManifest(parserResult.value);
        }
    }
    if (cancelToken.isCancellationRequested) return [];
    if (settings.trace.server === 'verbose') {
        console.dir(parserResult);
    }
    let problems = 0;
    const diagnostics: Diagnostic[] = [];

    for (const error of parserResult.parserErrors) {
        problems++;
        if (problems > settings.maxNumberOfProblems) break;
        const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
                start: textDocument.positionAt(error.token.start),
                end: textDocument.positionAt(error.token.end ?? error.token.start),
            },
            message: error.message,
            source: 'cosmoteer-language-server',
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

    let validationErrors: ValidationError[] = [];
    const validateStarted = Date.now();
    // Wall time of one validation pass, accumulated into a perf counter for the scan bench's
    // per-pass breakdown. Only the bulk scan records (persist=false), the open-file flow doesn't.
    const timedPass = async <T>(counter: string, run: () => Promise<T> | T): Promise<T> => {
        if (persist) return await run();
        const started = Date.now();
        const result = await run();
        perfCount(counter, Date.now() - started);
        return result;
    };
    try {
        validationErrors = await timedPass('scan.vElementsMs', async () => {
            const pormises: Promise<ValidationError[]>[] = [];
            for (const node of parserResult.value.elements) {
                pormises.push(Validator.instance.validate(node, cancelToken));
            }
            return (await Promise.all(pormises).catch(() => [])).flat();
        });
        // Top-level duplicate keys span sibling elements (each validated independently above), and
        // inheritance cycles span multiple nodes/files — both need a whole-document view, so they run
        // as separate passes over the root, like the mod-action pass below.
        const documentDuplicate = await ValidationForDocumentDuplicates.callback(parserResult.value, cancelToken).catch(
            () => undefined
        );
        if (documentDuplicate) validationErrors.push(documentDuplicate);
        const inheritanceCycleErrors = await timedPass('scan.vCyclesMs', () =>
            validateInheritanceCycles(parserResult.value, cancelToken).catch(() => [])
        );
        validationErrors = validationErrors.concat(inheritanceCycleErrors);
        // Separate pass: schema-driven checks (currently invalid enum values), like the duplicate /
        // inheritance-cycle passes above. Self-gates to non-mod `.rules` files.
        const schemaErrors = await timedPass('scan.vSchemaMs', () =>
            validateSchema(parserResult.value, cancelToken).catch(() => [])
        );
        validationErrors = validationErrors.concat(schemaErrors);
        // Separate pass: schema `ID<…>` component references that name no component in the part.
        // On by default, but only once the game `Data` tree is indexed: the part-wide id union folds
        // in inherited vanilla bases, which cannot resolve without the install.
        if (settings.diagnostics?.validateComponentReferences && gameIndexAvailable()) {
            const siblingRefErrors = await timedPass('scan.vSiblingMs', () =>
                validateSchemaSiblingReferences(parserResult.value, cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(siblingRefErrors);
        }
        // Separate pass: cross-file `ID<…>` references (GUI toggle/color/targeter/trigger ids) whose
        // id names no declaration in the project. On by default, but only once the game `Data` tree is
        // indexed: without it, a reference to a vanilla-declared id would be a false positive.
        if (settings.diagnostics?.validateCrossFileReferences && gameIndexAvailable()) {
            const idRefErrors = await timedPass('scan.vCrossFileMs', async () =>
                validateCrossFileIdReferences(parserResult.value, await searchFolderUris(), cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(idRefErrors);
        }
        // Separate pass: groups missing a schema-required field, checked through the inheritance chain.
        // Opt-in (default off): engine-injected required fields and bases in the unindexed vanilla
        // install mean a single-project check cannot be fully false-positive-free.
        if (settings.diagnostics?.validateRequiredFields) {
            const requiredFieldErrors = await timedPass('scan.vRequiredMs', async () => {
                // The project-wide set of inheritance-base names lets the check skip cross-file
                // templates (a `BASE_*` group inherited by other files) that a single-file scan
                // would false-positive.
                const workspaceBaseNames = await TemplateBaseIndex.instance
                    .baseNames(await searchFolderUris(), cancelToken)
                    .catch(() => undefined);
                return validateRequiredFields(parserResult.value, cancelToken, workspaceBaseNames).catch(() => []);
            });
            validationErrors = validationErrors.concat(requiredFieldErrors);
        }
        // Separate pass: inline `_`-prefixed shader constants a material sets, checked against the
        // uniforms its `.shader` declares. Opt-in (default off): the game ships a few dead constant keys
        // its shaders do not read, so a default-on check would warn on vanilla data.
        if (settings.diagnostics?.validateShaderConstants) {
            const shaderConstantErrors = await validateShaderConstants(parserResult.value, cancelToken).catch(() => []);
            validationErrors = validationErrors.concat(shaderConstantErrors);
        }
        // Separate pass: literal localization keys (`NameKey = "Parts/Foo"`) that no strings file
        // declares. On by default, but only once the game `Data` tree is indexed: a mod referencing a
        // vanilla key would false-positive against the mod's own strings alone.
        if (settings.diagnostics?.validateLocalizationKeys && gameIndexAvailable()) {
            const localizationErrors = await timedPass('scan.vLocalizationMs', async () =>
                validateLocalizationKeys(parserResult.value, await searchFolderUris(), cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(localizationErrors);
        }
        // Separate pass: `,`/`;` separators that a line break already makes redundant. A token-level
        // scan, since separators never become AST nodes. Hint severity keeps the finding out of the
        // Problems panel (vanilla itself ships hundreds of trailing separators).
        if (settings.diagnostics?.validateRedundantSeparators) {
            validationErrors = validationErrors.concat(validateRedundantSeparators(tokens));
        }
        if (isModRules(textDocument.uri)) {
            // Separate pass: validate the manifest's action verbs/targets against the
            // effective game tree (the AstType-keyed Validator allows only one pass per type).
            const modActionErrors = await validateModActions(
                ModRulesRegistrar.instance.getActions(textDocument.uri),
                cancelToken
            ).catch(() => []);
            validationErrors = validationErrors.concat(modActionErrors);
        }
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
    }
    if (!persist) perfCount('scan.validateMs', Date.now() - validateStarted);

    for (const error of validationErrors) {
        problems++;
        if (problems > settings.maxNumberOfProblems) break;
        const diagnostic: Diagnostic = {
            severity: VALIDATION_SEVERITY[error.severity ?? 'error'],
            range: {
                start: textDocument.positionAt(error.node.position.start),
                end: textDocument.positionAt(error.node.position.end),
            },
            message: error.message,
            source: 'cosmoteer-language-server',
        };
        // Round-trip quick-fix data (e.g. "did you mean") to the code-action handler.
        if (error.data) diagnostic.data = error.data;
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
    if (cancelToken.isCancellationRequested) return [];
    return diagnostics;
}

// ── Whole-workspace diagnostics (opt-in) ────────────────────────────────────────────────────
// By default the server only validates the file open in the editor (see `documents.onDidChange-
// Content`). When `cosmoteerLSPRules.diagnostics.validateWholeWorkspace` is enabled, we also walk
// every `.rules` file in the open workspace folder(s) and publish diagnostics for them, so problems
// surface in the Problems panel without opening each file. It is off by default because parsing the
// whole project keeps every file's AST in memory and costs CPU up front.

/** How many workspace files to validate concurrently — bounded so a big mod can't exhaust memory.
 *  Each in-flight validation holds an AST plus its cross-file resolution working set, so keep this
 *  low. The parsed ASTs are discarded after each file (validateTextDocument `persist: false`). */
const WORKSPACE_DIAGNOSTIC_CONCURRENCY = 4;
/** URIs we have published whole-workspace diagnostics for, so we can clear them when disabled. */
const workspaceDiagnosticUris = new Set<string>();
/** Cancels an in-flight whole-workspace pass when settings or folders change again. */
let workspaceValidationSource: CancellationTokenSource | undefined;

/** Whether the whole-workspace diagnostics feature is currently enabled. */
const wholeWorkspaceEnabled = (): boolean => globalSettings.diagnostics?.validateWholeWorkspace ?? false;

/** Normalized URIs of every document currently open in the editor (they get diagnostics via the normal flow). */
const openDocumentNorms = (): Set<string> => new Set(documents.all().map((d) => normalizeUri(d.uri)));

/**
 * Validate a single `.rules` file from disk and publish its diagnostics. Skips files open in the
 * editor (the live-edit flow already covers them). Reuses {@link validateTextDocument} so on-disk
 * files go through the exact same lexer/parser/validator path as open ones.
 *
 * @param file the on-disk path of the `.rules` file to validate.
 * @param openNorms normalized uris of documents open in the editor, which are skipped.
 * @param token cancellation token for the in-flight workspace pass.
 */
async function validateWorkspaceFile(file: string, openNorms: Set<string>, token: CancellationToken): Promise<void> {
    const uri = filePathToUri(file);
    if (openNorms.has(normalizeUri(uri))) return;
    let text: string;
    try {
        text = await readFile(file, { encoding: 'utf-8' });
    } catch {
        return;
    }
    if (token.isCancellationRequested) return;
    const textDocument = TextDocument.create(uri, 'rules', 0, text);
    try {
        // persist=false: don't cache this unopened file's AST (memory) — produce diagnostics and discard.
        const diagnostics = await validateTextDocument(textDocument, token, false);
        if (token.isCancellationRequested) return;
        perfCount('scan.files');
        perfSampleMemory();
        workspaceDiagnosticUris.add(uri);
        await connection.sendDiagnostics({ uri, diagnostics });
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
    }
}

/**
 * Validate every `.rules` file in the open workspace folder(s) and publish their diagnostics. No-op
 * when the feature is disabled. Scoped to the workspace folders (the mod) — not the Cosmoteer game
 * `Data` tree, which would be enormous. Any previous pass is cancelled first.
 */
async function runWorkspaceValidation(): Promise<void> {
    if (!wholeWorkspaceEnabled()) return;
    workspaceValidationSource?.cancel();
    const source = new CancellationTokenSource();
    workspaceValidationSource = source;
    const token = source.token;

    const folders = await getWorkspaceFoldersCached();
    const folderUris = (folders ?? []).map((folder) => folder.uri);
    if (folderUris.length === 0) return;

    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('Validating workspace', 0, '', false);
    startScanCpuProfile();
    // Trust the fs caches for the duration of the pass: a scan re-checks the same directories and
    // base files tens of thousands of times, and the file watcher invalidates changed paths anyway.
    beginFsTrustWindow();
    try {
        const files: string[] = [];
        for (const folder of folderUris) {
            for await (const file of collectRulesFiles(uriToFsPath(folder))) {
                if (token.isCancellationRequested) return;
                files.push(file);
            }
        }
        // In 'modRulesReachable' scope, restrict the pass to files the game can actually load (the
        // manifest's reachability closure), so dead backups and templates stay out of the Problems
        // panel. A folder without a manifest keeps every file (nothing to scope by).
        if (globalSettings.diagnostics?.workspaceValidationScope === 'modRulesReachable') {
            const reachableKeys = new Set<string>();
            let anyManifest = false;
            for (const folder of folderUris) {
                const folderPath = uriToFsPath(folder);
                const modRoot = findModRoot(join(folderPath, 'probe.rules'));
                if (!modRoot) continue;
                const reachability = await computeModReachability(modRoot, token);
                if (!reachability) continue;
                anyManifest = true;
                for (const key of reachability.reachable) reachableKeys.add(key);
            }
            if (anyManifest) {
                const scoped = files.filter((file) => reachableKeys.has(reachabilityKey(file)));
                files.length = 0;
                files.push(...scoped);
            }
        }
        const openNorms = openDocumentNorms();
        let next = 0;
        let done = 0;
        const worker = async (): Promise<void> => {
            while (next < files.length && !token.isCancellationRequested) {
                const file = files[next++];
                await validateWorkspaceFile(file, openNorms, token);
                done++;
                progress.report(Math.round((done / files.length) * 100), `${done}/${files.length}`);
            }
        };
        await Promise.all(Array.from({ length: WORKSPACE_DIAGNOSTIC_CONCURRENCY }, worker));
    } finally {
        endFsTrustWindow();
        await stopScanCpuProfile();
        progress.done();
        if (workspaceValidationSource === source) workspaceValidationSource = undefined;
    }
}

/** Clear all whole-workspace diagnostics we published (except files still open in the editor). */
async function clearWorkspaceDiagnostics(): Promise<void> {
    workspaceValidationSource?.cancel();
    const openNorms = openDocumentNorms();
    for (const uri of workspaceDiagnosticUris) {
        if (openNorms.has(normalizeUri(uri))) continue;
        await connection.sendDiagnostics({ uri, diagnostics: [] });
    }
    workspaceDiagnosticUris.clear();
}

/**
 * A read-override that returns an OPEN editor buffer's text for an absolute path, so shader features
 * see unsaved edits instead of the on-disk file. Keyed by normalized (forward-slash, lower-case) path.
 */
function openBufferReadOverride(): (absPath: string) => string | undefined {
    const openByPath = new Map<string, string>();
    for (const open of documents.all()) {
        openByPath.set(uriToFsPath(open.uri).replace(/\\/g, '/').toLowerCase(), open.getText());
    }
    return (absPath) => openByPath.get(absPath.replace(/\\/g, '/').toLowerCase());
}

// This handler provides the initial list of the completion items.
connection.onCompletion(
    async (textDocumentPosition: TextDocumentPositionParams, cancellationToken): Promise<CompletionItem[]> => {
        // `.shader` files get HLSL completion (builtins plus the uniforms/functions/structs the file and
        // its `#include` chain declare), not the OT schema completion below.
        if (isShaderDocument(textDocumentPosition.textDocument.uri)) {
            const document = documents.get(textDocumentPosition.textDocument.uri);
            if (!document) return [];
            const text = document.getText();
            // Widen completion to the include chain so a custom base shader's symbols resolve too.
            const includeText = await collectIncludeText(
                text,
                uriToFsPath(textDocumentPosition.textDocument.uri),
                undefined,
                openBufferReadOverride()
            ).catch(() => '');
            return shaderCompletions(text, document.offsetAt(textDocumentPosition.position), includeText);
        }
        const parserResult = ensureParserResult(textDocumentPosition.textDocument.uri);
        let completions: Completion[] = [];
        try {
            if (!parserResult) return [];
            await ensureFragmentRooting(cancellationToken);
            const node = findNodeAtPosition(parserResult, textDocumentPosition?.position);
            if (node) {
                completions = await AutoCompletionService.instance.getCompletions(node, cancellationToken).catch(() => []);
                // Cross-file `ID<X>` value completion (e.g. `ResourceType = ` → project resource ids).
                // Only when nothing else matched, and gated internally to reference fields.
                if (completions.length === 0) {
                    completions = await SchemaIdIndex.instance
                        .idCompletions(node, await searchFolderUris(), cancellationToken)
                        .catch(() => []);
                }
                // Localization-key value completion (a `KeyString` field, e.g. `NameKey = "…"`) → every
                // key declared in the project's strings files. Gated internally to `KeyString` fields.
                if (completions.length === 0) {
                    completions = await LocalizationKeyIndex.instance
                        .keyCompletionsForNode(node, await searchFolderUris(), cancellationToken)
                        .catch(() => []);
                }
            } else if (isModRules(textDocumentPosition.textDocument.uri)) {
                // Empty insertion point in a mod.rules: offer the action entry's remaining field names,
                // or a full action-block snippet at the `Actions [ … ]` list level. Needs the byte
                // offset, so use the open document.
                const document = documents.get(textDocumentPosition.textDocument.uri);
                if (document) {
                    completions = modRulesOffsetCompletions(
                        parserResult,
                        document.offsetAt(textDocumentPosition.position)
                    );
                }
            } else {
                // Empty insertion point in a normal `.rules`. Offset-based (no AST leaf under the
                // cursor): at an empty `Key = ` value position offer that field's legal values, else
                // offer the enclosing group's not-yet-present schema field names.
                const document = documents.get(textDocumentPosition.textDocument.uri);
                if (document) {
                    const offset = document.offsetAt(textDocumentPosition.position);
                    const linePrefix = document.getText({
                        start: { line: textDocumentPosition.position.line, character: 0 },
                        end: textDocumentPosition.position,
                    });
                    // Inside an unclosed function call (`Damage = ceil(sq`) the AST has no leaf and
                    // the line is no `Key = ` value position either, so check the call context first
                    // and offer the math-function names there instead of field names.
                    const mathCompletions = mathFunctionCompletionsAtLinePrefix(parserResult, offset, linePrefix);
                    const valueCompletions =
                        mathCompletions.length > 0
                            ? mathCompletions
                            : schemaValueCompletionsAtOffset(parserResult, offset, linePrefix);
                    if (valueCompletions === undefined) {
                        // Not a `Key = ` value position → offer field names instead.
                        completions = await schemaFieldNameCompletions(parserResult, offset, cancellationToken);
                    } else if (valueCompletions.length > 0) {
                        completions = valueCompletions;
                    } else {
                        // A value position with no sync values — a cross-file `ID<X>` field? Offer the
                        // project's ids of the target class (e.g. `ResourceType = ` → resource ids).
                        const target = crossFileReferenceTargetAtOffset(parserResult, offset, linePrefix);
                        if (target) {
                            completions = await SchemaIdIndex.instance
                                .idCompletionsForClass(target, await searchFolderUris(), cancellationToken)
                                .catch(() => []);
                        } else if (isLocalizationKeyFieldAtOffset(parserResult, offset, linePrefix)) {
                            // A `KeyString` field (`NameKey = `) → the project's strings keys.
                            completions = await LocalizationKeyIndex.instance
                                .allKeyCompletions(await searchFolderUris(), cancellationToken)
                                .catch(() => []);
                        }
                    }
                }
            }
            // Cross-file id fallback: when nothing else matched, offer the project's ids for the
            // reference class at the cursor. This covers a `map<reference X>` key position
            // (`MaxBuffValues = { … }`), a direct reference value, and a `list<reference X>` element
            // (`TypeCategories = [ … ]`). It runs after the branches above because an empty list or
            // map resolves the cursor to its container node, which skips the offset-based detection.
            if (completions.length === 0) {
                const document = documents.get(textDocumentPosition.textDocument.uri);
                if (document) {
                    const offset = document.offsetAt(textDocumentPosition.position);
                    const linePrefix = document.getText({
                        start: { line: textDocumentPosition.position.line, character: 0 },
                        end: textDocumentPosition.position,
                    });
                    // A particle data channel field (`AIn = `, `DataOut = `) offers the file's channel
                    // names — a same-file symbol set, no project index needed.
                    const channels = particleChannelCompletionsAtOffset(parserResult, offset, linePrefix);
                    if (channels && channels.length > 0) {
                        completions = channels;
                    } else {
                        const enclosingGroup = findEnclosingGroup(parserResult, offset);
                        const enclosingList = findEnclosingList(parserResult, offset);
                        const target =
                            (enclosingGroup ? mapKeyTargetOf(enclosingGroup) : undefined) ??
                            (enclosingList ? listElementReferenceTarget(enclosingList) : undefined) ??
                            crossFileReferenceTargetAtOffset(parserResult, offset, linePrefix);
                        if (target) {
                            completions = await SchemaIdIndex.instance
                                .idCompletionsForClass(target, await searchFolderUris(), cancellationToken)
                                .catch(() => []);
                        }
                    }
                }
            }
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        }
        return completions.map<CompletionItem>((completion) => toCompletionItem(completion, hasSnippetCapability));
    }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    return item;
});

// Go-to-definition: resolve the reference under the cursor to its target location.
connection.onDefinition(async (params: TextDocumentPositionParams, cancellationToken) => {
    // `.shader` files: resolve an `#include "…"` under the cursor to the included file, or a `_uniform`
    // / function name to its declaration in this file or the include chain.
    if (isShaderDocument(params.textDocument.uri)) {
        const document = documents.get(params.textDocument.uri);
        if (!document) return null;
        const text = document.getText();
        const offset = document.offsetAt(params.position);
        const dataDir = CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath;
        const include = shaderDocumentDefinition(text, offset, params.textDocument.uri, dataDir);
        if (include) return include;
        return await shaderSymbolDefinition(text, offset, params.textDocument.uri, dataDir, openBufferReadOverride());
    }
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        await ensureFragmentRooting(cancellationToken);
        return await DefinitionService.instance.getDefinition(
            parserResult,
            params.position,
            cancellationToken,
            await searchFolderUris()
        );
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Document links: underline every reference and asset in the file so they are visibly clickable
// (Ctrl-click) without placing the cursor first. Ranges are computed from the cached AST here; each
// link's target is resolved lazily in onDocumentLinkResolve, so an unopened link costs nothing.
connection.onDocumentLinks((params, cancellationToken) => {
    // `.shader` files have no `.rules` references; their `#include` navigation is handled by definition.
    if (isShaderDocument(params.textDocument.uri)) return null;
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        return computeDocumentLinks(parserResult);
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Resolve a single link's target on demand — the same resolution go-to-definition performs.
connection.onDocumentLinkResolve(async (link, cancellationToken) => {
    const data = link.data as { uri: string; line: number; character: number } | undefined;
    if (!data) return link;
    const parserResult = ensureParserResult(data.uri);
    if (!parserResult) return link;
    try {
        await ensureFragmentRooting(cancellationToken);
        return await resolveDocumentLink(link, parserResult, await searchFolderUris(), cancellationToken);
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return link;
    }
});

// Document outline: project the cached AST into a hierarchical symbol tree
// (drives the breadcrumb bar + Outline view). Pure structural, no resolution.
connection.onDocumentSymbol((params, cancellationToken) => {
    // `.shader` files: outline the file's `_`-uniforms and functions from the HLSL scan.
    if (isShaderDocument(params.textDocument.uri)) {
        const document = documents.get(params.textDocument.uri);
        return document ? shaderDocumentSymbols(document.getText()) : null;
    }
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        if (cancellationToken.isCancellationRequested) return null;
        return DocumentSymbolService.instance.getDocumentSymbols(parserResult);
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// The cross-file existence validators (ids, localization keys) judge a reference against everything
// the game can see at load time, most of which is the vanilla install. Until the game `Data` root is
// initialized, that coverage is missing and an unknown-id verdict could be wrong, so those passes
// hold off rather than false-positive (they are on by default and activate once the path resolves).
const gameIndexAvailable = (): boolean => !!CosmoteerWorkspaceService.instance.dataRootPath;

// Folders the cross-file index searches: the open workspace (the mod) plus the Cosmoteer
// game `Data` tree. Vanilla symbols (e.g. `Part` in `base_part.rules`) and most references
// to them live in the game install, outside the open mod folder — without this, find-all-
// references on a vanilla symbol finds only its declaration.
async function searchFolderUris(): Promise<string[]> {
    const folders = await getWorkspaceFoldersCached();
    const uris = (folders ?? []).map((folder) => folder.uri);
    // Use the actually-initialized Data root (reliable), not globalSettings.cosmoteerPath
    // (which a config-change event can transiently blank). This is where the vanilla files
    // and the references between them live — the referencing files need not be open.
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (dataRoot) uris.push(dataRoot);
    return uris;
}

/**
 * Makes both fragment-rooting indexes current before any synchronous schema resolution runs. A
 * standalone fragment file is rooted either forward, through `cosmoteer.rules`'s own aliases, or in
 * reverse, through the field that `&<includes>` it, so every schema feature awaits this so a fragment's
 * fields, references, and shader material resolve. The first call also builds the other project-wide
 * indexes over the same document walk, so completion and validation don't each pay a separate
 * whole-project parse later.
 *
 * @param cancellationToken cancels the reconcile of changed documents.
 * @returns once the indexes are built and the fragment-rooting ones are reconciled.
 */
async function ensureFragmentRooting(cancellationToken: CancellationToken): Promise<void> {
    // Never build before `onInitialized` settled the game-tree scan: a validation of an
    // already-open file arrives earlier, and building then would permanently omit the game
    // `Data` root from every project index (they are one-time builds).
    await workspaceInitialized;
    // Only the two rooting sources feed the schema-context memos: the forward alias walk and the
    // reverse-include index. Snapshot their revisions so the epoch below is only bumped when one
    // of them actually moved. The whole-workspace scan calls this once per file, and bumping
    // unconditionally invalidated every memo on shared base nodes several thousand times per scan.
    const rootingRevisionBefore = aliasRootIndex.revision + ReverseIncludeIndex.instance.revision;
    await ensureAliasRootIndex(cancellationToken).catch(() => undefined);
    const folders = await searchFolderUris();
    await WatchedDocumentIndex.buildTogether(
        [
            ReverseIncludeIndex.instance,
            SchemaIdIndex.instance,
            TemplateBaseIndex.instance,
            LocalizationKeyIndex.instance,
        ],
        folders,
        'Indexing project'
    ).catch(() => undefined);
    await ReverseIncludeIndex.instance.ensureBuilt(folders, cancellationToken).catch(() => undefined);
    // The builds above may have (re)rooted fragments, which changes what the per-node schema
    // resolution memos would answer, so start a fresh memo epoch for the features that follow.
    if (aliasRootIndex.revision + ReverseIncludeIndex.instance.revision !== rootingRevisionBefore) {
        invalidateSchemaContextCache();
    }
}

// Disk changes the editor doesn't surface as edits (git pull/checkout, external tools,
// create/delete): keep the cached symbol table in step. Deletions drop immediately.
// Created/externally-changed files are re-read from disk at the next workspace-symbol query.
connection.onDidChangeWatchedFiles(async (params) => {
    const openNorms = wholeWorkspaceEnabled() ? openDocumentNorms() : undefined;
    // Disk changes can re-root fragments and shift schema anchoring for unchanged open ASTs.
    invalidateSchemaContextCache();
    // A cosmoteer.rules add/change/delete can alter how fragments are rooted — rebuild lazily.
    if (params.changes.some((c) => basenameOf(c.uri).toLowerCase() === 'cosmoteer.rules')) {
        aliasRootIndex.invalidate();
    }
    const toRevalidate: string[] = [];
    for (const change of params.changes) {
        // A disk change invalidates the parsed-document cache entry and the parent directory
        // listing reference resolution keeps, and dirties the mention index's word entry.
        invalidateFsPath(uriToFsPath(change.uri));
        MentionIndex.instance.markDirty(uriToFsPath(change.uri));
        if (change.type === FileChangeType.Deleted) {
            WorkspaceSymbolService.instance.remove(change.uri);
            SchemaIdIndex.instance.remove(change.uri);
            TemplateBaseIndex.instance.remove(change.uri);
            LocalizationKeyIndex.instance.remove(change.uri);
            ReverseIncludeIndex.instance.remove(change.uri);
            // Clear any whole-workspace diagnostics we published for the now-deleted file. We must
            // send to the same uri string we published with, so match by normalized form (the
            // watcher's uri may differ in encoding from our `filePathToUri` form).
            const deletedNorm = normalizeUri(change.uri);
            for (const stored of workspaceDiagnosticUris) {
                if (normalizeUri(stored) !== deletedNorm) continue;
                workspaceDiagnosticUris.delete(stored);
                await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
            }
        } else {
            WorkspaceSymbolService.instance.markDirty(change.uri);
            SchemaIdIndex.instance.markDirty(change.uri);
            TemplateBaseIndex.instance.markDirty(change.uri);
            LocalizationKeyIndex.instance.markDirty(change.uri);
            ReverseIncludeIndex.instance.markDirty(change.uri);
            if (openNorms) toRevalidate.push(uriToFsPath(change.uri));
        }
    }
    // Re-validate created/externally-changed files so their diagnostics stay current (files open
    // in the editor are skipped, the live-edit flow already covers those). A git-pull-sized burst
    // arrives as one notification with many changes, so the files run through the same bounded
    // worker pool as the whole-workspace pass instead of strictly one after another.
    if (openNorms && toRevalidate.length > 0) {
        let next = 0;
        const worker = async (): Promise<void> => {
            while (next < toRevalidate.length) {
                await validateWorkspaceFile(toRevalidate[next++], openNorms, CancellationToken.None);
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(WORKSPACE_DIAGNOSTIC_CONCURRENCY, toRevalidate.length) }, worker)
        );
    }
});

// Find-all-references: the reverse of go-to-definition. Resolves the symbol under the
// cursor, then searches the project (name-pre-filtered) for references resolving to it.
connection.onReferences(async (params, cancellationToken) => {
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        await ensureFragmentRooting(cancellationToken);
        return await ReferenceIndex.instance.findReferences(
            parserResult,
            params.position,
            params.context?.includeDeclaration ?? true,
            await searchFolderUris(),
            cancellationToken,
            await connection.window.createWorkDoneProgress()
        );
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Workspace symbols: flat, project-wide name search ("Go to Symbol in Workspace").
connection.onWorkspaceSymbol(async (params, cancellationToken) => {
    try {
        // Scoped to the open project (the mod), not the whole game tree — a project-wide
        // symbol table over all of Cosmoteer would be huge; "go to symbol in workspace" is
        // about the files you're editing.
        const folders = await getWorkspaceFoldersCached();
        const folderUris = (folders ?? []).map((folder) => folder.uri);
        return await WorkspaceSymbolService.instance.getWorkspaceSymbols(
            params.query,
            folderUris,
            cancellationToken
        );
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Rename: validate the symbol under the cursor, then rewrite its declaration and every
// reference segment that resolves to it across the project.
connection.onPrepareRename(async (params) => {
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        return await RenameService.instance.prepareRename(parserResult, params.position);
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

connection.onRenameRequest(async (params, cancellationToken) => {
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        const edit = await RenameService.instance.rename(
            parserResult,
            params.position,
            params.newName,
            await searchFolderUris(),
            cancellationToken
        );
        // Safety: rename searches the whole game tree but must never write to the read-only vanilla
        // install — strip any edits under the Data root so we only touch the open mod. A developer
        // working ON the game data can opt into editing vanilla via the setting.
        if (!edit || globalSettings.rename?.allowEditingVanillaFiles) return edit;
        return dropEditsUnderRoot(edit, CosmoteerWorkspaceService.instance.dataRootPath);
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Code actions: surface the quick fixes carried on diagnostics' `data` — the "did you mean …"
// replacements (a typo'd reference name, asset filename, or localization key) as one-click edits of
// the flagged range, and the "insert missing localization key" fix as a cross-file edit that adds the
// key to every language strings file of the mod, plus the extract-repeated-value refactoring.
connection.onCodeAction(async (params, cancellationToken): Promise<CodeAction[]> => {
    const actions: CodeAction[] = [];
    // Extract-to-shared-field refactoring, offered on repeated literal values independent of any
    // diagnostic (skipped when the client asked only for kinds that exclude refactorings).
    const wantsRefactor =
        !params.context.only || params.context.only.some((kind) => CodeActionKind.RefactorExtract.startsWith(kind));
    if (wantsRefactor) {
        const parserResult = ensureParserResult(params.textDocument.uri);
        const text = documents.get(params.textDocument.uri)?.getText();
        if (parserResult && text !== undefined) {
            const extract = extractValueCodeAction(parserResult, text, params.range.start, params.textDocument.uri);
            if (extract) actions.push(extract);
        }
    }
    for (const diagnostic of params.context.diagnostics) {
        const data = diagnostic.data as ValidationErrorData | undefined;
        if (data?.quickFix) {
            actions.push({
                title: data.quickFix.title,
                kind: CodeActionKind.QuickFix,
                diagnostics: [diagnostic],
                isPreferred: true,
                edit: {
                    changes: {
                        [params.textDocument.uri]: [{ range: diagnostic.range, newText: data.quickFix.newText }],
                    },
                },
            });
        }
        if (data?.insertLocalizationKey) {
            const key = data.insertLocalizationKey.key;
            const edit = await buildInsertLocalizationKeyEdit(params.textDocument.uri, key, cancellationToken).catch(
                () => null
            );
            if (edit) {
                actions.push({
                    title: l10n.t('Add "{0}" to the mod\'s strings files', key),
                    kind: CodeActionKind.QuickFix,
                    diagnostics: [diagnostic],
                    edit,
                });
            }
        }
    }
    return actions;
});

// Hover: show what a value resolves to — its computed number and/or reference target.
connection.onHover(async (params, cancellationToken) => {
    // `.shader` files: explain the symbol under the cursor (uniform, intrinsic, type, function, …).
    if (isShaderDocument(params.textDocument.uri)) {
        const document = documents.get(params.textDocument.uri);
        if (!document) return null;
        const text = document.getText();
        const includeText = await collectIncludeText(
            text,
            uriToFsPath(params.textDocument.uri),
            undefined,
            openBufferReadOverride()
        ).catch(() => '');
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
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Live shader preview: build the payload (translated GLSL, constants, texture, blend mode) for the
// material at a position, consumed by the client's WebGL preview webview.
connection.onRequest('cosmoteer/shaderPreview', async (params: TextDocumentPositionParams, cancellationToken) => {
    const parserResult = ensureParserResult(params.textDocument.uri);
    const document = documents.get(params.textDocument.uri);
    if (!parserResult || !document) return null;
    try {
        // Root a standalone fragment (a particle `_def.rules` included through a `Def = &<…>` field, say)
        // so its material's schema class resolves and the preview can find the shader to render.
        await ensureFragmentRooting(cancellationToken);
        // Let the preview read the shader chain from any open editor buffer instead of disk, so editing
        // a `.shader` updates the preview live before the file is saved.
        const readOverride = openBufferReadOverride();
        return await buildShaderPreview(
            parserResult,
            document.getText(),
            document.offsetAt(params.position),
            cancellationToken,
            readOverride
        );
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Mod overview: render the "what does this mod.rules do" markdown report — the manifest header,
// every action with its resolution status, and the reachability section listing dead files.
connection.onRequest('cosmoteer/modOverview', async (params: { textDocument: { uri: string } }, cancellationToken) => {
    try {
        // Action targets resolve against the effective game tree, so the workspace and the fragment
        // indexes must be ready, exactly as for validation of the manifest itself.
        await ensureFragmentRooting(cancellationToken);
        return (await generateModOverview(params.textDocument.uri, cancellationToken)) ?? null;
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Performance introspection for the scan bench (server/test/perf/scan-bench.mjs): the hot-path
// counters, the peak heap sampled during workspace scans, and the current memory usage. The
// optional reset lets the bench isolate a warm pass from the cold one that preceded it.
connection.onRequest('cosmoteer/perfStats', (params: { reset?: boolean } | null) => {
    const snapshot = { ...perfSnapshot(), memory: process.memoryUsage() };
    if (params?.reset) perfReset();
    return snapshot;
});

// Document colours: render an inline swatch for `{ Rf Gf Bf Af }` / `{ R G B A }` colour groups.
connection.onDocumentColor((params) => {
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

// Inlay hints: show the computed result of math/function assignments inline (`= 14`).
// Computed once per document version over the whole document and cached; each request (the client
// re-asks on every scroll) filters the cached hints down to its visible range.
const inlayHintCache: Map<string, { version: number; promise: Promise<InlayHint[]> }> = new Map();

/** The whole-document range, so one inlay computation covers every later scroll request. */
const FULL_DOCUMENT_RANGE = {
    start: { line: 0, character: 0 },
    end: { line: Number.MAX_SAFE_INTEGER, character: 0 },
};

connection.languages.inlayHint.on(async (params, cancellationToken) => {
    const uri = params.textDocument.uri;
    const parserResult = ensureParserResult(uri);
    if (!parserResult) return null;
    try {
        const version = documents.get(uri)?.version;
        let entry = version !== undefined ? inlayHintCache.get(uri) : undefined;
        if (!entry || entry.version !== version) {
            const promise = InlayHintService.instance.getInlayHints(parserResult, FULL_DOCUMENT_RANGE, cancellationToken);
            if (version !== undefined) {
                entry = { version, promise };
                inlayHintCache.set(uri, entry);
            } else {
                entry = { version: -1, promise };
            }
        }
        const hints = await entry.promise;
        // A cancelled computation returned partial hints, drop it so the next request recomputes.
        if (cancellationToken.isCancellationRequested) {
            if (inlayHintCache.get(uri) === entry) inlayHintCache.delete(uri);
            return null;
        }
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
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Semantic tokens: colour the parsed document by meaning the TextMate grammar can't infer (a `&…`
// reference vs a bareword enum vs a math function). The grammar stays the synchronous base layer;
// this is the overlay. Drives both VS Code and the native IntelliJ LSP highlighter.
// The token walk is pure CPU over the cached AST, so its result is cached per document version and
// repeated requests for unchanged text answer from memory.
const semanticTokensCache: Map<string, { version: number; tokens: { data: number[] } }> = new Map();

connection.languages.semanticTokens.on((params, cancellationToken) => {
    if (cancellationToken.isCancellationRequested) return { data: [] };
    try {
        const uri = params.textDocument.uri;
        const version = documents.get(uri)?.version;
        const cached = semanticTokensCache.get(uri);
        if (cached && version !== undefined && cached.version === version) return cached.tokens;
        let tokens: { data: number[] };
        // `.shader` files are HLSL, scanned lexically straight from text, no OT parse needed.
        if (isShaderDocument(uri)) {
            const document = documents.get(uri);
            tokens = document ? buildShaderSemanticTokens(document.getText()) : { data: [] };
        } else {
            const parserResult = ensureParserResult(uri);
            tokens = parserResult ? buildSemanticTokens(parserResult) : { data: [] };
        }
        if (version !== undefined) semanticTokensCache.set(uri, { version, tokens });
        return tokens;
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
            const includeText = await collectIncludeText(
                text,
                uriToFsPath(params.textDocument.uri),
                undefined,
                openBufferReadOverride()
            ).catch(() => '');
            return shaderSignatureHelp(text, document.offsetAt(params.position), includeText);
        }
        return computeSignatureHelp(document.getText(), document.offsetAt(params.position));
    } catch (e) {
        if (globalSettings.trace.server === 'messages') console.error(e);
        return null;
    }
});

// Document formatting: whitespace-only normalization (indentation, spacing around structural
// punctuation, trailing whitespace). `.rules` formatting is guarded by a lexical-equivalence check
// and returns no edits rather than risk changing what the game reads; `.shader` files get a plain
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

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();