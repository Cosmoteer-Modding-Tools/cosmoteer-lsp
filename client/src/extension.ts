import * as path from 'path';
import {
    workspace,
    ExtensionContext,
    l10n,
    commands,
    languages,
    window,
    Position,
    Uri,
    TextDocument,
    MarkdownString,
    ConfigurationTarget,
    ProgressLocation,
    Diagnostic,
    DiagnosticSeverity,
    Range,
    SnippetString,
} from 'vscode';

import {
    ExecuteCommandRequest,
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';
import { SharedDiagnosticCollectionProvider } from './diagnostic-collection';
import { ShaderPreviewCodeLensProvider } from './shader-preview/codelens';
import { ShaderPreviewPanel } from './shader-preview/preview-panel';
import { PartGridCodeLensProvider } from './part-editor/codelens';
import { PartGridEditorPanel } from './part-editor/editor-panel';
import {
    MOD_OVERVIEW_SCHEME,
    ModOverviewCodeLensProvider,
    ModOverviewContentProvider,
    showModOverview,
} from './mod-overview/mod-overview';
import { POST_UPDATE_REPORT_SCHEME, PostUpdateReportContentProvider, showPostUpdateReport } from './post-update/post-update-report';
import {
    PART_WIRING_SCHEME,
    PartWiringCodeLensProvider,
    PartWiringContentProvider,
    showPartWiring,
} from './part-wiring/part-wiring';
import {
    EFFECTIVE_GROUP_SCHEME,
    EffectiveGroupContentProvider,
    showEffectiveGroup,
} from './effective-group/effective-group';
import {
    REFERENCE_TRACE_SCHEME,
    ReferenceTraceContentProvider,
    showReferenceTrace,
} from './reference-trace/reference-trace';
import { SCHEMA_DOC_SCHEME, SchemaDocContentProvider, showSchemaSearch } from './schema-search/schema-search';
import {
    DIFF_PREVIEW_SCHEME,
    DiffPreviewProvider,
    showDiffPreview,
    showPatchPreview,
    DiffPreviewFile,
} from './preview/diff-preview';
import { ApplyCleanup, openDocumentPaths, saveAndTidy, setPreviewScheme } from './shared-base/apply-cleanup';

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
    // The server is implemented in node
    const serverModule = context.asAbsolutePath(path.join('out', 'server', 'src', 'server.mjs'));

    const bundle = l10n.uri ? { EXTENSION_BUNDLE_PATH: l10n.uri?.fsPath } : undefined;

    const serverOptions: ServerOptions = {
        run: {
            module: serverModule,
            options: {
                env: {
                    ...bundle,
                },
                // A whole-mod check allocates heavily and briefly (one AST per file, dropped again
                // once its diagnostics are out). Node's default young generation is too small for
                // that: it fills hundreds of times, and the objects that survive only because a
                // collection caught them mid-file are promoted into the old generation, where
                // clearing them costs a major collection the user feels as a pause. A larger young
                // generation halves the collections and cuts the longest pause of a scan by more
                // than half, at the price of a bigger resident set while the scan runs. `--expose-gc`
                // lets the server hand that memory back once a check is over rather than sit on it.
                execArgv: ['--max-semi-space-size=64', '--expose-gc'],
            },
            transport: TransportKind.ipc,
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: {
                env: {
                    ...bundle,
                },
            },
        },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'rules' },
            // `.shader` files get semantic-token highlighting (and future shader features) from the
            // same server. The server branches on the URI extension.
            { scheme: 'file', language: 'cosmoteer-shader' },
        ],
        synchronize: {
            // Notify the server about file changes to '.clientrc files contained in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
        },
        progressOnInitialization: true,
        // A code action's edit cannot carry a tab stop, so the server offers a snippet only to a client
        // that says it registers the command that writes one. The protocol has no field for that, which
        // is what this option is for.
        initializationOptions: { snippetCodeActions: true },
        // The server answers open files through the pull model and pushes the whole-mod pass for the
        // rest, so both models write to the Problems panel. One collection for both keeps a file
        // that moves between them from being listed twice.
        diagnosticCollectionProvider: new SharedDiagnosticCollectionProvider(),
        middleware: {
            // Server hovers can end with an "Open in decompiler" command link (opt-in via
            // `decompiler.showInHover`). VS Code only executes command links from trusted
            // markdown, and the protocol has no way to mark it, so trust exactly that one
            // command here on the converted hover.
            provideHover: async (document, position, token, next) => {
                const hover = await next(document, position, token);
                for (const content of hover?.contents ?? []) {
                    if (content instanceof MarkdownString) {
                        content.isTrusted = { enabledCommands: [OPEN_IN_DECOMPILER_COMMAND] };
                    }
                }
                return hover;
            },
        },
    };

    claimShaderFiles(context);

    client = new LanguageClient('cosmoteer lsp', 'Cosmoteer Language Server', serverOptions, clientOptions);

    client.onRequest('cosmoteer/openSettings', async (params) => {
        await commands.executeCommand('workbench.action.openSettings2', params);
    });

    // Whole-mod validation is on by default, which is work the user never asked for. Tell them once,
    // the first time it actually costs something, and offer the switch right there.
    client.onNotification('cosmoteer/workspaceValidated', async (params: WorkspaceValidatedParams) => {
        await showWorkspaceValidationNotice(context, params);
    });

    // Live shader preview: a CodeLens above each `Shader = …` and a command that opens the WebGL
    // preview for the material at a position (the lens passes it, the palette uses the cursor).
    context.subscriptions.push(
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new ShaderPreviewCodeLensProvider()),
        commands.registerCommand('cosmoteer.previewShader', async (uri?: Uri, position?: Position) => {
            const editor = window.activeTextEditor;
            const targetUri = uri ?? editor?.document.uri;
            const targetPosition = position ?? editor?.selection.active;
            if (!targetUri || !targetPosition) return;
            await ShaderPreviewPanel.show(context, client, targetUri, targetPosition);
        })
    );

    // Part grid editor: a CodeLens above each root `Part` group and a command that opens the
    // interactive grid editor for the part at a position (the lens passes it, the palette uses the
    // cursor).
    context.subscriptions.push(
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new PartGridCodeLensProvider()),
        commands.registerCommand('cosmoteer.editPartGrid', async (uri?: Uri, position?: Position) => {
            const editor = window.activeTextEditor;
            const targetUri = uri ?? editor?.document.uri;
            const targetPosition = position ?? editor?.selection.active;
            if (!targetUri || !targetPosition) return;
            await PartGridEditorPanel.show(context, client, targetUri, targetPosition);
        })
    );

    // Mod overview: a CodeLens on a mod manifest and a command that render what the manifest does
    // (its actions with resolution status, and the mod's unreachable files) as a markdown preview.
    const modOverviewProvider = new ModOverviewContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(MOD_OVERVIEW_SCHEME, modOverviewProvider),
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new ModOverviewCodeLensProvider()),
        commands.registerCommand('cosmoteer.showModOverview', async (uri?: Uri) => {
            await showModOverview(client, modOverviewProvider, uri);
        })
    );

    // What the game update changed: the difference between the findings recorded under the previous
    // game version and the ones the project produces now, the compatibility verdict of every
    // manifest, and what the migration would rewrite. A markdown preview like the mod overview.
    const postUpdateProvider = new PostUpdateReportContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(POST_UPDATE_REPORT_SCHEME, postUpdateProvider),
        commands.registerCommand('cosmoteer.showPostUpdateReport', async () => {
            await showPostUpdateReport(client, postUpdateProvider);
        })
    );

    // Part wiring: a CodeLens above each root `Part` group and a command that render what the part
    // still needs before the game can build it (the lens passes the part's line, the palette uses
    // the cursor).
    const partWiringProvider = new PartWiringContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(PART_WIRING_SCHEME, partWiringProvider),
        languages.registerCodeLensProvider({ scheme: 'file', language: 'rules' }, new PartWiringCodeLensProvider()),
        commands.registerCommand('cosmoteer.showPartWiring', async (uri?: Uri, position?: Position) => {
            await showPartWiring(client, partWiringProvider, uri, position);
        })
    );

    // Effective group: one command rendering the member set the game really deserializes for the
    // group under the cursor, with every row's origin in the inheritance chain. No CodeLens: it
    // applies to any group, so a lens per group would bury the file.
    const effectiveGroupProvider = new EffectiveGroupContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(EFFECTIVE_GROUP_SCHEME, effectiveGroupProvider),
        commands.registerCommand('cosmoteer.showEffectiveGroup', async (uri?: Uri, position?: Position) => {
            await showEffectiveGroup(client, effectiveGroupProvider, uri, position);
        })
    );

    // Reference trace: one command that walks the reference under the cursor and says which segment
    // stopped it and what the game really has there. No CodeLens and no hover: a reference is far too
    // common for a lens, and the walk crosses files, so it runs only when it is asked for.
    const referenceTraceProvider = new ReferenceTraceContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(REFERENCE_TRACE_SCHEME, referenceTraceProvider),
        commands.registerCommand('cosmoteer.explainReference', async (uri?: Uri, position?: Position) => {
            await showReferenceTrace(client, referenceTraceProvider, uri, position);
        })
    );

    // Schema search: one command that searches every schema type, field, enum member and Type=
    // registry plus the field documentation, opens a hit's documentation as a markdown preview, and
    // can write a found field straight into the group the cursor is in. The palette id deliberately
    // differs from the server's executeCommand id `cosmoteer.insertSchemaField`, because the language
    // client auto-registers that one as a plain no-feedback forwarder.
    const schemaDocProvider = new SchemaDocContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(SCHEMA_DOC_SCHEME, schemaDocProvider),
        commands.registerCommand('cosmoteer.searchSchema', async () => {
            await showSchemaSearch(client, schemaDocProvider);
        })
    );

    // Creating a piece of content and wiring it into the game are one step, because a file nothing
    // registers is a file the game never loads and the editor never types. The server writes and
    // registers. This wrapper only asks the questions a tool cannot answer for the author.
    context.subscriptions.push(
        commands.registerCommand(NEW_CONTENT_LOCAL_COMMAND, async () => {
            await createNewContent(client);
        })
    );

    // Workspace migration: one command that upgrades every rules file to the current game version
    // (deprecation-registry renames, deletions, and rewrites). The server computes and applies the
    // WorkspaceEdit, so this wrapper only asks about the optional dead-field cleanup and renders
    // the returned summary. A distinct command id from the server's executeCommand id, because the
    // language client auto-registers that one as a plain no-feedback forwarder.
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.migrateMod', async () => {
            const choice = await window.showQuickPick(
                [
                    {
                        label: l10n.t('Preview the migration'),
                        description: l10n.t('Show every change as a diff without writing anything'),
                        removeDeadFields: false,
                        dryRun: true,
                    },
                    {
                        label: l10n.t('Apply migrations'),
                        description: l10n.t('Rename, rewrite, or remove fields changed by game updates'),
                        removeDeadFields: false,
                        dryRun: false,
                    },
                    {
                        label: l10n.t('Apply migrations and remove dead fields'),
                        description: l10n.t('Additionally remove fields the game never reads'),
                        removeDeadFields: true,
                        dryRun: false,
                    },
                ],
                { placeHolder: l10n.t('Migrate every rules file of this workspace to the current game version') }
            );
            if (!choice) return;
            const summary = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.migrateWorkspace',
                arguments: [{ removeDeadFields: choice.removeDeadFields, dryRun: choice.dryRun }],
            })) as MigrationSummary | null;
            if (!summary) {
                window.showInformationMessage(l10n.t('Cosmoteer migration: no workspace folder is open.'));
                return;
            }
            if (summary.preview) {
                await showMigrationPreview(summary, diffPreviewProvider);
                return;
            }
            await showMigrationSummary(summary);
        })
    );

    // What the game itself said the last time it loaded this mod. Its own collection, never the
    // language server's: these findings are a recording of a past run, so nothing an edit does can
    // make them true again, and they have to be retractable on their own. Cleared when a file they
    // name is saved, since that is the moment the recording stops describing it.
    const gameLogDiagnostics = languages.createDiagnosticCollection('cosmoteer-game-log');
    context.subscriptions.push(gameLogDiagnostics);
    context.subscriptions.push(
        workspace.onDidSaveTextDocument((document) => {
            if (gameLogDiagnostics.get(document.uri)?.length) gameLogDiagnostics.delete(document.uri);
        })
    );
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.importGameLog', async () => {
            const uri = window.activeTextEditor?.document.uri.toString() ?? workspace.workspaceFolders?.[0]?.uri.toString();
            if (!uri) {
                window.showInformationMessage(l10n.t('Cosmoteer: open a file of the mod first.'));
                return;
            }
            const result = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.readGameLog',
                arguments: [{ uri }],
            })) as ImportGameLogResult | null;
            if (!result) {
                window.showErrorMessage(l10n.t('The game log could not be read.'));
                return;
            }
            gameLogDiagnostics.clear();
            if (result.kind === 'no-mod') {
                window.showInformationMessage(l10n.t('This file is not inside a mod: no mod.rules was found above it.'));
                return;
            }
            if (result.kind === 'no-logs') {
                window.showInformationMessage(l10n.t('Cosmoteer has written no logs yet. Run the game once, then try again.'));
                return;
            }
            if (result.kind === 'nothing-for-this-mod') {
                window.showInformationMessage(
                    l10n.t('No game log mentions this mod. The game reports a mod only while it loads it.')
                );
                return;
            }
            const byUri = new Map<string, Diagnostic[]>();
            for (const entry of result.diagnostics) {
                const range = new Range(
                    entry.diagnostic.range.start.line,
                    entry.diagnostic.range.start.character,
                    entry.diagnostic.range.end.line,
                    entry.diagnostic.range.end.character
                );
                const diagnostic = new Diagnostic(
                    range,
                    entry.diagnostic.message,
                    // The protocol counts severities from one, the editor from zero.
                    (entry.diagnostic.severity ?? 1) - 1 as DiagnosticSeverity
                );
                diagnostic.source = 'cosmoteer-game-log';
                const existing = byUri.get(entry.uri);
                if (existing) existing.push(diagnostic);
                else byUri.set(entry.uri, [diagnostic]);
            }
            for (const [uriText, diagnostics] of byUri) gameLogDiagnostics.set(Uri.parse(uriText), diagnostics);
            const parts = [
                l10n.t('{0} findings from the run of {1}', String(result.diagnostics.length), result.log?.time ?? '?'),
            ];
            // A log outlives the files it describes, so anything that no longer fits is counted
            // rather than moved to a line that happens to exist.
            if (result.stale > 0) {
                parts.push(l10n.t('{0} no longer fit the files and were left out', String(result.stale)));
            }
            window.showInformationMessage(`${parts.join(', ')}.`);
        })
    );

    // Run the mod: the server links the workspace into the folder the game loads mods from, switches
    // it on in the game's own settings and starts the game in developer mode. Everything that can go
    // wrong comes back as a named reason rather than a thrown error, since the flow writes into the
    // user's game settings and each refusal needs its own sentence. A distinct command id from the
    // server's executeCommand id, for the same reason as the migration above.
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.runInGame', async () => {
            const uri = window.activeTextEditor?.document.uri.toString() ?? workspace.workspaceFolders?.[0]?.uri.toString();
            if (!uri) {
                window.showInformationMessage(l10n.t('Cosmoteer: open a file of the mod first.'));
                return;
            }
            const run = async (userDataFolder?: string): Promise<RunGameResult | null> =>
                (await client.sendRequest(ExecuteCommandRequest.type, {
                    command: 'cosmoteer.runInCosmoteer',
                    arguments: [{ uri, userDataFolder }],
                })) as RunGameResult | null;

            let result = await run();
            if (result?.kind === 'choose-user-data') {
                // Which folder the game uses depends on the Steam account it is signed into, which
                // the server cannot read, so the user picks.
                const chosen = await window.showQuickPick(result.candidates.slice(), {
                    placeHolder: l10n.t('Which Cosmoteer user folder does the game use?'),
                });
                if (!chosen) return;
                result = await run(chosen);
            }
            if (!result) {
                window.showErrorMessage(l10n.t('Cosmoteer could not be started.'));
                return;
            }
            if (result.kind === 'refused') {
                window.showErrorMessage(runGameRefusalMessage(result.reason, result.detail));
                return;
            }
            if (result.kind !== 'started') return;
            window.showInformationMessage(
                result.linked
                    ? l10n.t('Starting Cosmoteer. The mod is linked into your Mods folder as {0}.', result.modFolder)
                    : l10n.t('Starting Cosmoteer with the mod enabled.')
            );
            if (!result.compatible) {
                window.showWarningMessage(
                    l10n.t(
                        "The mod's CompatibleGameVersions names no game version this build accepts, so the game will turn it off again while loading."
                    )
                );
            }
        })
    );

    // Code mod schema: a command that re-reads every mod assembly and merges the types it declares
    // into the schema, so a mod's own `Type=` discriminators and fields resolve. The server loads
    // the cached result at startup on its own, so this is for picking up a mod that was just built
    // or installed. A distinct command id from the server's executeCommand id, for the same reason
    // as the migration above.
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.buildModSchemaFromMods', async () => {
            const summary = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.buildModSchema',
                arguments: [],
            })) as ModSchemaSummary | null;
            if (!summary) {
                window.showInformationMessage(l10n.t('Cosmoteer code mod schema: no workspace folder is open.'));
                return;
            }
            if (summary.disabled) {
                window.showInformationMessage(
                    l10n.t(
                        'Cosmoteer code mod schema: code mod support is turned off (cosmoteerLSPRules.codeMods.enabled).'
                    )
                );
                return;
            }
            if (summary.types === 0) {
                window.showInformationMessage(
                    l10n.t('Cosmoteer code mod schema: no code mod assemblies found, nothing to add.')
                );
                return;
            }
            window.showInformationMessage(
                l10n.t(
                    'Cosmoteer code mod schema: added {0} types and {1} discriminators from {2} assemblies.',
                    summary.types,
                    summary.discriminators,
                    summary.assemblies
                )
            );
        })
    );

    // Shared base extraction: a command that sweeps the mod for fields several files write word for
    // word and turns the set the user picks into a base file all of them inherit, the way the game's
    // own data and the larger mods are written. The server ranks the extractions, writes the base file
    // and applies the multi-file edit, so this wrapper only offers the plans and renders the returned
    // summary. A distinct command id from the server's executeCommand id, for the same reason as the
    // migration above.
    const diffPreviewProvider = new DiffPreviewProvider();
    setPreviewScheme(DIFF_PREVIEW_SCHEME);
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(DIFF_PREVIEW_SCHEME, diffPreviewProvider),
        commands.registerCommand('cosmoteer.extractSharedBaseFiles', async () => {
            const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.extractSharedBase',
                arguments: [{}],
            })) as SharedBaseScanResult | null;
            if (!scan) {
                window.showInformationMessage(l10n.t('Cosmoteer shared base: the search could not be completed.'));
                return;
            }
            if (scan.plans.length === 0) {
                window.showInformationMessage(
                    l10n.t(
                        'Cosmoteer shared base: nothing worth extracting in {0} files, no group repeats another one word for word.',
                        scan.filesScanned
                    )
                );
                return;
            }
            const plan = await pickSharedBasePlan(scan.plans);
            if (plan) await previewAndApplySharedBase(plan, diffPreviewProvider);
        }),
        // The command the server's lightbulb refactoring carries. The server does not declare it, so
        // the editor runs this rather than forwarding it, and the rewrite gets a real diff.
        // The command the server's "move this block into its own file" refactoring carries. The name is
        // asked for here, and the server writes the file and re-expresses every path the block carries.
        commands.registerCommand(EXTRACT_GROUP_LOCAL_COMMAND, async (args?: ExtractGroupArgs) => {
            if (!args?.uri) return;
            const run = async (fileName?: string) =>
                (await client.sendRequest(ExecuteCommandRequest.type, {
                    command: 'cosmoteer.extractGroupToFile',
                    arguments: [{ ...args, fileName }],
                })) as ExtractGroupResult | null;
            const offered = await run();
            if (!offered?.offer) {
                window.showWarningMessage(extractGroupFailureMessage(offered?.failure));
                return;
            }
            const fileName = await window.showInputBox({
                title: l10n.t("Move '{0}' into its own file", offered.offer.name),
                prompt: l10n.t('The file to write it to, relative to the folder this file is in.'),
                value: offered.offer.fileName,
                valueSelection: [0, offered.offer.fileName.lastIndexOf('.')],
            });
            if (!fileName) return;
            const written = await run(fileName.trim());
            if (!written?.written) {
                window.showWarningMessage(extractGroupFailureMessage(written?.failure));
                return;
            }
            const document = await workspace.openTextDocument(Uri.parse(written.written.uri));
            await window.showTextDocument(document);
        }),
        // The command the server's "create the component this names" quick fix carries. The kind is
        // asked for here, and the server works out where the declaration goes and what it has to carry.
        commands.registerCommand(CREATE_COMPONENT_LOCAL_COMMAND, async (args?: CreateComponentArgs) => {
            if (!args?.uri || !args.name) return;
            const run = async (type?: string) =>
                (await client.sendRequest(ExecuteCommandRequest.type, {
                    command: 'cosmoteer.createComponent',
                    arguments: [{ ...args, type }],
                })) as CreateComponentResult | null;
            const offered = await run();
            if (!offered || offered.failure || !offered.choices?.length) {
                window.showWarningMessage(createComponentFailureMessage(offered?.failure));
                return;
            }
            const picked = await window.showQuickPick(
                offered.choices.map((choice) => ({ label: choice.type, detail: choice.detail })),
                {
                    title: l10n.t("Create the component '{0}'", args.name),
                    placeHolder: l10n.t('The kind of component to declare.'),
                    matchOnDetail: true,
                }
            );
            if (!picked) return;
            const written = await run(picked.label);
            if (!written?.insert) {
                window.showWarningMessage(createComponentFailureMessage(written?.failure));
                return;
            }
            const document = await workspace.openTextDocument(Uri.parse(written.insert.uri));
            const editor = await window.showTextDocument(document);
            const range = new Range(
                new Position(written.insert.range.start.line, written.insert.range.start.character),
                new Position(written.insert.range.end.line, written.insert.range.end.character)
            );
            await editor.insertSnippet(new SnippetString(written.insert.snippet), range);
        }),
        // The command the server's snippet-bearing code actions carry, which writes the text and leaves
        // the caret on the first tab stop. The edit cannot come through the code action itself: the
        // protocol's edits are plain text.
        commands.registerCommand(INSERT_SNIPPET_LOCAL_COMMAND, async (args?: InsertSnippetArgs) => {
            if (!args?.uri || typeof args.snippet !== 'string') return;
            const document = await workspace.openTextDocument(Uri.parse(args.uri));
            const editor = await window.showTextDocument(document);
            const range = new Range(
                new Position(args.range.start.line, args.range.start.character),
                new Position(args.range.end.line, args.range.end.character)
            );
            await editor.insertSnippet(new SnippetString(args.snippet), range);
        }),
        commands.registerCommand(EXTRACT_SHARED_BASE_LOCAL_COMMAND, async (plan?: SharedBasePlan) => {
            if (plan) await previewAndApplySharedBase(plan, diffPreviewProvider);
        }),
        // The command the server's localization-key extraction carries. The server does not declare
        // it, so the editor runs this and the author names the key before anything is written.
        commands.registerCommand(EXTRACT_LOCALIZATION_KEY_LOCAL_COMMAND, async (args?: ExtractLocalizationKeyArgs) => {
            if (!args) return;
            const key = await window.showInputBox({
                title: l10n.t('Extract text into a localization key'),
                prompt: l10n.t('The key path every language file will declare, one name per group.'),
                value: args.key,
                valueSelection: [args.key.lastIndexOf('/') + 1, args.key.length],
                validateInput: (value) =>
                    LOCALIZATION_KEY_PATH.test(value.trim())
                        ? undefined
                        : l10n.t('A key path is one or more names joined by "/".'),
            });
            if (!key) return;
            const openBefore = openDocumentPaths();
            const result = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.extractLocalizationKey',
                arguments: [{ ...args, key: key.trim() }],
            })) as ExtractLocalizationKeyResult | null;
            if (!result) {
                window.showWarningMessage(l10n.t('The text could not be extracted.'));
                return;
            }
            if (result.failure) {
                window.showWarningMessage(extractLocalizationKeyFailureMessage(result.failure));
                return;
            }
            await saveAndTidy(result.changedFiles, openBefore);
            window.showInformationMessage(
                l10n.t('Added "{0}" to {1} language files.', result.key, result.changedFiles.length)
            );
        }),
        // The command the server's whole-mod deprecation fix carries. The server does not claim it,
        // so the editor runs this and the author reads the rewrite as a diff before it happens.
        commands.registerCommand(MIGRATE_SYMBOL_LOCAL_COMMAND, async (args?: MigrateSymbolArgs) => {
            if (!args?.symbol || !args.uri) return;
            const run = async (dryRun: boolean) =>
                (await client.sendRequest(ExecuteCommandRequest.type, {
                    command: 'cosmoteer.migrateSymbol',
                    arguments: [{ symbol: args.symbol, uri: args.uri, dryRun }],
                })) as MigrationSummary | null;
            const preview = await run(true);
            if (!preview) {
                window.showInformationMessage(l10n.t('Cosmoteer migration: no workspace folder is open.'));
                return;
            }
            // Nothing to rewrite is the normal answer for a deprecation written once, and it has to
            // be said, or the fix looks like it did nothing.
            if (preview.files === 0) {
                window.showInformationMessage(
                    preview.manual.length > 0
                        ? l10n.t(
                              'Cosmoteer: {0} findings need manual review, nothing can be changed mechanically.',
                              preview.manual.length
                          )
                        : l10n.t('Cosmoteer: nothing else in this mod needs that change.')
                );
                return;
            }
            await showMigrationPreview(preview, diffPreviewProvider, async () => {
                const summary = await run(false);
                if (summary) await showMigrationSummary(summary);
            });
        }),
        // The command the server's part-registration refactoring carries. The server does not claim
        // it, so the editor runs this and the author picks the ship class before anything is written.
        commands.registerCommand(REGISTER_PART_IN_SHIP_LOCAL_COMMAND, async (args?: RegisterPartArgs) => {
            if (!args) return;
            const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.registerPartInShip',
                arguments: [args],
            })) as RegisterPartScanResult | null;
            if (!scan || scan.failure) {
                window.showWarningMessage(
                    scan?.failure
                        ? registerPartFailureMessage(scan.failure)
                        : l10n.t('Cosmoteer: the ship classes could not be read, so nothing was changed.')
                );
                return;
            }
            const ship = await pickShipCandidate(scan.candidates);
            if (!ship) return;
            // Captured before the edit, so the tidy-up can tell the tabs the user had from the one the
            // registration opened on its own.
            const openBefore = openDocumentPaths();
            const result = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.registerPartInShip',
                arguments: [{ ...args, ship: ship.key }],
            })) as RegisterPartApplyResult | null;
            if (!result) {
                window.showWarningMessage(
                    l10n.t('Cosmoteer: the part could not be registered, so nothing was changed.')
                );
                return;
            }
            if (result.failure) {
                window.showWarningMessage(registerPartFailureMessage(result.failure, result.manifests));
                return;
            }
            const cleanup = await saveAndTidy(result.changedFiles, openBefore);
            await showRegisterPartSummary(result, cleanup);
        }),
        // The command the server's override refactoring carries. The server does not claim it, so
        // the editor runs this and the author picks the mod before anything is written.
        commands.registerCommand(OVERRIDE_IN_MOD_LOCAL_COMMAND, async (args?: OverrideInModArgs) => {
            if (!args) return;
            const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.overrideInMod',
                arguments: [args],
            })) as OverrideInModScanResult | null;
            if (!scan || scan.failure) {
                window.showWarningMessage(
                    scan?.failure
                        ? overrideInModFailureMessage(scan.failure)
                        : l10n.t('Cosmoteer: the override could not be worked out, so nothing was changed.')
                );
                return;
            }
            const mod = await pickOverrideMod(scan.candidates);
            if (!mod) return;
            const shape = await pickOverrideShape(scan);
            if (!shape) return;
            // Captured before the edit, so the tidy-up can tell the tabs the user had from the one
            // the override opened on its own.
            const openBefore = openDocumentPaths();
            const result = (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.overrideInMod',
                arguments: [{ ...args, mod: mod.key, shape }],
            })) as OverrideInModApplyResult | null;
            if (!result) {
                window.showWarningMessage(
                    l10n.t('Cosmoteer: the override could not be written, so nothing was changed.')
                );
                return;
            }
            if (result.failure) {
                window.showWarningMessage(overrideInModFailureMessage(result.failure, result.manifests));
                return;
            }
            const cleanup = await saveAndTidy(result.changedFiles, openBefore);
            await showOverrideSummary(result, cleanup);
        }),
        // The command the server's clone refactoring carries. The server does not claim it, so the
        // editor runs this and the author names the id and reads the copy before anything is written.
        commands.registerCommand(CLONE_DECLARATION_LOCAL_COMMAND, async (args?: CloneDeclarationArgs) => {
            if (args) await cloneDeclarationFlow(args, diffPreviewProvider);
        })
    );

    return client.start();
}

