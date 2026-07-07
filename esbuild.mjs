import { context } from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

async function main() {
    if (!test) {
        const ctx = await context({
            entryPoints: ['client/src/extension.ts', 'server/src/server.ts'],
            bundle: true,
            // Native ESM bundles. The `.mjs` suffix makes Node (and the VS Code extension host,
            // 1.100+) load them as ESM without a `type: module` package.json, which would flip
            // the CJS test build under out/test too. The banner restores the CJS globals that
            // bundled CommonJS dependencies (winreg, jszip) and our __filename use rely on,
            // since esbuild does not polyfill them in ESM output.
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
            plugins: [
                /* add to the end of plugins array */
                esbuildProblemMatcherPlugin,
            ],
        });
        if (watch) {
            await ctx.watch();
        } else {
            await ctx.rebuild();
            await ctx.dispose();
        }
    } else {
        console.log('Compiling tests...');
        const testCtx = await context({
            entryPoints: ['client/src/test/**/*.ts'],
            bundle: false,
            format: 'cjs',
            minify: production,
            sourcemap: !production,
            sourcesContent: false,
            platform: 'node',
            outdir: 'out/test',
            logLevel: 'debug',
            plugins: [
                /* add to the end of plugins array */
                esbuildProblemMatcherPlugin,
            ],
        });
        if (watch) {
            await testCtx.watch();
        } else {
            await testCtx.rebuild();
            await testCtx.dispose();
        }
    }
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
