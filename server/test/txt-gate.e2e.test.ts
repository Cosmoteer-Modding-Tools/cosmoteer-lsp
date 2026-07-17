import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// End-to-end coverage of the `.txt` reference gate, driving the built server over stdio like VS Code
// does. The reference scan behind the gate is unit tested, but only this exercises the gate inside
// `validateWorkspaceFile`, the code path that decides what actually reaches the Problems panel.
// Runs in 'allFiles' scope, the default and the one the reported bug appeared under, so the
// reachability filter cannot mask what the gate does. Requires the bundle, build it first with
// `node esbuild.mjs`.
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER_BUNDLE = join(REPO_ROOT, 'out', 'server', 'src', 'server.mjs');
const MOD_DIR = join(__dirname, 'fixtures', 'txt-gate-mod');
const GAME_DIR = join(__dirname, 'fixtures', 'workspace');

const toClientUri = (fsPath: string): string => {
    const forward = resolve(fsPath).replace(/\\/g, '/');
    return 'file:///' + forward.replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}%3A`);
};

const MOD_URI = toClientUri(MOD_DIR);
const CREDITS_FILE = join(MOD_DIR, 'credits.txt');
const CREDITS_URI = toClientUri(CREDITS_FILE);

const settings = {
    maxNumberOfProblems: 1000,
    cosmoteerPath: GAME_DIR,
    trace: { server: 'off' },
    ignorePaths: [],
    diagnostics: {
        validateWholeWorkspace: true,
        workspaceValidationScope: 'allFiles',
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

/** A minimal LSP client over the spawned server's stdio, pull-capable or push-only. */
class TestClient {
    readonly pushed = new Map<string, PublishParams['diagnostics']>();
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
                this.reply(message.id, [{ uri: MOD_URI, name: 'txt-gate-mod' }]);
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
        const needle = part.toLowerCase().replace(/\\/g, '/');
        for (const [uri, diagnostics] of this.pushed) {
            if (decodeURIComponent(uri).toLowerCase().replace(/\\/g, '/').includes(needle)) return diagnostics;
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

/**
 * Drives the initialize handshake and waits for the first workspace scan to finish.
 *
 * @param client the client to initialize.
 * @param pullCapable whether the client announces `textDocument/diagnostic`. A push-only client is
 *     what the server pushes open-document diagnostics to, which is the path the panel sticks on.
 * @returns once the first scan has ended.
 */
const initialize = async (client: TestClient, pullCapable: boolean): Promise<void> => {
    await client.request('initialize', {
        processId: process.pid,
        rootUri: MOD_URI,
        workspaceFolders: [{ uri: MOD_URI, name: 'txt-gate-mod' }],
        capabilities: {
            workspace: {
                workspaceFolders: true,
                configuration: true,
                didChangeWatchedFiles: { dynamicRegistration: true },
            },
            textDocument: {
                publishDiagnostics: { relatedInformation: true },
                ...(pullCapable ? { diagnostic: { dynamicRegistration: true } } : {}),
            },
            window: { workDoneProgress: true },
        },
    });
    const scanDone = client.nextScanEnd();
    client.send('initialized', {});
    await scanDone;
    await settle(500);
};

describe.skipIf(!existsSync(SERVER_BUNDLE))('txt reference gate over the built server', () => {
    let client: TestClient;

    beforeAll(async () => {
        client = new TestClient();
        await initialize(client, true);
    }, 120_000);

    afterAll(async () => {
        await client.shutdown();
    });

    it('validates the files around the gated one, so a silent no-op cannot pass as a pass', () => {
        // Without this the `.txt` assertion below is worthless: a scan that walked nothing at all
        // would publish nothing and read exactly like a working gate.
        const orphan = client.pushedFor('orphan.rules');
        expect(orphan, 'the scan must reach the fixture root, where credits.txt also lives').toBeDefined();
        expect(orphan!.length, 'an unreferenced .rules is never gated, it keeps the benefit of the doubt').toBeGreaterThan(0);

        const referenced = client.pushedFor('wired/referenced.txt');
        expect(referenced, 'a .txt a rules file names must still be validated').toBeDefined();
        expect(referenced!.length, 'the gate must not over-suppress a referenced .txt').toBeGreaterThan(0);
    });

    it('publishes nothing for a .txt nothing references', () => {
        // credits.txt is markup, not rules. Parsed as rules it yields parser errors, which is the
        // noise this gate exists to keep out of the panel.
        expect(client.pushedFor('credits.txt') ?? []).toEqual([]);
    });

    it('still validates a .txt the user explicitly opens as rules', async () => {
        // A .txt is not registered as language `rules`, so this only happens when the user sets the
        // language mode by hand. That is a deliberate "this is rules", so the gate must not swallow
        // it: gating the shared validate path would leave the user with no feedback and no reason why.
        client.send('textDocument/didOpen', {
            textDocument: { uri: CREDITS_URI, languageId: 'rules', version: 1, text: readFileSync(CREDITS_FILE, 'utf8') },
        });
        const pull = await client.request('textDocument/diagnostic', { textDocument: { uri: CREDITS_URI } });
        const items = (pull.result as { items?: unknown[] } | undefined)?.items ?? [];
        expect(items.length, 'an explicitly opened .txt validates, the user said it is rules').toBeGreaterThan(0);
        client.send('textDocument/didClose', { textDocument: { uri: CREDITS_URI } });
        await settle(1500);
    }, 30_000);

    it('keeps a .txt out of the panel when the watcher reports it changed', async () => {
        client.pushed.clear();
        client.send('workspace/didChangeWatchedFiles', { changes: [{ uri: CREDITS_URI, type: 2 }] });
        await settle(2500);
        expect(client.pushedFor('credits.txt') ?? []).toEqual([]);

        // The same watcher burst must still refresh a referenced .txt, so the gate is not just
        // silencing the whole watcher path.
        client.send('workspace/didChangeWatchedFiles', {
            changes: [{ uri: toClientUri(join(MOD_DIR, 'wired', 'referenced.txt')), type: 2 }],
        });
        await settle(2500);
        const referenced = client.pushedFor('wired/referenced.txt');
        expect(referenced).toBeDefined();
        expect(referenced!.length).toBeGreaterThan(0);
    }, 30_000);
});

describe.skipIf(!existsSync(SERVER_BUNDLE))('txt reference gate for a push-only client', () => {
    let client: TestClient;

    beforeAll(async () => {
        client = new TestClient();
        await initialize(client, false);
    }, 120_000);

    afterAll(async () => {
        await client.shutdown();
    });

    it('clears an explicitly opened .txt from the panel when its tab closes', async () => {
        // A push-only client (no `textDocument/diagnostic`) is the one the server pushes open-document
        // diagnostics to itself, so it is the only client that can see the panel entry outlive the tab.
        // A pull client never receives a push for the file, so the same close there proves nothing.
        client.send('textDocument/didOpen', {
            textDocument: { uri: CREDITS_URI, languageId: 'rules', version: 1, text: readFileSync(CREDITS_FILE, 'utf8') },
        });
        await settle(2500);
        const whileOpen = client.pushed.get(CREDITS_URI) ?? [];
        expect(whileOpen.length, 'an explicitly opened .txt is pushed to a push-only client').toBeGreaterThan(0);

        // Closing it must retract those problems. The gate holds that the game never loads this file,
        // so its problems leave with the tab rather than persisting the way a scanned file's do.
        client.send('textDocument/didClose', { textDocument: { uri: CREDITS_URI } });
        await settle(2500);
        expect(client.pushed.get(CREDITS_URI) ?? [], 'the closed .txt must not keep its problems').toEqual([]);
    }, 40_000);
});
