import { Uri, Webview } from 'vscode';
import { readFileSync, statSync } from 'fs';

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
export const stringsScript = (nonce: string, strings: Record<string, string>): string =>
    `<script nonce="${nonce}">window.cosmoteerStrings = ${JSON.stringify(strings).replace(/</g, '\\u003c')};</script>`;

/**
 * A random nonce for a webview content-security-policy script allowance.
 *
 * @returns a 32-character alphanumeric nonce.
 */
const nonceString = (): string => {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
};

/**
 * The shell pieces a panel's HTML is built from: a fresh nonce, a builder for the URIs of the
 * bundled media assets, and the content-security-policy that admits them.
 *
 * @param webview the panel's webview, whose resource URIs and CSP source the shell is built on.
 * @param extensionUri the extension root, under which the bundled `media` folder lives.
 * @returns the nonce, an asset URI builder taking the path parts under `media`, and the policy.
 */
export const webviewShell = (
    webview: Webview,
    extensionUri: Uri
): { nonce: string; asset: (...parts: string[]) => string; csp: string } => {
    const nonce = nonceString();
    // A per-panel cache-buster so a rebuilt media script is fetched fresh, not served from the
    // webview's resource cache.
    const asset = (...parts: string[]): string =>
        `${webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', ...parts)).toString()}?v=${nonce}`;
    const csp =
        `default-src 'none'; img-src ${webview.cspSource} blob: data:; ` +
        `style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return { nonce, asset, csp };
};
