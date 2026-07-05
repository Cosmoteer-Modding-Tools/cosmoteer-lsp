import { context } from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

async function main() {
    if (!test) {
        const ctx = await context({
            entryPoints: ['client/src/extension.ts', 'server/src/server.ts'],
            bundle: true,
            format: 'cjs',
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
