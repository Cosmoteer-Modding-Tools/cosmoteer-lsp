import { CancellationToken, Location, SymbolKind, WorkspaceSymbol } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    ListNode,
    isListNode,
    isAssignmentNode,
    isGroupNode,
    isValueNode,
    GroupNode,
} from '../../core/ast/ast';
import { filePathToUri } from './navigation-strategy';
import { normalizeUri, rangeOf } from './reference-location';
import { WatchedDocumentIndex } from './watched-document-index';

/** Cap on returned symbols, so an empty query over a large project can't flood the client. */
const MAX_RESULTS = 2000;

/**
 * Workspace symbol search (`workspace/symbol`) — the flat, project-wide name table that
 * powers "Go to Symbol in Workspace". Emits one {@link WorkspaceSymbol} per named member
 * (identified `Group`/`List`, `key = value` assignment), carrying its enclosing container
 * as `containerName` for disambiguation.
 *
 * Backed by a cached per-document symbol table (built once over {@link projectDocuments},
 * kept current by the client file watcher via the {@link WatchedDocumentIndex} base) so
 * queries don't re-parse the whole project each time — only the substring filter runs per
 * query.
 */
export class WorkspaceSymbolService extends WatchedDocumentIndex {
    private static _instance: WorkspaceSymbolService;

    /** normalized source uri → that file's symbols (the full set, unfiltered). */
    private readonly bySource = new Map<string, WorkspaceSymbol[]>();

    private constructor() {
        super();
    }

    public static get instance(): WorkspaceSymbolService {
        if (!WorkspaceSymbolService._instance) {
            WorkspaceSymbolService._instance = new WorkspaceSymbolService();
        }
        return WorkspaceSymbolService._instance;
    }

    protected clear(): void {
        this.bySource.clear();
    }

    public async getWorkspaceSymbols(
        query: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<WorkspaceSymbol[]> {
        await this.ensureFresh(
            (progress) => this.buildFromProject(folderPaths, progress),
            cancellationToken,
            'Indexing symbols'
        );

        // Substring pre-filter over the cache. The client still applies its own fuzzy
        // ranking. An empty query matches everything (bounded by MAX_RESULTS).
        const needle = query.toLowerCase();
        const results: WorkspaceSymbol[] = [];
        for (const symbols of this.bySource.values()) {
            for (const symbol of symbols) {
                if (needle && !symbol.name.toLowerCase().includes(needle)) continue;
                results.push(symbol);
                if (results.length >= MAX_RESULTS) return results;
            }
        }
        return results;
    }

    /** (Re)build one document's symbols, replacing any prior set from the same source. */
    protected indexDocument(document: AbstractNodeDocument): void {
        const symbols: WorkspaceSymbol[] = [];
        this.collect(document, document.uri, undefined, symbols);
        this.bySource.set(normalizeUri(document.uri), symbols);
    }

    protected removeSource(source: string): void {
        this.bySource.delete(source);
    }

    private collect(
        container: GroupNode | ListNode | AbstractNodeDocument,
        uri: string,
        containerName: string | undefined,
        out: WorkspaceSymbol[]
    ): void {
        for (const element of container.elements) {
            if (!element) continue; // error-parsed docs can have null slots
            if ((isGroupNode(element) || isListNode(element)) && element.identifier) {
                out.push(this.symbol(element.identifier.name, this.kindOf(element), element, uri, containerName));
                this.collect(element, uri, element.identifier.name, out);
            } else if (isGroupNode(element) || isListNode(element)) {
                // Anonymous container (e.g. a list entry): no symbol of its own, but recurse
                // so nested named members are still found.
                this.collect(element, uri, containerName, out);
            } else if (isAssignmentNode(element)) {
                out.push(this.symbol(element.left.name, this.kindOf(element.right), element.left, uri, containerName));
                if (isGroupNode(element.right) || isListNode(element.right)) {
                    this.collect(element.right, uri, element.left.name, out);
                }
            }
        }
    }

    private symbol(
        name: string,
        kind: SymbolKind,
        target: AbstractNode,
        uri: string,
        containerName: string | undefined
    ): WorkspaceSymbol {
        const location: Location = { uri: filePathToUri(uri), range: rangeOf(target) };
        return { name, kind, location, containerName };
    }

    private kindOf(node: AbstractNode): SymbolKind {
        if (isGroupNode(node)) return SymbolKind.Object;
        if (isListNode(node)) return SymbolKind.Array;
        if (isValueNode(node)) {
            switch (node.valueType.type) {
                case 'String':
                    return SymbolKind.String;
                case 'Number':
                    return SymbolKind.Number;
                case 'Boolean':
                    return SymbolKind.Boolean;
                case 'Reference':
                    return SymbolKind.Variable;
                case 'Sprite':
                case 'Sound':
                case 'Shader':
                    return SymbolKind.File;
            }
        }
        return SymbolKind.Field;
    }
}
