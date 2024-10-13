import * as path from 'path';
import { workspace, ExtensionContext, l10n, commands } from 'vscode';

import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
    // The server is implemented in node
    const serverModule = context.asAbsolutePath(path.join('out', 'server', 'src', 'server.js'));

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

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'rules' }],
        synchronize: {
            // Notify the server about file changes to '.clientrc files contained in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
        },
        progressOnInitialization: true,
    };

    client = new LanguageClient('cosmoteer lsp', 'Cosmoteer Language Server', serverOptions, clientOptions);

    client.onRequest('cosmoteer/openSettings', async (params) => {
        await commands.executeCommand('workbench.action.openSettings2', params);
    });

    client.start();
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
