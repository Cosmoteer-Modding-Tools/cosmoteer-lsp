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
              ? [node.right]
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
    }

    /**
     * Serializes the per-source base names for the persistent game-tree cache.
     *
     * @returns the JSON-safe state.
     */
    public saveState(): unknown {
        return [...this.bySource.entries()];
    }

    /**
     * Primes the index from a previously saved state, rebuilding the reference counts from the
     * per-source name lists.
     *
     * @param state the value a prior {@link saveState} returned.
     * @returns true when the state had the expected shape and was loaded.
     */
    public loadState(state: unknown): boolean {
        if (!Array.isArray(state)) return false;
        this.clear();
        for (const entry of state as Array<[string, string[]]>) {
            if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) return false;
            const [source, names] = entry;
            this.bySource.set(source, names);
            for (const name of names) this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
        }
        return true;
    }

    protected removeSource(source: string): void {
        const prior = this.bySource.get(source);
        if (!prior) return;
        for (const name of prior) {
            const next = (this.counts.get(name) ?? 0) - 1;
            if (next <= 0) this.counts.delete(name);
            else this.counts.set(name, next);
        }
        this.bySource.delete(source);
    }

    protected indexDocument(document: AbstractNodeDocument): void {
        const source = normalizeUri(document.uri);
        this.removeSource(source);
        const names = baseNamesOf(document);
        if (!names.length) return;
        this.bySource.set(source, names);
        for (const name of names) this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    }

    /** The set of names used as an inheritance base anywhere in the project, after refreshing the index. */
    public async baseNames(folderPaths: string[], cancellationToken: CancellationToken): Promise<ReadonlySet<string>> {
        await this.ensureFresh(
            (progress) => this.buildFromProject(folderPaths, progress),
            cancellationToken,
            'Indexing inheritance bases'
        );
        return new Set(this.counts.keys());
    }
}
