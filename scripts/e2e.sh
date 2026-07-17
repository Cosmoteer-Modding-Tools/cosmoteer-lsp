#!/usr/bin/env bash
set -e

# Extension-host end-to-end tests: downloads VS Code, launches it with this extension loaded, and
# runs client/src/test/*.test.ts against a real editor.
#
# Both builds are required. esbuild produces the extension the host actually loads (package.json
# `main` points at out/client/src/extension.mjs). tsc produces the test runner. `check-types` is
# --noEmit, so a normal dev loop never emits the runner and this script must build it itself.
#
# tsc's `rootDir: src` strips the prefix, so client/src/test lands in out/client/test, not
# out/client/src/test, and not the out/test that an older layout used.

cd "$(dirname "$0")/.."

node esbuild.mjs
npx tsc -b

node ./out/client/test/runTest
