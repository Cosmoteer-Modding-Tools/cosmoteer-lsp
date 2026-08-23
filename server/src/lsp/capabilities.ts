import { ClientCapabilities } from 'vscode-languageserver/node';

/** Does the client support `workspace/configuration`? Without it, global settings are the answer. */
export let hasConfigurationCapability = false;
/** Does the client report its workspace folders? */
export let hasWorkspaceFolderCapability = false;
/** Does the client render related information on a diagnostic? */
export let hasDiagnosticRelatedInformationCapability = false;
/** Can the client watch files on disk for us? */
export let hasDidChangeWatchedFilesCapability = false;
/** Does the client render snippet (`$1`/`${1:…}`) insert text in completions? */
export let hasSnippetCapability = false;
/** Does the client pull diagnostics itself (`textDocument/diagnostic`)? */
export let hasPullDiagnosticsCapability = false;
/** Does the client resolve completion documentation lazily? */
export let hasCompletionDocResolveCapability = false;

/**
 * Reads the capability flags the rest of the server branches on out of the client's announcement.
 * The flags live here rather than beside the initialize handler because nearly every feature reads
 * one of them and none of them writes.
 *
 * @param capabilities the capabilities the client sent with `initialize`.
 */
export function readClientCapabilities(capabilities: ClientCapabilities): void {
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
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
    hasCompletionDocResolveCapability =
        !!capabilities.textDocument?.completion?.completionItem?.resolveSupport?.properties?.includes('documentation');
}
