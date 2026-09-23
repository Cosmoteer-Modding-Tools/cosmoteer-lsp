import { Disposable, ExtensionContext, Uri, ViewColumn, Webview, WebviewPanel, window } from 'vscode';
import { readFileSync, statSync } from 'fs';
import { randomUUID } from 'crypto';

/**
 * A scripted webview panel that keeps its page alive while hidden and may load the bundled `media`
 * assets. Anything else a page shows (a game image, a texture) is inlined as a data URI, since it
 * lives outside any workspace folder a resource grant could cover.
 *
 * @param context the extension context, whose `media` folder the page may load from.
 * @param viewType the panel's view type.
 * @param title the tab title.
 * @param column where the panel opens.
 * @returns the panel.
 */
export const createCosmoteerPanel = (
    context: ExtensionContext,
    viewType: string,
    title: string,
    column: ViewColumn
): WebviewPanel =>
    window.createWebviewPanel(viewType, title, column, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [Uri.joinPath(context.extensionUri, 'media')],
    });

/**
 * Disposes a panel's listeners and empties the list, for the panel's own teardown.
 *
 * @param disposables the listeners, emptied in place.
 */
export const disposeAll = (disposables: Disposable[]): void => {
    for (const disposable of disposables) disposable.dispose();
    disposables.length = 0;
};

/**
 * Webview helpers shared by the shader preview and the part grid editor: inlining game images as
 * data URIs (their files live outside any workspace folder, so a localResourceRoots grant cannot
 * cover them) and the content-security-policy nonce.
 */

/** The image kinds the webviews can inline, keyed by file extension. */
const IMAGE_MIME: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
};

/** The largest image inlined as a data URI, above which it is skipped to keep the message small. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Reads an image file into a `data:` URI so a webview can show it without a localResourceRoots
 * grant. Returns null when there is no image, it is too large, or it cannot be read.
 *
 * @param fileUri the `file://` URI of the image the server resolved.
 * @returns a base64 data URI, or null.
 */
export const imageDataUri = (fileUri: string | null): string | null => {
    if (!fileUri) return null;
    try {
        const path = Uri.parse(fileUri).fsPath;
        if (statSync(path).size > MAX_IMAGE_BYTES) return null;
        const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        const mime = IMAGE_MIME[extension];
        if (!mime) return null;
        return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
    } catch {
        return null;
    }
};

/**
 * The inline script a panel puts ahead of its bundled webview script, carrying the localized text
 * the page looks its strings up in. The opening angle bracket is escaped so a translated string can
 * never end the script element early.
 *
 * @param nonce the panel's content-security-policy nonce, which admits the inline script.
 * @param strings the localized text, keyed by its English source.
 * @returns a script element assigning the strings to the page's `cosmoteerStrings` global.
 */
const stringsScript = (nonce: string, strings: Record<string, string>): string =>
    `<script nonce="${nonce}">window.cosmoteerStrings = ${JSON.stringify(strings).replace(/</g, '\\u003c')};</script>`;

/** The shell pieces a panel's HTML is built from. */
export interface WebviewShell {
    /** The content-security-policy nonce, which also cache-busts the asset URIs. */
    nonce: string;
    /**
     * The URI of a bundled asset.
     *
     * @param parts the path parts under `media`.
     * @returns the webview URI to write into the page.
     */
    asset: (...parts: string[]) => string;
    /** The content-security-policy admitting the bundled assets and the nonced scripts. */
    csp: string;
}

/**
 * The shell pieces a panel's HTML is built from: a fresh nonce, a builder for the URIs of the
 * bundled media assets, and the content-security-policy that admits them.
 *
 * @param webview the panel's webview, whose resource URIs and CSP source the shell is built on.
 * @param extensionUri the extension root, under which the bundled `media` folder lives.
 * @returns the nonce, an asset URI builder taking the path parts under `media`, and the policy.
 */
export const webviewShell = (webview: Webview, extensionUri: Uri): WebviewShell => {
    // 32 alphanumeric characters for the script allowance, which is all the nonce is read as.
    const nonce = randomUUID().replaceAll('-', '');
    // A per-panel cache-buster so a rebuilt media script is fetched fresh, not served from the
    // webview's resource cache.
    const asset = (...parts: string[]): string =>
        `${webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', ...parts)).toString()}?v=${nonce}`;
    const csp =
        `default-src 'none'; img-src ${webview.cspSource} blob: data:; ` +
        `style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return { nonce, asset, csp };
};

/**
 * The page of a panel that shows one of the bundled webviews: the document around its stylesheet,
 * its body and its script, with the localized text written in ahead of the script.
 *
 * @param shell the panel's nonce, asset URI builder and content-security-policy.
 * @param page the tab title, the stylesheet and the script under `media`, the localized text keyed
 * by its English source, and the body's HTML.
 * @returns the page's HTML.
 */
export const panelHtml = (
    shell: WebviewShell,
    page: { title: string; css: string; script: string; strings: Record<string, string>; body: string }
): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${shell.csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${shell.asset(page.css)}" />
<title>${page.title}</title>
</head>
<body>
${page.body}
${stringsScript(shell.nonce, page.strings)}
<script nonce="${shell.nonce}" src="${shell.asset('dist', page.script)}"></script>
</body>
</html>`;

/**
 * The gate a panel posts its payloads through. A page that has not loaded its script yet drops
 * whatever is posted to it, so the payload waits here until the page says it is listening, and the
 * handshake sends the last one held. `listening` says whether a message the panel would rather drop
 * than hold, such as a progress note, is worth posting at all.
 *
 * @param webview the panel's webview.
 * @returns the gate: its readiness, `post` to send or hold a payload, and `ready` for the handshake.
 */
export const postWhenReady = (
    webview: Webview
): { listening: boolean; post: (message: unknown) => Promise<void>; ready: () => Promise<void> } => {
    let held: unknown;
    const gate = {
        listening: false,
        post: async (message: unknown): Promise<void> => {
            if (!gate.listening) {
                held = message;
                return;
            }
            await webview.postMessage(message);
        },
        ready: async (): Promise<void> => {
            gate.listening = true;
            const message = held;
            held = undefined;
            if (message) await gate.post(message);
        },
    };
    return gate;
};
