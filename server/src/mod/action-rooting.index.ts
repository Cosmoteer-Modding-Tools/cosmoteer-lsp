import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    ValueNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../core/ast/ast';
import { getStartOfAstNode } from '../utils/ast.utils';
import { isModRules } from '../document/document-kind';
import { AliasMemberSource, aliasRootIndex, registerAliasFallbackSource } from '../document/schema/alias-root';
import { documentRootClass } from '../document/schema/document-root';
import {
    listElementType,
    memberTypeIn,
    registerNodeSlotSource,
    resolveGroupClass,
} from '../document/schema/schema-context';
import { ValueType } from '../document/schema/schema.types';
import { FullNavigationStrategy } from '../features/navigation/full.navigation-strategy';
import { normalizeUri } from '../features/navigation/reference-location';
import { ReverseIncludeIndex } from '../features/navigation/reverse-include.index';
import { WatchedDocumentIndex } from '../features/navigation/watched-document-index';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { cachedParseFilePath } from '../workspace/fs-cache';
import { CosmoteerWorkspaceService, FileTree, FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';
import { Action } from './action';
import { isActionFragmentDocument, parseModActions } from './action-parser';
import { resolveActionTarget } from './action-target-resolver';

const navigation = new FullNavigationStrategy();

/** What a resolved target or source landing can be: a node inside a file, or a whole file. */
type Landing = AbstractNode | FileWithPath | null;

/** The group-kind {@link ValueType} for a class FullName. */
const groupType = (cls: string): ValueType => ({ kind: 'group', ref: cls, name: cls.split('.').pop() ?? cls });

/** How many reference-to-reference hops a landing is followed through before giving up. */
const MAX_REFERENCE_HOPS = 4;

/**
 * Whether a target path is one this index can type: a `<file>` prefix followed only by plain member
 * segments. Index segments are skipped because a `Remove` or an `Index`-inserting action of an
 * earlier mod renumbers them, so the node they name is load-order-dependent. Navigation segments
 * (`^`, `..`, `:`, `#`) have zero corpus uses and are skipped rather than half-modelled. A skipped
 * action just leaves its source unrooted, which is today's behavior.
 *
 * @param raw the target path as written (quotes already stripped by the lexer).
 * @returns true when every inner segment is a plain member name.
 */
const isTypableTargetPath = (raw: string): boolean => {
    const m = /^&?\s*<[^>]*>\s*(?:\/(.*))?$/.exec(raw.trim());
    if (!m) return false;
    const segments = (m[1] ?? '').split('/').map((s) => s.trim());
    return segments.every((segment) => !/^\d+$/.test(segment) && !['^', '..', ':', '#'].includes(segment));
};

/**
 * Project index of the schema types that `mod.rules` actions give their source values, so files (and
 * inline values) that enter the game tree only through actions type from the action's target slot.
 *
 * The reverse-include index roots a fragment from the field that `&<includes>` it, but a mod's
 * content fragments are typically wired in by manifest actions instead: an `AddMany` appends
 * `&<fragment>` refs to a vanilla list, an `AddBase` appends a fragment as an inheritance base, an
 * `Overrides` merges a whole fragment file over a vanilla one. Nothing in the fragment names its own
 * type. The action's target slot carries it. For every action of every manifest (and included action
 * fragment) this index resolves the target against the unpatched game tree, derives the slot type
 * the value fills per the verb's semantics (an `AddMany` target list's element type, an `Add` slot's
 * own type, the target's resolved class for `AddBase`/`Overrides` since inheritance and overriding
 * preserve type), and records it two ways:
 *
 * - A `&<fragment>` value (followed through up to {@link MAX_REFERENCE_HOPS} re-export references)
 *   records `(fragment, member) → type` and this index answers through the same
 *   {@link AliasMemberSource} sink reverse-include records use, so the fragment roots exactly like a
 *   reverse-included one. When a record for a fragment changes, that fragment is dirty-marked on the
 *   reverse-include index so its own includes re-type through the new root (the chained-fragment
 *   case), converging on the next freshness pass.
 * - An inline `{}`/`[]` value (the dominant `Add`/`Replace` form) records the node itself, keyed by
 *   its position, and this index answers through the node-slot fallback of the schema layer
 *   ({@link registerNodeSlotSource}), so the value's members complete, hover and validate inside the
 *   manifest.
 *
 * Targets are resolved against the unpatched tree, which covers the corpus's dominant shape (member
 * paths into vanilla files). Patching is not simulated. Unsafe targets are skipped entirely (see
 * {@link isTypableTargetPath}), as are cross-mod targets whose file is absent and targets whose
 * inner path fails to resolve. Scoped to the workspace mod folders, since the game `Data` tree
 * carries no mod actions.
 */
export class ActionRootingIndex extends WatchedDocumentIndex implements AliasMemberSource {
    private static _instance: ActionRootingIndex;

    /** Fragment uri (normalized) → member (lower-cased, '' for the whole file) → source uri → type. */
    private readonly byTarget = new Map<string, Map<string, Map<string, ValueType>>>();
    /** Inline/deep node key → the slot type the action gives that node. */
    private readonly byNode = new Map<string, ValueType>();
    /** Source manifest uri → its contributions, so a re-index can drop them. */
    private readonly bySource = new Map<string, { targets: Array<{ target: string; member: string }>; nodes: string[] }>();
    /** Per-source signature of the recorded entries, so an identical re-index does not move the revision. */
    private readonly sourceSignatures = new Map<string, string>();

    private constructor() {
        super();
        // Register both sinks in the constructor, before the first ensureBuilt, so they are in place
        // ahead of any synchronous schema resolution. Reverse-include registers its fallback first
        // (the instance is created earlier in the startup chain), so it stays ahead in the chain.
        registerAliasFallbackSource(this);
        registerNodeSlotSource((node) => this.nodeSlotType(node));
    }

    public static get instance(): ActionRootingIndex {
        if (!ActionRootingIndex._instance) ActionRootingIndex._instance = new ActionRootingIndex();
        return ActionRootingIndex._instance;
    }

    /** A stable identity key for a node, matching another parse of the same file content. */
    private static nodeKey(node: AbstractNode): string {
        const document = getStartOfAstNode(node);
        return `${normalizeUri(document.uri)}|${node.position?.start ?? -1},${node.position?.end ?? -1}`;
    }

    /**
     * The schema type actions gave `member` of the fragment at `uri`, when every recording action
     * agrees on it. A conflict roots to nothing, so a fragment is never given a guessed type.
     *
     * @param uri the fragment's document uri.
     * @param member the member name, or '' for the whole file. Matched case-insensitively.
     * @returns the recorded schema type, or undefined when nothing records it or sources disagree.
     */
    public memberType(uri: string, member: string): ValueType | undefined {
        const sources = this.byTarget.get(normalizeUri(uri))?.get(member.toLowerCase());
        if (!sources || sources.size === 0) return undefined;
        let chosen: ValueType | undefined;
        let signature: string | undefined;
        for (const valueType of sources.values()) {
            const current = JSON.stringify(valueType);
            if (signature === undefined) {
                signature = current;
                chosen = valueType;
            } else if (current !== signature) {
                return undefined;
            }
        }
        return chosen;
    }

    /**
     * The schema type actions gave the whole fragment at `uri` (a member-less `&<fragment>` value).
     *
     * @param uri the fragment's document uri.
     * @returns the fragment's root type, or undefined when no action records it.
     */
    public rootType(uri: string): ValueType | undefined {
        return this.memberType(uri, '');
    }

    /**
     * The slot type an action gave an inline source value or a deep fragment container, for the
     * schema layer's node-slot fallback. Synchronous, consulted per unanchorable node, so the empty
     * case returns before any key derivation.
     *
     * @param node the group or list node whose slot ordinary anchoring could not resolve.
     * @returns the recorded slot type, or undefined.
     */
    public nodeSlotType(node: GroupNode | ListNode): ValueType | undefined {
        if (this.byNode.size === 0) return undefined;
        return this.byNode.get(ActionRootingIndex.nodeKey(node));
    }

    /**
     * Builds the index once over the workspace mod folders, then reconciles changed files. The game
     * `Data` root is excluded: it holds no mod actions. Must run after the alias-root and
     * reverse-include indexes are fresh, since the target slot types resolve through them.
     *
     * @param folderPaths the project folders (the mod plus the game `Data` tree).
     * @param cancellationToken cancels the post-build reconcile.
     * @returns once the index is built and fresh.
     */
    public async ensureBuilt(folderPaths: string[], cancellationToken: CancellationToken): Promise<void> {
        const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
        const dataKey = dataRoot ? normalizeUri(dataRoot) : undefined;
        const modFolders = folderPaths.filter((folder) => normalizeUri(uriToFsPath(folder)) !== dataKey);
        await this.ensureFresh(
            (progress) => this.buildFromProject(modFolders, progress),
            cancellationToken,
            'Indexing action rooting'
        );
    }

    protected async indexDocument(document: AbstractNodeDocument, cancellationToken: CancellationToken): Promise<boolean> {
        const source = normalizeUri(document.uri);
        const previousSignature = this.sourceSignatures.get(source) ?? '';
        const previousTargets = new Set((this.bySource.get(source)?.targets ?? []).map((entry) => entry.target));
        this.removeSource(source);
        if (!isModRules(document.uri) && !isActionFragmentDocument(document)) return previousSignature !== '';

        const contributed = { targets: [] as Array<{ target: string; member: string }>, nodes: [] as string[] };
        const lines: string[] = [];
        for (const action of parseModActions(document)) {
            if (cancellationToken.isCancellationRequested) break;
            const value = action.sources[0];
            if (!value) continue;
            const slot = await this.sourceSlotFor(action, cancellationToken);
            if (!slot) continue;
            if (isValueNode(value)) {
                if (value.valueType.type === 'Reference') {
                    await this.recordValueLanding(value, slot, source, contributed, lines, cancellationToken);
                }
                continue;
            }
            // An inline `{}`/`[]` source: the node's slot resolves inside the manifest itself. An
            // AddMany list's ref elements land like whole refs (with the element type), and its
            // inline elements are recorded directly, since an identified list's elements read their
            // type through the owner class, which a manifest does not have.
            this.recordNodeSlot(value, slot, contributed, lines);
            if (action.type === 'AddMany' && isListNode(value) && slot.kind === 'list') {
                for (const element of value.elements) {
                    if (isValueNode(element) && element.valueType.type === 'Reference') {
                        await this.recordValueLanding(element, slot.element, source, contributed, lines, cancellationToken);
                    } else if (isGroupNode(element) || isListNode(element)) {
                        this.recordNodeSlot(element, slot.element, contributed, lines);
                    }
                }
            }
        }

        if (contributed.targets.length || contributed.nodes.length) this.bySource.set(source, contributed);
        const signature = lines.sort().join('\n');
        if (signature) this.sourceSignatures.set(source, signature);
        const changed = signature !== previousSignature;
        if (changed) {
            // A changed record can re-root a fragment whose own includes were untypable before, so
            // the reverse-include index re-scans it on its next freshness pass (chained fragments).
            for (const { target } of contributed.targets) previousTargets.add(target);
            for (const target of previousTargets) {
                if (target !== source) ReverseIncludeIndex.instance.markDirty(target);
            }
        }
        return changed;
    }

    /**
     * The schema type the action's source value fills, derived from the resolved target per the
     * verb's semantics. Undefined skips the action (the safe default).
     *
     * @param action the parsed action.
     * @param cancellationToken cancels the target navigation.
     * @returns the source slot type, or undefined when the target is unsafe or unresolvable.
     */
    private async sourceSlotFor(action: Action, cancellationToken: CancellationToken): Promise<ValueType | undefined> {
        const target = action.targets[0];
        if (!target) return undefined;
        if (!isTypableTargetPath(String(target.valueType.value))) return undefined;
        let resolved: Landing = await resolveActionTarget(target, cancellationToken).catch(() => null);
        // Replace operates on the target node itself (dereferenceFinalNode: false), so its slot is
        // read where the navigation landed. The container verbs need the dereferenced container.
        if (action.type !== 'Replace') resolved = await this.dereferenceLanding(resolved, cancellationToken);
        if (!resolved) return undefined;

        const node = resolved as AbstractNode;
        const wholeFile = isFile(resolved as unknown as FileTree) || isDocumentNode(node);
        switch (action.type) {
            case 'Add': {
                // Into a list the value is an element. Into a group/file it is the `Name` member,
                // whose type the container's class (or map value type) declares.
                if (!wholeFile && isListNode(node)) return listElementType(node);
                const name = action.nameNode ? String(action.nameNode.valueType.value) : undefined;
                if (!name) return undefined;
                if (wholeFile) {
                    const targetDocument = await this.landingDocument(resolved);
                    return targetDocument ? memberTypeIn(targetDocument, name) : undefined;
                }
                return isGroupNode(node) ? memberTypeIn(node, name) : undefined;
            }
            case 'AddMany': {
                if (wholeFile) return undefined;
                if (isListNode(node)) {
                    const element = listElementType(node);
                    if (element) return { kind: 'list', element };
                }
                // Into a MAP the payload holds map entries rather than list elements (a mod adding
                // its ship AIs or render layers: `AddTo = "<…>/RenderLayers"` with a `ManyToAdd` of
                // `{ Key = … Value { … } }` pairs). The payload takes the map's own type, which is
                // what the schema layer reads entry members through, and what tells the id validator
                // that a self-keyed map's keys declare rather than reference.
                const slot = isListNode(node) || isGroupNode(node) ? this.slotOfNode(node) : undefined;
                return slot?.kind === 'map' ? slot : undefined;
            }
            case 'Replace':
                return wholeFile ? undefined : this.slotOfNode(node);
            case 'Overrides':
            case 'AddBase': {
                // The value becomes a partial of the target (an override merge or an inheritance
                // base), so it types as the target's own resolved class, else as the target's slot
                // (a class-less map container like a part's `Components` keeps its map type).
                if (wholeFile) {
                    const targetDocument = await this.landingDocument(resolved);
                    return targetDocument ? this.fileRootType(targetDocument) : undefined;
                }
                if (isGroupNode(node)) {
                    const cls = resolveGroupClass(node);
                    if (cls) return groupType(cls);
                }
                return this.slotOfNode(node);
            }
            default:
                return undefined; // Remove/RemoveMany carry no value side. Unknown is not typable.
        }
    }

    /**
     * Follows a landing through final reference nodes (a target path ending on `X = &<file>/Y`
     * dereferences like the game's intermediate-segment walk), bounded by {@link MAX_REFERENCE_HOPS}.
     *
     * @param resolved the navigation landing.
     * @param cancellationToken cancels the follow-up navigation.
     * @returns the dereferenced landing, or null when a hop fails.
     */
    private async dereferenceLanding(resolved: Landing, cancellationToken: CancellationToken): Promise<Landing> {
        for (let hop = 0; resolved && hop < MAX_REFERENCE_HOPS; hop++) {
            const node = resolved as AbstractNode;
            if (isFile(resolved as unknown as FileTree) || !isValueNode(node) || node.valueType.type !== 'Reference') {
                return resolved;
            }
            resolved = (await navigation
                .navigate(String(node.valueType.value), node, getStartOfAstNode(node).uri, cancellationToken)
                .catch(() => null)) as Landing;
        }
        return resolved;
    }

    /** The parsed document behind a whole-file landing (a {@link FileWithPath} or a document root). */
    private async landingDocument(resolved: AbstractNode | FileWithPath): Promise<AbstractNodeDocument | undefined> {
        if (isDocumentNode(resolved as AbstractNode)) return resolved as AbstractNodeDocument;
        if (isFile(resolved as unknown as FileTree)) {
            return (await cachedParseFilePath((resolved as FileWithPath).path).catch(() => null)) ?? undefined;
        }
        return undefined;
    }

    /**
     * The slot type of a resolved target node, read from the field or list that declares it, through
     * the same anchoring every other schema feature uses.
     *
     * @param node the resolved target node.
     * @returns the slot's schema type, or undefined when its container cannot be anchored.
     */
    private slotOfNode(node: AbstractNode): ValueType | undefined {
        const parent = node.parent;
        if (!parent) return undefined;
        if (isListNode(parent)) return listElementType(parent);
        if (!isGroupNode(parent) && !isDocumentNode(parent)) return undefined;
        const name =
            (isGroupNode(node) || isListNode(node)) && node.identifier
                ? node.identifier.name
                : parent.elements.filter(isAssignmentNode).find((element) => element.right === node)?.left.name;
        return name ? memberTypeIn(parent, name) : undefined;
    }

    /**
     * The schema type a whole file roots to: its own root class, or the type the forward alias walk
     * or the reverse-include index recorded for it (a map file like `buffs.rules` keeps its map type).
     *
     * @param document the target file's parsed document.
     * @returns the file's root type, or undefined when it is not rooted.
     */
    private fileRootType(document: AbstractNodeDocument): ValueType | undefined {
        const native = documentRootClass(document);
        if (native) return groupType(native);
        return aliasRootIndex.rootType(document.uri) ?? ReverseIncludeIndex.instance.rootType(document.uri);
    }

    /**
     * Resolves a `&<fragment>` source value to where it lands and records the slot type there: a
     * whole file or a top-level named member records a `(fragment, member)` rooting entry, and a
     * nested container records the node itself. Re-export references (`X = &<other>/Y` at the landing)
     * are
     * followed like the game's `FindFinalTarget`, which is what routes the classic
     * `ManyToAdd = &<own_file>/Deep/Path` through the fragment it re-exports.
     *
     * @param ref the source's reference value node.
     * @param slot the schema type the action's target slot gives the value.
     * @param source the recording manifest's normalized uri.
     * @param contributed collects this source's entries for removal.
     * @param lines collects the signature lines.
     * @param cancellationToken cancels the navigation.
     */
    private async recordValueLanding(
        ref: ValueNode,
        slot: ValueType,
        source: string,
        contributed: { targets: Array<{ target: string; member: string }>; nodes: string[] },
        lines: string[],
        cancellationToken: CancellationToken
    ): Promise<void> {
        let origin: AbstractNode = ref;
        let path = String(ref.valueType.value);
        for (let hop = 0; hop < MAX_REFERENCE_HOPS; hop++) {
            const resolved = (await navigation
                .navigate(path, origin, getStartOfAstNode(origin).uri, cancellationToken)
                .catch(() => null)) as Landing;
            if (!resolved) return;
            if (isFile(resolved as unknown as FileTree)) {
                this.recordTarget(normalizeUri((resolved as FileWithPath).path), '', slot, source, contributed, lines);
                return;
            }
            const node = resolved as AbstractNode;
            if (isDocumentNode(node)) {
                this.recordTarget(normalizeUri(node.uri), '', slot, source, contributed, lines);
                return;
            }
            if (isValueNode(node) && node.valueType.type === 'Reference') {
                origin = node;
                path = String(node.valueType.value);
                continue;
            }
            if (isGroupNode(node) || isListNode(node)) {
                if (node.identifier && node.parent && isDocumentNode(node.parent)) {
                    this.recordTarget(normalizeUri(node.parent.uri), node.identifier.name, slot, source, contributed, lines);
                } else {
                    // A nested landing has no stable name to root by, so the node itself is recorded.
                    this.recordNodeSlot(node, slot, contributed, lines);
                }
            }
            return; // a scalar landing types nothing
        }
    }

    /** Records a `(fragment, member) → type` rooting entry for one source. */
    private recordTarget(
        target: string,
        member: string,
        slot: ValueType,
        source: string,
        contributed: { targets: Array<{ target: string; member: string }>; nodes: string[] },
        lines: string[]
    ): void {
        const memberKey = member.toLowerCase();
        const members = this.byTarget.get(target) ?? this.byTarget.set(target, new Map()).get(target)!;
        const sources = members.get(memberKey) ?? members.set(memberKey, new Map()).get(memberKey)!;
        sources.set(source, slot);
        contributed.targets.push({ target, member: memberKey });
        lines.push(`T ${target} ${memberKey} ${JSON.stringify(slot)}`);
    }

    /** Records a node-keyed slot type (inline values, nested landings), tracked for removal. */
    private recordNodeSlot(
        node: AbstractNode,
        slot: ValueType,
        contributed: { targets: Array<{ target: string; member: string }>; nodes: string[] },
        lines: string[]
    ): void {
        const key = ActionRootingIndex.nodeKey(node);
        this.byNode.set(key, slot);
        contributed.nodes.push(key);
        lines.push(`N ${key} ${JSON.stringify(slot)}`);
    }

    protected removeSource(source: string): void {
        this.sourceSignatures.delete(source);
        const prior = this.bySource.get(source);
        if (!prior) return;
        for (const { target, member } of prior.targets) {
            const members = this.byTarget.get(target);
            const sources = members?.get(member);
            sources?.delete(source);
            if (sources && sources.size === 0) members!.delete(member);
            if (members && members.size === 0) this.byTarget.delete(target);
        }
        for (const key of prior.nodes) this.byNode.delete(key);
        this.bySource.delete(source);
    }

    protected clear(): void {
        this.byTarget.clear();
        this.byNode.clear();
        this.bySource.clear();
        this.sourceSignatures.clear();
    }
}
