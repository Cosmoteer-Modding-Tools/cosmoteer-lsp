// Whole-mod scan benchmark for the Cosmoteer language server.
//
// Drives the BUILT server over stdio exactly like VS Code does, turns on whole-workspace
// validation, and times the scan end-to-end: once cold (fresh server, empty caches) and once warm
// (same server, caches populated by the cold pass). After each pass it pulls the server's hot-path
// counters through the custom `cosmoteer/perfStats` request, so a wall-clock regression can be
// attributed: stat syscalls, readdir/parse cache hits, reference resolutions, schema memo epoch
// bumps, and the peak heap the scan reached.
//
// Usage (from repo root, after `node esbuild.mjs`):
//   node server/test/perf/scan-bench.mjs
// Override the install/mod via env:
//   COSMOTEER_GAME="…/Cosmoteer" SCAN_MOD_DIR="C:\path\to\mod" node server/test/perf/scan-bench.mjs
// Optional: SCAN_SCOPE=modRulesReachable (default allFiles), SCAN_MAX_OLD_SPACE_MB=4096.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

const SERVER = 'out/server/src/server.js';
if (!existsSync(SERVER)) {
    console.error(`Server bundle not found at ${SERVER}. Build it first: node esbuild.mjs`);
    process.exit(2);
}

const GAME = process.env.COSMOTEER_GAME || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cosmoteer';
const MOD_DIR = process.env.SCAN_MOD_DIR || 'C:\\Users\\fpabs\\Documents\\Projekte\\Star-Wars-A-Cosmos-Divided';
const SCOPE = process.env.SCAN_SCOPE || 'allFiles';
const MAX_OLD_SPACE_MB = Number(process.env.SCAN_MAX_OLD_SPACE_MB || 0);
if (!existsSync(MOD_DIR)) {
    console.error(`Mod folder not found: ${MOD_DIR} (set SCAN_MOD_DIR)`);
    process.exit(2);
}

// VS Code URI form: lowercase drive letter, %3A for the drive colon, forward slashes.
const toVsCodeUri = (fsPath) => {
    const resolved = path.resolve(fsPath).replace(/\\/g, '/');
    return 'file:///' + resolved.replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}%3A`);
};
const MOD_URI = toVsCodeUri(MOD_DIR);

// Full settings object (the server takes the configuration reply verbatim, no deep merge), with
// the whole-workspace scan on and every default-on validator active, matching a real session.
const settings = {
    maxNumberOfProblems: 1000,
    cosmoteerPath: GAME,
    trace: { server: 'off' },
    ignorePaths: [],
    diagnostics: {
        validateWholeWorkspace: true,
        workspaceValidationScope: SCOPE,
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

// ── LSP plumbing ─────────────────────────────────────────────────────────────────────────────────
const nodeArgs = MAX_OLD_SPACE_MB > 0 ? [`--max-old-space-size=${MAX_OLD_SPACE_MB}`] : [];
const server = spawn('node', [...nodeArgs, SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0);
const waiters = new Map();
let publishCount = 0;
let diagnosticTotal = 0;
const progressByToken = new Map();
let scanEndResolvers = [];

server.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const len = Number(buf.slice(0, headerEnd).toString().match(/Content-Length: (\d+)/i)[1]);
        const start = headerEnd + 4;
        if (buf.length < start + len) return;
        const msg = JSON.parse(buf.slice(start, start + len).toString());
        buf = buf.slice(start + len);
        if (msg.method && msg.id !== undefined) onServerRequest(msg);
        else if (msg.method) onServerNotification(msg);
        else if (msg.id !== undefined && waiters.has(msg.id)) {
            waiters.get(msg.id)(msg);
            waiters.delete(msg.id);
        }
    }
});

let nextId = 1;
const fr = (o) => {
    const j = JSON.stringify(o);
    server.stdin.write(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`);
};
const send = (method, params) => fr({ jsonrpc: '2.0', method, params });
const reply = (id, result) => fr({ jsonrpc: '2.0', id, result });
const request = (method, params) => {
    const id = nextId++;
    fr({ jsonrpc: '2.0', id, method, params });
    return new Promise((r) => waiters.set(id, r));
};

