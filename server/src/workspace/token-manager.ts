import { CancellationToken, CancellationTokenSource, URI, Disposable } from 'vscode-languageserver';

export class WorkspaceTokenManager implements Disposable {
    private readonly tokens: Map<URI, CancellationTokenSource> = new Map();

    constructor() {}

    public cancelToken(uri: URI): void {
        const tokenSource = this.tokens.get(uri);
        if (tokenSource) {
            tokenSource.cancel();
            this.tokens.delete(uri);
        }
    }

    public createToken(uri: URI): CancellationToken {
        const tokenSource = new CancellationTokenSource();
        if (this.tokens.has(uri)) {
            this.cancelToken(uri);
        }
        this.tokens.set(uri, tokenSource);
        return tokenSource.token;
    }

    public dispose(): void {
        this.tokens.forEach((tokenSource) => {
            tokenSource.cancel();
            tokenSource.dispose();
        });
        this.tokens.clear();
    }
}
