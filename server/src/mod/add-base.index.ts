import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, ValueNode, isValueNode } from '../core/ast/ast';
import { getStartOfAstNode } from '../utils/ast.utils';
import { isModRules } from '../document/document-kind';
import { registerInheritanceExtensionSource } from '../semantics/reference-resolver';
import { WatchedDocumentIndex } from '../features/navigation/watched-document-index';
import { normalizeUri } from '../features/navigation/reference-location';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { FileTree, FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';
import { isActionFragmentDocument, parseModActions } from './action-parser';
import { resolveActionTarget } from './action-target-resolver';

/** One `AddBase`-appended base: the `BaseToAdd` reference and the source document that declared it. */
interface AppendedBase {
    /** The normalized uri of the manifest/fragment whose action appended this base (for removal). */
    readonly source: string;
    /** The `BaseToAdd` reference value node; navigation dereferences it against its own file. */
    readonly base: ValueNode;
}

/**
 * Project index of the inheritance bases that `mod.rules` `AddBase` actions append to game-tree nodes,
 * so a `^/N` reference into an added base resolves everywhere the resolver runs.
 *
 * The game's `Cosmoteer.Mods.ModAddBaseAction` appends its `BaseToAdd` to the target node's
 * `InheritanceList` at load time (`InheritanceList.Add`), so a part that already has a static base at
 * slot 0 receives the added base at slot 1. Plain static resolution knows only the node's own written
 * inheritance, so `^/1/Member` into an added base resolves nowhere and a reference copied from a vanilla
 * part (whose overclock base sits at slot 0) onto such a part cannot be told from a valid one. This
 * index records, per target node, the bases every `AddBase` in the workspace's manifests and included
 * action fragments appends, and registers itself as the resolver's inheritance-extension source
 * ({@link registerInheritanceExtensionSource}). `stepIntoNode` then reads it for any `^/N` whose index
 * runs past the node's own list, giving navigation, validation, hover and completion one shared answer.
 *
 * Only appends are modelled: an `AddBase` with an explicit `Index` inserts mid-list and could re-slot
 * every following base, which static analysis cannot safely reconcile, so those actions are skipped
 * (the reference is then left to resolve, or not, on the written list alone). The index is scoped to the
 * workspace mod folders, since the game `Data` tree carries no mod actions.
 */
export class AddBaseIndex extends WatchedDocumentIndex {
    private static _instance: AddBaseIndex;

    /** Target node key → the bases appended to it, in the order the actions declare them. */
    private readonly byNode = new Map<string, AppendedBase[]>();
    /** Source document uri → the target node keys it contributed to, so a re-index can drop them. */
    private readonly bySource = new Map<string, string[]>();

    private constructor() {
        super();
        // Register as the resolver's inheritance-extension source in the constructor, before the first
        // ensureBuilt, so it is in place ahead of any synchronous `^/N` resolution.
        registerInheritanceExtensionSource((node, extraIndex) => this.appendedBaseAt(node, extraIndex));
    }

    public static get instance(): AddBaseIndex {
        if (!AddBaseIndex._instance) AddBaseIndex._instance = new AddBaseIndex();
        return AddBaseIndex._instance;
    }

    /** A stable identity key for a game-tree node, matching another resolution of the same cached node. */
    private static nodeKey(node: AbstractNode): string {
        const document = getStartOfAstNode(node);
        return `${normalizeUri(document.uri)}|${node.position?.start ?? -1},${node.position?.end ?? -1}`;
    }

    /**
     * The base an `AddBase` appended at `extraIndex` past a node's own inheritance list, or undefined.
     * Synchronous, for the resolver's per-segment step.
     *
     * @param node the caret base node whose extended inheritance is queried.
     * @param extraIndex the 0-based position past the node's static inheritance list.
     * @returns the appended base reference node, or undefined when nothing was appended there.
     */
    public appendedBaseAt(node: AbstractNode, extraIndex: number): AbstractNode | undefined {
        return this.byNode.get(AddBaseIndex.nodeKey(node))?.[extraIndex]?.base;
    }

    /**
     * How many bases `AddBase` actions appended to a node's inheritance list, so `^/N` slot completion
     * can offer the appended slots (which sit past the node's own written inheritance) too.
     *
     * @param node the node whose appended-base count is queried.
     * @returns the number of appended bases (0 when none).
     */
    public appendedBaseCount(node: AbstractNode): number {
        return this.byNode.get(AddBaseIndex.nodeKey(node))?.length ?? 0;
    }

    /**
     * Builds the index once over the workspace mod folders, then reconciles changed files. The game
     * `Data` root is excluded: it holds no mod actions, so walking it would only cost time.
     *
     * @param folderPaths the project folders (the mod plus the game `Data` tree).
     * @param cancellationToken cancels the post-build reconcile.
     * @returns once the index is built and fresh.
     */
    public async ensureBuilt(folderPaths: string[], cancellationToken: CancellationToken): Promise<void> {
        const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
        const dataKey = dataRoot ? normalizeUri(dataRoot) : undefined;
        const modFolders = folderPaths.filter((folder) => normalizeUri(uriToFsPath(folder)) !== dataKey);
        await this.ensureFresh((progress) => this.buildFromProject(modFolders, progress), cancellationToken, 'Indexing bases');
    }

    protected async indexDocument(document: AbstractNodeDocument, cancellationToken: CancellationToken): Promise<boolean> {
        const source = normalizeUri(document.uri);
        const previous = this.bySource.get(source) ?? [];
        this.removeSource(source);
        // Only manifests and included action fragments carry `AddBase` actions.
        if (!isModRules(document.uri) && !isActionFragmentDocument(document)) return previous.length > 0;

        const contributedKeys: string[] = [];
        for (const action of parseModActions(document)) {
            if (cancellationToken.isCancellationRequested) break;
            if (action.type !== 'AddBase') continue;
            // An `Index`-inserting AddBase can re-slot the list; skip it rather than mis-model a slot.
            if (action.presentFields.has('index')) continue;
            const target = action.targets[0];
            const base = action.sources[0];
            if (!target || !base || !isValueNode(base) || base.valueType.type !== 'Reference') continue;
            const resolved = await resolveActionTarget(target, cancellationToken).catch(() => null);
            if (!resolved || isFile(resolved as unknown as FileTree)) continue;
            const key = AddBaseIndex.nodeKey(resolved as AbstractNode);
            const bases = this.byNode.get(key) ?? this.byNode.set(key, []).get(key)!;
            bases.push({ source, base });
            contributedKeys.push(key);
        }
        if (contributedKeys.length) this.bySource.set(source, contributedKeys);
        // Changed unless this source contributed nothing before and nothing now.
        return contributedKeys.length > 0 || previous.length > 0;
    }

    protected removeSource(source: string): void {
        const keys = this.bySource.get(source);
        if (!keys) return;
        for (const key of keys) {
            const bases = this.byNode.get(key);
            if (!bases) continue;
            const kept = bases.filter((entry) => entry.source !== source);
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
