import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import type { WireDiagnostic } from './findings';

// A language client is the only honest way to run the same checks the editor runs. The passes are
// wired into the server's whole-workspace scan, which owns the scope closure, the shared indexes,
// the fs trust window and the on-disk caches. Re-implementing that here would give the CLI and the
// editor two answers to the same question, which is exactly the failure this tool exists to catch.

/** The title the server's whole-workspace pass reports progress under. */
export const SCAN_PROGRESS_TITLE = 'Validating workspace';

/** A workspace folder as the protocol names it. */
export interface WorkspaceFolder {
    uri: string;
    name: string;
}

/** Everything the session needs to stand a server up and answer its questions. */
export interface SessionOptions {
    /** Path of the built server bundle to run. */
    serverPath: string;
    /** The folders to validate. */
    folders: readonly WorkspaceFolder[];
    /** The configuration to answer `workspace/configuration` with. */
    settings: unknown;
    /** The environment the server runs in, which is how the cache location is redirected. */
    env: NodeJS.ProcessEnv;
    /** Called for every published diagnostic set, including the empty ones clean files get. */
    onDiagnostics: (uri: string, diagnostics: WireDiagnostic[]) => void;
    /** Called when the whole-workspace pass starts and when it finishes. */
    onScanBoundary?: (kind: 'begin' | 'end') => void;
}

/** A JSON-RPC message as it arrives, before it is sorted into a request, a reply or a notification. */
interface WireMessage {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
}

/** The reply to a request: either a result or the error the server answered with. */
export interface RequestReply {
    result?: unknown;
    error?: { code: number; message: string };
}

/** A session with one spawned language server, driven over its stdio like an editor drives it. */
export class LanguageServerSession {
    private readonly options: SessionOptions;
    private server: ChildProcessWithoutNullStreams | undefined;
    private buffer = Buffer.alloc(0);
    private nextId = 1;
    private readonly waiters = new Map<number, (reply: RequestReply) => void>();
    private readonly progressTitles = new Map<string | number, string>();
    private stderrText = '';
    private exitReason: string | undefined;

    /**
     * @param options everything the session needs to stand the server up.
     */
    constructor(options: SessionOptions) {
        this.options = options;
    }

    /** Whatever the server wrote to its error stream, which is the only clue a crash leaves. */
    get errorOutput(): string {
        return this.stderrText;
    }

    /** Why the server is gone, or undefined while it is still running. */
    get gone(): string | undefined {
        return this.exitReason;
    }

    /**
     * Spawn the server and run the initialize handshake, leaving it ready for `initialized`.
     *
     * @returns once the server has answered the initialize request.
     */
    async start(): Promise<void> {
        const server = spawn(process.execPath, [this.options.serverPath, '--stdio'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: this.options.env,
        });
        this.server = server;
        server.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
        // The server's own logging would otherwise land in the middle of a report written to
        // stdout, so it is held here and only shown when something went wrong.
        server.stderr.on('data', (chunk: Buffer) => {
            this.stderrText += chunk.toString();
        });
        server.on('exit', (code, signal) => this.onExit(code, signal));
        server.on('error', (error: Error) => this.onExit(null, null, error.message));

        await this.request('initialize', {
            processId: process.pid,
            rootUri: this.options.folders[0]?.uri,
            workspaceFolders: this.options.folders,
            capabilities: {
                workspace: {
                    workspaceFolders: true,
                    configuration: true,
                    didChangeWatchedFiles: { dynamicRegistration: true },
                },
                textDocument: {
                    publishDiagnostics: { relatedInformation: true },
                    diagnostic: { dynamicRegistration: true },
                },
                // Without this the server is handed a progress reporter that sends nothing, and the
                // end of the scan becomes unobservable, so the run would hang until its timeout.
                window: { workDoneProgress: true },
            },
        });
    }

    /**
     * Tell the server the client is ready, which is what starts the first whole-workspace pass.
     */
    announceInitialized(): void {
        this.notify('initialized', {});
    }

    /**
     * Send a request and wait for its reply.
     *
     * @param method the request method.
     * @param params the request parameters.
     * @returns the server's reply, or an error reply when the server is gone.
     */
    request(method: string, params: unknown): Promise<RequestReply> {
        if (this.exitReason) return Promise.resolve({ error: { code: -32099, message: this.exitReason } });
        const id = this.nextId++;
        this.frame({ jsonrpc: '2.0', id, method, params });
        return new Promise<RequestReply>((resolve) => this.waiters.set(id, resolve));
    }

    /**
     * Send a notification, which has no reply.
     *
     * @param method the notification method.
     * @param params the notification parameters.
     */
    notify(method: string, params: unknown): void {
        if (this.exitReason) return;
        this.frame({ jsonrpc: '2.0', method, params });
    }

