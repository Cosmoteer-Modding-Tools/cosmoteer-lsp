import { context } from 'esbuild';
import { readFileSync } from 'node:fs';
import { computeCacheBuildId } from './esbuild.cache-id.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
// Builds the webview pages alone, which is what the tests that load a page ask for when the bundle
// they drive is older than its sources. The extension and the server bundle take seconds; the four
// pages take a fraction of one.
const mediaOnly = process.argv.includes('--media');

/**
 * Runs one esbuild configuration: watching it under `--watch`, building it once otherwise.
 *
 * @param {import('esbuild').BuildOptions} options the configuration to build.
 */
async function run(options) {
    const ctx = await context(options);
    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

/**
 * The webview pages: one bundled browser script per page, written to the name its panel and the
 * JetBrains host load. Each page is a folder of ES modules under media/src, and the bundle is a
 * single IIFE because the JetBrains plugin inlines exactly one file into the page it shows, so a
 * tree of separately served modules would leave Rider with a blank panel.
 */
function buildMedia() {
    return run({
        entryPoints: {
            'part-grid-editor': 'media/src/part-grid/main.js',
            'part-table': 'media/src/part-table/main.js',
            'shader-preview': 'media/src/shader-preview/main.js',
            'diagram-view': 'media/src/diagram/main.js',
        },
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['es2022'],
        // A page that exports helpers (the grid editor's geometry, the diagram's layout, the
        // table's header shortening) hands them to the Node unit tests through this name: the IIFE
        // evaluates to the entry's exports, and the footer passes them on where a CommonJS `module`
        // exists, which is true under `require` and false in a webview. Naming `module` in the page
        // itself is not an option, since esbuild reads that as the file being CommonJS and gives it
        // a `module` of its own.
        globalName: 'cosmoteerWebviewPage',
        footer: { js: "if (typeof module !== 'undefined') module.exports = cosmoteerWebviewPage;" },
        minify: production,
        // No source map: the JetBrains host inlines the script into its page, where a map file it
        // cannot serve would only be a dead reference.
        sourcemap: false,
        outdir: 'media/dist',
        logLevel: 'silent',
        plugins: [esbuildProblemMatcherPlugin],
    });
}

async function main() {
    if (mediaOnly) {
        await buildMedia();
        return;
    }
    // Scoped cache invalidation id, baked into the bundle via `define`: the on-disk caches gate
    // on it, and it only changes when cache-relevant source (or a dependency) changes (see
    // esbuild.cache-id.mjs and server/src/workspace/index-cache.ts). Computed once, so it is
    // injected only for one-shot builds (production packaging and the perf benches). Under
    // `--watch` the id is left undefined and the server falls back to hashing its own bundle,
    // which changes on every incremental rebuild, so a dev never serves a stale cache.
    // The lint command prints its version, and the package manifests sit outside the compiled
    // source root, so the number is injected here rather than imported. A watch build leaves it
    // undefined and the command reports 'unknown', which is right for a build with no version.
    const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
    const define = watch
        ? {}
        : {
              __CACHE_BUILD_ID__: JSON.stringify(computeCacheBuildId()),
              __CLI_VERSION__: JSON.stringify(version),
          };
    await run({
        // The lint command is a third entry point rather than a project of its own: it lives in
        // server/src, so `check-types`, `lint` and the l10n export already cover it, and the
        // bundle it produces sits beside the server bundle it drives.
        entryPoints: ['client/src/extension.ts', 'server/src/server.ts', 'server/src/cli/lint.ts'],
        bundle: true,
        define,
        // Native ESM bundles. The `.mjs` suffix makes Node (and the VS Code extension host,
        // 1.100+) load them as ESM without a `type: module` package.json. The banner restores the
        // CJS globals that bundled CommonJS dependencies (winreg, jszip) and our __filename use
        // rely on, since esbuild does not polyfill them in ESM output.
        format: 'esm',
        outExtension: { '.js': '.mjs' },
        banner: {
            js: [
                "import { createRequire as __cjsCreateRequire } from 'node:module';",
                "import { fileURLToPath as __cjsFileURLToPath } from 'node:url';",
                "import { dirname as __cjsDirname } from 'node:path';",
                'const require = __cjsCreateRequire(import.meta.url);',
                'const __filename = __cjsFileURLToPath(import.meta.url);',
                'const __dirname = __cjsDirname(__filename);',
            ].join('\n'),
        },
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outdir: 'out',
        external: ['vscode'],
        logLevel: 'silent',
        plugins: [esbuildProblemMatcherPlugin],
    });
    await buildMedia();
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    },
};

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
