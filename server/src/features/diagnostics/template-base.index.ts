import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { normalizeUri } from '../navigation/reference-location';
import { WatchedDocumentIndex } from '../navigation/watched-document-index';
import { inheritanceBaseLeafName } from '../../utils/reference.utils';

/** Every distinct name used as an inheritance base anywhere in one document (`Floor : BASE_SPRITES`). */
const baseNamesOf = (document: AbstractNodeDocument): string[] => {
    const names = new Set<string>();
    const visit = (node: AbstractNode): void => {
        if (isGroupNode(node) || isListNode(node)) {
            for (const reference of node.inheritance ?? []) {
                if (!isValueNode(reference) || reference.valueType.type !== 'Reference') continue;
                const leaf = inheritanceBaseLeafName(reference.valueType.value);
                if (leaf) names.add(leaf);
            }
        }
        const children = isGroupNode(node) || isListNode(node) || isDocumentNode(node)
            ? node.elements
            : isAssignmentNode(node)
              ? (node.right ? [node.right] : [])
              : [];
        for (const child of children) visit(child);
    };
    visit(document);
    return [...names];
};

/**
 * Project-wide index of the group names used as an inheritance base anywhere in the workspace, the
 * data the required-field check needs to recognize a cross-file template. A `BASE_THERMAL_PORT` group
 * defined in `base_part_overclock.rules` and inherited by other part files looks like a normal
 * instance to a single-file scan, so its own file would false-positive on its (template-supplied)
 * required fields. This index makes that base name known project-wide so the group is skipped.
 *
 * Deliberately name-based and resolution-free: it is a pure syntactic walk of each file's inheritance
 * references (no go-to-definition, no disk I/O beyond the one parse the workspace already does), so it
 * stays cheap on large mods. The build over the whole vanilla tree is tens of milliseconds on top of
 * the parse the project already pays. Over-skipping from a name collision only suppresses a warning,
 * never raises a false one. Built once over {@link projectDocuments} and kept current by the file
 * watcher via {@link WatchedDocumentIndex} (see `server.ts` markDirty/remove/reset wiring).
 */
export class TemplateBaseIndex extends WatchedDocumentIndex {
    private static _instance: TemplateBaseIndex;

    /** base name → how many source files reference it as an inheritance base (so removal can decrement). */
    private readonly counts = new Map<string, number>();
    /** normalized source uri → the distinct base names that file contributed. */
    private readonly bySource = new Map<string, string[]>();
    /** normalized source uri → the file's original (parseable) uri, so a query can re-parse it. The
     *  normalized key is lower-cased and slash-stripped for identity, which is not a valid path off
     *  Windows, so the raw uri is kept for {@link uriToFsPath}. */
    private readonly rawUriBySource = new Map<string, string>();
    /** Reverse edge: lower-cased base leaf name → the normalized source uris that inherit it. This is
     *  the inheritor→base relation the virtual-inheritance (`:`) resolver walks the other way, to find
     *  the derived overrides of a base group. Keyed case-insensitively, like the game's member lookup. */
    private readonly byName = new Map<string, Set<string>>();
    /** Snapshot handed out by {@link baseNames}, rebuilt only after the counts changed. */
    private namesSnapshot: ReadonlySet<string> | null = null;

    private constructor() {
        super();
    }

    public static get instance(): TemplateBaseIndex {
        if (!TemplateBaseIndex._instance) TemplateBaseIndex._instance = new TemplateBaseIndex();
        return TemplateBaseIndex._instance;
    }

    /** This index's slot in the persistent game-tree cache. */
    public readonly cacheId = 'templateBases';

    protected clear(): void {
        this.counts.clear();
        this.bySource.clear();
        this.rawUriBySource.clear();
        this.byName.clear();
        this.namesSnapshot = null;
    }

