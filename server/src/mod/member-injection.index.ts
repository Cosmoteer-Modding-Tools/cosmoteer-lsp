import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isDocumentNode, isGroupNode, isValueNode } from '../core/ast/ast';
import { getStartOfAstNode, namedMembersOf, parseFilePath } from '../utils/ast.utils';
import { isModRules } from '../document/document-kind';
import { registerMemberExtensionSource } from '../semantics/reference-resolver';
import { WatchedDocumentIndex } from '../features/navigation/watched-document-index';
import { normalizeUri } from '../features/navigation/reference-location';
import { modFolderPaths, uriToFsPath } from '../features/navigation/workspace-files';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { FileTree, FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';
import { isActionFragmentDocument, parseModActions } from './action-parser';
import { resolveActionTarget } from './action-target-resolver';

/** One member a nested `Overrides` action merges into a node. */
interface InjectedMember {
    /** Normalized uri of the manifest/fragment whose action injected it (for removal). */
    readonly source: string;
    /** The member name as written (the key the reference uses). */
    readonly name: string;
    /** The member's declaration node (an `Overrides {}` child), so navigation lands on it. */
    readonly node: AbstractNode;
}

const navigation = new FullNavigationStrategy();

/**
 * Project index of the members that `mod.rules` actions merge into a game-tree node, either a nested
 * `Overrides` (its `Overrides` group's members) or an `Add` with a `Name` (the single `Name = ToAdd`
 * member), so a reference to such a member resolves everywhere the resolver runs.
 *
 * mod-context already folds whole-file overrides (`OverrideIn=<…/indicators.rules>`) into the effective
 * tree, but a nested-container override (`OverrideIn=<…/missile_launcher.rules>/Part/Components` adding a
 * `FlareMissilesToggle`) is not, since its members would lose their container sub-path if attributed at
 * the file level. This index records those per target node and registers itself as the resolver's
 * member-extension source ({@link registerMemberExtensionSource}), so `stepIntoNode` resolves an
 * injected member when the node defines none of its own. Whole-file targets are skipped (mod-context
 * owns them). Scoped to the workspace mod folders, since the game `Data` tree carries no mod actions.
 */
export class MemberInjectionIndex extends WatchedDocumentIndex {
    private static _instance: MemberInjectionIndex;

    /** Target node key → the members injected into it. */
    private readonly byNode = new Map<string, InjectedMember[]>();
    /** Source document uri → the target node keys it contributed to, so a re-index can drop them. */
    private readonly bySource = new Map<string, string[]>();

    private constructor() {
        super();
        registerMemberExtensionSource((node, member) => this.injectedMember(node, member));
    }

    public static get instance(): MemberInjectionIndex {
        if (!MemberInjectionIndex._instance) MemberInjectionIndex._instance = new MemberInjectionIndex();
        return MemberInjectionIndex._instance;
    }

    /**
     * A stable identity key for a game-tree node, matching another resolution of the same cached node.
     *
     * @param node the node to key.
     * @returns the node's identity key.
     */
    private static nodeKey(node: AbstractNode): string {
        const document = getStartOfAstNode(node);
        return `${normalizeUri(document.uri)}|${node.position?.start ?? -1},${node.position?.end ?? -1}`;
    }

    /**
     * The member a nested `Overrides` merged into `node` under `name` (case-insensitively, like the
     * game's node lookup), or undefined. Synchronous, for the resolver's per-segment step.
     *
     * @param node the node whose injected members are queried.
     * @param name the member name the reference asks for.
     * @returns the injected member's declaration node, or undefined.
     */
    public injectedMember(node: AbstractNode, name: string): AbstractNode | undefined {
        const members = this.byNode.get(MemberInjectionIndex.nodeKey(node));
        if (!members) return undefined;
        const lower = name.toLowerCase();
        return members.find((member) => member.name.toLowerCase() === lower)?.node;
    }

    /**
     * The names of every member a nested `Overrides` merges into `node`, for completion listing.
     *
     * @param node the node whose injected member names are queried.
     * @returns the injected member names, empty when nothing is injected.
     */
    public injectedMemberNames(node: AbstractNode): string[] {
        return (this.byNode.get(MemberInjectionIndex.nodeKey(node)) ?? []).map((member) => member.name);
    }

    /**
     * Builds the index once over the workspace mod folders, then reconciles changed files. The game
     * `Data` root is excluded: it holds no mod actions.
     *
     * @param folderPaths the project folders (the mod plus the game `Data` tree).
     * @param cancellationToken cancels the post-build reconcile.
     * @returns once the index is built and fresh.
     */
    public async ensureBuilt(folderPaths: string[], cancellationToken: CancellationToken): Promise<void> {
        await this.ensureFresh(
            (progress) => this.buildFromProject(modFolderPaths(folderPaths), progress),
            cancellationToken,
            'Indexing overrides'
        );
    }

    /**
     * The members an `Overrides` source merges in: an inline `{}` group's members, or the top-level
     * members of the file a `&<modfile>` source dereferences to.
     *
     * @param source the action's source value node.
     * @returns the merged members as `[name, node]` pairs, empty when the source names none.
     */
    private async overrideMembers(source: AbstractNode): Promise<[string, AbstractNode][]> {
        if (isGroupNode(source)) return namedMembersOf(source);
        if (isValueNode(source) && source.valueType.type === 'Reference') {
            const resolved = await navigation
                .navigate(String(source.valueType.value), source, getStartOfAstNode(source).uri, CancellationToken.None)
                .catch(() => null);
            if (!resolved) return [];
            if (isFile(resolved as unknown as FileTree)) {
                const document = await parseFilePath((resolved as FileWithPath).path).catch(() => null);
                return document ? namedMembersOf(document) : [];
            }
            if (isDocumentNode(resolved as AbstractNode)) return namedMembersOf(resolved as AbstractNodeDocument);
        }
        return [];
    }

    /**
     * Re-indexes one document, replacing whatever it contributed before with the members its actions
     * merge into their target nodes. Only manifests and included action fragments carry mod actions,
     * so any other document contributes nothing.
     *
     * @param document the parsed document to index.
     * @param cancellationToken cancels the action walk.
     * @returns true when this source's contribution differs from the one it replaced.
     */
    protected async indexDocument(document: AbstractNodeDocument, cancellationToken: CancellationToken): Promise<boolean> {
        const source = normalizeUri(document.uri);
        const previous = this.bySource.get(source) ?? [];
        this.removeSource(source);
        if (!isModRules(document.uri) && !isActionFragmentDocument(document)) return previous.length > 0;

        const contributedKeys: string[] = [];
        for (const action of parseModActions(document)) {
            if (cancellationToken.isCancellationRequested) break;
            // The members an action merges into its target node, by name. `Overrides` merges the
            // members of its `Overrides` source. `Add` with a `Name` merges the single member
            // `Name = ToAdd` (the game keys it under `Name`, verified from ModAddAction). Other verbs
            // inject no named member: `AddMany` appends list elements, `AddBase` extends the
            // inheritance list (handled by the AddBase index), and `Replace`/`Remove` add nothing.
            let members: [string, AbstractNode][];
            if (action.type === 'Overrides' && action.sources[0]) {
                members = await this.overrideMembers(action.sources[0]);
            } else if (action.type === 'Add' && action.nameNode && action.sources[0]) {
                members = [[String(action.nameNode.valueType.value), action.sources[0]]];
            } else {
                continue;
            }
            if (members.length === 0) continue;
            const target = action.targets[0];
            if (!target) continue;
            const resolved = await resolveActionTarget(target, cancellationToken).catch(() => null);
            // Whole-file targets are owned by mod-context, so only a node target is indexed here.
            if (!resolved || isFile(resolved as unknown as FileTree) || isDocumentNode(resolved as AbstractNode)) continue;
            const key = MemberInjectionIndex.nodeKey(resolved as AbstractNode);
            const bucket = this.byNode.get(key) ?? this.byNode.set(key, []).get(key)!;
            for (const [name, node] of members) bucket.push({ source, name, node });
            contributedKeys.push(key);
        }
        if (contributedKeys.length) this.bySource.set(source, contributedKeys);
        return contributedKeys.length > 0 || previous.length > 0;
    }

    protected removeSource(source: string): void {
        const keys = this.bySource.get(source);
        if (!keys) return;
        for (const key of keys) {
            const members = this.byNode.get(key);
            if (!members) continue;
            const kept = members.filter((member) => member.source !== source);
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
