import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticTag,
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
    UnchangedDocumentDiagnosticReport,
    ResponseError,
    LSPErrorCodes,
    CompletionList,
    SemanticTokens,
    SemanticTokensDelta,
    MarkupKind,
    CodeAction,
    CodeActionKind,
    WorkspaceFolder,
    TextEdit,
    InlayHint,
    Range,
} from 'vscode-languageserver/node';

import { readFile, stat } from 'fs/promises';
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
import { OPEN_IN_DECOMPILER_COMMAND } from './features/hover/decompiler-link';
import { OpenInDecompilerArgs, openInDecompiler } from './features/hover/decompiler-launcher';
import { ValidationError, ValidationErrorData, Validator } from './features/diagnostics/validator';
import { ValidationForIdentifier, ValidationForValue } from './features/diagnostics/validator.value';
import { ValidationForFunctionCall } from './features/diagnostics/validator.functioncall';

import * as l10n from '@vscode/l10n';
import { CosmoteerWorkspaceService } from './workspace/cosmoteer-workspace.service';
import { ValidationForAssignment } from './features/diagnostics/validator.assignment';
import { validateRedundantSeparators } from './features/diagnostics/validator.separator';
import { validateIgnoredFields } from './features/diagnostics/validator.ignored-field';
import { validateDefaultValuedFields } from './features/diagnostics/validator.default-value';
import { ValidationForMath } from './features/diagnostics/validator.math';
import { ValidationForDocumentDuplicates, ValidationForGroupDuplicates } from './features/diagnostics/validator.duplicate-key';
import { validateInheritanceCycles } from './features/diagnostics/validator.inheritance-cycle';
import { CancellationError } from './utils/cancellation';
import { WorkspaceTokenManager } from './workspace/token-manager';
import { CosmoteerSettings, defaultSettings, globalSettings, setGlobalSettings } from './settings';
import { basenameOf, isManifestBasename, isModRules, isRulesFileName } from './document/document-kind';
import { ModRulesRegistrar } from './mod/mod-rules.registrar';
import { isActionFragmentDocument, parseModActions } from './mod/action-parser';
import { ActionRootingIndex } from './mod/action-rooting.index';
import { AddBaseIndex } from './mod/add-base.index';
import { MemberInjectionIndex } from './mod/member-injection.index';
import { computeModReachability, reachabilityKey } from './mod/mod-reachability';
import { generateModOverview } from './mod/mod-overview';
import { clearModRootCache, findModRoot } from './mod/mod-root';
import { join } from 'path';
import { validateModActions } from './features/diagnostics/validator.mod-action';
import { invalidateModContext } from './mod/mod-context';
import { modRulesOffsetCompletions } from './features/completion/autocompletion.mod-rules';
import { mathFunctionCompletionsAtLinePrefix } from './features/completion/autocompletion.math-function';
import {
    crossFileReferenceTargetAtOffset,
    isBareFieldNameIdentifier,
    isLocalizationKeyFieldAtOffset,
    schemaFieldNameCompletions,
    schemaValueCompletionsAtOffset,
} from './features/completion/autocompletion.schema-fields';
import { LocalizationKeyIndex } from './features/completion/localization-key.index';
import { validateSchema } from './features/diagnostics/validator.schema';
import { validateRequiredFields } from './features/diagnostics/validator.required-fields';
import { TemplateBaseIndex } from './features/diagnostics/template-base.index';
import { invalidateComponentIdCache, validateSchemaSiblingReferences } from './features/diagnostics/validator.schema-sibling';
import { invalidateLooseDeclarationCache } from './features/diagnostics/validator.schema-id-reference';
import { validateCrossFileIdReferences } from './features/diagnostics/validator.schema-id-reference';
import { validateLocalizationKeys } from './features/diagnostics/validator.localization-key';
import { buildInsertLocalizationKeyEdit } from './features/diagnostics/localization-key-insert';
import { mapKeyTargetOf, schemaReferenceFieldOf } from './features/navigation/schema-id-reference.navigation';
import { componentIdCompletionsForTarget } from './features/completion/autocompletion.component-id';
import { buildShaderPreview } from './features/shader/shader-preview.service';
import { buildPartGridData } from './features/part-editor/part-grid-data.service';
import { buildPartGridEdit } from './features/part-editor/grid-edit.service';
import { PartGridEditParams } from './features/part-editor/part-grid.types';
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
import { collectRulesFiles, modFolderPaths, uriToFsPath } from './features/navigation/workspace-files';
import { collectReferencedTxtKeys } from './features/navigation/txt-reference-scan';
import {
    beginFsTrustWindow,
    clearFsCaches,
    endFsTrustWindow,
    foldPathCase,
    invalidateFsPath,
    primeParsedFile,
} from './workspace/fs-cache';
import { clearNavigationMemo, invalidateNavigationMemoForFile } from './features/navigation/full.navigation-strategy';
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
import {
    beginStatSweepWindow,
    endStatSweepWindow,
    saveScanCache,
    ScanCacheEntry,
    tryLoadScanCache,
} from './workspace/index-cache';
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
import { shaderCompletions, shaderIncludePathCompletions } from './features/shader/shader-completion';
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
let hasCompletionDocResolveCapability = false;

/** The cached `workspace/workspaceFolders` answer, `undefined` until (re)fetched. */
let workspaceFoldersCache: WorkspaceFolder[] | null | undefined;

