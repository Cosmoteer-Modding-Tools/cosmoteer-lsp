import { DocumentUri } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../core/ast/ast';

/** Canonicalize a `file://` URI or OS path for comparison (decode, slashes, case). */
const normalizePath = (uriOrPath: string): string => {
    let path = uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath;
    try {
        path = decodeURIComponent(path);
    } catch {
        /* leave as-is on malformed escapes */
    }
    return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
};

export class ParserResultRegistrar {
    private static _instance: ParserResultRegistrar;
    private results: Map<DocumentUri, AbstractNodeDocument> = new Map();
    /** Normalized path → document, kept in step with {@link results} so path lookups are O(1).
     *  Project walks look up every file here, so a linear scan would be paid per file. */
    private byNormalizedPath: Map<string, AbstractNodeDocument> = new Map();

    private constructor() {}

    public static get instance(): ParserResultRegistrar {
        if (!ParserResultRegistrar._instance) {
            ParserResultRegistrar._instance = new ParserResultRegistrar();
        }
        return ParserResultRegistrar._instance;
    }

    public getResult(uri: DocumentUri): AbstractNodeDocument | undefined {
        return this.results.get(uri);
    }

    /**
     * The in-editor AST for a file given its on-disk path, matching regardless of
     * `file://`-URI vs OS-path spelling. Lets disk-reading code prefer the live
     * (possibly unsaved) buffer over what's on disk.
     *
     * @param osPath the on-disk file path to look up.
     * @returns the registered AST for that file, or `undefined` if none is open for it.
     */
    public getResultByPath(osPath: string): AbstractNodeDocument | undefined {
        return this.byNormalizedPath.get(normalizePath(osPath));
    }

    /** Every currently-registered (open/parsed) document. */
    public allResults(): IterableIterator<AbstractNodeDocument> {
        return this.results.values();
    }

    public setResult(uri: DocumentUri, result: AbstractNodeDocument): void {
        this.results.set(uri, result);
        this.byNormalizedPath.set(normalizePath(uri), result);
    }

    public removeResult(uri: DocumentUri): void {
        const removed = this.results.get(uri);
        this.results.delete(uri);
        if (!removed) return;
        const normalized = normalizePath(uri);
        if (this.byNormalizedPath.get(normalized) !== removed) return;
        this.byNormalizedPath.delete(normalized);
        // The same file can be registered under another uri spelling. Re-point the path entry at
        // that surviving document so path lookups keep finding it.
        for (const [otherUri, document] of this.results) {
            if (normalizePath(otherUri) === normalized) {
                this.byNormalizedPath.set(normalized, document);
                return;
            }
        }
    }

    public clear(): void {
        this.results.clear();
        this.byNormalizedPath.clear();
    }
}
