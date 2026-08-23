import { CancellationToken, FileChangeType } from 'vscode-languageserver/node';
import { WorkspaceSymbolService } from '../../features/navigation/workspace-symbol.service';
import { SchemaIdIndex } from '../../features/completion/schema-id.index';
import { TemplateBaseIndex } from '../../features/diagnostics/template-base.index';
import { LocalizationKeyIndex } from '../../features/completion/localization-key.index';
import { ReverseIncludeIndex } from '../../features/navigation/reverse-include.index';
import { MentionIndex } from '../../features/navigation/mention.index';
import { AddBaseIndex } from '../../mod/add-base.index';
import { MemberInjectionIndex } from '../../mod/member-injection.index';
import { ActionRootingIndex } from '../../mod/action-rooting.index';
import { aliasRootIndex } from '../../document/schema/alias-root';
import { invalidateSchemaContextCache } from '../../document/schema/schema-context';
import { invalidateComponentIdCache } from '../../features/diagnostics/validator.schema-sibling';
import { invalidateEffectiveChainCache } from '../../semantics/effective-group';
import { invalidateLooseDeclarationCache } from '../../features/diagnostics/validator.schema-id-reference';
import { clearModRootCache } from '../../mod/mod-root';
import { invalidateModContext } from '../../mod/mod-context';
import { reachabilityKey } from '../../mod/mod-reachability';
import { invalidateFsPath } from '../../workspace/fs-cache';
import { basenameOf, isManifestBasename, isRulesFileName } from '../../document/document-kind';
import { filePathToUri } from '../../features/navigation/navigation-strategy';
import { normalizeUri } from '../../features/navigation/reference-location';
import { uriToFsPath } from '../../features/navigation/workspace-files';
import { hasPullDiagnosticsCapability } from '../capabilities';
import { connection } from '../context';
import { diagnosticsCache, inlayHintCache } from '../document-caches';
import { codeModAutoRefreshEnabled, refreshModSchema } from '../mod-schema';
import { openDocumentNorms } from '../open-documents';
import { bumpWorkspaceScanEpoch } from '../scan-epoch';
import { invalidateShipLayersFor } from '../ship-layers';
import { bumpValidationScopeEpoch, validationScopeKeys, wholeWorkspaceEnabled } from '../validation-scope';
import {
    WORKSPACE_DIAGNOSTIC_CONCURRENCY,
    validateWorkspaceFile,
    workspaceDiagnosticUris,
} from '../workspace-scan';

/**
 * Registers the watched-file notification: disk changes the editor never surfaces as edits (a git
 * pull or checkout, an external tool, a file created or deleted outside the editor).
 */