/** What the server reports after a whole-mod validation pass (see server.ts `announceWorkspaceValidation`). */
interface WorkspaceValidatedParams {
    files: number;
    fresh: number;
    elapsedMs: number;
    scope: 'allFiles' | 'modRulesReachable';
}

/** Remembers that the whole-mod validation notice has been shown, so it is shown exactly once. */
const WORKSPACE_VALIDATION_NOTICE_KEY = 'cosmoteer.workspaceValidationNoticeShown';

/**
 * Tell the user once that the whole mod is validated, not just their open tabs, and let them switch
 * it off without going looking for the setting.
 *
 * The server only reports a pass that actually did work, so a project where this is instant never
 * produces the notice at all, and the flag stays unset, so the first genuinely large project the
 * user opens is still the one that tells them.
 *
 * @param context the extension context, whose global state remembers that the notice was shown.
 * @param params what the pass covered.
 * @returns once the user answered or dismissed the notice.
 */
async function showWorkspaceValidationNotice(
    context: ExtensionContext,
    params: WorkspaceValidatedParams
): Promise<void> {
    if (context.globalState.get<boolean>(WORKSPACE_VALIDATION_NOTICE_KEY)) return;
    await context.globalState.update(WORKSPACE_VALIDATION_NOTICE_KEY, true);

    const openFilesOnly = l10n.t('Only open files');
    const settingsAction = l10n.t('Settings');
    const message =
        params.scope === 'modRulesReachable'
            ? l10n.t(
                  'Cosmoteer: the Problems panel now covers your whole mod, not just open files. {0} files the mod.rules actions load were validated, and the results are cached, so later starts are fast.',
                  params.files
              )
            : l10n.t(
                  'Cosmoteer: the Problems panel now covers your whole workspace, not just open files. {0} files were validated, and the results are cached, so later starts are fast.',
                  params.files
              );
    const choice = await window.showInformationMessage(message, openFilesOnly, settingsAction);
    if (choice === openFilesOnly) {
        await workspace
            .getConfiguration('cosmoteerLSPRules')
            .update('diagnostics.validateWholeWorkspace', false, ConfigurationTarget.Global);
    } else if (choice === settingsAction) {
        await commands.executeCommand('workbench.action.openSettings2', {
            query: 'cosmoteerLSPRules.diagnostics.validateWholeWorkspace',
        });
    }
}

