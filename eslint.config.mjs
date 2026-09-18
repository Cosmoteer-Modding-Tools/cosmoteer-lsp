import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

/**
 * The globals the webview pages are handed by their host, declared here because ESLint 10 no longer
 * ships environment presets. Keeping the list explicit doubles as the inventory of what a page is
 * allowed to reach for: anything outside it has to arrive through the host bridge.
 */
const webviewGlobals = {
    acquireVsCodeApi: 'readonly',
    clearTimeout: 'readonly',
    console: 'readonly',
    document: 'readonly',
    getComputedStyle: 'readonly',
    requestAnimationFrame: 'readonly',
    setTimeout: 'readonly',
    window: 'readonly',
    Image: 'readonly',
    ResizeObserver: 'readonly',
    HTMLButtonElement: 'readonly',
    HTMLInputElement: 'readonly',
};

/**
 * Layers `server/src/core` is not allowed to reach into. The lexer, the parser and the AST are the
 * one part of the server that a consumer outside the language server (the CLI bundle, a test, a
 * future tool) can use on its own, and they only stay that way while nothing above them is
 * importable from there. This is an error rather than a warning because the layer is clean today,
 * so the rule costs nothing and the next upward import is the one worth stopping.
 */
const layersAboveCore = [
    '**/document/**',
    '**/semantics/**',
    '**/mod/**',
    '**/workspace/**',
    '**/features/**',
    '**/lsp/**',
    '**/registrar/**',
    '**/cli/**',
];

export default tseslint.config(
    {
        ignores: [
            'node_modules/**',
            'client/node_modules/**',
            'client/out/**',
            'server/node_modules/**',
            'server/out/**',
            'out/**',
            'media/dist/**',
            'esbuild.mjs',
            'esbuild.cache-id.mjs',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            semi: ['error', 'always'],
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' },
            ],
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        // The parser layer's purity, locked in at the one place it can be stated declaratively. The
        // remaining layer boundaries are convention, documented in ARCHITECTURE.md.
        files: ['server/src/core/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', { patterns: layersAboveCore }],
        },
    },
    {
        // The webview pages are ES modules bundled per page by esbuild, so they are linted as
        // modules and the bundled output under media/dist is ignored. They were outside the lint run
        // entirely until they joined it, and a duplicate function declaration had been sitting in
        // the part grid editor unnoticed because of that.
        files: ['media/src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: webviewGlobals,
        },
        rules: {
            semi: ['error', 'always'],
            'no-redeclare': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
    eslintConfigPrettier
);
