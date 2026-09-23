// What the connected client can do, written once at `initialize` and read everywhere afterwards.
// It sits beside `settings.ts` at the server root for the same reason that file does: every layer
// branches on one of these flags, so putting them inside a layer would make the readers below it
// reach upward for a value that is settled before any of them runs.
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
/** Does the client take an insert/replace edit pair and pick between them with its own insert mode? */
export let hasInsertReplaceCapability = false;
/** Does the client pull diagnostics itself (`textDocument/diagnostic`)? */
export let hasPullDiagnosticsCapability = false;
/** Does the client resolve completion documentation lazily? */
export let hasCompletionDocResolveCapability = false;
/**
 * Does the client run the server's snippet command, so a code action can leave the caret on a tab
 * stop? Announced through `initializationOptions` rather than through a capability, since the
 * protocol has no field for it: a code action's edit cannot carry a tab stop, so the offer is only
 * made in that form to a client that has said it registers the command.
 */
export let hasSnippetCodeActionCapability = false;

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
    hasInsertReplaceCapability = !!capabilities.textDocument?.completion?.completionItem?.insertReplaceSupport;
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

/**
 * Reads the options a client sends beside its capabilities, which is where anything the protocol
 * has no field for is announced.
 *
 * @param options the `initializationOptions` the client sent with `initialize`.
 */
export function readInitializationOptions(options: unknown): void {
    const declared = (options as { snippetCodeActions?: unknown } | null | undefined)?.snippetCodeActions;
    hasSnippetCodeActionCapability = declared === true;
}