/** Mirror of the server's game-log import result (see server features/game-log/import-game-log.command.ts). */
interface ImportGameLogResult {
    kind: 'imported' | 'no-mod' | 'no-logs' | 'nothing-for-this-mod';
    log?: { path: string; time: string; gameVersion?: string };
    diagnostics: Array<{
        uri: string;
        diagnostic: {
            range: { start: { line: number; character: number }; end: { line: number; character: number } };
            severity?: number;
            message: string;
        };
    }>;
    stale: number;
}

/** Mirror of the server's run-in-game result (see server features/run-game/run-game.command.ts). */
type RunGameResult =
    | { kind: 'started'; modFolder: string; linked: boolean; enabled: boolean; backup?: string; compatible: boolean }
    | { kind: 'choose-user-data'; candidates: string[] }
    | { kind: 'refused'; reason: string; detail?: string };

/**
 * The sentence for each reason the run refused. Every one of them is a state the flow will not
 * guess its way through, since it writes into the user's own game settings and mods folder.
 *
 * @param reason the reason the server answered with.
 * @param detail the path or message it named, when it named one.
 * @returns the message to show.
 */
function runGameRefusalMessage(reason: string, detail?: string): string {
    switch (reason) {
        case 'unsupported-platform':
            return l10n.t('Cosmoteer ships no macOS build, so it cannot be started from here.');
        case 'no-install':
            return l10n.t('No Cosmoteer install was found. Set "cosmoteerLSPRules.cosmoteerPath" to its Data folder.');
        case 'no-executable':
            return l10n.t('The Cosmoteer executable is missing at {0}.', detail ?? '');
        case 'no-mod':
            return l10n.t('This file is not inside a mod: no mod.rules was found above it.');
        case 'no-user-data':
            return l10n.t('Cosmoteer has no user folder yet. Start the game once, then try again.');
        case 'no-settings-file':
            return l10n.t('Cosmoteer has never written its settings file at {0}, so there is nothing to enable the mod in.', detail ?? '');
        case 'game-running':
            return l10n.t('Cosmoteer is running. It rewrites its settings when it exits, so close it first.');
        case 'duplicate-mod-enabled':
            return l10n.t(
                'Another copy of this mod is already enabled at {0}. Cosmoteer loads no mod id twice and stops with an error, so turn that copy off in its mod list or unsubscribe it first.',
                detail ?? ''
            );
        case 'link-name-taken':
            return l10n.t('{0} already exists and is not a link to this mod. Rename one of them first.', detail ?? '');
        case 'link-failed':
            return l10n.t('The mod could not be linked into your Mods folder: {0}', detail ?? '');
        case 'settings-unparseable':
            return l10n.t("Cosmoteer's settings file could not be read, so it was left untouched.");
        case 'settings-no-game-settings':
        case 'settings-no-enabled-mods':
            return l10n.t("Cosmoteer's settings file has no enabled-mods list, so it was left untouched.");
        case 'settings-not-equivalent':
        case 'settings-bad-entry':
            return l10n.t('The change to the settings file did not come out as expected, so nothing was written.');
        case 'settings-write-failed':
            return l10n.t('The settings file could not be written: {0}', detail ?? '');
        default:
            return l10n.t('Cosmoteer could not be started.');
    }
}

