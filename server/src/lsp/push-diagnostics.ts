import { Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { globalSettings } from '../settings';
import { CancellationError } from '../utils/cancellation';
import { connection, documents, tokenSourceManager } from './context';
import { diagnosticsCache } from './document-caches';
import { validateTextDocument } from './validate-document';

/** How long to sit out further keystrokes before a push-model validation runs. Validating one open
 *  document costs a fraction of this, so the wait is what the user feels between typing and seeing
 *  the problem. It only has to outlast the gap between two keystrokes of continuous typing. */
const VALIDATION_DEBOUNCE_MS = 100;

/** Per-uri debounce timers of the push-diagnostics flow (clients without pull support). */
const pushValidationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/** Source of the pull-diagnostics `resultId`s, unique across the whole session. */
let diagnosticsResultIdCounter = 0;

/**
 * Returns the diagnostics of an open document, computing them at most once per document version.
 * A newer version cancels the previous run through the per-uri token source. A run that was
 * cancelled mid-way drops its (partial) cache entry so the next request recomputes.
 *
 * @param document the open document to validate.
 * @returns the document's diagnostics.
 */
export function computeDiagnosticsCached(document: TextDocument): Promise<Diagnostic[]> {
    const uri = document.uri;
    const cached = diagnosticsCache.get(uri);
    if (cached && cached.version === document.version) return cached.promise;
    const token = tokenSourceManager.createToken(uri);
    const version = document.version;
    const dropOwnEntry = (): void => {
        const entry = diagnosticsCache.get(uri);
        if (entry && entry.version === version && entry.promise === promise) diagnosticsCache.delete(uri);
    };
    const promise: Promise<Diagnostic[]> = validateTextDocument(document, token).then(
        (diagnostics) => {
            // A cancelled run resolves with partial results, never serve them to a later request.
            if (token.isCancellationRequested) dropOwnEntry();
            return diagnostics;
        },
        (e) => {
            dropOwnEntry();
            throw e;
        }
    );
    diagnosticsCache.set(uri, { version, promise, resultId: String(++diagnosticsResultIdCounter) });
    return promise;
}

/**
 * Debounced push validation for clients without pull-diagnostics support. The first diagnostics of
 * a freshly opened document go out immediately. While typing, each keystroke resets a short timer
 * so only the settled text is validated.
 *
 * @param document the open document whose validation to schedule.
 */
export function schedulePushValidation(document: TextDocument): void {
    const uri = document.uri;
    const existing = pushValidationTimers.get(uri);
    if (existing !== undefined) clearTimeout(existing);
    const run = async (): Promise<void> => {
        pushValidationTimers.delete(uri);
        const current = documents.get(uri);
        if (!current) return;
        try {
            const diagnostics = await computeDiagnosticsCached(current);
            await connection.sendDiagnostics({ uri, version: current.version, diagnostics });
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
        }
    };
    if (!diagnosticsCache.has(uri)) {
        void run();
        return;
    }
    pushValidationTimers.set(
        uri,
        setTimeout(() => void run(), VALIDATION_DEBOUNCE_MS)
    );
}

/**
 * Cancels and forgets the debounced validation of a document, when its tab closes.
 *
 * @param uri the closed document's uri.
 */
export function cancelPushValidation(uri: string): void {
    const timer = pushValidationTimers.get(uri);
    if (timer !== undefined) {
        clearTimeout(timer);
        pushValidationTimers.delete(uri);
    }
}
