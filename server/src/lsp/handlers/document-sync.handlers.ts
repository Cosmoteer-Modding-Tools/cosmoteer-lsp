import {
    CancellationToken,
    type DocumentDiagnosticReport,
    DocumentDiagnosticReportKind,
    FullDocumentDiagnosticReport,
    LSPErrorCodes,
    ResponseError,
    UnchangedDocumentDiagnosticReport,
} from 'vscode-languageserver/node';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { clearDocumentHighlightCache } from '../../features/navigation/document-highlight';
import { invalidateNavigationMemoForFile } from '../../features/navigation/full.navigation-strategy';
import { filePathToUri } from '../../features/navigation/navigation-strategy';
import { normalizeUri } from '../../features/navigation/reference-location';
import { uriToFsPath } from '../../features/navigation/workspace-files';
import { reachabilityKey } from '../../mod/mod-reachability';
import { globalSettings } from '../../settings';
import { CancellationError } from '../../utils/cancellation';
import { hasPullDiagnosticsCapability } from '../capabilities';
import { connection, documents, tokenSourceManager } from '../context';
import { diagnosticsCache, inlayHintCache, semanticTokensCache } from '../document-caches';
import { forgetDocumentSettings } from '../document-settings';
import { openDocumentNorms, openParseCache, registerOpenDocument } from '../open-documents';
import { cancelPushValidation, computeDiagnosticsCached, schedulePushValidation } from '../push-diagnostics';
import { bumpWorkspaceScanEpoch } from '../scan-epoch';
import { isOutsideRulesPanel, validationScopeKeys, wholeWorkspaceEnabled } from '../validation-scope';
import { validateWorkspaceFile, workspaceDiagnosticUris } from '../workspace-scan';

/**
 * Registers the document lifecycle: the close that retracts or persists a file's problems, the
 * change that re-parses and schedules validation, and the diagnostic pull a capable client makes
 * for itself.
 */
export function register(): void {
    // Only keep settings for open documents
    documents.onDidClose(async (e) => {
        // The registrar entry this drops was what resolution saw for the file, back to disk state.
        // Only entries whose resolution read the buffer can differ from disk.
        invalidateNavigationMemoForFile(e.document.uri);
        // Scanned files may have derived diagnostics from the discarded buffer.
        bumpWorkspaceScanEpoch();
        forgetDocumentSettings(e.document.uri);
        cancelPushValidation(e.document.uri);
        tokenSourceManager.cancelToken(e.document.uri);
        openParseCache.delete(e.document.uri);
        diagnosticsCache.delete(e.document.uri);
        inlayHintCache.delete(e.document.uri);
        semanticTokensCache.delete(e.document.uri);
        clearDocumentHighlightCache(e.document.uri);
        ParserResultRegistrar.instance.removeResult(e.document.uri);
        if (wholeWorkspaceEnabled()) {
            // Whole-workspace mode: the file's problems should persist after closing. Clear the
            // editor-uri diagnostics, then re-validate from disk under the canonical (`filePathToUri`)
            // uri the full pass uses, so the file isn't tracked twice under different uri encodings.
            const path = uriToFsPath(e.document.uri);
            const canonicalUri = filePathToUri(path);
            const scopeKeys = await validationScopeKeys(CancellationToken.None);
            // A `.txt` nothing references leaves with its tab for the same reason an out-of-scope file
            // does. It validated while open, since opening it as `rules` is a deliberate "this is rules",
            // but the game would never load it, so nothing persists it once the tab is gone. Without this
            // its problems stick forever: the scan gate below never publishes the file, so no later pass
            // is left to retract what the open flow pushed.
            const outOfScope = scopeKeys && !scopeKeys.has(reachabilityKey(path));
            if (outOfScope || (await isOutsideRulesPanel(path, CancellationToken.None))) {
                // The file is outside what the panel persists. It validated while it was open
                // (open files always validate), but its problems leave the panel with the tab instead
                // of persisting the way scanned files' problems do.
                await connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
                const closedNorm = normalizeUri(canonicalUri);
                for (const stored of [...workspaceDiagnosticUris]) {
                    if (normalizeUri(stored) !== closedNorm) continue;
                    workspaceDiagnosticUris.delete(stored);
                    await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
                }
                return;
            }
            if (normalizeUri(canonicalUri) !== normalizeUri(e.document.uri)) {
                await connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
            }
            await validateWorkspaceFile(path, openDocumentNorms(), CancellationToken.None);
            return;
        }
        await connection.sendDiagnostics({
            uri: e.document.uri,
            version: e.document.version,
            diagnostics: [],
        });
    });

    documents.onDidChangeContent(
        (e) => {
            try {
                // Parse and publish the AST immediately, completion/hover/navigation read it between
                // keystrokes. Validation is scheduled separately below.
                registerOpenDocument(e.document);
            } catch (err) {
                if (globalSettings.trace.server === 'messages' && !(err instanceof CancellationError)) console.error(err);
            }
            // A pull-capable client requests `textDocument/diagnostic` itself after the change. Pushing
            // here as well would run the whole validation twice per edit.
            if (hasPullDiagnosticsCapability) return;
            schedulePushValidation(e.document);
        },
        null,
        [tokenSourceManager]
    );

    connection.languages.diagnostics.on(async (params, cancelToken) => {
        const document = documents.get(params.textDocument.uri);
        if (document === undefined) {
            // We don't know the document. We can either try to read it from disk
            // or we don't report problems for it.
            return {
                kind: DocumentDiagnosticReportKind.Full,
                items: [],
            } satisfies DocumentDiagnosticReport;
        }
        // If the whole-workspace pass pushed diagnostics for this file before it was opened, retract
        // them. The pull result replaces them, and keeping both would double every entry.
        const norm = normalizeUri(params.textDocument.uri);
        for (const stored of workspaceDiagnosticUris) {
            if (normalizeUri(stored) !== norm) continue;
            workspaceDiagnosticUris.delete(stored);
            await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
        }
        const items = await computeDiagnosticsCached(document);
        if (cancelToken.isCancellationRequested) {
            throw new ResponseError(LSPErrorCodes.RequestCancelled, 'diagnostic pull cancelled');
        }
        // The cache entry outlives the computation exactly as long as its result stays valid: every
        // invalidation path (new version, cross-file edit, watched-file change, config change) drops
        // or replaces it. So a client whose `previousResultId` still names the live entry already has
        // these diagnostics and only needs an "unchanged" confirmation.
        const entry = diagnosticsCache.get(document.uri);
        if (entry && params.previousResultId !== undefined && params.previousResultId === entry.resultId) {
            return {
                kind: DocumentDiagnosticReportKind.Unchanged,
                resultId: entry.resultId,
            } satisfies UnchangedDocumentDiagnosticReport;
        }
        return {
            kind: DocumentDiagnosticReportKind.Full,
            resultId: entry?.resultId,
            items,
        } satisfies FullDocumentDiagnosticReport;
    });
}
