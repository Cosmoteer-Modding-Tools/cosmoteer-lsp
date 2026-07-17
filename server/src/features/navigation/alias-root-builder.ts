import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, isDocumentNode } from '../../core/ast/ast';
import { aliasRootIndex } from '../../document/schema/alias-root';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { FullNavigationStrategy } from './full.navigation-strategy';

const navigation = new FullNavigationStrategy();

/** The in-flight build, shared so concurrent callers walk the alias graph once instead of racing. */
let buildInFlight: Promise<void> | undefined;

/**
 * Build the alias-root index (once, then cached) by walking `cosmoteer.rules`'s `&<file>` aliases.
 * The file resolver is the shared {@link FullNavigationStrategy}. Navigating a bare `<file>` ref
 * returns that file's parsed document. Safe to call before any schema-resolving feature. It no-ops
 * once built, shares an already-running build, and silently does nothing when there is no game root
 * (e.g. an unconfigured workspace).
 *
 * @param cancellationToken unused, kept for call-site symmetry. The walk itself is deliberately
 * request-independent: it runs once and its result is pinned by `isReady()`, so a cancelled
 * triggering request must not be able to null out individual aliases (a half-built index would
 * permanently unroot fragments like `buffs.rules`, and every dependent one-time index such as
 * schema ids and localization keys would pin that state too).
 * @returns once the index is built (or determined unbuildable for now).
 */
export const ensureAliasRootIndex = async (cancellationToken: CancellationToken): Promise<void> => {
    void cancellationToken;
    if (aliasRootIndex.isReady()) return;
    if (buildInFlight) return buildInFlight;
    buildInFlight = (async () => {
        const root = await CosmoteerWorkspaceService.instance.getCosmoteerRules().catch(() => undefined);
        const rootDoc = root?.content.parsedDocument;
        if (!rootDoc) return;
        // Show an "indexing" indicator while the alias graph is walked from the game root. On a full game
        // tree this follows many fragment files, so it can take a moment on the first schema-resolving call.
        await CosmoteerWorkspaceService.instance.withIndexingProgress('Indexing game data', () =>
            aliasRootIndex.build(rootDoc, async (fileRef, fromUri) => {
                const target = await navigation
                    .navigate(fileRef, rootDoc, fromUri, CancellationToken.None)
                    .catch(() => null);
                return target && isDocumentNode(target as AbstractNodeDocument)
                    ? (target as AbstractNodeDocument)
                    : undefined;
            })
        );
    })().finally(() => {
        // A finished build is either cached in aliasRootIndex or legitimately retryable (no game
        // root yet, invalidated later), so the shared promise is always released.
        buildInFlight = undefined;
    });
    return buildInFlight;
};