    /**
     * Shut the server down the way an editor does, then make sure the process is really gone.
     *
     * @returns once the process has been asked to exit.
     */
    async stop(): Promise<void> {
        const server = this.server;
        if (!server || this.exitReason) return;
        await this.request('shutdown', {});
        this.notify('exit', {});
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                server.kill();
                resolve();
            }, 2000);
            server.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    /**
     * Write one message in the protocol's `Content-Length` framing.
     *
     * @param payload the message to send.
     */
    private frame(payload: object): void {
        const json = JSON.stringify(payload);
        this.server?.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
    }

    /**
     * Read as many complete messages out of the incoming bytes as they hold.
     *
     * @param chunk the bytes that just arrived.
     */
    private onData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            const header = this.buffer.subarray(0, headerEnd).toString();
            const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1] ?? NaN);
            if (!Number.isFinite(length)) {
                // A header without a length means the stream is no longer framed messages, so
                // nothing further can be read from it.
                this.onExit(null, null, 'the server sent a message without a Content-Length header');
                return;
            }
            const start = headerEnd + 4;
            if (this.buffer.length < start + length) return;
            const body = this.buffer.subarray(start, start + length).toString();
            this.buffer = this.buffer.subarray(start + length);
            let message: WireMessage;
            try {
                message = JSON.parse(body) as WireMessage;
            } catch {
                this.onExit(null, null, 'the server sent a message that is not valid JSON');
                return;
            }
            this.dispatch(message);
        }
    }

    /**
     * Route one message to the request handler, the reply waiters or the notification handler.
     *
     * @param message the parsed message.
     */
    private dispatch(message: WireMessage): void {
        if (message.method !== undefined && message.id !== undefined) {
            this.onServerRequest(message.id, message.method);
            return;
        }
        if (message.method !== undefined) {
            this.onNotification(message.method, message.params);
            return;
        }
        if (message.id === undefined) return;
        const waiter = this.waiters.get(message.id);
        if (!waiter) return;
        this.waiters.delete(message.id);
        waiter({ result: message.result, error: message.error });
    }

    /**
     * Answer the requests the server makes of its client.
     *
     * Everything the run does not care about is answered with null rather than left open, because
     * the server awaits several of these and would stall on a request that never comes back.
     *
     * @param id the request id to reply to.
     * @param method the request method.
     */
    private onServerRequest(id: number, method: string): void {
        if (method === 'workspace/configuration') {
            // One answer per requested section, all of them the same configuration: the run applies
            // to every folder, so there is nothing folder-specific to vary.
            this.frame({ jsonrpc: '2.0', id, result: [this.options.settings] });
            return;
        }
        if (method === 'workspace/workspaceFolders') {
            this.frame({ jsonrpc: '2.0', id, result: this.options.folders });
            return;
        }
        this.frame({ jsonrpc: '2.0', id, result: null });
    }

    /**
     * Collect the published diagnostics and follow the whole-workspace pass's progress.
     *
     * @param method the notification method.
     * @param params the notification parameters.
     */
    private onNotification(method: string, params: unknown): void {
        if (method === 'textDocument/publishDiagnostics') {
            const published = params as { uri: string; diagnostics: WireDiagnostic[] };
            this.options.onDiagnostics(published.uri, published.diagnostics ?? []);
            return;
        }
        if (method !== '$/progress') return;
        const progress = params as { token: string | number; value: { kind: string; title?: string } };
        if (progress.value?.kind === 'begin') {
            this.progressTitles.set(progress.token, progress.value.title ?? '');
            if (progress.value.title === SCAN_PROGRESS_TITLE) this.options.onScanBoundary?.('begin');
            return;
        }
        if (progress.value?.kind !== 'end') return;
        const title = this.progressTitles.get(progress.token);
        this.progressTitles.delete(progress.token);
        if (title === SCAN_PROGRESS_TITLE) this.options.onScanBoundary?.('end');
    }

    /**
     * Record that the server is gone and release everything still waiting on it.
     *
     * @param code the exit code, when the process exited on its own.
     * @param signal the signal it was killed with, when it was.
     * @param reason an explicit reason, used when the failure was not an exit.
     */
    private onExit(code: number | null, signal: NodeJS.Signals | null, reason?: string): void {
        if (this.exitReason) return;
        this.exitReason =
            reason ??
            (signal ? `the server was killed by ${signal}` : `the server exited with code ${code ?? 'unknown'}`);
        for (const [id, waiter] of this.waiters) {
            this.waiters.delete(id);
            waiter({ error: { code: -32099, message: this.exitReason } });
        }
    }
}
