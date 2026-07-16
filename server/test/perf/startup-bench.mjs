// Startup benchmark for the Cosmoteer language server.
//
// scan-bench.mjs times the whole-workspace scan and never restarts the process, so it cannot see
// what a real cold start costs: the game `Data` walk, the project index chain, and the mention
// index, before any scan runs. This bench spawns a fresh server per pass, the only way to measure
// a cache-served restart, and times the phases a user actually waits through:
//
//   spawn      → the `initialize` reply          (node boot + bundle compile + module-graph init)
//   initialize → `Startup: project indexes ready` (game tree walk + alias root + project indexes)
//
// The server reports its own split (project indexes vs mention index) in that log line. Both are
// parsed out. Whole-workspace validation stays off (the default), so the numbers isolate startup
// rather than folding in the scan.
//
// Cold vs warm is controlled by LOCALAPPDATA, which is where index-cache.ts puts its artifacts:
// COLD points it at a fresh empty dir, WARM reuses the dir the cold pass just populated.
//
// Usage (from repo root, after `node esbuild.mjs`):
//   STARTUP_MOD_DIR="C:\path\to\mod" node server/test/perf/startup-bench.mjs
// Optional: COSMOTEER_GAME="…/Cosmoteer", STARTUP_CPU_PROF=dir, STARTUP_PASSES=3.

import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

const SERVER = 'out/server/src/server.mjs';
if (!existsSync(SERVER)) {
    console.error(`Server bundle not found at ${SERVER}. Build it first: node esbuild.mjs`);
    process.exit(2);
}
const GAME = process.env.COSMOTEER_GAME || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cosmoteer';
const MOD_DIR = process.env.STARTUP_MOD_DIR || '';
if (!existsSync(MOD_DIR)) {
    console.error(`Mod folder not found: ${MOD_DIR} (set STARTUP_MOD_DIR)`);
    process.exit(2);
}

const toVsCodeUri = (fsPath) => {
    const resolved = path.resolve(fsPath).replace(/\\/g, '/');
    return 'file:///' + resolved.replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}%3A`);
};
const MOD_URI = toVsCodeUri(MOD_DIR);

const settings = {
    maxNumberOfProblems: 1000,
    cosmoteerPath: GAME,
    trace: { server: 'off' },
    ignorePaths: [],
    diagnostics: {
        validateWholeWorkspace: false,
        workspaceValidationScope: 'allFiles',
        validateComponentReferences: true,
        validateCrossFileReferences: true,
        validateRequiredFields: true,
        validateShaderConstants: true,
        validateShaderCode: true,
        validateLocalizationKeys: true,
        validateRedundantSeparators: true,
        validateIgnoredFields: true,
        validateDefaultValues: true,
    },
    rename: { allowEditingVanillaFiles: false },
    formatting: { enabled: true, formatOnSave: false },
};

/**
 * Run one pass, which is one whole server lifetime, from spawn to the startup log line.
 *
 * @param label the name this pass is reported under, such as `COLD` or `WARM#1`.
 * @param cacheDir the directory used as LOCALAPPDATA, which decides whether the pass is cache-served.
 * @returns the phase timings in ms, plus the `startup.*` counters the server reports.
 */
