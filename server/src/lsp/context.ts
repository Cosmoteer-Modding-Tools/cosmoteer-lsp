import { Connection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceTokenManager } from '../workspace/token-manager';

/**
 * The connection to the client, set once by {@link initServerContext} before any handler is
 * registered. It is a module binding rather than a parameter threaded through every feature: the
 * whole server talks to one client, and the alternative is an extra argument on several hundred
 * call sites that could never hold anything else.
 */
export let connection: Connection;

/** The text document manager, which mirrors the client's open buffers. */
export const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

/** Per-document cancellation, so a newer request supersedes the one it overtakes. */
export const tokenSourceManager = new WorkspaceTokenManager();

/**
 * Publishes the connection every feature module reads. Called once from the entry point, before
 * the handler modules register anything on it.
 *
 * @param value the connection the entry point created.
 */
export function initServerContext(value: Connection): void {
    connection = value;
}