/** Resolves {@link workspaceInitialized} once `onInitialized` settled the game-tree scan. */
let resolveWorkspaceInitialized: () => void;
/**
 * Settles once `onInitialized` finished initializing the Cosmoteer workspace (successfully or
 * not). A `didOpen` validation of an already-open file can arrive while that scan is still
 * running, and building the project indexes at that moment would bake in a folder set without the
 * game `Data` root. Every index would then silently lack the vanilla tree for the whole session.
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
    // A client that resolves completion documentation lazily (`completionItem/resolve` with
    // `documentation` in `resolveSupport`) gets the Markdown docs deferred out of the list payload.
    hasCompletionDocResolveCapability = !!capabilities.textDocument?.completion?.completionItem?.resolveSupport?.properties?.includes('documentation');
    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: {
                openClose: true,
                // Clients send range-scoped deltas instead of the whole text per keystroke. The
                // TextDocuments manager applies them, so the server still sees full documents.
                change: TextDocumentSyncKind.Incremental,
                // Lets the format-on-save setting return edits right before the client writes the file.
                willSaveWaitUntil: true,
            },
            completionProvider: {
                resolveProvider: true,
                // '.' drives `.shader` member/swizzle completion. '"' pops value completion (localization
                // keys, assets, references) the moment a quote opens. '#' pops `.shader` preprocessor
                // directives. The rest are `.rules` reference sigils.
                triggerCharacters: ['<', '&', '/', '^', '~', '..', '=', '.', '"', '#'],
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
            // The "Open in decompiler" hover link executes on the server (it spawns the user's
            // ILSpy/dotPeek locally), so VS Code and the JetBrains plugin share one implementation.
            executeCommandProvider: {
                commands: [OPEN_IN_DECOMPILER_COMMAND],
            },
            semanticTokensProvider: {
                legend: semanticTokensLegend,
                // Delta lets an edit answer with the changed slice of the token array instead of
                // re-shipping the whole thing, and range serves the viewport before the full pass.
                full: { delta: true },
                range: true,
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
    Validator.instance.registerValidation(ValidationForIdentifier);
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
            const gameTreeStarted = Date.now();
            await CosmoteerWorkspaceService.instance.initialize(
                settings.cosmoteerPath,
                await connection.window.createWorkDoneProgress()
            );
            perfCount('startup.gameTreeMs', Date.now() - gameTreeStarted);
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
        // across changes it can't see as editor edits, such as git pull/checkout, external tools,
        // file creation/deletion. This is the cache-safe alternative to re-walking the tree.
        // Asset files are watched too: their existence is memoized (asset.navigation-strategy),
        // and without a watcher event a created or deleted sprite/sound/shader would never drop
        // its memo entry, pinning a stale "asset not found" (or a stale hit) indefinitely.
        connection.client.register(DidChangeWatchedFilesNotification.type, {
            watchers: [{ globPattern: '**/*.{rules,txt}' }, { globPattern: '**/*.{png,mp3,wav,ogg,shader}' }],
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
            // over the new folder set, clearing first so diagnostics for removed folders don't
            // linger.
            workspaceFoldersCache = undefined;
            validationScopeEpoch++;
            WorkspaceSymbolService.instance.reset();
            SchemaIdIndex.instance.reset();
            TemplateBaseIndex.instance.reset();
            LocalizationKeyIndex.instance.reset();
            ReverseIncludeIndex.instance.reset();
            AddBaseIndex.instance.reset();
            MemberInjectionIndex.instance.reset();
            ActionRootingIndex.instance.reset();
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
    // above and build the context against a not-yet-loaded game tree, caching an empty result that
    // never recovers (every `&/INDICATORS/SWX`-style override ref then false-flags). Drop it now that
    // the scan is done so the next resolve rebuilds against the fully-loaded tree.
    invalidateModContext();
    // The same race can already have validated restored-tab files against the not-yet-loaded tree.
    // Their reference false flags sit in the version-keyed caches now, and the versions never move
    // without an edit, so the results would pin. Drop them and have the client recompute.
    diagnosticsCache.clear();
    inlayHintCache.clear();
    invalidateComponentIdCache();
    invalidateLooseDeclarationCache();
    if (hasPullDiagnosticsCapability) {
        connection.languages.diagnostics.refresh();
    } else {
        for (const document of documents.all()) schedulePushValidation(document);
    }

    // Warm the project indexes in the background so the first completion, hover, or validation
    // finds them already built instead of paying the whole-project walk itself. Deliberately not
    // awaited, since the first feature request would coalesce onto the same in-flight build anyway.
    // The mention index (find-all-references pre-filter) warms afterwards so the two builds don't
    // compete for the disk. The sweep window spans both builds, so the mention sync reuses the
    // walk+stat sweeps the project build (and its cache manifest checks) already paid.
    beginStatSweepWindow();
    const warmupStartedMs = Date.now();
    void ensureFragmentRooting(CancellationToken.None)
        .then(async () => {
            const projectMs = Date.now() - warmupStartedMs;
            await MentionIndex.instance.ensureBuilt(await searchFolderUris(), CancellationToken.None);
            connection.console.info(
                `Startup: project indexes ready in ${projectMs}ms, mention index in ${Date.now() - warmupStartedMs}ms`
            );
        })
        .catch(() => undefined)
        .finally(() => endStatSweepWindow());

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
    // notification carries no payload (`change.settings` is null), so we must re-pull the
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
        // The Cosmoteer root changed where references resolve to, so drop the cached symbol
        // table (find-all-references / rename are stateless and re-resolve per query).
        WorkspaceSymbolService.instance.reset();
        SchemaIdIndex.instance.reset();
        TemplateBaseIndex.instance.reset();
        LocalizationKeyIndex.instance.reset();
        ReverseIncludeIndex.instance.reset();
        AddBaseIndex.instance.reset();
        ActionRootingIndex.instance.reset();
        MentionIndex.instance.reset();
        clearFsCaches();
        invalidateSchemaContextCache();
    }
    // Changed settings change what a validation would produce (validators toggled, ignore paths,
    // problem limits), but open documents' versions are unchanged. The version-keyed caches
    // would keep serving results computed under the old settings to the refresh's re-pull.
    diagnosticsCache.clear();
    inlayHintCache.clear();
    invalidateComponentIdCache();
    invalidateLooseDeclarationCache();
    const scanSettingsKey = scanSettingsKeyOf();
    if (lastScanSettingsKey === undefined) {
        lastScanSettingsKey = scanSettingsKey;
    } else if (scanSettingsKey !== lastScanSettingsKey) {
        lastScanSettingsKey = scanSettingsKey;
        bumpWorkspaceScanEpoch();
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
 * the AST (most visibly the colour provider, which the editor does not re-request once it has been
 * answered with an empty result) would otherwise return nothing until the file is edited or
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
 * this map instead of racing two independent full passes over the same text. Each entry carries a
 * unique `resultId` for the pull protocol: a pull whose `previousResultId` still matches the live
 * entry answers "unchanged" instead of re-serializing the same diagnostic set. Every path that
 * invalidates diagnostics (a new version, a cross-file edit, a config change) drops or replaces
 * the entry, so a matching id is proof the client's copy is current.
 */
const diagnosticsCache: Map<string, { version: number; promise: Promise<Diagnostic[]>; resultId: string }> = new Map();

/** Source of the pull-diagnostics `resultId`s, unique across the whole session. */
let diagnosticsResultIdCounter = 0;

