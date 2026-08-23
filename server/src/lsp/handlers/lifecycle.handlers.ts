import * as l10n from '@vscode/l10n';
import {
    CancellationToken,
    CodeActionKind,
    DidChangeConfigurationNotification,
    DidChangeWatchedFilesNotification,
    InitializeParams,
    InitializeResult,
    PositionEncodingKind,
    TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { Validator } from '../../features/diagnostics/validator';
import { ValidationForIdentifier, ValidationForValue } from '../../features/diagnostics/validator.value';
import { ValidationForFunctionCall } from '../../features/diagnostics/validator.functioncall';
import { ValidationForAssignment } from '../../features/diagnostics/validator.assignment';
import { ValidationForMath } from '../../features/diagnostics/validator.math';
import { ValidationForGroupDuplicates } from '../../features/diagnostics/validator.duplicate-key';
import { OPEN_IN_DECOMPILER_COMMAND } from '../../features/hover/decompiler-link';
import { MIGRATE_WORKSPACE_COMMAND } from '../../features/migration/migrate-workspace';
import { MIGRATE_SYMBOL_COMMAND } from '../../features/migration/migrate-symbol';
import { POST_UPDATE_REPORT_COMMAND } from '../../features/post-update/post-update-report';
import { BUILD_MOD_SCHEMA_COMMAND } from '../../features/mod-schema/mod-schema';
import { EXTRACT_SHARED_BASE_COMMAND } from '../../features/refactor/shared-base/shared-base.command';
import { clearSharedBaseScanCache } from '../../features/refactor/shared-base/mod-scan';
import { EXTRACT_LOCALIZATION_KEY_COMMAND } from '../../features/refactor/extract-localization-key';
import { REGISTER_PART_IN_SHIP_COMMAND } from '../../features/refactor/register-part/register-part.command';
import { OVERRIDE_IN_MOD_COMMAND } from '../../features/refactor/override-in-mod/override-in-mod.command';
import { CLONE_DECLARATION_COMMAND } from '../../features/refactor/clone-declaration/clone.command';
import { NEW_CONTENT_COMMAND } from '../../features/refactor/new-content/new-content.command';
import { INSERT_SCHEMA_FIELD_COMMAND } from '../../features/schema-search/schema-search.insert';
import { RUN_IN_COSMOTEER_COMMAND } from '../../features/run-game/run-game.command';
import { IMPORT_GAME_LOG_COMMAND } from '../../features/game-log/import-game-log.command';
import { semanticTokensLegend } from '../../features/semantic/legend';
import { WorkspaceSymbolService } from '../../features/navigation/workspace-symbol.service';
import { SchemaIdIndex } from '../../features/completion/schema-id.index';
import { TemplateBaseIndex } from '../../features/diagnostics/template-base.index';
import { LocalizationKeyIndex } from '../../features/completion/localization-key.index';
import { ReverseIncludeIndex } from '../../features/navigation/reverse-include.index';
import { MentionIndex } from '../../features/navigation/mention.index';
import { AddBaseIndex } from '../../mod/add-base.index';
import { MemberInjectionIndex } from '../../mod/member-injection.index';
import { ActionRootingIndex } from '../../mod/action-rooting.index';
import { invalidateShipLayers } from '../../features/ships/ship-layer.index';
import { invalidateModContext } from '../../mod/mod-context';
import { invalidateSchemaContextCache } from '../../document/schema/schema-context';
import { invalidateComponentIdCache } from '../../features/diagnostics/validator.schema-sibling';
import { invalidateEffectiveChainCache } from '../../semantics/effective-group';
import { invalidateLooseDeclarationCache } from '../../features/diagnostics/validator.schema-id-reference';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { clearFsCaches } from '../../workspace/fs-cache';
import { beginStatSweepWindow, endStatSweepWindow } from '../../workspace/index-cache';
import { extendSchemaWithMods } from '../../document/schema/schema';
import { CosmoteerSettings, globalSettings, setGlobalSettings } from '../../settings';
import { perfCount } from '../../utils/perf-counters';
import {
    hasConfigurationCapability,
    hasDidChangeWatchedFilesCapability,
    hasPullDiagnosticsCapability,
    hasWorkspaceFolderCapability,
    readClientCapabilities,
} from '../capabilities';
import { connection, documents } from '../context';
import { diagnosticsCache, inlayHintCache } from '../document-caches';
import { clearDocumentSettings } from '../document-settings';
import { ensureFragmentRooting, markWorkspaceReady, timedStartupPhase } from '../fragment-rooting';
import {
    applyModSchemaChange,
    codeModAutoRefreshEnabled,
    codeModsEnabled,
    disarmModAssemblyWatch,
    loadModSchema,
} from '../mod-schema';
import { schedulePushValidation } from '../push-diagnostics';
import { noteScanSettingsChange } from '../scan-epoch';
import {
    bumpValidationScopeEpoch,
    wholeWorkspaceEnabled,
    workspaceValidationScope,
} from '../validation-scope';
import {
    getWorkspaceFoldersCached,
    invalidateWorkspaceFoldersCache,
    searchFolderUris,
} from '../workspace-folders';
import { clearWorkspaceDiagnostics, runWorkspaceValidation } from '../workspace-scan';

/**
 * Registers the three lifecycle handlers: the capability handshake, the startup that scans the game
 * tree and warms the project indexes, and the configuration change that decides what has to be
 * recomputed under the new settings.
 */
export function register(): void {
    connection.onInitialize(async (params: InitializeParams) => {
        readClientCapabilities(params.capabilities);
        const result: InitializeResult = {
            capabilities: {
                // Every position the server hands out is a UTF-16 offset (`TextDocument.positionAt` and
                // plain JS string indices throughout). That is also the protocol's default, so this only
                // states it out loud for a client that reads the field.
                positionEncoding: PositionEncodingKind.UTF16,
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
                    // directives. ':' pops inheritance-base completion after `Child :`. The rest are
                    // `.rules` reference sigils.
                    triggerCharacters: ['<', '&', '/', '^', '~', '=', '.', '"', '#', ':'],
                },
                diagnosticProvider: {
                    interFileDependencies: true,
                    workspaceDiagnostics: false,
                },
                definitionProvider: true,
                documentHighlightProvider: true,
                documentLinkProvider: {
                    resolveProvider: true,
                },
                documentSymbolProvider: true,
                foldingRangeProvider: true,
                selectionRangeProvider: true,
                // The inheritance graph of a `Foo : Bar` container, one level per request. Declared as a
                // plain boolean: both clients register the feature from the capability alone.
                typeHierarchyProvider: true,
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
                    codeActionKinds: [
                        CodeActionKind.QuickFix,
                        CodeActionKind.RefactorExtract,
                        CodeActionKind.RefactorInline,
                    ],
                },
                // The "Open in decompiler" hover link executes on the server (it spawns the user's
                // ILSpy/dotPeek locally), so VS Code and the JetBrains plugin share one implementation.
                // The workspace migration also runs server-side for the same reason: one implementation
                // computes the WorkspaceEdit, both clients only trigger it and show the summary.
                executeCommandProvider: {
                    commands: [
                        OPEN_IN_DECOMPILER_COMMAND,
                        MIGRATE_WORKSPACE_COMMAND,
                        MIGRATE_SYMBOL_COMMAND,
                        BUILD_MOD_SCHEMA_COMMAND,
                        EXTRACT_SHARED_BASE_COMMAND,
                        EXTRACT_LOCALIZATION_KEY_COMMAND,
                        REGISTER_PART_IN_SHIP_COMMAND,
                        OVERRIDE_IN_MOD_COMMAND,
                        CLONE_DECLARATION_COMMAND,
                        INSERT_SCHEMA_FIELD_COMMAND,
                        RUN_IN_COSMOTEER_COMMAND,
                        IMPORT_GAME_LOG_COMMAND,
                        POST_UPDATE_REPORT_COMMAND,
                        NEW_CONTENT_COMMAND,
                    ],
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
            setGlobalSettings(
                await connection.workspace.getConfiguration({
                    scopeUri: workspaceFolders[0].uri,
                    section: 'cosmoteerLSPRules',
                })
            );
            const settings = globalSettings;
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
                                'The Cosmoteer path is not set, so every check that reads the game data is off: component references, cross-file ids, localization keys, duplicate ids, unreceivable buffs and included action fragments. Set the path in the Cosmoteer Rules settings. If the setting is not shown yet, restart the editor.'
                            ),
                            {
                                title: l10n.t('Open Settings'),
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
        // Merge the schema surface of any code mod before anything validates. A code mod's `.dll`
        // declares types and `Type=` discriminators the shipped schema has never seen, and its `.rules`
        // files name them, so validating before this lands reports them as unknown. The cached
        // extraction makes the common case a file read, and the walk that decides whether the cache
        // still applies is a fraction of a second over the whole installed workshop tree.
        await timedStartupPhase('startup.modSchemaMs', () => loadModSchema()).catch((e) => {
            if (globalSettings.trace.server === 'messages') console.error(e);
        });

        // The game-tree scan (or the decision that there is none) is settled. Index builds that were
        // waiting on it may now resolve the folder set, with the Data root included when it exists.
        markWorkspaceReady();

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
            // A code mod's assembly (and the XML doc file beside it) is watched too: rebuilding a mod
            // the user has open changes the types the schema must know about, and until they are
            // re-extracted every `Type=` the new build added reads as an unknown discriminator.
            connection.client.register(DidChangeWatchedFilesNotification.type, {
                watchers: [
                    { globPattern: '**/*.{rules,txt}' },
                    { globPattern: '**/*.{png,mp3,wav,ogg,shader}' },
                    { globPattern: '**/*.{dll,xml}' },
                ],
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
                invalidateWorkspaceFoldersCache();
                bumpValidationScopeEpoch();
                WorkspaceSymbolService.instance.reset();
                SchemaIdIndex.instance.reset();
                invalidateShipLayers();
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
        invalidateEffectiveChainCache();
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

        // On by default: validate every file in the workspace, not just the open ones.
        await runWorkspaceValidation();
    });

    connection.onDidChangeConfiguration(async (change) => {
        if (hasConfigurationCapability) {
            clearDocumentSettings();
        }
        const wasWholeWorkspace = wholeWorkspaceEnabled();
        const previousScope = workspaceValidationScope();
        const previousCosmoteerPath = globalSettings.cosmoteerPath;
        const wasCodeModsEnabled = codeModsEnabled();
        const wasCodeModAutoRefresh = codeModAutoRefreshEnabled();

        const workspaceFolders = await getWorkspaceFoldersCached();
        // With the pull model (the client advertises `workspace/configuration`), the change
        // notification carries no payload (`change.settings` is null), so we must re-pull the
        // settings here. Only fall back to the pushed payload when the client uses the push model.
        // (Without this, toggling a setting like `diagnostics.validateWholeWorkspace` did nothing,
        // because `globalSettings` was never refreshed.)
        let answer: unknown;
        if (hasConfigurationCapability) {
            answer = await connection.workspace.getConfiguration({
                scopeUri: workspaceFolders?.[0]?.uri,
                section: 'cosmoteerLSPRules',
            });
        } else if (change.settings?.cosmoteerLSPRules) {
            answer = change.settings.cosmoteerLSPRules;
        }
        let settings: CosmoteerSettings | undefined;
        if (answer !== undefined && answer !== null) {
            setGlobalSettings(answer);
            settings = globalSettings;
        }

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
        invalidateEffectiveChainCache();
        invalidateLooseDeclarationCache();
        // The shared-base memo holds a mod-wide set filtered by the validation scope, so a scope change
        // would otherwise keep serving a set built under the other filter until a file changes on disk.
        clearSharedBaseScanCache();
        noteScanSettingsChange();
        connection.languages.diagnostics.refresh();

        // React to the code-mod switches. Turning the feature off has to unmerge what is already in the
        // schema (the types stay live otherwise), turning it on has to run the merge the startup load
        // skipped, and the auto-refresh switch only decides whether the watch is armed.
        if (codeModsEnabled() !== wasCodeModsEnabled) {
            if (codeModsEnabled()) {
                await loadModSchema().catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                });
            } else {
                disarmModAssemblyWatch();
                extendSchemaWithMods(undefined);
            }
            applyModSchemaChange();
        } else if (codeModAutoRefreshEnabled() !== wasCodeModAutoRefresh) {
            if (codeModAutoRefreshEnabled()) {
                // Arming needs the assembly list, and a mod may well have changed while the watch was
                // off, so this goes through the normal build.
                await loadModSchema().catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                });
            } else {
                disarmModAssemblyWatch();
            }
        }

        // React to the whole-workspace diagnostics toggle (and to a Cosmoteer-path or scope change while
        // it's on, since those change how every reference resolves / which files are covered). A scope
        // change clears first, so diagnostics published for now-out-of-scope files don't linger.
        const nowWholeWorkspace = wholeWorkspaceEnabled();
        const nowScope = workspaceValidationScope();
        const scopeChanged = nowScope !== previousScope;
        if (nowWholeWorkspace && (!wasWholeWorkspace || cosmoteerPathChanged || scopeChanged)) {
            if (scopeChanged && wasWholeWorkspace) await clearWorkspaceDiagnostics();
            await runWorkspaceValidation();
        } else if (!nowWholeWorkspace && wasWholeWorkspace) {
            await clearWorkspaceDiagnostics();
        }
    });
}
