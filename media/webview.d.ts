// The globals the webview pages are handed by their host, which is VS Code natively and the
// JetBrains plugin through the shim it injects ahead of the page's script. They are declared here
// so the modules under src/ type-check in an editor without carrying a suppression at the top of
// every file.

/** The host bridge a page posts its messages through and reads its kept state from. */
interface CosmoteerWebviewApi {
    /**
     * Sends a message to the host.
     *
     * @param message the message, which has to survive being serialized.
     */
    postMessage(message: unknown): void;
    /**
     * The state the host kept for the page.
     *
     * @returns the state, undefined when the page has kept none.
     */
    getState(): unknown;
    /**
     * Keeps state for the page, which a hidden and restored webview gets back.
     *
     * @param state the state to keep.
     */
    setState(state: unknown): void;
}

/**
 * The host bridge, provided once per page.
 *
 * @returns the bridge.
 */
declare function acquireVsCodeApi(): CosmoteerWebviewApi;

interface Window {
    /** The localized text the panel writes ahead of the page's script, keyed by its English source. */
    cosmoteerStrings?: Record<string, string>;
}
