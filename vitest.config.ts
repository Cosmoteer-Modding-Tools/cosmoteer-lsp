// Root Vitest config so `vitest` run from the repo root only picks up the SERVER unit tests. The
// client's `client/src/test/**` (and compiled `client/out/test/**`) are VS Code extension-host e2e
// tests — they `import * as vscode from 'vscode'`, which only exists inside the Extension Development
// Host, so they are run by `scripts/e2e.sh` (npm run test), never by Vitest. Without this, a bare
// `vitest` at the root scans every `*.test.ts`/`.js` and reports those host tests as failures.
//
// A plain object (not `defineConfig`) on purpose: Vitest is a dependency of `server/`, not the root,
// so importing `vitest/config` here fails to resolve when run from the repo root.
export default {
    test: {
        include: ['server/test/**/*.test.ts'],
        exclude: ['**/node_modules/**', 'client/**', '**/out/**'],
        environment: 'node',
        globals: false,
    },
};