/**
 * Lexes and parses an open document once per version and publishes the result to every consumer:
 * the parser-result registrar (completion/hover/navigation read the live AST back), the project
 * indexes (marked dirty for their next query), and the mod-manifest registrar. Validation used to
 * do all of this inline. It lives here so the AST is current the moment an edit arrives, even when
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
    // The edit changes what references touching this file resolve to, and the disk watcher never
    // sees open-buffer edits, so drop the navigation memo entries whose resolution read this file.
    // Entries that never read it (the vanilla-tree bulk) survive the keystroke.
    invalidateNavigationMemoForFile(document.uri);
    // Scanned files may derive diagnostics from this buffer (registrar-first parse reads), so
    // their cached scan results are stale from this edit on.
    bumpWorkspaceScanEpoch();
    // Other open documents may derive diagnostics and inlay values from this document (an
    // inherited base, a strings file, a component provider), so their version-keyed caches are
    // stale now even though their own versions did not change. Drop everyone else's entries.
    // The client's next pull recomputes them against the fresh AST.
    for (const uri of [...diagnosticsCache.keys()]) {
        if (uri !== document.uri) diagnosticsCache.delete(uri);
    }
    for (const uri of [...inlayHintCache.keys()]) {
        if (uri !== document.uri) inlayHintCache.delete(uri);
    }
    invalidateComponentIdCache();
    invalidateLooseDeclarationCache();
    // An edit changes which symbols this file contributes. Re-index it lazily at the next
    // workspace-symbol query. (find-all-references is stateless, it re-reads per query.)
    WorkspaceSymbolService.instance.markDirty(document.uri);
    SchemaIdIndex.instance.markDirty(document.uri);
    TemplateBaseIndex.instance.markDirty(document.uri);
    LocalizationKeyIndex.instance.markDirty(document.uri);
    ReverseIncludeIndex.instance.markDirty(document.uri);
    AddBaseIndex.instance.markDirty(document.uri);
    MemberInjectionIndex.instance.markDirty(document.uri);
    ActionRootingIndex.instance.markDirty(document.uri);
    if (isModRules(document.uri)) {
        // Parse the manifest's actions. A mod.rules edit changes the effective game tree.
        ModRulesRegistrar.instance.registerManifest(parserResult.value);
        invalidateModContext();
        // The effective tree changed under every memoized super-path, so scoped invalidation
        // isn't enough here.
        clearNavigationMemo();
    } else if (basenameOf(document.uri).toLowerCase() === 'cosmoteer.rules') {
        // The mod's own cosmoteer.rules contributes convenience globals to the effective tree.
        invalidateModContext();
        clearNavigationMemo();
        // Its aliases drive fragment rooting, rebuild that index on the next feature use.
        aliasRootIndex.invalidate();
    }
}

/**
 * Returns the diagnostics of an open document, computing them at most once per document version.
 * A newer version cancels the previous run through the per-uri token source. A run that was
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
    diagnosticsCache.set(uri, { version, promise, resultId: String(++diagnosticsResultIdCounter) });
    return promise;
}

/**
 * Debounced push validation for clients without pull-diagnostics support. The first diagnostics of
 * a freshly opened document go out immediately. While typing, each keystroke resets a short timer
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
    // The registrar entry this drops was what resolution saw for the file, back to disk state.
    // Only entries whose resolution read the buffer can differ from disk.
    invalidateNavigationMemoForFile(e.document.uri);
    // Scanned files may have derived diagnostics from the discarded buffer.
    bumpWorkspaceScanEpoch();
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
        // uri the full pass uses, so the file isn't tracked twice under different uri encodings.
        const path = uriToFsPath(e.document.uri);
        const canonicalUri = filePathToUri(path);
        const scopeKeys = await validationScopeKeys(CancellationToken.None);
        // A `.txt` nothing references leaves with its tab for the same reason an out-of-scope file
        // does. It validated while open, since opening it as `rules` is a deliberate "this is rules",
        // but the game would never load it, so nothing persists it once the tab is gone. Without this
        // its problems stick forever: the scan gate below never publishes the file, so no later pass
        // is left to retract what the open flow pushed.
        const outOfScope = scopeKeys && !scopeKeys.has(reachabilityKey(path));
        if (outOfScope || (await isUnreferencedTxt(path, CancellationToken.None))) {
            // The file is outside what the panel persists. It validated while it was open
            // (open files always validate), but its problems leave the panel with the tab instead
            // of persisting the way scanned files' problems do.
            await connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
            const closedNorm = normalizeUri(canonicalUri);
            for (const stored of [...workspaceDiagnosticUris]) {
                if (normalizeUri(stored) !== closedNorm) continue;
                workspaceDiagnosticUris.delete(stored);
                await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
            }
            return;
        }
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
        // A pull-capable client requests `textDocument/diagnostic` itself after the change. Pushing
        // here as well would run the whole validation twice per edit.
        if (hasPullDiagnosticsCapability) return;
        schedulePushValidation(e.document);
    },
    null,
    [tokenSourceManager]
);

connection.languages.diagnostics.on(async (params, cancelToken) => {
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
    const items = await computeDiagnosticsCached(document);
    if (cancelToken.isCancellationRequested) {
        throw new ResponseError(LSPErrorCodes.RequestCancelled, 'diagnostic pull cancelled');
    }
    // The cache entry outlives the computation exactly as long as its result stays valid: every
    // invalidation path (new version, cross-file edit, watched-file change, config change) drops
    // or replaces it. So a client whose `previousResultId` still names the live entry already has
    // these diagnostics and only needs an "unchanged" confirmation.
    const entry = diagnosticsCache.get(document.uri);
    if (entry && params.previousResultId !== undefined && params.previousResultId === entry.resultId) {
        return {
            kind: DocumentDiagnosticReportKind.Unchanged,
            resultId: entry.resultId,
        } satisfies UnchangedDocumentDiagnosticReport;
    }
    return {
        kind: DocumentDiagnosticReportKind.Full,
        resultId: entry?.resultId,
        items,
    } satisfies FullDocumentDiagnosticReport;
});

/** Maps a {@link ValidationError} severity (default 'error') to the LSP DiagnosticSeverity. */
const VALIDATION_SEVERITY: Record<NonNullable<ValidationError['severity']>, DiagnosticSeverity> = {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    information: DiagnosticSeverity.Information,
    hint: DiagnosticSeverity.Hint,
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
 * @returns the document's diagnostics, capped at the configured problem limit.
 */
async function validateTextDocument(
    textDocument: TextDocument,
    cancelToken: CancellationToken,
    persist = true
): Promise<Diagnostic[]> {
    // `.shader` files reach the server (for semantic tokens / hover / include navigation) but are HLSL,
    // not OT, so never run the `.rules` lexer/parser/validators on them, which would flag every line as a
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
        // inheritance cycles span multiple nodes/files, and both need a whole-document view, so they run
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
        // Separate pass: fields the game provably ignores (not a member of the resolved schema class
        // and never referenced in the file). Hint severity with a remove quick fix.
        if (settings.diagnostics?.validateIgnoredFields) {
            const ignoredFieldErrors = await validateIgnoredFields(parserResult.value, cancelToken).catch(() => []);
            validationErrors = validationErrors.concat(ignoredFieldErrors);
        }
        // Separate pass: fields that restate the game's default, faded as dead weight with a remove
        // quick fix. Judged only inside groups that do not inherit, so an explicit default overriding
        // a base's value is never flagged.
        if (settings.diagnostics?.validateDefaultValues) {
            const defaultValueErrors = await timedPass('scan.vDefaultValueMs', () =>
                validateDefaultValuedFields(parserResult.value, cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(defaultValueErrors);
        }
        if (isModRules(textDocument.uri)) {
            // Separate pass: validate the manifest's action verbs/targets against the
            // effective game tree (the AstType-keyed Validator allows only one pass per type).
            const modActionErrors = await validateModActions(
                ModRulesRegistrar.instance.getActions(textDocument.uri),
                cancelToken
            ).catch(() => []);
            validationErrors = validationErrors.concat(modActionErrors);
        } else if (gameIndexAvailable() && isActionFragmentDocument(parserResult.value)) {
            // An included action fragment (launcher.rules, register.rules) holds a literal `Actions`
            // list that a manifest concatenates via `Actions: &<file>/Actions`. Validate its actions
            // the same way (verbs, required fields, and targets resolved against the game root), so
            // its `AddTo`/`OverrideIn` paths are checked instead of misread as unresolved mod-relative
            // references. Gated on the game index being ready, since target resolution needs the game
            // tree (an unready tree would flag every real vanilla target as missing).
            const modActionErrors = await validateModActions(parseModActions(parserResult.value), cancelToken).catch(
                () => []
            );
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
                start: textDocument.positionAt(error.range?.start ?? error.node.position.start),
                end: textDocument.positionAt(error.range?.end ?? error.node.position.end),
            },
            message: error.message,
            source: 'cosmoteer-language-server',
        };
        if (error.unnecessary) diagnostic.tags = [DiagnosticTag.Unnecessary];
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

/** How many workspace files to validate concurrently, bounded so a big mod can't exhaust memory.
 *  Each in-flight validation holds an AST plus its cross-file resolution working set, so keep this
 *  low. The parsed ASTs are discarded after each file (validateTextDocument `persist: false`).
 *  Six measured best on the reference mod: four left the pass idle on read IO for ~6% of the cold
 *  wall time, eight bought nothing further while raising peak heap. */
const WORKSPACE_DIAGNOSTIC_CONCURRENCY = 6;
/** URIs we have published whole-workspace diagnostics for, so we can clear them when disabled. */
const workspaceDiagnosticUris = new Set<string>();
/** Cancels an in-flight whole-workspace pass when settings or folders change again. */
let workspaceValidationSource: CancellationTokenSource | undefined;

/** Whether the whole-workspace diagnostics feature is currently enabled. */
const wholeWorkspaceEnabled = (): boolean => globalSettings.diagnostics?.validateWholeWorkspace ?? false;

/** Bumped whenever the on-disk `.rules` state or the folder set changes, staling the scope cache. */
let validationScopeEpoch = 0;
/** The cached result of {@link validationScopeKeys}, valid while its epoch is current. */
let validationScopeCache: { epoch: number; keys: Set<string> | undefined } | undefined;
/** The cached result of {@link referencedTxtKeys}, valid while {@link validationScopeEpoch} holds. */
let referencedTxtCache: { epoch: number; keys: Set<string> | undefined } | undefined;

/**
 * The `.txt` files something in the project references by path, or undefined when the project holds
 * no `.txt` and the gate is moot. Cached until a disk or folder change bumps the scope epoch, like
 * {@link validationScopeKeys}.
 *
 * @param token cancels the text scan. A cancelled (possibly partial) scan is not cached.
 * @returns the referenced keys, or undefined when no gate applies.
 */
async function referencedTxtKeys(token: CancellationToken): Promise<Set<string> | undefined> {
    if (referencedTxtCache?.epoch === validationScopeEpoch) return referencedTxtCache.keys;
    const epoch = validationScopeEpoch;
    const folders = await getWorkspaceFoldersCached();
    const keys = await collectReferencedTxtKeys((folders ?? []).map((folder) => uriToFsPath(folder.uri)), token).catch(
        () => undefined
    );
    if (!token.isCancellationRequested) referencedTxtCache = { epoch, keys };
    return keys;
}

/**
 * Whether a walked file is a `.txt` no rules text names, which the game would therefore never load
 * as rules. The walk claims every `.txt` because mods do keep real rules in them, but `.txt` is also
 * the extension of the game's own credits screen, of readmes, of decal whitelists and of stale
 * backups, and parsing those as rules fills the panel with noise. A `.rules` file is never gated:
 * nothing else uses that extension.
 *
 * Answers false while the reference set is unavailable, so an unscanned or cancelled state shows
 * diagnostics rather than hiding them.
 *
 * @param file the on-disk path of the walked file.
 * @param token cancels the reference scan the first call runs.
 * @returns true when the file is a `.txt` nothing references.
 */
async function isUnreferencedTxt(file: string, token: CancellationToken): Promise<boolean> {
    if (!file.toLowerCase().endsWith('.txt')) return false;
    const keys = await referencedTxtKeys(token);
    if (!keys) return false;
    return !keys.has(foldPathCase(file));
}

/**
 * The reachability keys the 'modRulesReachable' validation scope allows, or undefined when every
 * file is in scope (allFiles scope, or no workspace folder carries a mod manifest to scope by).
 * The closure walk parses every manifest and reached file, so the result is cached until a disk
 * or folder change bumps {@link validationScopeEpoch}.
 *
 * @param token cancels the closure walk. A cancelled (possibly partial) walk is not cached.
 * @returns the allowed reachability keys, or undefined when unrestricted.
 */
async function validationScopeKeys(token: CancellationToken): Promise<Set<string> | undefined> {
    if (globalSettings.diagnostics?.workspaceValidationScope !== 'modRulesReachable') return undefined;
    if (validationScopeCache?.epoch === validationScopeEpoch) return validationScopeCache.keys;
    const epoch = validationScopeEpoch;
    const folders = await getWorkspaceFoldersCached();
    const reachableKeys = new Set<string>();
    let anyManifest = false;
    for (const folder of folders ?? []) {
        const folderPath = uriToFsPath(folder.uri);
        const modRoot = findModRoot(join(folderPath, 'probe.rules'));
        if (!modRoot) continue;
        const reachability = await computeModReachability(modRoot, token);
        if (!reachability) continue;
        anyManifest = true;
        for (const key of reachability.reachable) reachableKeys.add(key);
    }
    const keys = anyManifest ? reachableKeys : undefined;
    if (!token.isCancellationRequested) validationScopeCache = { epoch, keys };
    return keys;
}

/** Normalized URIs of every document currently open in the editor (they get diagnostics via the normal flow). */
const openDocumentNorms = (): Set<string> => new Set(documents.all().map((d) => normalizeUri(d.uri)));

// A scanned file's diagnostics are a pure function of its on-disk content plus the shared state
// the validators consult (settings, open buffers, the rooting and declaration indexes). The cache
// below keys on all of them, so a repeat scan skips the lex, parse, and validate work for every
// file whose inputs are unchanged. That skip is what removes the re-parse allocation churn the
// garbage collector otherwise pays for on each warm pass.

/** Bumped whenever shared validator input outside the scanned files changes: an open-buffer edit
 *  or close, a watched disk change, a configuration change, or a workspace-folder change. Any bump
 *  invalidates every cached scan result, which trades fine-grained tracking for the guarantee that
 *  a cross-file dependency can never pin a stale result. */
let workspaceScanEpoch = 0;
/** The last seen scan-relevant settings serialization, so only a real change bumps the epoch
 *  (the whole-workspace toggle itself re-pulls configuration twice per flip). Undefined until
 *  the first configuration change establishes the baseline. */
let lastScanSettingsKey: string | undefined;

const bumpWorkspaceScanEpoch = (): void => {
    workspaceScanEpoch++;
};

/**
 * The scan-relevant settings serialization. Only settings that change what a file's validation
 * produces participate: the whole-workspace toggle and scope select which files are scanned, not
 * what a file yields, and flipping the toggle is exactly the repeat-scan case the caches exist
 * for. The l10n bundle path rides along because persisted diagnostics carry localized messages.
 *
 * @returns the serialized key.
 */
const scanSettingsKeyOf = (): string =>
    JSON.stringify({
        ...globalSettings,
        diagnostics: {
            ...globalSettings.diagnostics,
            validateWholeWorkspace: undefined,
            workspaceValidationScope: undefined,
        },
        l10nBundle: process.env['EXTENSION_BUNDLE_PATH'] ?? '',
    });

interface ScanResultEntry {
    size: number;
    mtimeMs: number;
    epoch: number;
    revisions: number;
    diagnostics: Diagnostic[];
}

/** Per-file scan results, keyed by case-folded fs path. */
const scanResultCache = new Map<string, ScanResultEntry>();
/** Upper bound of cached scan results, above one full pass over the largest known mods. */
const SCAN_RESULT_CAP = 16384;

/** Whether the persisted scan cache was already offered to this session (it seeds at most once). */
let persistedScanAttempted = false;
/** How many files any scan pass validated fresh (not served from a cache), for the save gate. */
let scanFreshValidations = 0;

/**
 * Seeds the in-memory scan cache from the persisted one, once per session. Only called after the
 * shared indexes converged, so the seeded entries carry the epoch and revision sum the per-file
 * check will compare against for the rest of the pass. The persisted cache is gated on nothing
 * having moved since it was saved (see `index-cache.ts`), which makes the seeded results exactly
 * what re-validating would produce.
 *
 * @param folderUris the workspace folder uris being scanned.
 * @returns once seeding finished (or was skipped).
 */
async function seedPersistedScanResults(folderUris: string[]): Promise<void> {
    if (persistedScanAttempted) return;
    persistedScanAttempted = true;
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return;
    const entries = await tryLoadScanCache(dataRoot, folderUris.map(uriToFsPath), scanSettingsKeyOf());
    if (!entries) return;
    const epoch = workspaceScanEpoch;
    const revisions = scanRevisionSum();
    for (const [path, size, mtimeMs, diagnostics] of entries) {
        scanResultCache.set(foldPathCase(path), { size, mtimeMs, epoch, revisions, diagnostics });
    }
    connection.console.info(`Workspace scan: ${entries.length} file results restored from cache`);
}

/**
 * The combined revision of every index whose content feeds scanned diagnostics. Captured before a
 * file validates and compared after: a result computed while an index was still ingesting must not
 * be stored, and a stored result is only served while every index is where it was.
 *
 * @returns the sum of the participating index revisions.
 */
const scanRevisionSum = (): number =>
    aliasRootIndex.revision +
    ReverseIncludeIndex.instance.revision +
    ActionRootingIndex.instance.revision +
    SchemaIdIndex.instance.revision +
    TemplateBaseIndex.instance.revision +
    LocalizationKeyIndex.instance.revision;

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
    // A `.txt` nothing references is not rules content the game would ever load, so it never enters
    // the panel. Anything it published before the gate could answer (or under an older reference set)
    // is cleared instead of left to stick.
    if (await isUnreferencedTxt(file, token)) {
        if (workspaceDiagnosticUris.has(uri)) {
            workspaceDiagnosticUris.delete(uri);
            await connection.sendDiagnostics({ uri, diagnostics: [] });
        }
        return;
    }
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
        stats = await stat(file);
    } catch {
        return;
    }
    const cacheKey = foldPathCase(file);
    const epochBefore = workspaceScanEpoch;
    const revisionsBefore = scanRevisionSum();
    const cached = scanResultCache.get(cacheKey);
    if (
        cached &&
        cached.size === stats.size &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.epoch === epochBefore &&
        cached.revisions === revisionsBefore
    ) {
        perfCount('scan.files');
        perfCount('scan.cacheHit');
        workspaceDiagnosticUris.add(uri);
        await connection.sendDiagnostics({ uri, diagnostics: cached.diagnostics });
        return;
    }
    let text: string;
    try {
        text = await readFile(file, { encoding: 'utf-8' });
    } catch {
        return;
    }
    if (token.isCancellationRequested) return;
    const textDocument = TextDocument.create(uri, 'rules', 0, text);
    try {
        // persist=false: don't cache this unopened file's AST (memory). Produce diagnostics and discard.
        const diagnostics = await validateTextDocument(textDocument, token, false);
        if (token.isCancellationRequested) return;
        // Only a result whose shared inputs did not move while it computed may be cached: a file
        // validated while an index was still ingesting (the cold pass builds them mid-flight)
        // reflects a state the next pass will not see.
        if (workspaceScanEpoch === epochBefore && scanRevisionSum() === revisionsBefore) {
            scanResultCache.set(cacheKey, {
                size: stats.size,
                mtimeMs: stats.mtimeMs,
                epoch: epochBefore,
                revisions: revisionsBefore,
                diagnostics,
            });
            while (scanResultCache.size > SCAN_RESULT_CAP) {
                const oldest = scanResultCache.keys().next().value;
                if (oldest === undefined) break;
                scanResultCache.delete(oldest);
            }
        }
        perfCount('scan.files');
        perfSampleMemory();
        scanFreshValidations++;
        workspaceDiagnosticUris.add(uri);
        await connection.sendDiagnostics({ uri, diagnostics });
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
    }
}

/**
 * Validate every `.rules` file in the open workspace folder(s) and publish their diagnostics. No-op
 * when the feature is disabled. Scoped to the workspace folders (the mod), not the Cosmoteer game
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
        const scopeKeys = await validationScopeKeys(token);
        if (scopeKeys) {
            const scoped = files.filter((file) => scopeKeys.has(reachabilityKey(file)));
            files.length = 0;
            files.push(...scoped);
        }
        const openNorms = openDocumentNorms();
        // Problems published for files that are no longer in scope (the closure shrank, or a tab
        // close or watcher event validated them before the scope gates existed) are not refreshed
        // by this pass, so they would stick in the panel forever. Clear them instead.
        if (scopeKeys) {
            for (const stored of [...workspaceDiagnosticUris]) {
                if (scopeKeys.has(reachabilityKey(uriToFsPath(stored)))) continue;
                if (openNorms.has(normalizeUri(stored))) continue;
                workspaceDiagnosticUris.delete(stored);
                await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
            }
        }
        // Converge the shared indexes before the pass, then seed the persisted scan results: the
        // seeded entries carry the converged epoch and revision sum, so the per-file check can
        // serve them for the whole pass instead of re-validating everything after a restart.
        await ensureFragmentRooting(token).catch(() => undefined);
        await seedPersistedScanResults(folderUris);
        const startedMs = Date.now();
        const freshBefore = scanFreshValidations;
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
        const fresh = scanFreshValidations - freshBefore;
        if (!token.isCancellationRequested) {
            connection.console.info(
                `Workspace validation: ${files.length} files in ${Date.now() - startedMs}ms (${fresh} validated, rest cached or open)`
            );
            // Persist the results computed under the pass's final shared state, so the next
            // session's scan can restore them instead of re-validating an unchanged project.
            // Only worth rewriting when this pass validated anything fresh.
            if (fresh > 0) {
                const epoch = workspaceScanEpoch;
                const revisions = scanRevisionSum();
                const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
                if (dataRoot) {
                    const entries: ScanCacheEntry[] = [];
                    for (const [key, entry] of scanResultCache) {
                        if (entry.epoch !== epoch || entry.revisions !== revisions) continue;
                        entries.push([key, entry.size, entry.mtimeMs, entry.diagnostics]);
                    }
                    // Awaited, so a server shutdown right after the pass cannot tear the write.
                    await saveScanCache(dataRoot, folderUris.map(uriToFsPath), scanSettingsKeyOf(), entries);
                }
            }
        }
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
 * A read-override that returns an open editor buffer's text for an absolute path, so shader features
 * see unsaved edits instead of the on-disk file. Keyed by normalized (forward-slash, lower-case) path.
 *
 * @returns the lookup function, which answers undefined for a path no open buffer covers.
 */
function openBufferReadOverride(): (absPath: string) => string | undefined {
    const openByPath = new Map<string, string>();
    for (const open of documents.all()) {
        openByPath.set(uriToFsPath(open.uri).replace(/\\/g, '/').toLowerCase(), open.getText());
    }
    return (absPath) => openByPath.get(absPath.replace(/\\/g, '/').toLowerCase());
}

// This handler provides the initial list of the completion items.
/** Upper bound of completion items shipped in one response. Larger lists (every localization key,
 *  every project id) are prefix-filtered and truncated, and marked incomplete so the client
 *  re-requests as the user types instead of holding a huge stale list. */
const COMPLETION_ITEM_CAP = 500;

/** Markdown documentation deferred out of recent completion responses, keyed by request id and
 *  item index, until the client resolves the selected item. Only the latest few requests are kept,
 *  a resolve only ever targets the list the client is currently showing. */
const completionDocStores: Map<number, Array<string | undefined>> = new Map();

/** Source of the completion request ids the deferred-documentation store is keyed by. */
let completionRequestCounter = 0;

/** How many recent completion responses keep their deferred documentation resolvable. */
const COMPLETION_DOC_STORES_KEPT = 4;

/**
 * Strips the Markdown documentation out of completion items and parks it in
 * {@link completionDocStores}, marking each stripped item with the store key in `item.data` so
 * `completionItem/resolve` can reattach it. Documentation is the bulk of a list's payload and the
 * client only ever shows one item's docs at a time, so shipping it lazily keeps the per-keystroke
 * response small. Only called when the client declared `resolveSupport` for `documentation`.
 *
 * @param items the completion items about to be returned.
 */
const deferCompletionDocumentation = (items: CompletionItem[]): void => {
    if (!items.some((item) => item.documentation !== undefined)) return;
    const requestId = ++completionRequestCounter;
    const docs: Array<string | undefined> = [];
    items.forEach((item, index) => {
        const documentation = item.documentation;
        if (documentation === undefined) return;
        docs[index] = typeof documentation === 'string' ? documentation : documentation.value;
        delete item.documentation;
        item.data = { docRequest: requestId, docIndex: index };
    });
    completionDocStores.set(requestId, docs);
    for (const key of completionDocStores.keys()) {
        if (completionDocStores.size <= COMPLETION_DOC_STORES_KEPT) break;
        completionDocStores.delete(key);
    }
};

/**
 * Packs raw completions into the LSP response list. Lists over {@link COMPLETION_ITEM_CAP} are
 * narrowed to the word prefix at the cursor and truncated, and flagged `isIncomplete` so the
 * client asks again on the next keystroke with the narrower prefix.
 *
 * @param completions the raw completions of the matched strategy.
 * @param wordPrefix the identifier-like text immediately left of the cursor.
 * @returns the completion list to return to the client.
 */
const finishCompletionList = (completions: Completion[], wordPrefix: string): CompletionList => {
    // An empty list is never authoritative. It can come from a still-warming index, a cancelled
    // cross-file walk, or a swallowed error, and the client caches a complete empty list for the
    // whole suggest session (typing then only refilters the cached nothing). Incomplete makes the
    // client re-request on the next keystroke, so a transient empty heals itself.
    let isIncomplete = completions.length === 0;
    if (completions.length > COMPLETION_ITEM_CAP) {
        const prefix = wordPrefix.toLowerCase();
        const filtered = prefix
            ? completions.filter((completion) =>
                  (typeof completion === 'string' ? completion : completion.label).toLowerCase().includes(prefix)
              )
            : completions;
        completions = filtered.slice(0, COMPLETION_ITEM_CAP);
        // The served set depends on the typed prefix, so the client must re-request as it changes.
        isIncomplete = true;
    }
    const items = completions.map<CompletionItem>((completion) => toCompletionItem(completion, hasSnippetCapability));
    if (hasCompletionDocResolveCapability) deferCompletionDocumentation(items);
    return { isIncomplete, items };
};

connection.onCompletion(
    async (textDocumentPosition: TextDocumentPositionParams, cancellationToken): Promise<CompletionItem[] | CompletionList> => {
        // `.shader` files get HLSL completion (builtins plus the uniforms/functions/structs the file and
        // its `#include` chain declare), not the OT schema completion below.
        if (isShaderDocument(textDocumentPosition.textDocument.uri)) {
            const document = documents.get(textDocumentPosition.textDocument.uri);
            if (!document) return [];
            const text = document.getText();
            const offset = document.offsetAt(textDocumentPosition.position);
            // Inside an `#include "…"` string, complete the include path from the file system.
            const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
            const includeMatch = /^\s*#\s*include\s+"([^"]*)$/.exec(text.slice(lineStart, offset));
            if (includeMatch) {
                return shaderIncludePathCompletions(
                    includeMatch[1],
                    uriToFsPath(textDocumentPosition.textDocument.uri),
                    CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath
                ).catch(() => []);
            }
            // Widen completion to the include chain so a custom base shader's symbols resolve too.
            const includeText = await collectIncludeText(
                text,
                uriToFsPath(textDocumentPosition.textDocument.uri),
                undefined,
                openBufferReadOverride()
            ).catch(() => '');
            return shaderCompletions(text, offset, includeText);
        }
        const parserResult = ensureParserResult(textDocumentPosition.textDocument.uri);
        let completions: Completion[] = [];
        try {
            // Incomplete for the same reason as the empty case in finishCompletionList: the document
            // may simply not be parsed yet, and the client must ask again rather than cache nothing.
            if (!parserResult) return { isIncomplete: true, items: [] };
            await ensureFragmentRooting(cancellationToken);
            // Offset-based completion, shared by the no-leaf branch below and the bare-identifier
            // fallback: at an empty `Key = ` value position offer that field's legal values, else
            // offer the enclosing group's not-yet-present schema field names.
            const offsetBasedCompletions = async (): Promise<Completion[]> => {
                const document = documents.get(textDocumentPosition.textDocument.uri);
                if (!document) return [];
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
                        : await schemaValueCompletionsAtOffset(parserResult, offset, linePrefix, cancellationToken);
                if (valueCompletions === undefined) {
                    // Not a `Key = ` value position → offer field names instead.
                    return schemaFieldNameCompletions(parserResult, offset, cancellationToken);
                }
                if (valueCompletions.length > 0) return valueCompletions;
                // A value position with no sync values: maybe a cross-file `ID<X>` field. Offer the
                // project's ids of the target class (e.g. `ResourceType = ` → resource ids).
                const target = crossFileReferenceTargetAtOffset(parserResult, offset, linePrefix);
                if (target) {
                    return (
                        (await componentIdCompletionsForTarget(target, parserResult, cancellationToken).catch(
                            () => undefined
                        )) ??
                        (await SchemaIdIndex.instance
                            .idCompletionsForClass(target, await searchFolderUris(), cancellationToken)
                            .catch(() => []))
                    );
                }
                if (isLocalizationKeyFieldAtOffset(parserResult, offset, linePrefix)) {
                    // A `KeyString` field (`NameKey = `) → the project's strings keys.
                    return LocalizationKeyIndex.instance
                        .allKeyCompletions(await searchFolderUris(), cancellationToken)
                        .catch(() => []);
                }
                return [];
            };
            const node = findNodeAtPosition(parserResult, textDocumentPosition?.position);
            if (node) {
                // The cursor offset lets the reference completer complete the path segment at the
                // cursor rather than the whole written value, so editing a middle segment of a long
                // reference path offers that segment's members instead of a stale suggestion.
                const cursorOffset = documents.get(textDocumentPosition.textDocument.uri)?.offsetAt(textDocumentPosition.position);
                completions = await AutoCompletionService.instance
                    .getCompletions(node, cancellationToken, cursorOffset)
                    .catch(() => []);
                // A part-component target (a router's `Routes [ [A, B, 0] ]` tuple slot): the ids are
                // part-local, so the part-wide component union serves them, not the cross-file index.
                // Tried first, because the index would otherwise answer with just the engine builtins.
                if (completions.length === 0) {
                    const ref = schemaReferenceFieldOf(node);
                    if (ref) {
                        completions =
                            (await componentIdCompletionsForTarget(ref.targetClass, parserResult, cancellationToken).catch(
                                () => undefined
                            )) ?? [];
                    }
                }
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
                // A partially typed field name on its own line (`Ig`) parses as a bare Identifier
                // member, which no node completer serves, so typing a field name went dark the
                // moment its first character landed (the offset path only fires when no leaf is
                // under the cursor). Route such identifiers to the same offset-based completion an
                // empty insertion point gets. The client filters by the typed prefix.
                if (
                    completions.length === 0 &&
                    isBareFieldNameIdentifier(node) &&
                    !isModRules(textDocumentPosition.textDocument.uri)
                ) {
                    completions = await offsetBasedCompletions();
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
                // Empty insertion point in a normal `.rules` (no AST leaf under the cursor).
                completions = await offsetBasedCompletions();
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
                    // names, a same-file symbol set, no project index needed.
                    const channels = particleChannelCompletionsAtOffset(parserResult, offset, linePrefix);
                    if (channels && channels.length > 0) {
                        completions = channels;
                    } else {
                        const enclosingGroup = findEnclosingGroup(parserResult, offset);
                        const enclosingList = findEnclosingList(parserResult, offset);
                        const target =
                            (enclosingGroup ? mapKeyTargetOf(enclosingGroup) : undefined) ??
                            (enclosingList ? listElementReferenceTarget(enclosingList, offset) : undefined) ??
                            crossFileReferenceTargetAtOffset(parserResult, offset, linePrefix);
                        if (target) {
                            completions =
                                (await componentIdCompletionsForTarget(target, parserResult, cancellationToken).catch(
                                    () => undefined
                                )) ??
                                (await SchemaIdIndex.instance
                                    .idCompletionsForClass(target, await searchFolderUris(), cancellationToken)
                                    .catch(() => []));
                        }
                    }
                }
            }
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        }
        const document = documents.get(textDocumentPosition.textDocument.uri);
        const linePrefix = document
            ? document.getText({
                  start: { line: textDocumentPosition.position.line, character: 0 },
                  end: textDocumentPosition.position,
              })
            : '';
        // `/` stays in the prefix: localization keys and reference paths are slash-segmented, and
        // narrowing an over-cap list on just the last segment leaves it over-cap.
        const wordPrefix = /[A-Za-z0-9_./-]*$/.exec(linePrefix)?.[0] ?? '';
        return finishCompletionList(completions, wordPrefix);
    }
);

// Reattach the documentation deferred out of the completion response for the item the client is
// about to show. An item without deferred documentation resolves to itself.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    const data = item.data as { docRequest?: number; docIndex?: number } | undefined;
    if (data?.docRequest !== undefined && data.docIndex !== undefined) {
        const documentation = completionDocStores.get(data.docRequest)?.[data.docIndex];
        if (documentation !== undefined) {
            item.documentation = { kind: MarkupKind.Markdown, value: documentation };
        }
    }
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
// (Ctrl-click) without placing the cursor first. Ranges are computed from the cached AST here. Each
// link's target is resolved lazily in onDocumentLinkResolve, so an unopened link costs nothing.
connection.onDocumentLinks((params, cancellationToken) => {
    // `.shader` files have no `.rules` references. Their `#include` navigation is handled by definition.
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

// Resolve a single link's target on demand, using the same resolution go-to-definition performs.
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
// to them live in the game install, outside the open mod folder. Without this, find-all-
// references on a vanilla symbol finds only its declaration.
async function searchFolderUris(): Promise<string[]> {
    const folders = await getWorkspaceFoldersCached();
    const uris = (folders ?? []).map((folder) => folder.uri);
    // Use the actually-initialized Data root (reliable), not globalSettings.cosmoteerPath
    // (which a config-change event can transiently blank). This is where the vanilla files
    // and the references between them live. The referencing files need not be open.
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (dataRoot) uris.push(dataRoot);
    return uris;
}

/**
 * Times one startup index build into a `startup.*` counter. Unlike the scan's `timedPass`, these
 * always record: startup happens once per session, so the counters cost nothing and are the only
 * attribution of where a cold start goes (see server/test/perf/startup-bench.mjs).
 *
 * @param counter the counter to add the elapsed milliseconds to.
 * @param run the build to time.
 * @returns whatever `run` returns.
 */
const timedStartupPhase = async <T>(counter: string, run: () => Promise<T> | T): Promise<T> => {
    const started = Date.now();
    try {
        return await run();
    } finally {
        perfCount(counter, Date.now() - started);
    }
};

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
    // Only the rooting sources feed the schema-context memos: the forward alias walk, the
    // reverse-include index, and the mod-action rooting index. Snapshot their revisions so the
    // epoch below is only bumped when one of them actually moved. The whole-workspace scan calls
    // this once per file, and bumping unconditionally invalidated every memo on shared base nodes
    // several thousand times per scan.
    const rootingRevisionBefore =
        aliasRootIndex.revision + ReverseIncludeIndex.instance.revision + ActionRootingIndex.instance.revision;
    // The action indexes feed the resolver's `^/N`/injected-member extensions. When an edit to a
    // manifest or action fragment changes what they hold, references that resolved through them are
    // stale in the navigation memo (they never read the edited file, so the per-file memo drop misses
    // them). Snapshot their revisions and clear the memo below if a reconcile moved either.
    const actionRevisionBefore = AddBaseIndex.instance.revision + MemberInjectionIndex.instance.revision;
    await timedStartupPhase('startup.aliasRootMs', () => ensureAliasRootIndex(cancellationToken)).catch(
        () => undefined
    );
    const folders = await searchFolderUris();
    await timedStartupPhase('startup.buildTogetherMs', () =>
        WatchedDocumentIndex.buildTogether(
            [
                ReverseIncludeIndex.instance,
                SchemaIdIndex.instance,
                TemplateBaseIndex.instance,
                LocalizationKeyIndex.instance,
            ],
            folders,
            'Indexing project'
        )
    ).catch(() => undefined);
    await timedStartupPhase('startup.reverseIncludeMs', () =>
        ReverseIncludeIndex.instance.ensureBuilt(folders, cancellationToken)
    ).catch(() => undefined);
    // The AddBase index feeds the resolver's `^/N`-into-added-base extension, the Overrides index the
    // nested-Overrides member extension (both mod folders only, since the game Data tree carries no
    // mod actions). They share one walk of the mod tree instead of parsing all of it once each, which
    // is most of what a warm start used to spend.
    //
    // Sharing does move what each sees of the other: both resolve their action targets through the
    // reference resolver, which reads both extension sources, so during the shared walk each sees the
    // other populated only up to the current file rather than empty (AddBase, which used to run first)
    // or complete (Overrides, which used to run second). Only the Overrides direction can lose:
    // a target path stepping through `^/N` into a base that an AddBase in a later-walked file appends.
    // No such target is known to exist. Splitting the walk again is the fix if one ever shows up.
    //
    // ActionRootingIndex is deliberately not in this group, though it walks the same folders and
    // folding it in is tempting (it is the single biggest remaining startup phase). It resolves its
    // targets against a half-built AddBase/Overrides extension when it shares the walk, and the
    // damage is silent: a bogus `&/INDICATORS/DefinitelyNotReal` stops being flagged, because its
    // alias fallback answers from state the walk had not finished. A whole-mod scan is blind to this
    // class of damage and reports no difference. Only the end-to-end mod-driver's negative control
    // catches it, so measure with the mod-driver, not the scan, before touching this ordering again.
    //
    // They stay out of the cacheable group above on purpose: their state holds live AST nodes, which
    // no saved state can rehydrate, and a cacheId-less member in that group would disable the project
    // cache for all four. The ensureBuilt calls that follow find the build already done and only
    // reconcile dirty files, mirroring the reverse-include pattern above.
    await timedStartupPhase('startup.modActionWalkMs', () =>
        WatchedDocumentIndex.buildTogether(
            [AddBaseIndex.instance, MemberInjectionIndex.instance],
            modFolderPaths(folders),
            'Indexing mod actions'
        )
    ).catch(() => undefined);
    await timedStartupPhase('startup.addBaseMs', () =>
        AddBaseIndex.instance.ensureBuilt(folders, cancellationToken)
    ).catch(() => undefined);
    await timedStartupPhase('startup.memberInjectionMs', () =>
        MemberInjectionIndex.instance.ensureBuilt(folders, cancellationToken)
    ).catch(() => undefined);
    // The action-rooting index types action-wired fragments and inline action values from their
    // target slots. Built after the rooting indexes above, since the target slot types resolve
    // through them (mod folders only), and on its own walk. See the note above for what breaks
    // when it joins the shared one.
    await timedStartupPhase('startup.actionRootingMs', () =>
        ActionRootingIndex.instance.ensureBuilt(folders, cancellationToken)
    ).catch(() => undefined);
    // The action-rooting build re-roots fragments whose own includes then contribute new
    // reverse-include records (it marks those fragments dirty). Reconcile them here, repeating
    // while the reconcile still uncovers deeper chains, so the rooting revisions settle within
    // this call. Left to the next call, the late revision move would invalidate the scan-result
    // cache one pass after it was seeded and force a needless whole-workspace re-validation.
    for (let round = 0; round < 4; round++) {
        const reverseRevisionBefore = ReverseIncludeIndex.instance.revision;
        await ReverseIncludeIndex.instance.ensureBuilt(folders, cancellationToken).catch(() => undefined);
        if (ReverseIncludeIndex.instance.revision === reverseRevisionBefore) break;
    }
    // The builds above may have (re)rooted fragments, which changes what the per-node schema
    // resolution memos would answer, so start a fresh memo epoch for the features that follow.
    if (
        aliasRootIndex.revision + ReverseIncludeIndex.instance.revision + ActionRootingIndex.instance.revision !==
        rootingRevisionBefore
    ) {
        invalidateSchemaContextCache();
    }
    // A reconcile that changed an action index (a manifest/fragment edit added or removed an
    // AddBase/Overrides/Add) invalidates every `^/N`/injected-member resolution the memo cached.
    if (AddBaseIndex.instance.revision + MemberInjectionIndex.instance.revision !== actionRevisionBefore) {
        clearNavigationMemo();
    }
}

// Disk changes the editor doesn't surface as edits (git pull/checkout, external tools,
// create/delete): keep the cached symbol table in step. Deletions drop immediately.
// Created/externally-changed files are re-read from disk at the next workspace-symbol query.
connection.onDidChangeWatchedFiles(async (params) => {
    const openNorms = wholeWorkspaceEnabled() ? openDocumentNorms() : undefined;
    const rulesChanges = params.changes.filter((change) => isRulesFileName(basenameOf(change.uri)));
    const assetChanges = params.changes.filter((change) => !isRulesFileName(basenameOf(change.uri)));
    // Asset (sprite/sound/shader) changes only affect the fs-derived caches: dropping the path
    // entry also fires the invalidation listeners that clear the asset and navigation memos, so
    // a created or deleted asset stops being answered from a stale memo. They must not dirty the
    // `.rules` indexes, which would try to re-parse a binary file as rules on the next reconcile.
    for (const change of assetChanges) {
        invalidateFsPath(uriToFsPath(change.uri));
    }
    if (rulesChanges.length > 0) {
        // Disk changes can re-root fragments and shift schema anchoring for unchanged open ASTs.
        invalidateSchemaContextCache();
        // They can also grow or shrink the manifest's reachability closure.
        validationScopeEpoch++;
    }
    // A cosmoteer.rules add/change/delete can alter how fragments are rooted. Rebuild lazily.
    if (rulesChanges.some((c) => basenameOf(c.uri).toLowerCase() === 'cosmoteer.rules')) {
        aliasRootIndex.invalidate();
    }
    // A created or deleted manifest moves mod-root boundaries, so the per-directory root memo
    // (negatives included) and the mod contexts built on top of it are stale.
    if (rulesChanges.some((c) => c.type !== FileChangeType.Changed && isManifestBasename(basenameOf(c.uri)))) {
        clearModRootCache();
        invalidateModContext();
    }
    const toRevalidate: string[] = [];
    for (const change of rulesChanges) {
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
            AddBaseIndex.instance.remove(change.uri);
            MemberInjectionIndex.instance.remove(change.uri);
            ActionRootingIndex.instance.remove(change.uri);
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
            AddBaseIndex.instance.markDirty(change.uri);
            MemberInjectionIndex.instance.markDirty(change.uri);
            ActionRootingIndex.instance.markDirty(change.uri);
            if (openNorms) toRevalidate.push(uriToFsPath(change.uri));
        }
    }
    // Open documents may show diagnostics and inlay values that were derived from the changed
    // files (an inherited base, a strings file, a referenced asset), so their version-keyed
    // caches are stale even though their own versions are unchanged. Drop them and ask a
    // pull-capable client to re-pull, which recomputes against the new disk state. Cached scan
    // results of unchanged files can derive from the changed ones the same way.
    if (params.changes.length > 0) {
        diagnosticsCache.clear();
        inlayHintCache.clear();
        invalidateComponentIdCache();
        invalidateLooseDeclarationCache();
        bumpWorkspaceScanEpoch();
        if (hasPullDiagnosticsCapability) connection.languages.diagnostics.refresh();
    }
    // Re-validate created/externally-changed files so their diagnostics stay current (files open
    // in the editor are skipped, the live-edit flow already covers those). A git-pull-sized burst
    // arrives as one notification with many changes, so the files run through the same bounded
    // worker pool as the whole-workspace pass instead of strictly one after another.
    if (openNorms && toRevalidate.length > 0) {
        // Only files inside the validation scope get their problems published. An out-of-scope
        // file (a dead backup a git operation touched, say) must not enter the panel, and any
        // entry it still holds from an earlier closure is cleared instead.
        const scopeKeys = await validationScopeKeys(CancellationToken.None);
        const inScope: string[] = [];
        for (const file of toRevalidate) {
            if (!scopeKeys || scopeKeys.has(reachabilityKey(file))) {
                inScope.push(file);
                continue;
            }
            const staleNorm = normalizeUri(filePathToUri(file));
            for (const stored of [...workspaceDiagnosticUris]) {
                if (normalizeUri(stored) !== staleNorm) continue;
                workspaceDiagnosticUris.delete(stored);
                await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
            }
        }
        let next = 0;
        const worker = async (): Promise<void> => {
            while (next < inScope.length) {
                await validateWorkspaceFile(inScope[next++], openNorms, CancellationToken.None);
            }
        };
        await Promise.all(Array.from({ length: Math.min(WORKSPACE_DIAGNOSTIC_CONCURRENCY, inScope.length) }, worker));
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
        // Scoped to the open project (the mod), not the whole game tree. A project-wide
        // symbol table over all of Cosmoteer would be huge, and "go to symbol in workspace" is
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
        // install. Strip any edits under the Data root so we only touch the open mod. A developer
        // working on the game data can opt into editing vanilla via the setting.
        if (!edit || globalSettings.rename?.allowEditingVanillaFiles) return edit;
        return dropEditsUnderRoot(edit, CosmoteerWorkspaceService.instance.dataRootPath);
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

/**
 * The deletion range for a remove quick fix: the byte-offset span widened to whole lines when the
 * span (plus surrounding whitespace and a trailing `,`/`;`) is all its lines contain, so removing a
 * field takes its line with it instead of leaving a blank one. When other content shares a line, the
 * exact span (plus a trailing separator) is deleted instead.
 *
 * @param doc the open text document the diagnostic belongs to.
 * @param start the span's inclusive start byte offset.
 * @param end the span's exclusive end byte offset.
 * @returns the range to replace with the empty string.
 */
const removalRange = (doc: TextDocument, start: number, end: number): Range => {
    const text = doc.getText();
    let s = start;
    let e = end;
    // Swallow a trailing separator and the spaces around it, so `X = 1, Y = 2` minus X leaves `Y = 2`.
    while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
    if (text[e] === ',' || text[e] === ';') e++;
    while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
    const atLineStart = s === 0 || text[s - 1] === '\n';
    const restOfLine = text.slice(e, text.indexOf('\n', e) === -1 ? text.length : text.indexOf('\n', e));
    if (atLineStart && /^\s*$/.test(restOfLine)) {
        const nextLine = text.indexOf('\n', e);
        e = nextLine === -1 ? text.length : nextLine + 1;
    }
    return { start: doc.positionAt(s), end: doc.positionAt(e) };
};

// Code actions: surface the quick fixes carried on diagnostics' `data`, the "did you mean …"
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
        if (data?.remove) {
            const doc = documents.get(params.textDocument.uri);
            if (doc) {
                const range = removalRange(doc, data.remove.start, data.remove.end);
                actions.push({
                    title: data.remove.title,
                    kind: CodeActionKind.QuickFix,
                    diagnostics: [diagnostic],
                    isPreferred: true,
                    edit: { changes: { [params.textDocument.uri]: [{ range, newText: '' }] } },
                });
            }
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

// Hover: show what a value resolves to, its computed number and/or reference target.
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

// The "Open in decompiler" hover link (see decompiler-link.ts). Both clients route it here as a
// plain workspace/executeCommand, and the server finds and spawns the user's decompiler locally.
connection.onExecuteCommand(async (params) => {
    if (params.command !== OPEN_IN_DECOMPILER_COMMAND) return;
    await openInDecompiler((params.arguments?.[0] ?? {}) as OpenInDecompilerArgs, connection).catch((e) => {
        if (globalSettings.trace.server === 'messages') console.error(e);
    });
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

// Part grid editor: build the payload (effective size, sprites, per-cell field layers, rotation
// fields) for the part at a position, consumed by the client's interactive grid editor webview.
connection.onRequest('cosmoteer/partGridData', async (params: TextDocumentPositionParams, cancellationToken) => {
    const parserResult = ensureParserResult(params.textDocument.uri);
    const document = documents.get(params.textDocument.uri);
    if (!parserResult || !document) return null;
    try {
        // Root a standalone fragment first so the part group's schema class (and its components')
        // resolves even when the part file is only reachable through an `&<includes>` field.
        await ensureFragmentRooting(cancellationToken);
        return await buildPartGridData(
            parserResult,
            document.offsetAt(params.position),
            document.version,
            cancellationToken
        );
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Part grid editor write-back: turn one webview mutation into a minimal WorkspaceEdit. The client
// applies the edit (keeping undo native) and the resulting change event re-renders the webview. A
// version mismatch means the click was aimed at stale geometry, so it is refused and the client
// resyncs instead.
connection.onRequest('cosmoteer/partGridEdit', async (params: PartGridEditParams, cancellationToken) => {
    const parserResult = ensureParserResult(params.textDocument.uri);
    const document = documents.get(params.textDocument.uri);
    if (!parserResult || !document) return { status: 'notFound' };
    if (params.dataVersion !== document.version) return { status: 'stale' };
    try {
        await ensureFragmentRooting(cancellationToken);
        return await buildPartGridEdit(
            parserResult,
            document.getText(),
            params.textDocument.uri,
            document.offsetAt(params.anchor),
            params.mutation,
            cancellationToken
        );
    } catch (e) {
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return { status: 'error' };
    }
});

// Mod overview: render the "what does this mod.rules do" markdown report, the manifest header,
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
// Computed once per document version over the whole document and cached. Each request (the client
// re-asks on every scroll) filters the cached hints down to its visible range.
const inlayHintCache: Map<
    string,
    { version: number; promise: Promise<InlayHint[]>; source: CancellationTokenSource }
> = new Map();

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
        if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        return null;
    }
});

// Semantic tokens: colour the parsed document by meaning the TextMate grammar can't infer (a `&…`
// reference vs a bareword enum vs a math function). The grammar stays the synchronous base layer;
// this is the overlay. Drives both VS Code and the native IntelliJ LSP highlighter.
// The token walk is pure CPU over the cached AST, so its result is cached per document version and
// repeated requests for unchanged text answer from memory. Each result carries a `resultId` so a
// delta-capable client can request just the changed slice of the array after an edit instead of
// the whole thing, and a range request serves the viewport from the same cached array.
const semanticTokensCache: Map<string, { version: number; resultId: string; data: number[] }> = new Map();

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