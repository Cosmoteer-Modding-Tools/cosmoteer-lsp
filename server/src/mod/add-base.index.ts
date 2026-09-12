import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, ValueNode, isValueNode } from '../core/ast/ast';
import { registerInheritanceExtensionSource } from '../semantics/reference-resolver';
import { modFolderPaths } from '../features/navigation/workspace-files';
import { FileTree, isFile } from '../workspace/cosmoteer-workspace.service';
import { ModAction } from './action';
import { resolveActionTarget } from './action-target-resolver';
import { ModActionNodeIndex } from './mod-action-node.index';

/** One `AddBase`-appended base: the `BaseToAdd` reference and the source document that declared it. */
interface AppendedBase {
    /** The normalized uri of the manifest/fragment whose action appended this base (for removal). */
    readonly source: string;
    /** The `BaseToAdd` reference value node. Navigation dereferences it against its own file. */
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
export class AddBaseIndex extends ModActionNodeIndex<AppendedBase> {
    private static _instance: AddBaseIndex;

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
        await this.ensureFresh(
            (progress) => this.buildFromProject(modFolderPaths(folderPaths), progress),
            cancellationToken,
            'Indexing bases'
        );
    }

    /**
     * Records the base an `AddBase` action appends to its target node. An `Index`-inserting AddBase
     * can re-slot the list, so it is skipped rather than mis-modelled as an append.
     *
     * @param action the parsed action.
     * @param source the normalized uri of the document declaring it.
     * @param cancellationToken cancels the target resolution.
     * @returns the target node key, or nothing for an action this index does not model.
     */
    protected async indexAction(
        action: ModAction,
        source: string,
        cancellationToken: CancellationToken
    ): Promise<string[]> {
        if (action.type !== 'AddBase' || action.presentFields.has('index')) return [];
        const target = action.targets[0];
        const base = action.sources[0];
        if (!target || !base || !isValueNode(base) || base.valueType.type !== 'Reference') return [];
        const resolved = await resolveActionTarget(target, cancellationToken).catch(() => null);
        if (!resolved || isFile(resolved as unknown as FileTree)) return [];
        const key = AddBaseIndex.nodeKey(resolved as AbstractNode);
        this.bucketFor(key).push({ source, base });
        return [key];
    }
}
