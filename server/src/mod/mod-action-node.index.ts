import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument } from '../core/ast/ast';
import { isModRules } from '../document/document-kind';
import { WatchedDocumentIndex } from '../features/navigation/watched-document-index';
import { normalizeUri } from '../features/navigation/reference-location';
import { getStartOfAstNode } from '../utils/ast.utils';
import { ModAction } from './action';
import { isActionFragmentDocument, parseModActions, textCouldCarryActions } from './action-parser';

/**
 * A project index of what mod actions do to game-tree nodes, keyed by the target node. Each entry
 * remembers the manifest or fragment whose action contributed it, so re-indexing that source drops
 * its old contribution before the new one lands. Subclasses decide what one action contributes.
 *
 * Only a manifest or an included action fragment carries actions, so every other document
 * contributes nothing, and the build skips the parse of every file whose text provably holds none.
 */
export abstract class ModActionNodeIndex<T extends { readonly source: string }> extends WatchedDocumentIndex {
    /** The three mod-action indexes reject exactly the files that provably carry no actions. */
    public override readonly textGateId = 'mod-actions';

    /** Target node key to what the actions contribute to it, in the order the actions declare it. */
    protected readonly byNode = new Map<string, T[]>();
    /** Source document uri to the target node keys it contributed to, so a re-index can drop them. */
    private readonly bySource = new Map<string, string[]>();

    /**
     * A stable identity key for a game-tree node, matching another resolution of the same cached node.
     *
     * @param node the node to key.
     * @returns the node's identity key.
     */
    protected static nodeKey(node: AbstractNode): string {
        const document = getStartOfAstNode(node);
        return `${normalizeUri(document.uri)}|${node.position?.start ?? -1},${node.position?.end ?? -1}`;
    }

    /**
     * Only a manifest or a file declaring a top-level `Actions` list contributes here, and both
     * write that name into their text, so the build skips the parse of every other file of the mod.
     *
     * @param uri the file's uri.
     * @param text the file's raw text.
     * @returns true when the file could carry mod actions.
     */
    protected override acceptsText(uri: string, text: string): boolean {
        return textCouldCarryActions(uri, text);
    }

    /**
     * Re-indexes one document, replacing whatever it contributed before with what its actions
     * contribute now.
     *
     * @param document the parsed document to index.
     * @param cancellationToken cancels the action walk.
     * @returns true when this source's contribution differs from the one it replaced.
     */
    protected async indexDocument(
        document: AbstractNodeDocument,
        cancellationToken: CancellationToken
    ): Promise<boolean> {
        const source = normalizeUri(document.uri);
        const previous = this.bySource.get(source) ?? [];
        this.removeSource(source);
        if (!isModRules(document.uri) && !isActionFragmentDocument(document)) return previous.length > 0;

        const contributedKeys: string[] = [];
        for (const action of parseModActions(document)) {
            if (cancellationToken.isCancellationRequested) break;
            contributedKeys.push(...(await this.indexAction(action, source, cancellationToken)));
        }
        if (contributedKeys.length) this.bySource.set(source, contributedKeys);
        return contributedKeys.length > 0 || previous.length > 0;
    }

    /**
     * Records what one action contributes, through {@link bucketFor}.
     *
     * @param action the parsed action.
     * @param source the normalized uri of the document declaring it.
     * @param cancellationToken cancels the target resolution.
     * @returns the target node keys the action contributed to, one per bucket written.
     */
    protected abstract indexAction(
        action: ModAction,
        source: string,
        cancellationToken: CancellationToken
    ): Promise<string[]>;

    /**
     * The entries recorded for a target node, created empty on first use.
     *
     * @param key the target node's key.
     * @returns the mutable entry list.
     */
    protected bucketFor(key: string): T[] {
        return this.byNode.get(key) ?? this.byNode.set(key, []).get(key)!;
    }

    protected removeSource(source: string): void {
        const keys = this.bySource.get(source);
        if (!keys) return;
        for (const key of keys) {
            const entries = this.byNode.get(key);
            if (!entries) continue;
            const kept = entries.filter((entry) => entry.source !== source);
            if (kept.length) this.byNode.set(key, kept);
            else this.byNode.delete(key);
        }
        this.bySource.delete(source);
    }

    protected clear(): void {
        this.byNode.clear();
        this.bySource.clear();
    }
}
