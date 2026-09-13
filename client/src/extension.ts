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
} from 'vscode';

import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
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
import { BASE_DIFF_SCHEME, BaseDiffContentProvider, showBaseDiff } from './base-diff/base-diff';
import { DiagramPanel } from './diagram/diagram-panel';
import { PartTablePanel } from './part-table/table-panel';
import { SHIP_BLUEPRINT_SCHEME, ShipBlueprintContentProvider, showShipBlueprint } from './ships/ship-blueprint';
import {
    ADD_SHIP_TO_FACTION_COMMAND,
    addShipToFaction,
    createNewFaction,
    NEW_FACTION_LOCAL_COMMAND,
} from './ships/faction-wizard';
import { createNewNebula, NEW_NEBULA_LOCAL_COMMAND } from './wizards/nebula-wizard';
import { createNewGalaxySize, NEW_GALAXY_SIZE_LOCAL_COMMAND } from './wizards/galaxy-size-wizard';
import { NEW_MENU_LOCAL_COMMAND, showNewMenu } from './wizards/new-menu';
import { createNewAsteroidType, NEW_ASTEROID_TYPE_LOCAL_COMMAND } from './wizards/asteroid-type-wizard';
import { createNewPlanet, NEW_PLANET_LOCAL_COMMAND } from './wizards/planet-wizard';
import { createTradeGood, TRADE_GOOD_LOCAL_COMMAND } from './wizards/trade-good-wizard';
import { createNewTech, NEW_TECH_LOCAL_COMMAND } from './wizards/tech-wizard';
import {
    REFERENCE_TRACE_SCHEME,
    ReferenceTraceContentProvider,
    showReferenceTrace,
} from './reference-trace/reference-trace';
import { SCHEMA_DOC_SCHEME, SchemaDocContentProvider, showSchemaSearch } from './schema-search/schema-search';
import { DIFF_PREVIEW_SCHEME, DiffPreviewProvider } from './preview/diff-preview';
import { setPreviewScheme } from './shared-base/apply-cleanup';
import { registerWorkspaceValidation } from './workspace-validation/workspace-validation';
import { ContentKind, createNewContent, registerNewContent } from './new-content/new-content';
import { createNewMod, registerNewMod } from './new-mod/new-mod';
import { registerMigration } from './migration/migration';
import { registerGameLog } from './game-log/game-log';
import { registerRunGame } from './run-game/run-game';
import { registerModSchema } from './mod-schema/mod-schema';
import { registerSharedBase } from './shared-base/shared-base';
import { registerExtractGroup } from './extract-group/extract-group';
import { registerSnippetActions } from './snippets/snippet-actions';
import { registerLocalizationKey } from './localization-key/localization-key';
import { registerPartRegistration } from './register-part/register-part';
import { registerOverrideInMod } from './override-in-mod/override-in-mod';
import { registerCloneDeclaration } from './clone-declaration/clone-declaration';
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

    registerWorkspaceValidation(context, client);

    // The part table follows the files: after a change that makes the last table stale, the open
    // table asks for its rows again.
    client.onNotification('cosmoteer/partTableChanged', () => PartTablePanel.notifyChanged());
    client.onNotification('cosmoteer/partTableProgress', (progress: { done: number; total: number }) =>
        PartTablePanel.notifyProgress(progress.done, progress.total)
    );

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

    // Base diff: one command rendering what the group under the cursor loads differently from the
    // nearest base of it the game ships itself.
    const baseDiffProvider = new BaseDiffContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(BASE_DIFF_SCHEME, baseDiffProvider),
        commands.registerCommand('cosmoteer.diffAgainstBase', async (uri?: Uri, position?: Position) => {
            await showBaseDiff(client, baseDiffProvider, uri, position);
        })
    );

    // Ship blueprints: what a `.ship.png` places, read out of the low bits of the picture.
    const blueprintProvider = new ShipBlueprintContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(SHIP_BLUEPRINT_SCHEME, blueprintProvider),
        commands.registerCommand('cosmoteer.showShipBlueprint', async (uri?: Uri) => {
            await showShipBlueprint(client, blueprintProvider, uri);
        })
    );

    // Saved ships into a faction, and the faction itself. The server judges each ship the way the
    // game does and writes every file; these wrappers ask which faction and whether the suggestions
    // stand, which are the only two questions a tool cannot answer.
    context.subscriptions.push(
        commands.registerCommand(ADD_SHIP_TO_FACTION_COMMAND, async (uri?: Uri, uris?: Uri[]) => {
            await addShipToFaction(context, client, uri, uris);
        }),
        commands.registerCommand(NEW_FACTION_LOCAL_COMMAND, async () => {
            await createNewFaction(context, client);
        }),
        commands.registerCommand(NEW_NEBULA_LOCAL_COMMAND, async () => {
            await createNewNebula(context, client);
        }),
        commands.registerCommand(NEW_GALAXY_SIZE_LOCAL_COMMAND, async () => {
            await createNewGalaxySize(context, client);
        }),
        commands.registerCommand(NEW_ASTEROID_TYPE_LOCAL_COMMAND, async () => {
            await createNewAsteroidType(context, client);
        }),
        commands.registerCommand(NEW_PLANET_LOCAL_COMMAND, async () => {
            await createNewPlanet(context, client);
        }),
        commands.registerCommand(TRADE_GOOD_LOCAL_COMMAND, async () => {
            await createTradeGood(context, client);
        }),
        commands.registerCommand(NEW_TECH_LOCAL_COMMAND, async () => {
            await createNewTech(context, client);
        }),
        // One entry for all of it, the way an IDE's New submenu works: from the palette, from a
        // folder's context menu and from the editor, with that folder or file as the mod to write
        // into.
        commands.registerCommand(NEW_MENU_LOCAL_COMMAND, async (uri?: Uri) => {
            const anchor = uri?.toString();
            await showNewMenu({
                newMod: () => createNewMod(client),
                newContent: (kind) => createNewContent(client, { uri: anchor, kind: kind as ContentKind }),
                newFaction: async () => {
                    await createNewFaction(context, client, anchor);
                },
                addShipsToFaction: () => addShipToFaction(context, client, uri),
                newNebula: () => createNewNebula(context, client, anchor),
                newGalaxySize: () => createNewGalaxySize(context, client, anchor),
                newAsteroidType: () => createNewAsteroidType(context, client, anchor),
                newPlanet: () => createNewPlanet(context, client, anchor),
                tradeGood: () => createTradeGood(context, client, anchor),
                newTech: () => createNewTech(context, client, anchor),
            });
        })
    );

    // Diagrams: two drawn views sharing one panel. A part's resource wiring and its firing chain are
    // each a graph, and a graph is the shape none of the reports could take.
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.showResourceFlow', async (uri?: Uri, position?: Position) => {
            await showDiagram(
                {
                    method: 'cosmoteer/resourceFlowDiagram',
                    title: l10n.t('Resource Flow'),
                    missing: l10n.t('No diagram available: the cursor is not inside a part that carries resources.'),
                },
                uri,
                position
            );
        }),
        commands.registerCommand('cosmoteer.showEffectChain', async (uri?: Uri, position?: Position) => {
            await showDiagram(
                {
                    method: 'cosmoteer/effectChainDiagram',
                    title: l10n.t('Firing Chain'),
                    missing: l10n.t('No diagram available: the cursor is not inside a part that fires anything.'),
                },
                uri,
                position
            );
        })
    );

    /**
     * Opens one of the drawn views for the active editor's caret.
     *
     * @param request which diagram to draw.
     * @param uri the file's uri, or undefined to use the active editor.
     * @param position the caret, or undefined to use the active editor's.
     */
    async function showDiagram(
        request: { method: string; title: string; missing: string },
        uri?: Uri,
        position?: Position
    ): Promise<void> {
        const editor = window.activeTextEditor;
        const targetUri = uri ?? editor?.document.uri;
        const targetPosition = position ?? editor?.selection.active ?? new Position(0, 0);
        if (!targetUri) return;
        await DiagramPanel.show(context, client, request, targetUri, targetPosition);
    }

    // Part table: every part of the game and of the mod being edited side by side, with the fields
    // they carry resolved to the numbers the game computes, sortable, filterable and comparable.
    context.subscriptions.push(
        commands.registerCommand('cosmoteer.compareParts', async (uri?: Uri) => {
            await PartTablePanel.show(context, client, uri ?? window.activeTextEditor?.document.uri);
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

    // The side-by-side diff a refactoring shows before it rewrites anything, served from one provider
    // the shared-base extraction, the migration and the clone all write into.
    const diffPreviewProvider = new DiffPreviewProvider();
    setPreviewScheme(DIFF_PREVIEW_SCHEME);
    context.subscriptions.push(workspace.registerTextDocumentContentProvider(DIFF_PREVIEW_SCHEME, diffPreviewProvider));

    // Every command that asks the author something before the server writes anything lives in a
    // module of its own, and each registers what it contributes.
    registerNewContent(context, client);
    registerNewMod(context, client);
    registerMigration(context, client, diffPreviewProvider);
    registerGameLog(context, client);
    registerRunGame(context, client);
    registerModSchema(context, client);
    registerSharedBase(context, client, diffPreviewProvider);
    registerExtractGroup(context, client);
    registerSnippetActions(context, client);
    registerLocalizationKey(context, client);
    registerPartRegistration(context, client);
    registerOverrideInMod(context, client);
    registerCloneDeclaration(context, client, diffPreviewProvider);

    return client.start();
}

// The command id schema-hover "Open in decompiler" links invoke. The language client registers
// the VS Code command itself from the server's `executeCommandProvider` capability and forwards
// invocations to the server (which finds and spawns the decompiler), so the extension must not
// register it too. This constant only feeds the `enabledCommands` trust list in the hover
// middleware and must match the server's decompiler-link module.
const OPEN_IN_DECOMPILER_COMMAND = 'cosmoteer.openInDecompiler';

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
