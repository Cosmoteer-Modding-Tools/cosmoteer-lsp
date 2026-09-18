import { commands, ExtensionContext, Position, Uri, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { REFERENCE_TRACE_SCHEME, ReferenceTraceContentProvider, showReferenceTrace } from './reference-trace';

/**
 * Registers the reference trace: one command that walks the reference under the cursor and says
 * which segment stopped it and what the game really has there.
 *
 * No CodeLens and no hover: a reference is far too common for a lens, and the walk crosses files, so
 * it runs only when it is asked for.
 *
 * @param context the extension context the registrations are disposed with.
 * @param client the language client the trace is walked by.
 */
export function registerReferenceTrace(context: ExtensionContext, client: LanguageClient): void {
    const provider = new ReferenceTraceContentProvider();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(REFERENCE_TRACE_SCHEME, provider),
        commands.registerCommand('cosmoteer.explainReference', async (uri?: Uri, position?: Position) => {
            await showReferenceTrace(client, provider, uri, position);
        })
    );
}
