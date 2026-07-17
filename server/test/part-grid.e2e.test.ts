import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// End-to-end exercise of the part grid editor protocol over the built server's stdio, the way the
// IDE clients drive it: open the part, pull the grid payload, send a mutation with the payload's
// dataVersion, apply the returned edit through didChange, and confirm the next payload reflects it.
// Also guards the stale contract: a mutation carrying an outdated version must be refused without
// an edit. Requires the bundle, build it first with `node esbuild.mjs`.
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER_BUNDLE = join(REPO_ROOT, 'out', 'server', 'src', 'server.mjs');
const FIXTURE_DIR = join(__dirname, 'fixtures', 'part-editor');
const GAME_DIR = join(__dirname, 'fixtures', 'workspace');
const PART_FILE = join(FIXTURE_DIR, 'base_part.rules');

const toClientUri = (fsPath: string): string => {
    const forward = resolve(fsPath).replace(/\\/g, '/');
    return 'file:///' + forward.replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}%3A`);
};

const FIXTURE_URI = toClientUri(FIXTURE_DIR);
const PART_URI = toClientUri(PART_FILE);

const settings = {
    maxNumberOfProblems: 1000,
    cosmoteerPath: GAME_DIR,
    trace: { server: 'off' },
    ignorePaths: [],
    diagnostics: { validateWholeWorkspace: false },
    rename: { allowEditingVanillaFiles: false },
    formatting: { enabled: true, formatOnSave: false },
};

/** A minimal LSP client over the spawned server's stdio. */
class TestClient {
    private readonly server: ChildProcess;
    private buffer = Buffer.alloc(0);
    private nextId = 1;
    private readonly waiters = new Map<number, (msg: { result?: unknown }) => void>();

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

    private onServerRequest(message: { id: number; method: string; params?: { items?: unknown[] } }): void {
        const reply = (result: unknown) => this.frame({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'workspace/configuration') {
            reply((message.params?.items ?? [{}]).map(() => settings));
        } else if (message.method === 'workspace/workspaceFolders') {
            reply([{ uri: FIXTURE_URI, name: 'part-editor' }]);
        } else {
            reply(null);
        }
    }

    async shutdown(): Promise<void> {
        await this.request('shutdown', {}).catch(() => undefined);
        this.send('exit', {});
        setTimeout(() => this.server.kill(), 200);
    }
}

interface GridPayload {
    dataVersion: number;
    anchor: { line: number; character: number };
    size: { width: number; height: number };
    layers: Array<{ id: string; kind: string; cells?: Array<{ cell: { x: number; y: number } }> }>;
}

interface EditResult {
    status: string;
    edit?: { changes: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>> };
}

describe.skipIf(!existsSync(SERVER_BUNDLE))('part grid editor over the built server', () => {
    let client: TestClient;
    let text: string;
    let version = 1;

    beforeAll(async () => {
        client = new TestClient();
        await client.request('initialize', {
            processId: process.pid,
            rootUri: FIXTURE_URI,
            workspaceFolders: [{ uri: FIXTURE_URI, name: 'part-editor' }],
            capabilities: {
                workspace: { workspaceFolders: true, configuration: true },
                textDocument: { publishDiagnostics: { relatedInformation: true } },
                window: { workDoneProgress: true },
            },
        });
        client.send('initialized', {});
        text = readFileSync(PART_FILE, 'utf8');
        client.send('textDocument/didOpen', {
            textDocument: { uri: PART_URI, languageId: 'rules', version, text },
        });
    }, 120_000);

    afterAll(async () => {
        await client.shutdown();
    });

    const gridData = async (): Promise<GridPayload> => {
        const response = await client.request('cosmoteer/partGridData', {
            textDocument: { uri: PART_URI },
            position: { line: 0, character: 0 },
        });
        return response.result as GridPayload;
    };

    it('returns the payload with the document version', async () => {
        const data = await gridData();
        expect(data).toBeTruthy();
        expect(data.dataVersion).toBe(1);
        expect(data.size).toMatchObject({ width: 1, height: 2 });
    });

    it('produces an edit for a fresh mutation, which round-trips through didChange', async () => {
        const data = await gridData();
        const response = await client.request('cosmoteer/partGridEdit', {
            textDocument: { uri: PART_URI },
            anchor: data.anchor,
            dataVersion: data.dataVersion,
            mutation: { op: 'addCell', layerId: 'AllowedDoorLocations', cell: { x: -1, y: 0 } },
        });
        const result = response.result as EditResult;
        expect(result.status).toBe('ok');
        const edits = result.edit!.changes[PART_URI];
        expect(edits).toHaveLength(1);

        // Apply the edit the way the client would and notify the server.
        const lines = text.split('\n');
        const offsetOf = (position: { line: number; character: number }) =>
            lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
        const edit = edits[0];
        text = text.slice(0, offsetOf(edit.range.start)) + edit.newText + text.slice(offsetOf(edit.range.end));
        version++;
        client.send('textDocument/didChange', {
            textDocument: { uri: PART_URI, version },
            contentChanges: [{ text }],
        });

        const after = await gridData();
        expect(after.dataVersion).toBe(version);
        const doors = after.layers.find((layer) => layer.id === 'AllowedDoorLocations')!;
        expect(doors.cells!.map(({ cell }) => [cell.x, cell.y])).toContainEqual([-1, 0]);
    });

    it('refuses a mutation carrying a stale dataVersion without producing an edit', async () => {
        const data = await gridData();
        const response = await client.request('cosmoteer/partGridEdit', {
            textDocument: { uri: PART_URI },
            anchor: data.anchor,
            dataVersion: data.dataVersion - 1,
            mutation: { op: 'addCell', layerId: 'AllowedDoorLocations', cell: { x: 9, y: 9 } },
        });
        const result = response.result as EditResult;
        expect(result.status).toBe('stale');
        expect(result.edit).toBeUndefined();
    });
});