function onServerRequest(msg) {
    switch (msg.method) {
        case 'workspace/configuration':
            reply(msg.id, (msg.params.items ?? [{}]).map(() => settings));
            break;
        case 'workspace/workspaceFolders':
            reply(msg.id, [{ uri: MOD_URI, name: 'mod' }]);
            break;
        default:
            reply(msg.id, null); // registerCapability / workDoneProgress/create / …
    }
}

function onServerNotification(msg) {
    if (msg.method === 'textDocument/publishDiagnostics') {
        publishCount++;
        diagnosticTotal += msg.params.diagnostics.length;
        return;
    }
    if (msg.method === '$/progress') {
        const { token, value } = msg.params;
        if (value.kind === 'begin') progressByToken.set(token, value.title);
        if (value.kind === 'end') {
            const title = progressByToken.get(token);
            progressByToken.delete(token);
            if (title === 'Validating workspace') {
                const resolvers = scanEndResolvers;
                scanEndResolvers = [];
                resolvers.forEach((r) => r());
            }
        }
    }
}

const nextScanEnd = () => new Promise((r) => scanEndResolvers.push(r));

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(0) + ' MB';
const reportPass = (label, elapsedMs, stats) => {
    console.log(`\n=== ${label} ===`);
    console.log(`wall time            ${(elapsedMs / 1000).toFixed(1)} s`);
    console.log(`peak heap (scan)     ${mb(stats.peakHeapBytes)}`);
    console.log(`heap now / rss       ${mb(stats.memory.heapUsed)} / ${mb(stats.memory.rss)}`);
    const c = stats.counters;
    const row = (name) => console.log(`${name.padEnd(20)} ${c[name] ?? 0}`);
    for (const name of [
        'scan.files',
        'scan.parse',
        'navigate',
        'navigate.memoHit',
        'fs.stat',
        'fs.readdir',
        'fs.readdirHit',
        'fs.parse',
        'fs.parseHit',
        'asset.fsProbe',
        'asset.memoHit',
        'schemaEpochBump',
    ])
        row(name);
};

(async () => {
    await request('initialize', {
        processId: process.pid,
        rootUri: MOD_URI,
        workspaceFolders: [{ uri: MOD_URI, name: 'mod' }],
        capabilities: {
            workspace: { workspaceFolders: true, configuration: true },
            textDocument: { publishDiagnostics: { relatedInformation: true } },
            window: { workDoneProgress: true },
        },
    });

    // The initial scan starts inside onInitialized (validateWholeWorkspace is on from the first
    // configuration pull), so arm the end-listener before announcing initialized.
    const coldDone = nextScanEnd();
    const coldStart = Date.now();
    send('initialized', {});
    await coldDone;
    const coldMs = Date.now() - coldStart;
    const coldStats = (await request('cosmoteer/perfStats', { reset: true })).result;
    const coldPublishes = publishCount;
    reportPass(`COLD scan  (${MOD_DIR})`, coldMs, coldStats);
    console.log(`published            ${coldPublishes} files, ${diagnosticTotal} diagnostics`);

    // Warm pass: toggle the feature off (clears published diagnostics) and back on. The server
    // re-pulls configuration on every didChangeConfiguration, so flip the reply it will receive.
    settings.diagnostics.validateWholeWorkspace = false;
    send('workspace/didChangeConfiguration', { settings: null });
    // Wait for the clear to settle: the next config change re-triggers the scan.
    await new Promise((r) => setTimeout(r, 2000));
    publishCount = 0;
    diagnosticTotal = 0;
    settings.diagnostics.validateWholeWorkspace = true;
    const warmDone = nextScanEnd();
    const warmStart = Date.now();
    send('workspace/didChangeConfiguration', { settings: null });
    await warmDone;
    const warmMs = Date.now() - warmStart;
    const warmStats = (await request('cosmoteer/perfStats', { reset: false })).result;
    reportPass('WARM scan  (same server, populated caches)', warmMs, warmStats);
    console.log(`published            ${publishCount} files, ${diagnosticTotal} diagnostics`);

    await request('shutdown', {});
    send('exit', {});
    setTimeout(() => server.kill(), 200);
    console.log(`\ncold ${(coldMs / 1000).toFixed(1)}s | warm ${(warmMs / 1000).toFixed(1)}s`);
    process.exit(0);
})().catch((e) => {
    console.error(e);
    server.kill();
    process.exit(1);
});
