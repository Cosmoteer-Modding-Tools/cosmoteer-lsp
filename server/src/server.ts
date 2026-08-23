import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import * as l10n from '@vscode/l10n';
import { CosmoteerWorkspaceService } from './workspace/cosmoteer-workspace.service';
import { connection, documents, initServerContext } from './lsp/context';
import * as codeActionHandlers from './lsp/handlers/code-action.handlers';
import * as commandHandlers from './lsp/handlers/command.handlers';
import * as completionHandlers from './lsp/handlers/completion.handlers';
import * as customRequestHandlers from './lsp/handlers/custom-request.handlers';
import * as documentSyncHandlers from './lsp/handlers/document-sync.handlers';
import * as lifecycleHandlers from './lsp/handlers/lifecycle.handlers';
import * as navigationHandlers from './lsp/handlers/navigation.handlers';
import * as presentationHandlers from './lsp/handlers/presentation.handlers';
import * as watchedFilesHandlers from './lsp/handlers/watched-files.handlers';

// Re-exported for backwards compatibility with modules that imported these from './server'.
export { MAX_NUMBER_OF_PROBLEMS, globalSettings } from './settings';

if (process.env['EXTENSION_BUNDLE_PATH']) {
    l10n.config({
        fsPath: process.env['EXTENSION_BUNDLE_PATH'],
    });
}

initServerContext(createConnection(ProposedFeatures.all));
CosmoteerWorkspaceService.instance.setConnection(connection);

// Each feature area registers its own handlers on the connection. The order is presentational
// only: the protocol dispatches by method name, so no registration depends on another. What every
// module here does depend on is the connection above, which is why it is published first.
lifecycleHandlers.register();
documentSyncHandlers.register();
watchedFilesHandlers.register();
completionHandlers.register();
navigationHandlers.register();
codeActionHandlers.register();
commandHandlers.register();
customRequestHandlers.register();
presentationHandlers.register();

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
