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
 * `.shader` extension (for Unity), so in a mixed setup a shader can open as `shaderlab` — which means
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
