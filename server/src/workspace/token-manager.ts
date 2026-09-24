import { CancellationToken, CancellationTokenSource, URI } from 'vscode-languageserver';

export class WorkspaceTokenManager {
    private readonly tokens: Map<URI, CancellationTokenSource> = new Map();

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
}
