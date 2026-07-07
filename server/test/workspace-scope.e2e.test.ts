import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// End-to-end regression tests for the 'modRulesReachable' validation scope, driving the built
// server over stdio like VS Code does. Guards two bugs that inflated the Problems panel:
// out-of-scope files (dead backups) leaking their problems into the panel through the tab-close
// and file-watcher validation paths, and stale results pinning because no refresh was requested
// after initialization settles. Requires the bundle, build it first with `node esbuild.mjs`.
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER_BUNDLE = join(REPO_ROOT, 'out', 'server', 'src', 'server.mjs');
const MOD_DIR = join(__dirname, 'fixtures', 'scope-mod');
const GAME_DIR = join(__dirname, 'fixtures', 'workspace');

const toClientUri = (fsPath: string): string => {
    const forward = resolve(fsPath).replace(/\\/g, '/');
    return 'file:///' + forward.replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}%3A`);
};

const MOD_URI = toClientUri(MOD_DIR);
const GOOD_URI_KEY = 'wired/good.rules';
const DEAD_FILE = join(MOD_DIR, '_backup', 'dead.rules');
const DEAD_URI = toClientUri(DEAD_FILE);

const settings = {
    maxNumberOfProblems: 1000,
    cosmoteerPath: GAME_DIR,
    trace: { server: 'off' },
    ignorePaths: [],
    diagnostics: {
        validateWholeWorkspace: true,
        workspaceValidationScope: 'modRulesReachable',
        validateComponentReferences: true,
        validateCrossFileReferences: true,
        validateRequiredFields: true,
        validateShaderConstants: true,
        validateShaderCode: true,
        validateLocalizationKeys: true,
        validateRedundantSeparators: true,
    },
    rename: { allowEditingVanillaFiles: false },
    formatting: { enabled: true, formatOnSave: false },
};

interface PublishParams {
    uri: string;
    diagnostics: { message: string; severity?: number }[];
}

/** A minimal pull-capable LSP client over the spawned server's stdio. */
class TestClient {
    readonly pushed = new Map<string, PublishParams['diagnostics']>();
    refreshCount = 0;
    private readonly server: ChildProcess;
    private buffer = Buffer.alloc(0);
    private nextId = 1;
    private readonly waiters = new Map<number, (msg: { result?: unknown }) => void>();
    private readonly progressTitles = new Map<string | number, string>();
    private scanEndResolvers: (() => void)[] = [];

    constructor() {
        this.server = spawn('node', [SERVER_BUNDLE, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
        this.server.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    }

    private onData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            const header = this.buffer.subarray(0, headerEnd).toString();
            const length = Number(/Content-Length: (\d+)/i.exec(header)![1]);
            const start = headerEnd + 4;
            if (this.buffer.length < start + length) return;
            const message = JSON.parse(this.buffer.subarray(start, start + length).toString());
            this.buffer = this.buffer.subarray(start + length);
            if (message.method && message.id !== undefined) this.onServerRequest(message);
            else if (message.method) this.onServerNotification(message);
            else if (message.id !== undefined) {
                this.waiters.get(message.id)?.(message);
                this.waiters.delete(message.id);
            }
        }
    }

    private frame(payload: object): void {
        const json = JSON.stringify(payload);
        this.server.stdin!.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
    }

    send(method: string, params: unknown): void {
        this.frame({ jsonrpc: '2.0', method, params });
    }

    request(method: string, params: unknown): Promise<{ result?: unknown }> {
        const id = this.nextId++;
        this.frame({ jsonrpc: '2.0', id, method, params });
        return new Promise((resolveWaiter) => this.waiters.set(id, resolveWaiter));
    }

    private reply(id: number, result: unknown): void {
        this.frame({ jsonrpc: '2.0', id, result });
    }

    private onServerRequest(message: { id: number; method: string; params?: { items?: unknown[] } }): void {
        switch (message.method) {
            case 'workspace/configuration':
                this.reply(
                    message.id,
                    (message.params?.items ?? [{}]).map(() => settings)
                );
                break;
            case 'workspace/workspaceFolders':
                this.reply(message.id, [{ uri: MOD_URI, name: 'scope-mod' }]);
                break;
            case 'workspace/diagnostic/refresh':
                this.refreshCount++;
                this.reply(message.id, null);
                break;
            default:
                this.reply(message.id, null);
        }
    }

    private onServerNotification(message: { method: string; params?: unknown }): void {
        if (message.method === 'textDocument/publishDiagnostics') {
            const params = message.params as PublishParams;
            this.pushed.set(params.uri, params.diagnostics);
            return;
        }
        if (message.method === '$/progress') {
            const { token, value } = message.params as { token: string | number; value: { kind: string; title?: string } };
            if (value.kind === 'begin') this.progressTitles.set(token, value.title ?? '');
            if (value.kind === 'end') {
                const title = this.progressTitles.get(token);
                this.progressTitles.delete(token);
                if (title !== 'Validating workspace') return;
                const resolvers = this.scanEndResolvers;
                this.scanEndResolvers = [];
                resolvers.forEach((resolveScan) => resolveScan());
            }
        }
    }

    nextScanEnd(): Promise<void> {
        return new Promise((resolveScan) => this.scanEndResolvers.push(resolveScan));
    }

    /** The pushed diagnostics of the file whose uri contains `part` (case-insensitive), if any. */
    pushedFor(part: string): PublishParams['diagnostics'] | undefined {
        const needle = part.toLowerCase();
        for (const [uri, diagnostics] of this.pushed) {
            if (decodeURIComponent(uri).toLowerCase().includes(needle)) return diagnostics;
        }
        return undefined;
    }

    async shutdown(): Promise<void> {
        await this.request('shutdown', {}).catch(() => undefined);
        this.send('exit', {});
        setTimeout(() => this.server.kill(), 200);
    }
}

const settle = (ms: number): Promise<void> => new Promise((resolveTimer) => setTimeout(resolveTimer, ms));

describe.skipIf(!existsSync(SERVER_BUNDLE))('modRulesReachable scope over the built server', () => {
    let client: TestClient;

    beforeAll(async () => {
        client = new TestClient();
        await client.request('initialize', {
            processId: process.pid,
            rootUri: MOD_URI,
            workspaceFolders: [{ uri: MOD_URI, name: 'scope-mod' }],
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
                window: { workDoneProgress: true },
            },
        });
        const scanDone = client.nextScanEnd();
        client.send('initialized', {});
        await scanDone;
        await settle(500);
    }, 120_000);

    afterAll(async () => {
        await client.shutdown();
    });

    it('publishes problems for reachable files only', () => {
        const good = client.pushedFor(GOOD_URI_KEY);
        expect(good, 'the reachable file must be validated by the scan').toBeDefined();
        expect(good!.length).toBeGreaterThan(0);
        expect(client.pushedFor('_backup/dead.rules') ?? []).toEqual([]);
    });

    it('requests a diagnostics refresh once initialization settles', () => {
        // Guards the startup heal: results computed while the game tree was still loading would
        // otherwise pin in the version-keyed pull cache until the next edit.
        expect(client.refreshCount).toBeGreaterThan(0);
    });

    it('validates an out-of-scope file while open but clears it on close', async () => {
        client.send('textDocument/didOpen', {
            textDocument: { uri: DEAD_URI, languageId: 'rules', version: 1, text: readFileSync(DEAD_FILE, 'utf8') },
        });
        const pull = await client.request('textDocument/diagnostic', { textDocument: { uri: DEAD_URI } });
        const items = (pull.result as { items?: unknown[] } | undefined)?.items ?? [];
        expect(items.length, 'open files always validate, even out of scope').toBeGreaterThan(0);

        client.send('textDocument/didClose', { textDocument: { uri: DEAD_URI } });
        await settle(2000);
        expect(client.pushedFor('_backup/dead.rules') ?? []).toEqual([]);
    }, 30_000);

    it('ignores watcher changes to out-of-scope files but revalidates reachable ones', async () => {
        client.send('workspace/didChangeWatchedFiles', { changes: [{ uri: DEAD_URI, type: 2 }] });
        await settle(2500);
        expect(client.pushedFor('_backup/dead.rules') ?? []).toEqual([]);

        // The gate must not silence in-scope files: a change to the reachable file re-publishes it.
        client.pushed.clear();
        client.send('workspace/didChangeWatchedFiles', {
            changes: [{ uri: toClientUri(join(MOD_DIR, 'wired', 'good.rules')), type: 2 }],
        });
        await settle(2500);
        const good = client.pushedFor(GOOD_URI_KEY);
        expect(good).toBeDefined();
        expect(good!.length).toBeGreaterThan(0);
    }, 30_000);
});
