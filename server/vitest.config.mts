import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            // The client's own tests run inside a VS Code window, which a module that only decides
            // what to do with an answer does not need. Mapping the editor's module to a stub lets
            // those modules be imported here, so client logic can be pinned without a host.
            vscode: fileURLToPath(new URL('./test/client/vscode-stub.ts', import.meta.url)),
            // The language client package is CommonJS and requires the editor's module as it loads,
            // which the alias above cannot reach, so the package itself is mapped as well.
            'vscode-languageclient/node': fileURLToPath(
                new URL('./test/client/languageclient-stub.ts', import.meta.url)
            ),
        },
    },
    test: {
        // Tests mirror the server/src layout (core/, semantics/, document/schema/, features/*, mod/,
        // utils/). Snapshots resolve into a __snapshots__ folder next to each test file.
        include: ['test/**/*.test.ts'],
        environment: 'node',
        globals: false,
    },
});
