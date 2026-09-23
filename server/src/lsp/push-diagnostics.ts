import { Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { traceFailure } from '../utils/cancellation';
import { connection, documents, tokenSourceManager } from './context';
import { hasPullDiagnosticsCapability } from '../capabilities';
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
    // The passes that finish their cross-file work after the first publish ask for a second one,
    // and this flow is the one that publishes, so it hands them the way back in.
    const refresh = (): void => refreshOpenDocumentDiagnostics(uri);
    const promise: Promise<Diagnostic[]> = validateTextDocument(document, token, true, refresh).then(
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
 * @param alwaysDebounce keeps the wait even when nothing is cached for the document. The
 *     no-cache shortcut is there so a freshly opened file publishes at once; a document queued
 *     because another one changed has no cache entry either (the change dropped it) and must not
 *     take that shortcut, or every keystroke in one file would re-validate every other open tab.
 */
export function schedulePushValidation(document: TextDocument, alwaysDebounce = false): void {
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
            traceFailure(e);
        }
    };
    if (!alwaysDebounce && !diagnosticsCache.has(uri)) {
        void run();
        return;
    }
    pushValidationTimers.set(
        uri,
        setTimeout(() => void run(), VALIDATION_DEBOUNCE_MS)
    );
}

/**
 * Re-publishes the open documents that were judged against something that has since moved: another
 * buffer's edit, a file changed on disk, a refactoring's write, a settings change.
 *
 * A client that can pull is simply asked to pull again, which is what every such path already did.
 * A client that cannot pull was asked for nothing: the caches of the other open documents were
 * dropped and nobody ever recomputed them, so a squiggle the user had just fixed in the base file
 * stayed on the derived one until that file was itself edited or reopened. Each of them is queued
 * through the typing debounce, so a burst of edits or a git-pull-sized notification settles into
 * one validation per document rather than one per event.
 *
 * @param exceptUri the document the change came from, whose own flow already re-validates it.
 */
export function refreshDependentOpenDocuments(exceptUri?: string): void {
    if (hasPullDiagnosticsCapability) {
        connection.languages.diagnostics.refresh();
        return;
    }
    for (const document of documents.all()) {
        if (document.uri === exceptUri) continue;
        schedulePushValidation(document, true);
    }
}

/**
 * Validates an open document again, at its current version, because something it was judged
 * against has arrived since: a pull client is asked to pull once more, a push client gets a fresh
 * publish without the typing debounce. A document no longer open is left alone.
 *
 * @param uri the open document's uri.
 */
export function refreshOpenDocumentDiagnostics(uri: string): void {
    const current = documents.get(uri);
    if (!current) return;
    diagnosticsCache.delete(uri);
    if (hasPullDiagnosticsCapability) {
        connection.languages.diagnostics.refresh();
        return;
    }
    schedulePushValidation(current);
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
