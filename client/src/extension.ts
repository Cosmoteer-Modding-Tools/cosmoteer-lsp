import * as path from 'path';
import { workspace, ExtensionContext, l10n, commands, languages, TextDocument, MarkdownString } from 'vscode';
import { COSMOTEER_METHOD } from '../../shared/lsp-methods';

import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { SharedDiagnosticCollectionProvider } from './diagnostic-collection';
import { DIFF_PREVIEW_SCHEME, DiffPreviewProvider } from './preview/diff-preview';
import { setPreviewScheme } from './shared-base/apply-cleanup';
import { registerWorkspaceValidation } from './workspace-validation/workspace-validation';
import { registerNewContent } from './new-content/new-content';
import { registerNewMod } from './new-mod/new-mod';
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
import { registerShaderPreview } from './shader-preview/shader-preview';
import { registerPartEditor } from './part-editor/part-editor';
import { registerModOverview } from './mod-overview/mod-overview.registrar';
import { registerPartWiring } from './part-wiring/part-wiring.registrar';
import { registerEffectiveGroup } from './effective-group/effective-group.registrar';
import { registerBaseDiff } from './base-diff/base-diff.registrar';
import { registerShipBlueprint } from './ships/ship-blueprint.registrar';
import { registerWizards } from './wizards/wizards.registrar';
import { registerDiagrams } from './diagram/diagram.registrar';
import { registerPartTable } from './part-table/part-table.registrar';
import { registerReferenceTrace } from './reference-trace/reference-trace.registrar';
import { registerSchemaSearch } from './schema-search/schema-search.registrar';
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

    client.onRequest(COSMOTEER_METHOD.openSettings, async (params) => {
        await commands.executeCommand('workbench.action.openSettings2', params);
    });

    registerWorkspaceValidation(context, client);

    // The part table follows the files: after a change that makes the last table stale, the open
    // table asks for its rows again.
    // The side-by-side diff a refactoring shows before it rewrites anything, served from one provider
    // the shared-base extraction, the migration and the clone all write into.
    const diffPreviewProvider = new DiffPreviewProvider();
    setPreviewScheme(DIFF_PREVIEW_SCHEME);
    context.subscriptions.push(workspace.registerTextDocumentContentProvider(DIFF_PREVIEW_SCHEME, diffPreviewProvider));

    // Every command that asks the author something before the server writes anything lives in a
    // module of its own, and each registers what it contributes.
    registerShaderPreview(context, client);
    registerPartEditor(context, client);
    registerModOverview(context, client);
    registerPartWiring(context, client);
    registerEffectiveGroup(context, client);
    registerBaseDiff(context, client);
    registerShipBlueprint(context, client);
    registerWizards(context, client);
    registerDiagrams(context, client);
    registerPartTable(context, client);
    registerReferenceTrace(context, client);
    registerSchemaSearch(context, client);
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