/** Mirror of the server's code mod schema summary (see server features/mod-schema/mod-schema.ts). */
interface ModSchemaSummary {
    assemblies: number;
    types: number;
    discriminators: number;
    fromCache: boolean;
    unreadable: string[];
    /** Set when `codeMods.enabled` is off, so the command says so instead of "nothing found". */
    disabled?: boolean;
}

// The command id schema-hover "Open in decompiler" links invoke. The language client registers
// the VS Code command itself from the server's `executeCommandProvider` capability and forwards
// invocations to the server (which finds and spawns the decompiler), so the extension must not
// register it too. This constant only feeds the `enabledCommands` trust list in the hover
// middleware and must match the server's decompiler-link module.
const OPEN_IN_DECOMPILER_COMMAND = 'cosmoteer.openInDecompiler';

/**
 * The command the server's lightbulb refactoring carries. The server deliberately does not claim it,
 * so the editor resolves it here and the rewrite can be shown as a real diff before it happens.
 */
const EXTRACT_SHARED_BASE_LOCAL_COMMAND = 'cosmoteer.extractSharedBaseFromAction';

/**
 * The command the server's "extract text into a localization key" refactoring carries. The server
 * does not claim it, so the editor runs this instead and the author gets to name the key first.
 */
const EXTRACT_LOCALIZATION_KEY_LOCAL_COMMAND = 'cosmoteer.extractLocalizationKeyFromAction';

/**
 * The command the server's "register this part in a ship class" refactoring carries. The server does
 * not claim it, so the editor runs this instead and the author picks the ship class first.
 */
const REGISTER_PART_IN_SHIP_LOCAL_COMMAND = 'cosmoteer.registerPartInShipFromAction';

/**
 * The command the server's "apply this deprecation to the whole mod" fix carries. The server does not
 * claim it, so the editor runs this instead and the rewrite is shown as a diff before it happens.
 */
const MIGRATE_SYMBOL_LOCAL_COMMAND = 'cosmoteer.migrateSymbolFromAction';

/** Mirror of the server's bulk-migration arguments (see server features/migration/migrate-symbol.ts). */
interface MigrateSymbolArgs {
    symbol: string;
    uri: string;
    dryRun?: boolean;
}

/**
 * The palette command that creates a new content file. A distinct id from the server's own
 * `cosmoteer.newContent`, because the language client auto-registers that one as a plain
 * no-feedback forwarder and the questions have to be asked here.
 */
const NEW_CONTENT_LOCAL_COMMAND = 'cosmoteer.newContentFile';

/**
 * The command the server's "override this in my mod" refactoring carries. The server does not
 * claim it, so the editor runs this instead and the author picks the mod first.
 */
const OVERRIDE_IN_MOD_LOCAL_COMMAND = 'cosmoteer.overrideInModFromAction';

/**
 * The command the server's "move this block into its own file" refactoring carries. The server does
 * not claim it, so the editor runs this instead: what the new file is called is a name only the
 * author can give.
 */
const EXTRACT_GROUP_LOCAL_COMMAND = 'cosmoteer.extractGroupToFileFromAction';

/** Mirror of the server's extract-group arguments (see server features/refactor/extract-group). */
interface ExtractGroupArgs {
    uri: string;
    offset: number;
    fileName?: string;
}

/** Mirror of what the server answers with on either round. */
interface ExtractGroupResult {
    offer?: { name: string; fileName: string; members: number };
    written?: { uri: string; reference: string };
    failure?: string;
}

/**
 * What to say when a block cannot be moved into a file of its own.
 *
 * @param failure the reason the server gave, absent when it answered with nothing at all.
 * @returns the message to show.
 */
function extractGroupFailureMessage(failure: string | undefined): string {
    switch (failure) {
        case 'notAGroup':
            return l10n.t('Only a named block can be moved into a file of its own.');
        case 'notEditable':
            return l10n.t('Files in the game folder are read-only.');
        case 'inheritedGroup':
            return l10n.t('This block derives from another one, whose members a copy would not carry.');
        case 'multiLineText':
            return l10n.t('A text in this block runs across lines, so it cannot be moved.');
        case 'scopeRelativeValue':
            return l10n.t('This block reads something outside itself, so it would mean something else from another file.');
        case 'badFileName':
            return l10n.t('The name has to be a .rules file inside this folder.');
        case 'fileExists':
            return l10n.t('A file of that name is already there.');
        case 'editRejected':
            return l10n.t('The editor refused the change, so nothing was moved.');
        default:
            return l10n.t('The block could not be moved.');
    }
}

/**
 * The command the server's "create the component this names" quick fix carries. The server does not
 * claim it, so the editor runs this instead: which kind of component the author meant cannot be read
 * off the reference, and only they know it.
 */
const CREATE_COMPONENT_LOCAL_COMMAND = 'cosmoteer.createComponentFromAction';

/** Mirror of the server's create-component arguments (see server features/refactor/create-component). */
interface CreateComponentArgs {
    uri: string;
    offset: number;
    name: string;
    type?: string;
}

/** Mirror of what the server answers with on either round. */
interface CreateComponentResult {
    choices?: Array<{ type: string; detail: string }>;
    insert?: {
        uri: string;
        range: { start: { line: number; character: number }; end: { line: number; character: number } };
        snippet: string;
    };
    failure?: string;
}

/**
 * What to say when no component can be declared.
 *
 * @param failure the reason the server gave, absent when it answered with nothing at all.
 * @returns the message to show.
 */
function createComponentFailureMessage(failure: string | undefined): string {
    switch (failure) {
        case 'noOwner':
            return l10n.t('This file declares no part or bullet to add a component to.');
        case 'notEditable':
            return l10n.t('Files in the game folder are read-only.');
        case 'alreadyDeclared':
            return l10n.t('A component of that name is already declared here.');
        case 'unknownType':
            return l10n.t('That kind of component cannot be declared here.');
        default:
            return l10n.t('The component could not be created.');
    }
}

/**
 * The command the server's snippet-bearing code actions carry. The server does not claim it, and it
 * cannot: a `WorkspaceEdit` has no way to carry a tab stop, so the text is written here, where the
 * editor can leave the caret where the author has to type next.
 */
const INSERT_SNIPPET_LOCAL_COMMAND = 'cosmoteer.insertSnippetFromAction';

/** Mirror of the server's snippet arguments (see server features/refactor/snippet-action.ts). */
interface InsertSnippetArgs {
    uri: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    snippet: string;
}

/**
 * The command the server's "clone this under a new id" refactoring carries. The server does not claim
 * it, so the editor runs this instead: the new id is a name only the author can give, and the copy
 * writes files that have to be read before they are written.
 */
const CLONE_DECLARATION_LOCAL_COMMAND = 'cosmoteer.cloneDeclarationFromAction';

/** What an id may be spelled with, the same set the server and the rename refactoring enforce. */
const VALID_CLONE_ID = /^[A-Za-z0-9_.]+$/;

/**
 * Mirror of the server's clone arguments (see server
 * features/refactor/clone-declaration/clone.command.ts).
 */
interface CloneDeclarationArgs {
    uri: string;
    offset: number;
    newId?: string;
    destinationDir?: string;
    preview?: boolean;
}

/** Mirror of the server's report round. */
interface CloneScanResult {
    kind: 'scan';
    id: string;
    identityKey: string;
    unit: 'directory' | 'file' | 'listElement';
    files: number;
    proposedId: string;
    destinationDir: string;
    modRoots: string[];
    failure?: CloneFailure;
}

/** Mirror of the server's preview round. */
interface ClonePreviewResult {
    kind: 'preview';
    diff: string;
    changed: DiffPreviewFile[];
    omitted: number;
    writes: string[];
    copied: string[];
    stringsFiles: string[];
    destinationDir: string;
    newId: string;
    unit: 'directory' | 'file' | 'listElement';
    droppedOtherIds: string[];
    keys: Array<{ from: string; to: string }>;
    failure?: CloneFailure;
    detail?: string[];
}

/** Mirror of the server's apply round. */
interface CloneApplyResult {
    kind: 'apply';
    created: string;
    createdPaths: string[];
    changedFiles: string[];
    stringsFiles: string[];
    droppedOtherIds: string[];
    keys: number;
    newId: string;
    unit: 'directory' | 'file' | 'listElement';
    failure?: CloneFailure;
    detail?: string[];
}

/** Why a clone did nothing, as the server words it. */
type CloneFailure =
    | 'stale'
    | 'noDeclaration'
    | 'inheritedIdentity'
    | 'unreadableBase'
    | 'severalIdentities'
    | 'invalidId'
    | 'idUnchanged'
    | 'idTaken'
    | 'notEditable'
    | 'ambiguousDestination'
    | 'destinationExists'
    | 'unresolvablePath'
    | 'escapingPath'
    | 'writeFailed'
    | 'editRejected';

/**
 * Say why a clone did not happen, one message per reason the server reports, each naming what the user
 * can do about it.
 *
 * @param failure the server's reason.
 * @param detail what the reason is about: a path, a file, or the mods to choose between.
 * @returns the message to show.
 */
function cloneFailureMessage(failure: CloneFailure, detail?: string[]): string {
    const first = detail?.[0] ?? '';
    switch (failure) {
        case 'stale':
            return l10n.t('Cosmoteer: the declaration has moved since the offer was made, so nothing was changed.');
        case 'noDeclaration':
            return l10n.t('Cosmoteer: nothing here declares an id, so there is nothing to clone.');
        case 'inheritedIdentity':
            return l10n.t(
                'Cosmoteer: this takes its id from a base file, so a copy would carry the same id. Give it an ID of its own first.'
            );
        case 'unreadableBase':
            return l10n.t(
                'Cosmoteer: a base file of this one could not be read, so there is no saying what the copy would carry.'
            );
        case 'severalIdentities':
            return l10n.t('Cosmoteer: this file declares more than one thing. Put the cursor in the one to clone.');
        case 'invalidId':
            return l10n.t('Cosmoteer: an id is made of letters, digits, dots and underscores.');
        case 'idUnchanged':
            return l10n.t('Cosmoteer: that is the id it already has. The game matches ids without regard to case.');
        case 'idTaken':
            return l10n.t(
                'Cosmoteer: something already declares that id, and the game keeps one of two such entries and drops the other.'
            );
        case 'notEditable':
            return l10n.t(
                "Cosmoteer: the copy would land outside a mod you can edit. The game's own files and installed workshop mods are left alone."
            );
        case 'ambiguousDestination':
            return l10n.t(
                'Cosmoteer: the workspace holds several mods, so which one gets the copy is yours to decide. Candidates: {0}.',
                (detail ?? []).join(', ')
            );
        case 'destinationExists':
            return l10n.t('Cosmoteer: {0} is already there, so nothing was changed.', first);
        case 'unresolvablePath':
            return l10n.t(
                'Cosmoteer: this reads {0}, which is not on disk, so the copy would read nothing either.',
                first
            );
        case 'escapingPath':
            return l10n.t(
                'Cosmoteer: this reads {0} from outside the destination mod, which a published mod cannot do. Copy that file into the mod first.',
                first
            );
        case 'writeFailed':
            return l10n.t('Cosmoteer: the copy could not be written, so it was removed again.');
        case 'editRejected':
            return l10n.t('Cosmoteer: the editor turned the edit down.');
    }
}

/**
 * Ask for the new id, show the whole copy as a diff, and write it once the author says so.
 *
 * The exchange is three rounds, the same shape the shared-base extraction uses: the server reports what
 * cloning would take, the author names the id, the server works the copy out and answers with it, and
 * only then is anything written.
 *
 * @param args the declaration the lightbulb offered.
 * @param provider the content provider the copy's files are served from.
 * @returns once the copy happened or the author backed out.
 */
