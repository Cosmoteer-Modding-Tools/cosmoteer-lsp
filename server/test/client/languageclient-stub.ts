/**
 * Enough of the language client for a client module to be imported outside the extension host.
 *
 * The real package is CommonJS and calls `require('vscode')` as it loads, which no alias on the
 * editor's own module can reach, so the package itself is mapped here. A client module under test
 * only ever names the request type and the client's type, and the test hands it a stand-in client of
 * its own, so nothing here has to do any work.
 */

/** The request a client sends to run a server command. Only its `type` is ever read. */
export const ExecuteCommandRequest = { type: 'workspace/executeCommand' };

/** The client a module is handed. A test passes its own object, so this is a name, not a class. */
export declare class LanguageClient {
    public sendRequest(...args: unknown[]): Promise<unknown>;
}
