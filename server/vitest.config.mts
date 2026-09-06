import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        // Tests mirror the server/src layout (core/, semantics/, document/schema/, features/*, mod/,
        // utils/). Snapshots resolve into a __snapshots__ folder next to each test file.
        globals: false,
    },
});
