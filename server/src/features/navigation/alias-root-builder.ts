import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, isDocumentNode } from '../../core/ast/ast';
import { aliasRootIndex } from '../../document/schema/alias-root';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { FullNavigationStrategy } from './full.navigation-strategy';

const navigation = new FullNavigationStrategy();

/**
 * Build the alias-root index (once, then cached) by walking `cosmoteer.rules`'s `&<file>` aliases.
 * The file resolver is the shared {@link FullNavigationStrategy} — navigating a bare `<file>` ref
 * returns that file's parsed document. Safe to call before any schema-resolving feature. It no-ops
 * once built and silently does nothing when there is no game root (e.g. an unconfigured workspace).
 */
export const ensureAliasRootIndex = async (cancellationToken: CancellationToken): Promise<void> => {
    if (aliasRootIndex.isReady()) return;
    const root = await CosmoteerWorkspaceService.instance.getCosmoteerRules().catch(() => undefined);
    const rootDoc = root?.content.parsedDocument;
    if (!rootDoc) return;
    // Show an "indexing" indicator while the alias graph is walked from the game root — on a full game
    // tree this follows many fragment files, so it can take a moment on the first schema-resolving call.
    await CosmoteerWorkspaceService.instance.withIndexingProgress('Indexing game data', () =>
        aliasRootIndex.build(rootDoc, async (fileRef, fromUri) => {
            const target = await navigation.navigate(fileRef, rootDoc, fromUri, cancellationToken).catch(() => null);
            return target && isDocumentNode(target as AbstractNodeDocument) ? (target as AbstractNodeDocument) : undefined;
        })
    );
};