async function cloneDeclarationFlow(args: CloneDeclarationArgs, provider: DiffPreviewProvider): Promise<void> {
    const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.cloneDeclaration',
        arguments: [args],
    })) as CloneScanResult | null;
    if (!scan || scan.failure) {
        window.showWarningMessage(
            scan?.failure
                ? cloneFailureMessage(scan.failure)
                : l10n.t('Cosmoteer: this could not be read, so nothing was changed.')
        );
        return;
    }
    const newId = await window.showInputBox({
        title: l10n.t('Clone under a new id'),
        prompt: l10n.t(
            'The id the copy declares. Everything inside the copy that names the old id is rewritten to it.'
        ),
        value: scan.proposedId,
        validateInput: (value) =>
            VALID_CLONE_ID.test(value.trim())
                ? undefined
                : l10n.t('An id is made of letters, digits, dots and underscores.'),
    });
    if (!newId) return;

    // Captured before the preview, not after: the diff opens the real files on its left-hand side, so
    // by the time it is on screen those files count as open and the tidy-up would leave them behind.
    const openBefore = openDocumentPaths();
    const preview = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.cloneDeclaration',
        arguments: [{ ...args, newId: newId.trim(), preview: true }],
    })) as ClonePreviewResult | null;
    if (!preview || preview.failure) {
        window.showWarningMessage(
            preview?.failure
                ? cloneFailureMessage(preview.failure, preview.detail)
                : l10n.t('Cosmoteer: the copy could not be worked out, so nothing was changed.')
        );
        return;
    }
    const title = l10n.t('Clone: {0}', preview.newId);
    if (preview.changed.length > 0) await showDiffPreview(provider, `clone-${preview.newId}`, preview.changed, title);
    else await showPatchPreview(provider, `clone-${preview.newId}`, preview.diff);

    if (!(await confirmClone(preview))) return;
    const result = await window.withProgress(
        { location: ProgressLocation.Notification, title: l10n.t('Cloning {0}', preview.newId) },
        async () =>
            (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.cloneDeclaration',
                arguments: [{ ...args, newId: newId.trim() }],
            })) as CloneApplyResult | null
    );
    if (!result) {
        window.showWarningMessage(l10n.t('Cosmoteer: the copy could not be made, so nothing was changed.'));
        return;
    }
    if (result.failure) {
        window.showWarningMessage(cloneFailureMessage(result.failure, result.detail));
        return;
    }
    await saveAndTidy(result.changedFiles, openBefore);
    await showCloneSummary(result);
}

/**
 * Have the author confirm the copy whose diff is now open beside the editor. Worth its click because
 * applying it writes a folder of files into the project.
 *
 * @param preview the server's account of what the copy would write.
 * @returns true when the author asked for it to happen.
 */
async function confirmClone(preview: ClonePreviewResult): Promise<boolean> {
    const clone = l10n.t('Clone');
    const parts: string[] = [];
    parts.push(
        preview.omitted > 0
            ? l10n.t('The open diff shows {0} of the files the copy writes.', preview.changed.length)
            : l10n.t('The open diff is the whole change.')
    );
    if (preview.keys.length > 0) {
        parts.push(
            l10n.t(
                '{0} new language keys are declared with the text the original already has.',
                preview.keys.length
            )
        );
    }
    if (preview.droppedOtherIds.length > 0) {
        parts.push(
            l10n.t(
                'The OtherIDs aliases {0} stay with the original, because the game answers to them there.',
                preview.droppedOtherIds.join(', ')
            )
        );
    }
    parts.push(l10n.t('References elsewhere in the project keep pointing at the original.'));
    const confirmed = await window.showInformationMessage(
        preview.unit === 'listElement'
            ? l10n.t('Add {0} to the same list?', preview.newId)
            : l10n.t('Write {0} files into {1}?', preview.writes.length, path.basename(preview.destinationDir)),
        { modal: true, detail: parts.join(' ') },
        clone
    );
    return confirmed === clone;
}

/**
 * Render the outcome: one information message, with the copy behind a button.
 *
 * @param result what the server wrote.
 * @returns once the message is dismissed or the copy is opened.
 */
async function showCloneSummary(result: CloneApplyResult): Promise<void> {
    if (result.unit === 'listElement') {
        window.showInformationMessage(l10n.t('Added {0} to the same list.', result.newId));
        return;
    }
    const open = l10n.t('Open the copy');
    const picked = await window.showInformationMessage(
        l10n.t('Cloned as {0} into {1} files.', result.newId, result.createdPaths.length),
        open
    );
    if (picked !== open || !result.created) return;
    const document = await workspace.openTextDocument(Uri.file(result.created));
    await window.showTextDocument(document);
}

/** Mirror of the server's extraction arguments (see server features/refactor/extract-localization-key.ts). */
interface ExtractLocalizationKeyArgs {
    uri: string;
    offset: number;
    literal: string;
    key: string;
}

/** Mirror of the server's extraction result. */
interface ExtractLocalizationKeyResult {
    key: string;
    changedFiles: string[];
    failure?: 'stale' | 'noStringsFiles' | 'editRejected';
}

/** A key path as a strings file declares one, which is what the input box accepts. */
const LOCALIZATION_KEY_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

/**
 * Why an extraction invoked from the lightbulb did nothing, in one sentence the user can act on.
 *
 * @param failure the reason the command reported.
 * @returns the message to show.
 */
function extractLocalizationKeyFailureMessage(failure: NonNullable<ExtractLocalizationKeyResult['failure']>): string {
    switch (failure) {
        case 'stale':
            return l10n.t('That text has changed since the offer was made, so nothing was changed.');
        case 'noStringsFiles':
            return l10n.t('This mod has no language strings file to put the text in, so nothing was changed.');
        case 'editRejected':
            return l10n.t('The editor turned down the edit, so nothing was changed.');
    }
}

/** Mirror of the server's migration summary (see server features/migration/migrate-workspace.ts). */
interface MigrationSummary {
    files: number;
    fixes: number;
    byVersion: Record<string, number>;
    manual: Array<{ uri: string; line: number; message: string }>;
    deadFieldsRemoved: number;
    unparsable: number;
    /** Present only for a dry run, which changes nothing and answers with what it would have done. */
    preview?: {
        diff: string;
        changed: Array<{ fsPath: string; after: string }>;
        omitted: number;
        diffTruncated: boolean;
    };
}

/**
 * Show what a migration would do without doing it: the editor's own side-by-side diff over the files
 * it would rewrite, and a message saying what the view leaves out. A whole-mod migration can cover
 * more files than one message can carry, so the server caps what it sends and the counts here come
 * from the full run rather than from the capped view.
 *
 * @param summary the dry run's summary, whose `preview` carries the changes.
 * @param provider the content provider the rewritten contents are served from.
 * @param apply what to run when the user asks for the change. Absent for the whole-workspace
 * migration, which runs its own palette command.
 * @returns once the diff is open and the message shown.
 */
async function showMigrationPreview(
    summary: MigrationSummary,
    provider: DiffPreviewProvider,
    apply?: () => Promise<void>
): Promise<void> {
    const preview = summary.preview;
    if (!preview) return;
    if (summary.files === 0) {
        window.showInformationMessage(l10n.t('Cosmoteer migration: everything is already up to date.'));
        return;
    }
    const title = l10n.t('Migration preview');
    const changed: DiffPreviewFile[] = preview.changed.map((file) => ({ ...file, created: false }));
    if (changed.length > 0) await showDiffPreview(provider, 'migration', changed, title);
    else await showPatchPreview(provider, 'migration', preview.diff);

    const parts = [l10n.t('{0} fixes in {1} files', summary.fixes, summary.files)];
    if (summary.manual.length > 0) parts.push(l10n.t('{0} findings need manual review', summary.manual.length));
    if (preview.omitted > 0) parts.push(l10n.t('{0} more files are not shown', preview.omitted));
    if (preview.diffTruncated) parts.push(l10n.t('the diff stops short of the last files'));
    const choice = await window.showInformationMessage(
        l10n.t('Cosmoteer migration preview: {0}. Nothing was changed.', parts.join(', ')),
        l10n.t('Apply migrations')
    );
    if (!choice) return;
    if (apply) await apply();
    else await commands.executeCommand('cosmoteer.migrateMod');
}

/**
 * Render the migration outcome: a one-line information message, with a details view (a markdown
 * report listing per-version counts and every manual-review finding) behind a button.
 *
 * @param summary the server's migration summary.
 */
async function showMigrationSummary(summary: MigrationSummary): Promise<void> {
    if (summary.fixes === 0 && summary.deadFieldsRemoved === 0 && summary.manual.length === 0) {
        window.showInformationMessage(l10n.t('Cosmoteer migration: everything is already up to date.'));
        return;
    }
    const pieces: string[] = [];
    if (summary.fixes > 0) pieces.push(l10n.t('applied {0} fixes in {1} files', summary.fixes, summary.files));
    if (summary.deadFieldsRemoved > 0) pieces.push(l10n.t('removed {0} dead fields', summary.deadFieldsRemoved));
    if (summary.manual.length > 0) pieces.push(l10n.t('{0} findings need manual review', summary.manual.length));
    if (summary.unparsable > 0) pieces.push(l10n.t('skipped {0} files with parse errors', summary.unparsable));
    const details = l10n.t('Show Details');
    const picked = await window.showInformationMessage(l10n.t('Cosmoteer migration: {0}.', pieces.join(', ')), details);
    if (picked !== details) return;
    const doc = await workspace.openTextDocument({ content: migrationReport(summary), language: 'markdown' });
    await window.showTextDocument(doc, { preview: true });
}

/**
 * The markdown details report for a migration run: fixes grouped by the game version that made each
 * change, the optional dead-field cleanup, and a clickable list of manual-review findings.
 *
 * @param summary the server's migration summary.
 * @returns the report as markdown text.
 */
