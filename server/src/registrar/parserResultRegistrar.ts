import { DocumentUri } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../parser/ast';

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