export function register(): void {
    // Disk changes the editor doesn't surface as edits (git pull/checkout, external tools,
    // create/delete): keep the cached symbol table in step. Deletions drop immediately.
    // Created/externally-changed files are re-read from disk at the next workspace-symbol query.
    connection.onDidChangeWatchedFiles(async (params) => {
        const openNorms = wholeWorkspaceEnabled() ? openDocumentNorms() : undefined;
        const rulesChanges = params.changes.filter((change) => isRulesFileName(basenameOf(change.uri)));
        const assetChanges = params.changes.filter((change) => !isRulesFileName(basenameOf(change.uri)));
        // A code mod being developed in the workspace: its assembly (or the XML doc file beside it) was
        // just rebuilt, so the types and prose merged into the schema are one build behind. The
        // re-extraction runs in the background, since nothing in this handler depends on it.
        if (codeModAutoRefreshEnabled() && params.changes.some((change) => /\.(dll|xml)$/i.test(basenameOf(change.uri)))) {
            void refreshModSchema();
        }
        // Asset (sprite/sound/shader) changes only affect the fs-derived caches: dropping the path
        // entry also fires the invalidation listeners that clear the asset and navigation memos, so
        // a created or deleted asset stops being answered from a stale memo. They must not dirty the
        // `.rules` indexes, which would try to re-parse a binary file as rules on the next reconcile.
        for (const change of assetChanges) {
            invalidateFsPath(uriToFsPath(change.uri));
        }
        if (rulesChanges.length > 0) {
            // Disk changes can re-root fragments and shift schema anchoring for unchanged open ASTs.
            invalidateSchemaContextCache();
            // They can also grow or shrink the manifest's reachability closure.
            bumpValidationScopeEpoch();
        }
        // A cosmoteer.rules add/change/delete can alter how fragments are rooted. Rebuild lazily.
        if (rulesChanges.some((c) => basenameOf(c.uri).toLowerCase() === 'cosmoteer.rules')) {
            aliasRootIndex.invalidate();
        }
        // A created or deleted manifest moves mod-root boundaries, so the per-directory root memo
        // (negatives included) and the mod contexts built on top of it are stale.
        if (rulesChanges.some((c) => c.type !== FileChangeType.Changed && isManifestBasename(basenameOf(c.uri)))) {
            clearModRootCache();
            invalidateModContext();
        }
        const toRevalidate: string[] = [];
        for (const change of rulesChanges) {
            // A disk change invalidates the parsed-document cache entry and the parent directory
            // listing reference resolution keeps, and dirties the mention index's word entry.
            invalidateFsPath(uriToFsPath(change.uri));
            MentionIndex.instance.markDirty(uriToFsPath(change.uri));
            if (change.type === FileChangeType.Deleted) {
                WorkspaceSymbolService.instance.remove(change.uri);
                SchemaIdIndex.instance.remove(change.uri);
                TemplateBaseIndex.instance.remove(change.uri);
                LocalizationKeyIndex.instance.remove(change.uri);
                ReverseIncludeIndex.instance.remove(change.uri);
                AddBaseIndex.instance.remove(change.uri);
                MemberInjectionIndex.instance.remove(change.uri);
                ActionRootingIndex.instance.remove(change.uri);
                // Clear any whole-workspace diagnostics we published for the now-deleted file. We must
                // send to the same uri string we published with, so match by normalized form (the
                // watcher's uri may differ in encoding from our `filePathToUri` form).
                const deletedNorm = normalizeUri(change.uri);
                for (const stored of workspaceDiagnosticUris) {
                    if (normalizeUri(stored) !== deletedNorm) continue;
                    workspaceDiagnosticUris.delete(stored);
                    await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
                }
            } else {
                WorkspaceSymbolService.instance.markDirty(change.uri);
                SchemaIdIndex.instance.markDirty(change.uri);
                invalidateShipLayersFor(change.uri);
                TemplateBaseIndex.instance.markDirty(change.uri);
                LocalizationKeyIndex.instance.markDirty(change.uri);
                ReverseIncludeIndex.instance.markDirty(change.uri);
                AddBaseIndex.instance.markDirty(change.uri);
                MemberInjectionIndex.instance.markDirty(change.uri);
                ActionRootingIndex.instance.markDirty(change.uri);
                if (openNorms) toRevalidate.push(uriToFsPath(change.uri));
            }
        }
        // Open documents may show diagnostics and inlay values that were derived from the changed
        // files (an inherited base, a strings file, a referenced asset), so their version-keyed
        // caches are stale even though their own versions are unchanged. Drop them and ask a
        // pull-capable client to re-pull, which recomputes against the new disk state. Cached scan
        // results of unchanged files can derive from the changed ones the same way.
        if (params.changes.length > 0) {
            diagnosticsCache.clear();
            inlayHintCache.clear();
            invalidateComponentIdCache();
            invalidateEffectiveChainCache();
            invalidateLooseDeclarationCache();
            bumpWorkspaceScanEpoch();
            if (hasPullDiagnosticsCapability) connection.languages.diagnostics.refresh();
        }
        // Re-validate created/externally-changed files so their diagnostics stay current (files open
        // in the editor are skipped, the live-edit flow already covers those). A git-pull-sized burst
        // arrives as one notification with many changes, so the files run through the same bounded
        // worker pool as the whole-workspace pass instead of strictly one after another.
        if (openNorms && toRevalidate.length > 0) {
            // Only files inside the validation scope get their problems published. An out-of-scope
            // file (a dead backup a git operation touched, say) must not enter the panel, and any
            // entry it still holds from an earlier closure is cleared instead.
            const scopeKeys = await validationScopeKeys(CancellationToken.None);
            const inScope: string[] = [];
            for (const file of toRevalidate) {
                if (!scopeKeys || scopeKeys.has(reachabilityKey(file))) {
                    inScope.push(file);
                    continue;
                }
                const staleNorm = normalizeUri(filePathToUri(file));
                for (const stored of [...workspaceDiagnosticUris]) {
                    if (normalizeUri(stored) !== staleNorm) continue;
                    workspaceDiagnosticUris.delete(stored);
                    await connection.sendDiagnostics({ uri: stored, diagnostics: [] });
                }
            }
            let next = 0;
            const worker = async (): Promise<void> => {
                while (next < inScope.length) {
                    await validateWorkspaceFile(inScope[next++], openNorms, CancellationToken.None);
                }
            };
            await Promise.all(Array.from({ length: Math.min(WORKSPACE_DIAGNOSTIC_CONCURRENCY, inScope.length) }, worker));
        }
    });
}