function migrationReport(summary: MigrationSummary): string {
    const lines: string[] = ['# Cosmoteer migration report', ''];
    lines.push(l10n.t('Applied {0} fixes in {1} files.', summary.fixes, summary.files), '');
    const versions = Object.entries(summary.byVersion).sort(([a], [b]) =>
        a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })
    );
    for (const [version, count] of versions) {
        lines.push(`- ${version === '' ? l10n.t('pre-changelog game versions') : l10n.t('game version {0}', version)}: ${count}`);
    }
    if (summary.deadFieldsRemoved > 0) {
        lines.push('', l10n.t('Removed {0} fields the game never reads.', summary.deadFieldsRemoved));
    }
    if (summary.unparsable > 0) {
        lines.push('', l10n.t('Skipped {0} files with parse errors (never edited mechanically).', summary.unparsable));
    }
    if (summary.manual.length > 0) {
        lines.push('', `## ${l10n.t('Needs manual review')}`, '');
        for (const finding of summary.manual) {
            const file = Uri.parse(finding.uri).fsPath;
            lines.push(`- ${file}:${finding.line} ${finding.message}`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

/** Which duplication a plan came from, and so whether it writes a new base file or extends one. */
type SharedBaseTier = 'sharedBase' | 'cloneFamily' | 'existingBase';

/** Mirror of the server's serialized extraction plan (see server features/refactor/shared-base/plan.types.ts). */
interface SharedBasePlan {
    id: string;
    tier: SharedBaseTier;
    className: string;
    groupName: string;
    fields: string[];
    participants: Array<{ uri: string; fsPath: string; offset: number }>;
    donor: { uri: string; fsPath: string; offset: number };
    baseFsPath: string;
    inheritedRef?: string;
    savedBytes: number;
    /** The server's ready-made one-line description, so both clients word a plan the same way. */
    label: string;
}

/** Mirror of the server's sweep answer (see server features/refactor/shared-base/shared-base.command.ts). */
interface SharedBaseScanResult {
    kind: 'scan';
    plans: SharedBasePlan[];
    filesScanned: number;
}

/** Mirror of the server's extraction answer (same module). */
interface SharedBaseApplyResult {
    kind: 'apply';
    created: string;
    /** Every file the workspace edit changed, so they can be saved and tidied away. */
    changedFiles: string[];
    tier: SharedBaseTier;
    files: number;
    fields: number;
    removedBytes: number;
    failure?: SharedBaseFailure;
}

/** Mirror of the server's preview answer (same module). */
interface SharedBasePreviewResult {
    kind: 'preview';
    diff: string;
    /** The changed files with their rewritten contents, capped by the server. */
    changed: DiffPreviewFile[];
    /** How many changed files did not fit in {@link SharedBasePreviewResult.changed}. */
    omitted: number;
    baseFsPath: string;
    tier: SharedBaseTier;
    files: number;
    fields: number;
    removedBytes: number;
    failure?: SharedBaseFailure;
}

/** Why an extraction did not happen, as the server words it. */
type SharedBaseFailure = 'planStale' | 'baseFileExists' | 'notEditable' | 'editRejected';

/** Mirror of the server's registration arguments (see server features/refactor/register-part/register-part.command.ts). */
interface RegisterPartArgs {
    uri: string;
    offset: number;
    ship?: string;
}

/** Mirror of one ship class the part could be registered in (same module). */
interface ShipCandidate {
    /** The identity the pick is sent back by. */
    key: string;
    groupName: string;
    id?: string;
    fsPath: string;
    target: 'workspace' | 'vanilla';
    via: 'shipFile' | 'modAction';
    alreadyRegistered: boolean;
    blocked?: 'partsInherited' | 'noPartsList' | 'notEditable' | 'noModRoot' | 'unreadable';
}

/** Mirror of the server's candidate report (same module). */
interface RegisterPartScanResult {
    kind: 'scan';
    partId?: string;
    partGroupName: string;
    candidates: ShipCandidate[];
    failure?: RegisterPartFailure;
}

/** Mirror of the server's registration answer (same module). */
interface RegisterPartApplyResult {
    kind: 'apply';
    shipFsPath: string;
    via: 'shipFile' | 'modAction';
    /** Every file the edit changed, so they can be saved and tidied away. */
    changedFiles: string[];
    reference: string;
    warning?: 'noPartId';
    failure?: RegisterPartFailure;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
}

/** Why a registration did nothing, as the server words it. */
type RegisterPartFailure =
    | 'stale'
    | 'noShipClasses'
    | 'unknownShip'
    | 'alreadyRegistered'
    | 'partsInherited'
    | 'noPartsList'
    | 'noModRoot'
    | 'ambiguousManifest'
    | 'notEditable'
    | 'editRejected';

/**
 * Mirror of the server's content kinds (see server
 * features/refactor/new-content/new-content.types.ts).
 */
type ContentKind = 'part' | 'resource' | 'bullet' | 'mediaEffect';

/** Mirror of what one content kind would do in the mod. */
interface ContentKindInfo {
    kind: ContentKind;
    folder: string;
    registration: 'ship' | 'manifest' | 'none';
    pointedAtBy?: string;
    blocked?: string;
}

/** Mirror of a ship class a new part could be registered in. */
interface NewContentShip {
    key: string;
    groupName: string;
    id?: string;
    fsPath: string;
    target: 'workspace' | 'vanilla';
    via: 'shipFile' | 'modAction';
    blocked?: string;
}

/** Mirror of the server's scan round. */
interface NewContentScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    idPrefix: string;
    kinds: ContentKindInfo[];
    ships: NewContentShip[];
    failure?: NewContentFailure;
}

/** Mirror of the server's apply round. */
interface NewContentApplyResult {
    kind: 'apply';
    created: string;
    contentKind: ContentKind;
    id: string;
    route: 'ship' | 'manifest' | 'none';
    registeredIn: string;
    registrationFailure?: string;
    manifests?: string[];
    changedFiles: string[];
    localizationKeys: string[];
    localizationFiles: string[];
    reference: string;
    pointedAtBy?: string;
    placeholderAssets: string[];
    failure?: NewContentFailure;
}

/** Mirror of why the server created nothing at all. */
type NewContentFailure =
    | 'noModRoot'
    | 'notEditable'
    | 'unknownKind'
    | 'invalidName'
    | 'pathTaken'
    | 'idTaken'
    | 'writeFailed';

/**
 * Mirror of the server's override arguments (see server
 * features/refactor/override-in-mod/override-in-mod.command.ts).
 */
interface OverrideInModArgs {
    uri: string;
    offset: number;
    mod?: string;
    shape?: 'inline' | 'file';
}

/** Mirror of one mod the override could be written into (same module). */
interface OverrideModCandidate {
    /** The identity the pick is sent back by. */
    key: string;
    name: string;
    modRoot: string;
    manifests: string[];
    alreadyOverridden: boolean;
    blocked?: 'ambiguousManifest' | 'notEditable';
}

/** Mirror of the server's candidate report (same module). */
interface OverrideInModScanResult {
    kind: 'scan';
    memberName: string;
    target: string;
    body: string;
    replacesContainer: boolean;
    candidates: OverrideModCandidate[];
    failure?: OverrideInModFailure;
}

/** Mirror of the server's answer once the action is written (same module). */
interface OverrideInModApplyResult {
    kind: 'apply';
    modRoot: string;
    manifestFsPath: string;
    /** The fragment file that was created, empty for the inline shape. */
    createdFsPath: string;
    changedFiles: string[];
    target: string;
    memberName: string;
    replacesContainer: boolean;
    failure?: OverrideInModFailure;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
}

/** Why an override did nothing, as the server words it. */
type OverrideInModFailure =
    | 'stale'
    | 'insideList'
    | 'indexSegment'
    | 'unnamedMember'
    | 'shadowedName'
    | 'emptyMember'
    | 'inheritedMember'
    | 'multiLineText'
    | 'scopeRelativeValue'
    | 'unrebasablePath'
    | 'untypablePath'
    | 'notVanilla'
    | 'stringsFile'
    | 'noGamePath'
    | 'noModRoot'
    | 'unknownMod'
    | 'ambiguousManifest'
    | 'notEditable'
    | 'alreadyOverridden'
    | 'editRejected'
    | 'writeFailed';

/**
 * What registering into a ship would do, shown under its entry in the picker.
 *
 * @param candidate the ship the server reported.
 * @returns the one-line detail.
 */
function shipCandidateDetail(candidate: ShipCandidate): string {
    if (candidate.alreadyRegistered) return l10n.t('Already listed in this ship');
    if (candidate.via === 'modAction') {
        return l10n.t("Patched in from this mod's manifest, so the game files stay untouched");
    }
    return l10n.t("Appended to this ship's own Parts list");
}

/**
 * Offer the ship classes the part can go into and let the user pick one.
 *
 * @param candidates the ship classes the server reported, in registry order.
 * @returns the picked ship, or undefined when none can take the part or the user backed out.
 */
async function pickShipCandidate(candidates: ShipCandidate[]): Promise<ShipCandidate | undefined> {
    const open = candidates.filter((candidate) => !candidate.blocked);
    if (open.length === 0) {
        window.showInformationMessage(
            l10n.t(
                'Cosmoteer: no ship class can take this part. Either none is loaded, or every one of them gets its Parts list from a base file, which this refactoring will not rewrite.'
            )
        );
        return undefined;
    }
    const picked = await window.showQuickPick(
        open.map((candidate) => ({
            label: candidate.id ?? candidate.groupName,
            description: workspace.asRelativePath(candidate.fsPath),
            detail: shipCandidateDetail(candidate),
            candidate,
        })),
        { placeHolder: l10n.t('Pick the ship class this part belongs to'), matchOnDescription: true }
    );
    return picked?.candidate;
}

/**
 * Say what the registration did, with the file it changed behind a button.
 *
 * @param result the server's registration summary.
 * @param cleanup what the tidy-up did.
 */
async function showRegisterPartSummary(result: RegisterPartApplyResult, cleanup?: ApplyCleanup): Promise<void> {
    if (cleanup?.unsaved.length) {
        window.showWarningMessage(
            l10n.t(
                'Cosmoteer: {0} files could not be saved and are still open with their changes. Save them yourself or undo.',
                cleanup.unsaved.length
            )
        );
    }
    const changed = result.changedFiles[0] ?? result.shipFsPath;
    const note =
        result.warning === 'noPartId'
            ? ` ${l10n.t('This part declares no ID yet, and the game will refuse to load it until it does.')}`
            : '';
    const message =
        result.via === 'modAction'
            ? l10n.t(
                  'Cosmoteer: added the part to {0} through an action in {1}.',
                  path.basename(result.shipFsPath),
                  workspace.asRelativePath(changed)
              )
            : l10n.t('Cosmoteer: added the part to {0}.', workspace.asRelativePath(changed));
    const open = l10n.t('Open File');
    const picked = await window.showInformationMessage(message + note, open);
    if (picked !== open) return;
    const doc = await workspace.openTextDocument(Uri.file(changed));
    await window.showTextDocument(doc, { preview: true });
}

/**
 * Say why a registration did not happen, one message per reason the server reports, each naming what
 * the user can do about it.
 *
 * @param failure the server's reason.
 * @param manifests the manifest names to choose between, only for `ambiguousManifest`.
 * @returns the message to show.
 */
function registerPartFailureMessage(failure: RegisterPartFailure, manifests?: string[]): string {
    switch (failure) {
        case 'stale':
            return l10n.t('Cosmoteer: the part has moved since the offer was made, so nothing was changed.');
        case 'noShipClasses':
            return l10n.t(
                "Cosmoteer: no ship class was found. Set the Cosmoteer game path so the game's own ships are read."
            );
        case 'unknownShip':
            return l10n.t('Cosmoteer: that ship class is no longer registered, so nothing was changed.');
        case 'alreadyRegistered':
            return l10n.t('Cosmoteer: that ship already lists this part, so nothing was changed.');
        case 'partsInherited':
            return l10n.t(
                'Cosmoteer: that ship gets its Parts list from a base file, which this refactoring will not rewrite.'
            );
        case 'noPartsList':
            return l10n.t('Cosmoteer: that ship declares no Parts list to add to, so nothing was changed.');
        case 'noModRoot':
            return l10n.t(
                "Cosmoteer: this part is in no mod, so there is no manifest to patch the game's ship from. Put it in a mod, or turn on cosmoteerLSPRules.allowEditingVanillaFiles."
            );
        case 'ambiguousManifest':
            return l10n.t(
                'Cosmoteer: this mod has several manifests and none of them is mod.rules, so which one gets the part is yours to decide. Candidates: {0}.',
                (manifests ?? []).join(', ')
            );
        case 'notEditable':
            return l10n.t('Cosmoteer: the file could not be edited, so nothing was changed.');
        case 'editRejected':
            return l10n.t('Cosmoteer: the editor turned down the edit, so nothing was changed.');
    }
}

/**
 * Create a new content file: ask what to create, what to call it and where to register it, then let
 * the server write it, wire it in and add its localization keys.
 *
 * @param client the language client the command runs through.
 */
async function createNewContent(client: LanguageClient): Promise<void> {
    const uri = window.activeTextEditor?.document.uri.toString() ?? workspace.workspaceFolders?.[0]?.uri.toString();
    if (!uri) {
        window.showInformationMessage(l10n.t('Cosmoteer: open the folder of your mod first.'));
        return;
    }
    const scan = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.newContent',
        arguments: [{ uri }],
    })) as NewContentScanResult | null;
    if (!scan || scan.failure) {
        window.showWarningMessage(
            scan?.failure
                ? newContentFailureMessage(scan.failure)
                : l10n.t('Cosmoteer: the mod could not be read, so nothing was created.')
        );
        return;
    }
    const kind = await pickContentKind(scan);
    if (!kind) return;
    const name = await window.showInputBox({
        title: l10n.t('Cosmoteer: New Content File'),
        prompt:
            kind.kind === 'resource' || !scan.idPrefix
                ? l10n.t('Name it. The file, its folder and its id are derived from this.')
                : l10n.t('Name it. The file, its folder and the id {0}.<name> are derived from this.', scan.idPrefix),
        validateInput: (value) =>
            /^[A-Za-z][A-Za-z0-9 _-]*$/.test(value.trim())
                ? undefined
                : l10n.t('Use letters, digits, spaces, underscores and dashes, starting with a letter.'),
    });
    if (!name) return;

    let ship: NewContentShip | 'skip' | undefined;
    if (kind.registration === 'ship') {
        ship = await pickNewContentShip(scan.ships);
        if (!ship) return;
    }
    // Captured before the write, so the tidy-up can tell the tabs the author had from the ones the
    // registration opened on its own.
    const openBefore = openDocumentPaths();
    const result = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.newContent',
        arguments: [
            {
                uri,
                kind: kind.kind,
                name,
                ship: ship && ship !== 'skip' ? ship.key : undefined,
                skipRegistration: ship === 'skip',
            },
        ],
    })) as NewContentApplyResult | null;
    if (!result) {
        window.showWarningMessage(l10n.t('Cosmoteer: nothing was created.'));
        return;
    }
    if (result.failure) {
        window.showWarningMessage(newContentFailureMessage(result.failure));
        return;
    }
    await saveAndTidy(result.changedFiles, openBefore);
    const document = await workspace.openTextDocument(Uri.file(result.created));
    await window.showTextDocument(document, { preview: false });
    await showNewContentSummary(result);
}

