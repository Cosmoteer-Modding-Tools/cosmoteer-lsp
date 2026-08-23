import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isDocumentNode, isGroupNode, isListNode, isValueNode } from '../core/ast/ast';
import { getStartOfAstNode, namedMembersOf, parseFilePath } from '../utils/ast.utils';
import { isModRules } from '../document/document-kind';
import {
    registerMemberEnumerationSource,
    registerMemberExtensionSource,
    registerMemberReplacementSource,
} from '../semantics/reference-resolver';
import { WatchedDocumentIndex } from '../features/navigation/watched-document-index';
import { normalizeUri } from '../features/navigation/reference-location';
import { modFolderPaths } from '../features/navigation/workspace-files';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { FileTree, FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';
import { isActionFragmentDocument, parseModActions } from './action-parser';
import { resolveActionTarget, resolveActionTargetMember } from './action-target-resolver';

/**
 * What an action does to a name the target node already writes itself, read from the verbs in
 * `Cosmoteer.Mods`. `Overrides` swaps the target's own child outright, keeping its place, and creates
 * the member where the target writes none, so the injected declaration is the one the game reads.
 * `Add` inserts beside it, and the game refuses to load a group that would end up with the name
 * twice, so a colliding `Add` names no winner at all. `Remove` and `RemoveMany` delete the child from
 * its parent, and what the game then reads under that name is whatever a base supplies, or nothing.
 * `Replace` swaps the child like an `Overrides` but creates nothing: it names a member that already
 * exists, so where the target writes none there is nothing here for it to rewrite.
 */
type InjectionPrecedence = 'replaces' | 'adds' | 'removes' | 'rewrites';

/** One member a mod action merges into a node. */
interface InjectedMember {
    /** Normalized uri of the manifest/fragment whose action injected it (for removal). */
    readonly source: string;
    /** The member name as written (the key the reference uses). */
    readonly name: string;
    /** The member's declaration node (an `Overrides {}` child), so navigation lands on it. For a
     *  removal there is no new declaration, so this is the action's own target value node. */
    readonly node: AbstractNode;
    /** What it does to a member of that name the target writes itself. */
    readonly precedence: InjectionPrecedence;
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
 *
 * `Replace` and `Remove` are recorded here too, since both rewrite a member of an existing node. Two
 * shapes of them are deliberately left unmodelled, each because the answer would claim more than the
 * editor can stand behind. A target whose last segment is a list index is refused, because the game
 * renumbers a list when it removes an element and every index written after that one means something
 * else afterwards. And a removal of a name the target only inherits is not recorded: the game deletes
 * that member from the base it actually lives in, which reaches every file deriving from that base,
 * and this index would have to speak for files it was never asked about.
 *
 * A removal changes what the effective member set holds, never what a reference resolves to. The
 * game does fail to read a reference to a removed member, but a mod may remove a member of the
 * game's own tree, so resolving such a reference to nothing would report the game's files and every
 * other mod's files at the author of the removal. What the removal is worth saying is said where the
 * member set is shown.
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
        registerMemberEnumerationSource((node) => this.injectedMemberEntries(node));
        registerMemberReplacementSource((node, member) => this.injectedReplacement(node, member));
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
        // A removal declares nothing, so its record must never be handed back as a member: the node
        // it carries is the action's own target, which is a path in a manifest rather than a value.
        // A `Replace` names a member that already exists and creates none, so it adds nothing here
        // either. The last action written is the one the game leaves in place.
        return members.findLast(
            (member) =>
                member.precedence !== 'removes' &&
                member.precedence !== 'rewrites' &&
                member.name.toLowerCase() === lower
        )?.node;
    }

    /**
     * The member an `Overrides` action puts in place of the one `node` writes itself, or undefined.
     * Asked for every named segment of every reference, so it answers without building a key while
     * no mod action injects anything at all.
     *
     * @param node the node whose injected members are queried.
     * @param name the member name the reference asks for.
     * @returns the replacing declaration node, or undefined when nothing replaces that name.
     */
    public injectedReplacement(node: AbstractNode, name: string): AbstractNode | undefined {
        if (this.byNode.size === 0) return undefined;
        const members = this.byNode.get(MemberInjectionIndex.nodeKey(node));
        if (!members) return undefined;
        const lower = name.toLowerCase();
        // A `Replace` counts here and not in `injectedMember`: it never creates the member, and this
        // is asked only for a name the container already writes, which is where it does apply.
        return members.findLast(
            (member) =>
                (member.precedence === 'replaces' || member.precedence === 'rewrites') &&
                member.name.toLowerCase() === lower
        )?.node;
    }

    /**
     * The names of every member a mod action merges into `node`, for completion listing. A name a
     * `Remove` deletes is not among them: offering it would complete to a member the game does not
     * read there.
     *
     * @param node the node whose injected member names are queried.
     * @returns the injected member names, empty when nothing is injected.
     */
    public injectedMemberNames(node: AbstractNode): string[] {
        const names = new Set<string>();
        for (const member of this.byNode.get(MemberInjectionIndex.nodeKey(node)) ?? []) {
            // A `Replace` names a member the node already has, so it adds no name of its own, and a
            // `Remove` takes one away. Both are applied in written order, like the game applies them.
            if (member.precedence === 'removes' || member.precedence === 'rewrites') names.delete(member.name);
            else names.add(member.name);
        }
        return [...names];
    }

    /**
     * Every member a mod action merges into `node`, with what each one does to a member of that name
     * the node writes itself. A walk that folds a container's effective members needs the second
     * half: an `Overrides` member is what the game reads there, and an `Add` member is not.
     *
     * @param node the node whose injected members are queried.
     * @returns one entry per injected member, empty when nothing is injected.
     */
    public injectedMemberEntries(
        node: AbstractNode
    ): Array<{ name: string; precedence: InjectionPrecedence; value: AbstractNode }> {
        return (this.byNode.get(MemberInjectionIndex.nodeKey(node)) ?? []).map((member) => ({
            name: member.name,
            precedence: member.precedence,
            value: member.node,
        }));
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
     * The node key and member name a `Replace` or `Remove` target rewrites, or undefined when the
     * target is one this index refuses to model.
     *
     * Three shapes are refused, in every case because modelling one would claim more than the editor
     * can stand behind. A numeric last segment, since the game renumbers a list on removal and every
     * index written after it means something else afterwards. A container the walk cannot reach. And
     * a whole-file target, which the game refuses to replace at all.
     *
     * @param target the action's target value node.
     * @param cancellationToken cancels the resolution.
     * @returns the target node's key and the member name, or undefined.
     */
    private async rewrittenMemberKey(
        target: AbstractNode,
        cancellationToken: CancellationToken
    ): Promise<{ node: string; member: string } | undefined> {
        if (!isValueNode(target)) return undefined;
        const resolved = await resolveActionTargetMember(target, cancellationToken).catch(() => null);
        if (!resolved) return undefined;
        // The game renumbers a list when it removes an element, so every index written after that one
        // means something else afterwards and none of them can be spoken for.
        if (/^\d+$/.test(resolved.member)) return undefined;
        const container = resolved.container;
        // A member of a file's own root is rewritten like any other: its parent is the file, which
        // the walk hands back as a file rather than as the document node the fold reads.
        if (isFile(container as unknown as FileTree)) {
            const document = await parseFilePath((container as FileWithPath).path).catch(() => null);
            return document ? { node: MemberInjectionIndex.nodeKey(document), member: resolved.member } : undefined;
        }
        return { node: MemberInjectionIndex.nodeKey(container as AbstractNode), member: resolved.member };
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
            // The members an action merges into its target node, by name. `Overrides` merges the
            // members of its `Overrides` source, replacing what the target writes under each name.
            // `Add` with a `Name` merges the single member `Name = ToAdd` (the game keys it under
            // `Name`) beside what is already there. Other verbs inject no named member: `AddMany`
            // appends list elements, `AddBase` extends the inheritance list (handled by the AddBase
            // index), and `Replace`/`Remove` name an existing member rather than merging one in,
            // which needs a target resolved without dereferencing its final node.
            // `Replace` and `Remove` name an existing member instead of merging one in, so their
            // target is resolved without following that member, the way the game reads them.
            if (action.type === 'Replace' || action.type === 'Remove' || action.type === 'RemoveMany') {
                for (const target of action.targets) {
                    // A removal declares nothing new, so the action's own target node is what a
                    // reader is pointed at when it asks where the change came from.
                    const declaration = action.type === 'Replace' ? action.sources[0] : target;
                    if (!declaration) continue;
                    const key = await this.rewrittenMemberKey(target, cancellationToken);
                    if (!key) continue;
                    const bucket = this.byNode.get(key.node) ?? this.byNode.set(key.node, []).get(key.node)!;
                    bucket.push({
                        source,
                        name: key.member,
                        node: declaration,
                        precedence: action.type === 'Replace' ? 'rewrites' : 'removes',
                    });
                    contributedKeys.push(key.node);
                }
                continue;
            }
            let members: [string, AbstractNode][];
            let precedence: InjectionPrecedence;
            if (action.type === 'Overrides' && action.sources[0]) {
                members = await this.overrideMembers(action.sources[0]);
                precedence = 'replaces';
            } else if (action.type === 'Add' && action.nameNode && action.sources[0]) {
                members = [[String(action.nameNode.valueType.value), action.sources[0]]];
                precedence = 'adds';
            } else {
                continue;
            }
            if (members.length === 0) continue;
            const target = action.targets[0];
            if (!target) continue;
            const resolved = await resolveActionTarget(target, cancellationToken).catch(() => null);
            // Whole-file targets are owned by mod-context, so only a node target is indexed here.
            if (!resolved || isFile(resolved as unknown as FileTree) || isDocumentNode(resolved as AbstractNode))
                continue;
            // A list target ignores the `Name` outright and appends an anonymous element, so a named
            // member recorded there is a record nothing can ever read.
            if (precedence === 'adds' && isListNode(resolved as AbstractNode)) continue;
            const key = MemberInjectionIndex.nodeKey(resolved as AbstractNode);
            const bucket = this.byNode.get(key) ?? this.byNode.set(key, []).get(key)!;
            for (const [name, node] of members) bucket.push({ source, name, node, precedence });
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
