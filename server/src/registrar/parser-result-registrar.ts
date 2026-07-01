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
        const target = normalizePath(osPath);
        for (const [uri, document] of this.results) {
            if (normalizePath(uri) === target) return document;
        }
        return undefined;
    }

    /** Every currently-registered (open/parsed) document. */
    public allResults(): IterableIterator<AbstractNodeDocument> {
        return this.results.values();
    }

    public setResult(uri: DocumentUri, result: AbstractNodeDocument): void {
        this.results.set(uri, result);
    }

    public removeResult(uri: DocumentUri): void {
        this.results.delete(uri);
    }

    public clear(): void {
        this.results.clear();
    }
}