/**
 * Offer the content kinds, each saying where it goes and what will wire it in.
 *
 * @param scan the server's report for this mod.
 * @returns the picked kind, or undefined when the author backed out.
 */
async function pickContentKind(scan: NewContentScanResult): Promise<ContentKindInfo | undefined> {
    const labels: Record<ContentKind, string> = {
        part: l10n.t('Part'),
        resource: l10n.t('Resource'),
        bullet: l10n.t('Shot'),
        mediaEffect: l10n.t('Media effect'),
    };
    const picked = await window.showQuickPick(
        scan.kinds.map((info) => ({
            label: labels[info.kind],
            description: `${info.folder}/`,
            detail:
                info.pointedAtBy ??
                (info.blocked
                    ? l10n.t('Cannot be registered in this mod, so it will be created unwired')
                    : info.registration === 'ship'
                      ? l10n.t('Registered in a ship class you pick')
                      : l10n.t("Registered with an action in this mod's mod.rules")),
            info,
        })),
        { placeHolder: l10n.t('Pick what to create in {0}', scan.modId || workspace.asRelativePath(scan.modRoot)) }
    );
    return picked?.info;
}

/**
 * Offer the ship classes a new part could be registered in, plus the honest option of creating it
 * unregistered.
 *
 * @param ships the ship classes the server reported, in registry order.
 * @returns the picked ship, `skip` to create it unwired, or undefined when the author backed out.
 */
async function pickNewContentShip(ships: NewContentShip[]): Promise<NewContentShip | 'skip' | undefined> {
    const open = ships.filter((ship) => !ship.blocked);
    const items = [
        ...open.map((ship) => ({
            label: ship.id ?? ship.groupName,
            description: workspace.asRelativePath(ship.fsPath),
            detail:
                ship.via === 'modAction'
                    ? l10n.t("Patched in from this mod's manifest, so the game files stay untouched")
                    : l10n.t("Appended to this ship's own Parts list"),
            ship: ship as NewContentShip | undefined,
        })),
        {
            label: l10n.t('Do not register it yet'),
            description: '',
            detail: l10n.t('The file is created, and nothing will load it until a ship lists it'),
            ship: undefined as NewContentShip | undefined,
        },
    ];
    const picked = await window.showQuickPick(items, {
        placeHolder: l10n.t('Pick the ship class this part belongs to'),
        matchOnDescription: true,
    });
    if (!picked) return undefined;
    return picked.ship ?? 'skip';
}

/**
 * Say what was created and what still has to happen, which for a shot or a media effect is the whole
 * point: nothing in the game registers those, so the reference to paste is the answer.
 *
 * @param result the server's summary.
 */
async function showNewContentSummary(result: NewContentApplyResult): Promise<void> {
    const notes: string[] = [];
    if (result.route === 'none') {
        notes.push(result.pointedAtBy ?? l10n.t('Nothing references this file yet.'));
        notes.push(l10n.t('The reference to use is {0}.', result.reference));
    } else if (result.registrationFailure) {
        notes.push(newContentRegistrationMessage(result.registrationFailure, result.manifests));
        notes.push(l10n.t('The reference to use is {0}.', result.reference));
    } else {
        notes.push(l10n.t('Registered in {0}.', workspace.asRelativePath(result.registeredIn)));
    }
    if (result.localizationKeys.length > 0 && result.localizationFiles.length === 0) {
        notes.push(
            l10n.t(
                'This mod ships no language file, so {0} was not declared anywhere and the game will show no name.',
                result.localizationKeys[0]
            )
        );
    }
    if (result.placeholderAssets.length > 0) {
        notes.push(
            l10n.t(
                'It points at {0} for now, which is a file of the game you can replace with your own.',
                result.placeholderAssets[0]
            )
        );
    }
    window.showInformationMessage(
        [l10n.t('Cosmoteer: created {0}.', workspace.asRelativePath(result.created)), ...notes].join(' ')
    );
}

/**
 * Say why nothing was created, one message per reason the server reports.
 *
 * @param failure the server's reason.
 * @returns the message to show.
 */
function newContentFailureMessage(failure: NewContentFailure): string {
    switch (failure) {
        case 'noModRoot':
            return l10n.t('Cosmoteer: this folder is in no mod. Open a mod with a mod.rules manifest first.');
        case 'notEditable':
            return l10n.t(
                "Cosmoteer: this is the game's own data or somebody else's installed mod, which is not yours to add to."
            );
        case 'unknownKind':
            return l10n.t('Cosmoteer: that kind of content is not one this version can create.');
        case 'invalidName':
            return l10n.t(
                'Cosmoteer: that name leaves nothing usable behind. Use letters and digits, starting with a letter.'
            );
        case 'pathTaken':
            return l10n.t('Cosmoteer: a file or folder of that name is already there, so nothing was created.');
        case 'idTaken':
            return l10n.t(
                'Cosmoteer: that id is already declared, and two files with one id means the game keeps only one of them.'
            );
        case 'writeFailed':
            return l10n.t('Cosmoteer: the file could not be written, so nothing was created.');
    }
}

/**
 * Say why a created file was not wired in, which never stops the file from being created.
 *
 * @param failure the server's reason.
 * @param manifests the manifest names to choose between, only for `ambiguousManifest`.
 * @returns the message to show.
 */
function newContentRegistrationMessage(failure: string, manifests?: string[]): string {
    switch (failure) {
        case 'noShipChosen':
            return l10n.t('Nothing registers it yet, so no ship will build it until one lists it.');
        case 'alreadyRegistered':
            return l10n.t('It was already registered, so nothing was added twice.');
        case 'ambiguousManifest':
            return l10n.t(
                'This mod has several manifests and none of them is mod.rules, so which one gets it is yours to decide. Candidates: {0}.',
                (manifests ?? []).join(', ')
            );
        case 'manifestUnusable':
            return l10n.t(
                "This mod's Actions come from an included file, which cannot be appended to, so the action is yours to add."
            );
        case 'noGameRoot':
            return l10n.t('The Cosmoteer game path is unset, so where the registry lives could not be read.');
        case 'partsInherited':
            return l10n.t('That ship gets its Parts list from a base file, which is not rewritten.');
        case 'noPartsList':
            return l10n.t('That ship declares no Parts list to add to.');
        case 'editRejected':
            return l10n.t('The editor turned the registration down, so the file is not wired in yet.');
        default:
            return l10n.t('It could not be registered, so nothing loads it yet.');
    }
}

/**
 * Offer the mods the override can go into and let the user pick one.
 *
 * @param candidates the mods the server reported.
 * @returns the picked mod, or undefined when none can take it or the user backed out.
 */
async function pickOverrideMod(candidates: OverrideModCandidate[]): Promise<OverrideModCandidate | undefined> {
    const open = candidates.filter((candidate) => !candidate.blocked);
    if (open.length === 0) {
        window.showInformationMessage(
            l10n.t(
                'Cosmoteer: no mod in this workspace can take the override. Either there is none, or every one of them ships several manifests and which gets the override is yours to decide.'
            )
        );
        return undefined;
    }
    const picked = await window.showQuickPick(
        open.map((candidate) => ({
            label: candidate.name,
            description: workspace.asRelativePath(candidate.modRoot),
            detail: candidate.alreadyOverridden
                ? l10n.t('This mod already overrides that value')
                : l10n.t('The action is written into {0}', candidate.manifests[0] ?? 'mod.rules'),
            candidate,
        })),
        { placeHolder: l10n.t('Pick the mod this override belongs in'), matchOnDescription: true }
    );
    return picked?.candidate;
}

/**
 * Ask where the overridden value is written, which is only worth asking for a body big enough to
 * crowd the manifest. A single value always goes in the manifest itself.
 *
 * @param scan the server's report, which says whether the body is a whole group or list.
 * @returns the shape to write, or undefined when the user backed out.
 */
async function pickOverrideShape(scan: OverrideInModScanResult): Promise<'inline' | 'file' | undefined> {
    if (!scan.replacesContainer) return 'inline';
    const inline = l10n.t('Write it into mod.rules');
    const file = l10n.t('Keep it in its own file');
    const picked = await window.showQuickPick(
        [
            {
                label: inline,
                detail: l10n.t('The whole value is written into the action itself'),
                shape: 'inline' as const,
            },
            {
                label: file,
                detail: l10n.t('A file is created under "overrides" and the action points at it'),
                shape: 'file' as const,
            },
        ],
        { placeHolder: l10n.t('Where should the overridden value be written?') }
    );
    return picked?.shape;
}

/**
 * Say what the override did, with the file it changed behind a button.
 *
 * @param result the server's summary.
 * @param cleanup what the tidy-up did.
 */
async function showOverrideSummary(result: OverrideInModApplyResult, cleanup?: ApplyCleanup): Promise<void> {
    if (cleanup?.unsaved.length) {
        window.showWarningMessage(
            l10n.t(
                'Cosmoteer: {0} files could not be saved and are still open with their changes. Save them yourself or undo.',
                cleanup.unsaved.length
            )
        );
    }
    const changed = result.manifestFsPath;
    const note = result.replacesContainer
        ? ` ${l10n.t(
              'This replaces the whole of that group, so everything the game reads under it now comes from your copy.'
          )}`
        : '';
    const message = result.createdFsPath
        ? l10n.t(
              'Cosmoteer: added the override of {0} to {1}, with the value in {2}.',
              result.memberName,
              workspace.asRelativePath(changed),
              workspace.asRelativePath(result.createdFsPath)
          )
        : l10n.t(
              'Cosmoteer: added the override of {0} to {1}.',
              result.memberName,
              workspace.asRelativePath(changed)
          );
    const open = l10n.t('Open File');
    const picked = await window.showInformationMessage(message + note, open);
    if (picked !== open) return;
    const doc = await workspace.openTextDocument(Uri.file(changed));
    await window.showTextDocument(doc, { preview: true });
}

/**
 * Say why an override did not happen, one message per reason the server reports, each naming what
 * the user can do about it.
 *
 * @param failure the server's reason.
 * @param manifests the manifest names to choose between, only for `ambiguousManifest`.
 * @returns the message to show.
 */
