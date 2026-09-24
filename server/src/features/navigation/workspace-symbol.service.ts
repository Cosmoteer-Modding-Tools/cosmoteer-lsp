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
import { valueSymbolKind } from './document-symbol.service';
import { filePathToUri } from '../../document/reference-path';
import { normalizeUri, rangeOf } from '../../document/reference-location';
import { WatchedDocumentIndex } from '../../workspace/watched-document-index';

/** Cap on returned symbols, so an empty query over a large project can't flood the client. */
const MAX_RESULTS = 2000;

/**
 * Workspace symbol search (`workspace/symbol`): the flat, project-wide name table that
 * powers "Go to Symbol in Workspace". Emits one {@link WorkspaceSymbol} per named member
 * (identified `Group`/`List`, `key = value` assignment), carrying its enclosing container
 * as `containerName` for disambiguation.
 *
 * Backed by a cached per-document symbol table (built once over {@link projectDocuments},
 * kept current by the client file watcher via the {@link WatchedDocumentIndex} base) so
 * queries don't re-parse the whole project each time. Only the substring filter runs per
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

        // Substring pre-filter over the cache. The client still applies its own fuzzy ranking.
        const needle = query.toLowerCase();
        // An empty query matches everything and has nothing to rank by, so the first files' symbols
        // are as good an answer as any and the walk stops as soon as the cap is full.
        if (!needle) {
            const all: WorkspaceSymbol[] = [];
            for (const symbols of this.bySource.values()) {
                for (const symbol of symbols) {
                    all.push(symbol);
                    if (all.length >= MAX_RESULTS) return all;
                }
            }
            return all;
        }
        // A common field name matches far more symbols than the cap holds, and cutting the walk at
        // the cap answered whichever files the index happened to walk first. Typing the name in
        // full did not help, because the exact matches sit behind thousands of substring ones. So
        // the matches are collected by how well they match and cut afterwards, which puts every
        // exact match in the answer before a single substring one.
        const exact: WorkspaceSymbol[] = [];
        const prefix: WorkspaceSymbol[] = [];
        const substring: WorkspaceSymbol[] = [];
        for (const symbols of this.bySource.values()) {
            for (const symbol of symbols) {
                const name = symbol.name.toLowerCase();
                if (name === needle) exact.push(symbol);
                else if (name.startsWith(needle)) prefix.push(symbol);
                else if (name.includes(needle)) substring.push(symbol);
            }
        }
        return [...exact, ...prefix, ...substring].slice(0, MAX_RESULTS);
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
                if (element.right && (isGroupNode(element.right) || isListNode(element.right))) {
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

    private kindOf(node: AbstractNode | null): SymbolKind {
        if (!node) return SymbolKind.Field;
        if (isGroupNode(node)) return SymbolKind.Object;
        if (isListNode(node)) return SymbolKind.Array;
        if (isValueNode(node)) return valueSymbolKind(node);
        return SymbolKind.Field;
    }
}
