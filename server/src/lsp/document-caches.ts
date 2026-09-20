import { CancellationTokenSource, Diagnostic, InlayHint } from 'vscode-languageserver/node';
import { invalidateComponentIdCache } from '../features/diagnostics/validator.schema-sibling';
import { invalidateEffectiveChainCache } from '../semantics/effective-group';
import { invalidateLooseDeclarationCache } from '../features/diagnostics/validator.schema-id-reference';

// The three version-keyed result caches. They live together because almost everything that
// invalidates one invalidates the others: an edit to another file, a configuration change, a new
// code-mod schema. Each is keyed by document uri and only valid for the version it was computed
// from, so dropping an entry is always safe and never more than a recomputation.

/**
 * The in-flight or settled diagnostics of each open document, keyed by uri and valid for one
 * document version. The push flow and the pull handler share one validation per version through
 * this map instead of racing two independent full passes over the same text. Each entry carries a
 * unique `resultId` for the pull protocol: a pull whose `previousResultId` still matches the live
 * entry answers "unchanged" instead of re-serializing the same diagnostic set. Every path that
 * invalidates diagnostics (a new version, a cross-file edit, a config change) drops or replaces
 * the entry, so a matching id is proof the client's copy is current.
 */
export const diagnosticsCache: Map<string, { version: number; promise: Promise<Diagnostic[]>; resultId: string }> =
    new Map();

/**
 * The inlay hints of each open document, computed once per version over the whole document. The
 * client re-asks on every scroll, and each request filters this entry down to its visible range
 * rather than evaluating the document's expressions again.
 */
export const inlayHintCache: Map<
    string,
    { version: number; promise: Promise<InlayHint[]>; source: CancellationTokenSource }
> = new Map();

/**
 * The semantic-token array of each open document. The walk is pure CPU over the cached AST, so
 * repeated requests for unchanged text answer from here. The `resultId` lets a delta-capable client
 * ask for just the changed slice after an edit, and a range request is served from the same array.
 */
export const semanticTokensCache: Map<string, { version: number; resultId: string; data: number[] }> = new Map();

/**
 * Drops everything derived from document content that no document version movement would drop by
 * itself: the version-keyed diagnostics and inlay results, and the three cross-file memos the
 * validators build on top of them (component ids, effective chains, loose declarations). Every path
 * that changes what a validation would produce without changing a document's own version has to
 * drop the same set, so the set is named in one place here.
 *
 * @param exceptUri a document whose own entries survive, for the edit that produced the change. Its
 * results are recomputed from the fresh AST by the flow that follows the edit, so dropping them
 * here would only throw away work that is about to be redone.
 */
export function invalidateDerivedCaches(exceptUri?: string): void {
    if (exceptUri === undefined) {
        diagnosticsCache.clear();
        inlayHintCache.clear();
    } else {
        for (const uri of [...diagnosticsCache.keys()]) {
            if (uri !== exceptUri) diagnosticsCache.delete(uri);
        }
        for (const uri of [...inlayHintCache.keys()]) {
            if (uri !== exceptUri) inlayHintCache.delete(uri);
        }
    }
    invalidateComponentIdCache();
    invalidateEffectiveChainCache();
    invalidateLooseDeclarationCache();
}