function overrideInModFailureMessage(failure: OverrideInModFailure, manifests?: string[]): string {
    switch (failure) {
        case 'stale':
            return l10n.t('Cosmoteer: the value has moved since the offer was made, so nothing was changed.');
        case 'insideList':
            return l10n.t(
                'Cosmoteer: this value is inside a list, and the game addresses those by position, which another mod loading first renumbers. Override the whole list instead.'
            );
        case 'indexSegment':
        case 'untypablePath':
            return l10n.t(
                'Cosmoteer: the path to this value runs through a name the game reads as a position rather than as a name, so an override written for it could point somewhere else.'
            );
        case 'unnamedMember':
            return l10n.t('Cosmoteer: this value sits in a block with no name, so there is no path to write for it.');
        case 'shadowedName':
            return l10n.t(
                'Cosmoteer: another member of that group already answers to this name, so an override would change that one instead.'
            );
        case 'emptyMember':
            return l10n.t('Cosmoteer: this field has no value to copy, so nothing was changed.');
        case 'inheritedMember':
            return l10n.t(
                'Cosmoteer: this group has bases of its own, and an override replaces the whole of it, so copying only its body would drop what the bases supply.'
            );
        case 'multiLineText':
            return l10n.t(
                'Cosmoteer: this value carries text running across a line break, which cannot be copied safely.'
            );
        case 'scopeRelativeValue':
            return l10n.t(
                'Cosmoteer: this value reads something around it, with "~", "^", ":" or a bare name, so it would mean something else from your mod.'
            );
        case 'unrebasablePath':
            return l10n.t(
                'Cosmoteer: a path in this value could not be rewritten to read from the game folder, so an override would point at nothing.'
            );
        case 'notVanilla':
            return l10n.t(
                'Cosmoteer: this file is not one of the game install, so edit it directly rather than overriding it.'
            );
        case 'stringsFile':
            return l10n.t(
                'Cosmoteer: language files cannot be changed by an action. Ship your own file for that language instead.'
            );
        case 'noGamePath':
            return l10n.t('Cosmoteer: set the Cosmoteer game path so the override can name the file it changes.');
        case 'noModRoot':
            return l10n.t(
                'Cosmoteer: this workspace holds no mod, so there is no manifest to write the override into.'
            );
        case 'unknownMod':
            return l10n.t('Cosmoteer: that mod is no longer in the workspace, so nothing was changed.');
        case 'ambiguousManifest':
            return l10n.t(
                'Cosmoteer: this mod has several manifests and none of them is mod.rules, so which one gets the override is yours to decide. Candidates: {0}.',
                (manifests ?? []).join(', ')
            );
        case 'notEditable':
            return l10n.t('Cosmoteer: the manifest could not take another action, so nothing was changed.');
        case 'alreadyOverridden':
            return l10n.t('Cosmoteer: this mod already overrides that value, so nothing was changed.');
        case 'editRejected':
            return l10n.t('Cosmoteer: the editor turned down the edit, so nothing was changed.');
        case 'writeFailed':
            return l10n.t('Cosmoteer: the file holding the override could not be written, so nothing was changed.');
    }
}

/**
 * Offer the sweep's extractions and let the user pick one to look at.
 *
 * @param plans the plans the sweep reported, already ranked by how much duplication each removes.
 * @returns the picked plan, or undefined when the user backed out.
 */
async function pickSharedBasePlan(plans: SharedBasePlan[]): Promise<SharedBasePlan | undefined> {
    const picked = await window.showQuickPick(
        plans.map((plan) => ({
            label: plan.label,
            description: plan.className,
            detail: l10n.t(
                '{0}, removes {1} bytes of duplicated source',
                workspace.asRelativePath(plan.baseFsPath),
                plan.savedBytes
            ),
            plan,
        })),
        {
            placeHolder: l10n.t('Move fields several files of this mod repeat word for word into one shared base file'),
            matchOnDetail: true,
        }
    );
    return picked?.plan;
}

/**
 * The whole extraction exchange: work out what the plan would do, show it as a real diff, and apply
 * it only once the user says so. Shared by the palette command and the lightbulb, which the
 * middleware reroutes here so both get the editor's own diff rather than a patch to read.
 *
 * @param plan the plan to preview and apply.
 * @param provider the content provider the rewritten files are served from.
 * @returns once the extraction happened or the user backed out.
 */
async function previewAndApplySharedBase(plan: SharedBasePlan, provider: DiffPreviewProvider): Promise<void> {
    // Captured before the preview, not after: the diff opens the real file on its left-hand side, so
    // by the time it is on screen those files count as open and the tidy-up would leave them behind.
    const openBefore = openDocumentPaths();
    const preview = (await client.sendRequest(ExecuteCommandRequest.type, {
        command: 'cosmoteer.extractSharedBase',
        arguments: [{ plan, preview: true }],
    })) as SharedBasePreviewResult | null;
    if (!preview || preview.failure) {
        window.showWarningMessage(
            preview?.failure
                ? sharedBaseFailureMessage(preview.failure)
                : l10n.t('Cosmoteer shared base: the preview could not be built, nothing was changed.')
        );
        return;
    }
    const title = l10n.t('Shared base: {0}', path.basename(preview.baseFsPath));
    if (preview.changed.length > 0) await showDiffPreview(provider, plan.id, preview.changed, title);
    else await showPatchPreview(provider, plan.id, preview.diff);

    if (!(await confirmSharedBaseRewrite(preview))) return;
    const result = await window.withProgress(
        { location: ProgressLocation.Notification, title: l10n.t('Extracting {0}', path.basename(preview.baseFsPath)) },
        async () =>
            (await client.sendRequest(ExecuteCommandRequest.type, {
                command: 'cosmoteer.extractSharedBase',
                arguments: [{ plan }],
            })) as SharedBaseApplyResult | null
    );
    if (!result) {
        window.showWarningMessage(l10n.t('Cosmoteer shared base: the extraction failed, nothing was changed.'));
        return;
    }
    // A workspace edit over hundreds of files leaves every one of them open and unsaved, which is
    // not a state to hand back to anybody.
    const cleanup = result.failure ? undefined : await saveAndTidy(result.changedFiles, openBefore);
    await showSharedBaseSummary(result, cleanup);
}

/**
 * Have the user confirm the rewrite whose diff is now open beside the editor. Worth its click
 * because applying a plan writes or extends a file and edits every file that inherits it.
 *
 * @param preview the server's account of what the rewrite would do.
 * @returns true when the user asked for it to happen.
 */
async function confirmSharedBaseRewrite(preview: SharedBasePreviewResult): Promise<boolean> {
    const extract = l10n.t('Extract');
    const baseName = path.basename(preview.baseFsPath);
    const confirmed = await window.showInformationMessage(
        preview.tier === 'existingBase'
            ? l10n.t('Move {0} fields into {1}, the base those {2} files already inherit?', preview.fields, baseName, preview.files)
            : l10n.t('Create {0} and rewrite {1} files to inherit it?', baseName, preview.files),
        {
            modal: true,
            detail:
                preview.omitted > 0
                    ? l10n.t(
                          'The open diff shows {0} of the changed files. In total {1} fields leave {2} files, removing {3} bytes of duplicated source.',
                          preview.changed.length,
                          preview.fields,
                          preview.files,
                          preview.removedBytes
                      )
                    : l10n.t(
                          'The open diff is the whole change: {0} fields leave {1} files, removing {2} bytes of duplicated source.',
                          preview.fields,
                          preview.files,
                          preview.removedBytes
                      ),
        },
        extract
    );
    return confirmed === extract;
}

/**
 * Render the extraction outcome: a one-line information message, with the new base file behind a
 * button, or the reason nothing was changed.
 *
 * @param result the server's extraction summary.
 */
async function showSharedBaseSummary(result: SharedBaseApplyResult, cleanup?: ApplyCleanup): Promise<void> {
    if (result.failure) {
        window.showWarningMessage(sharedBaseFailureMessage(result.failure));
        return;
    }
    if (cleanup?.unsaved.length) {
        window.showWarningMessage(
            l10n.t(
                'Cosmoteer shared base: {0} files could not be saved and are still open with their changes. Save them yourself or undo.',
                cleanup.unsaved.length
            )
        );
    }
    const open = l10n.t('Open Base File');
    const tidied = cleanup?.saved
        ? ` ${l10n.t('{0} files saved, {1} tabs closed.', cleanup.saved, cleanup.closed)}`
        : '';
    const picked = await window.showInformationMessage(
        (result.tier === 'existingBase'
            ? l10n.t(
                  'Cosmoteer shared base: moved {1} fields into {0}, out of {2} files, removed {3} bytes.',
                  workspace.asRelativePath(result.created),
                  result.fields,
                  result.files,
                  result.removedBytes
              )
            : l10n.t(
                  'Cosmoteer shared base: created {0}, moved {1} fields out of {2} files, removed {3} bytes.',
                  workspace.asRelativePath(result.created),
                  result.fields,
                  result.files,
                  result.removedBytes
              )) + tidied,
        open
    );
    if (picked !== open) return;
    const doc = await workspace.openTextDocument(Uri.file(result.created));
    await window.showTextDocument(doc, { preview: true });
}

/**
 * Say why an extraction did not happen, one message per reason the server reports, each naming what
 * the user can do about it.
 *
 * @param failure the server's reason.
 * @returns the message to show.
 */
function sharedBaseFailureMessage(failure: SharedBaseFailure): string {
    switch (failure) {
        case 'planStale':
            return l10n.t(
                'Cosmoteer shared base: those files no longer write the same fields, so nothing was changed. Run the command again to search the current text.'
            );
        case 'baseFileExists':
            return l10n.t(
                'Cosmoteer shared base: a file of that name already sits next to those files, so nothing was changed. Rename or remove it and run the command again.'
            );
        case 'notEditable':
            return l10n.t(
                'Cosmoteer shared base: the base file could not be written, so nothing was changed. Check that its folder is writable.'
            );
        case 'editRejected':
            return l10n.t(
                'Cosmoteer shared base: the editor turned down the rewrite, so the base file was removed again and nothing was changed.'
            );
    }
}

/**
 * Cosmoteer `.shader` files are HLSL, but VS Code's built-in ShaderLab support also claims the
 * `.shader` extension (for Unity), so in a mixed setup a shader can open as `shaderlab`, which means
 * no Cosmoteer highlighting and no server features (our language never activates for it). Since this
 * extension only activates in a Cosmoteer project (a workspace with `.rules` files), we reassign such
 * files to the Cosmoteer Shader language on open so the user does not have to pick it by hand.
 *
 * It is deliberately conservative: it only reassigns files that opened under a generic claimant
 * (`shaderlab` or `plaintext`), never a language the user chose themselves, and it honours the
 * `cosmoteerLSPRules.associateShaderFiles` opt-out for anyone editing Unity shaders in the same window.
 *
 * @param context the extension context, used to dispose the open-document listener on shutdown.
 */
function claimShaderFiles(context: ExtensionContext): void {
    // The languages a `.shader` file may open under that we are willing to override.
    const GENERIC_CLAIMANTS = new Set(['shaderlab', 'plaintext']);
    const claim = (document: TextDocument): void => {
        if (!workspace.getConfiguration('cosmoteerLSPRules').get<boolean>('associateShaderFiles', true)) return;
        if (!document.fileName.toLowerCase().endsWith('.shader')) return;
        if (document.languageId === 'cosmoteer-shader' || !GENERIC_CLAIMANTS.has(document.languageId)) return;
        void languages.setTextDocumentLanguage(document, 'cosmoteer-shader');
    };
    workspace.textDocuments.forEach(claim);
    context.subscriptions.push(workspace.onDidOpenTextDocument(claim));
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