const runPass = (label, cacheDir) =>
    new Promise((resolve, reject) => {
        const env = { ...process.env, LOCALAPPDATA: cacheDir };
        if (process.env.STARTUP_CPU_PROF) env.COSMOTEER_CPU_PROF = process.env.STARTUP_CPU_PROF;
        const t0 = Date.now();
        const server = spawn('node', [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'], env });

        let buf = Buffer.alloc(0);
        const waiters = new Map();
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

        const timings = { label };
        const timer = setTimeout(() => {
            server.kill();
            reject(new Error(`${label}: timed out waiting for the startup log line`));
        }, 300_000);

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

                if (msg.method === 'workspace/configuration') reply(msg.id, msg.params.items.map(() => settings));
                else if (msg.method === 'workspace/workspaceFolders')
                    reply(msg.id, [{ uri: MOD_URI, name: path.basename(MOD_DIR) }]);
                else if (msg.method === 'client/registerCapability' || msg.method === 'window/workDoneProgress/create')
                    reply(msg.id, null);
                else if (msg.method === 'window/logMessage') {
                    // `Startup: project indexes ready in Xms, mention index in Yms` (server.ts).
                    const m = /project indexes ready in (\d+)ms, mention index in (\d+)ms/.exec(msg.params.message ?? '');
                    if (m) {
                        timings.readyMs = Date.now() - t0;
                        timings.projectMs = Number(m[1]);
                        timings.mentionMs = Number(m[2]);
                        clearTimeout(timer);
                        // The startup.* counters attribute the phases inside that total.
                        request('cosmoteer/perfStats', null).then((res) => {
                            timings.counters = res.result?.counters ?? {};
                            server.kill();
                            resolve(timings);
                        });
                    }
                } else if (msg.id !== undefined && waiters.has(msg.id)) {
                    waiters.get(msg.id)(msg);
                    waiters.delete(msg.id);
                }
            }
        });

        (async () => {
            await request('initialize', {
                processId: process.pid,
                rootUri: MOD_URI,
                workspaceFolders: [{ uri: MOD_URI, name: path.basename(MOD_DIR) }],
                capabilities: {
                    textDocument: {
                        publishDiagnostics: { tagSupport: { valueSet: [1, 2] }, relatedInformation: true },
                        completion: { completionItem: { snippetSupport: true } },
                    },
                    workspace: {
                        configuration: true,
                        workspaceFolders: true,
                        didChangeConfiguration: { dynamicRegistration: true },
                        didChangeWatchedFiles: { dynamicRegistration: true },
                    },
                    window: { workDoneProgress: true },
                },
            });
            timings.initializeMs = Date.now() - t0;
            send('initialized', {});
        })().catch(reject);
    });

const pad = (n) => String(n).padStart(6);
const main = async () => {
    const passes = Number(process.env.STARTUP_PASSES || 3);
    const coldDir = mkdtempSync(path.join(tmpdir(), 'cosmoteer-startup-cold-'));
    const warmDir = mkdtempSync(path.join(tmpdir(), 'cosmoteer-startup-warm-'));
    console.log(`game : ${GAME}`);
    console.log(`mod  : ${MOD_DIR}`);
    console.log(`cache: cold=${coldDir}  warm=${warmDir}\n`);

    const results = [];
    // COLD: a cache dir no server has ever written to.
    results.push(await runPass('COLD', coldDir));
    // WARM: first pass populates warmDir, the rest are served from it.
    for (let i = 0; i < passes; i++) results.push(await runPass(i === 0 ? 'WARM(seed)' : `WARM#${i}`, warmDir));

    console.log('pass          spawn→init   init→ready    ready(total)   projectIdx   mentionIdx');
    for (const r of results) {
        console.log(
            `${r.label.padEnd(12)}${pad(r.initializeMs)}ms  ${pad(r.readyMs - r.initializeMs)}ms  ${pad(r.readyMs)}ms  ${pad(r.projectMs)}ms  ${pad(r.mentionMs - r.projectMs)}ms`
        );
    }
    const PHASES = [
        'startup.gameTreeMs',
        'startup.aliasRootMs',
        'startup.buildTogetherMs',
        'startup.reverseIncludeMs',
        'startup.modActionWalkMs',
        'startup.addBaseMs',
        'startup.memberInjectionMs',
        'startup.actionRootingMs',
    ];
    console.log('\nphase attribution (ms)');
    console.log(`${''.padEnd(28)}${results.map((r) => r.label.padStart(12)).join('')}`);
    for (const phase of PHASES) {
        const row = results.map((r) => pad(r.counters?.[phase] ?? 0) + '      ').join('');
        console.log(`${phase.padEnd(28)}${row}`);
    }

    const warms = results.filter((r) => r.label.startsWith('WARM#'));
    if (warms.length) {
        const best = Math.min(...warms.map((r) => r.readyMs));
        console.log(`\nCOLD ${results[0].readyMs}ms → WARM best ${best}ms`);
    }
    rmSync(coldDir, { recursive: true, force: true });
    rmSync(warmDir, { recursive: true, force: true });
};
main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