    /** Registers the reverse edge (base name → source) and the source's raw uri for a just-indexed file. */
    private addReverse(source: string, rawUri: string, names: string[]): void {
        this.rawUriBySource.set(source, rawUri);
        for (const name of names) {
            const lower = name.toLowerCase();
            (this.byName.get(lower) ?? this.byName.set(lower, new Set()).get(lower)!).add(source);
        }
    }

    /**
     * The original (parseable) uris of every file that inherits a base named `name`, matched
     * case-insensitively. These are the candidate files the virtual-inheritance resolver re-parses to
     * find the concrete overrides of the base (a superset, since a name collision or a same-named base
     * in another chain can appear here), so the resolver confirms each candidate by resolving its
     * inheritance reference back to the base node.
     *
     * @param name the base group's leaf name.
     * @returns the raw uris of the inheriting files, or an empty array when none inherit that name.
     */
    public documentsForBaseName(name: string): string[] {
        const sources = this.byName.get(name.toLowerCase());
        if (!sources) return [];
        const uris: string[] = [];
        for (const source of sources) {
            const raw = this.rawUriBySource.get(source);
            if (raw) uris.push(raw);
        }
        return uris;
    }

    /**
     * Serializes the per-source base names for the persistent game-tree cache.
     *
     * @returns the JSON-safe state.
     */
    public saveState(): unknown {
        return {
            bySource: [...this.bySource.entries()],
            rawUris: [...this.rawUriBySource.entries()],
        };
    }

    /**
     * Primes the index from a previously saved state, rebuilding the reference counts from the
     * per-source name lists.
     *
     * @param state the value a prior {@link saveState} returned.
     * @returns true when the state had the expected shape and was loaded.
     */
    public loadState(state: unknown): boolean {
        const parsed = state as { bySource?: Array<[string, string[]]>; rawUris?: Array<[string, string]> };
        // A legacy array-shaped cache predates the reverse edge; reject it so the index rebuilds and
        // populates the raw-uri and name maps the virtual-inheritance resolver needs.
        if (!parsed || !Array.isArray(parsed.bySource) || !Array.isArray(parsed.rawUris)) return false;
        this.clear();
        const rawUris = new Map(parsed.rawUris);
        for (const entry of parsed.bySource) {
            if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) return false;
            const [source, names] = entry;
            this.bySource.set(source, names);
            for (const name of names) this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
            const raw = rawUris.get(source);
            if (raw) this.addReverse(source, raw, names);
        }
        return true;
    }

    protected removeSource(source: string): void {
        const prior = this.bySource.get(source);
        if (!prior) return;
        this.namesSnapshot = null;
        for (const name of prior) {
            const next = (this.counts.get(name) ?? 0) - 1;
            if (next <= 0) this.counts.delete(name);
            else this.counts.set(name, next);
            const sources = this.byName.get(name.toLowerCase());
            sources?.delete(source);
            if (sources && sources.size === 0) this.byName.delete(name.toLowerCase());
        }
        this.bySource.delete(source);
        this.rawUriBySource.delete(source);
    }

    protected indexDocument(document: AbstractNodeDocument): boolean {
        const source = normalizeUri(document.uri);
        const prior = this.bySource.get(source);
        const names = baseNamesOf(document);
        const changed = prior
            ? prior.length !== names.length || prior.some((name, index) => name !== names[index])
            : names.length > 0;
        this.removeSource(source);
        if (!names.length) return changed;
        this.namesSnapshot = null;
        this.bySource.set(source, names);
        for (const name of names) this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
        this.addReverse(source, document.uri, names);
        return changed;
    }

    /** The set of names used as an inheritance base anywhere in the project, after refreshing the index. */
    public async baseNames(folderPaths: string[], cancellationToken: CancellationToken): Promise<ReadonlySet<string>> {
        await this.ensureFresh(
            (progress) => this.buildFromProject(folderPaths, progress),
            cancellationToken,
            'Indexing inheritance bases'
        );
        if (!this.namesSnapshot) this.namesSnapshot = new Set(this.counts.keys());
        return this.namesSnapshot;
    }
}
