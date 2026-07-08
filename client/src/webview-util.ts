import { Uri } from 'vscode';
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
 * A random nonce for a webview content-security-policy script allowance.
 *
 * @returns a 32-character alphanumeric nonce.
 */
export const nonceString = (): string => {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
};
