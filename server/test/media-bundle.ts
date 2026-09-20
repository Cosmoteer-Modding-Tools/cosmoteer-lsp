import { execFileSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

/**
 * The built webview pages, for the tests that load one.
 *
 * The pages are folders of ES modules under `media/src`, bundled one file per page into
 * `media/dist` by the media build in `esbuild.mjs`. A test drives the bundle rather than the
 * modules, because the bundle is what a webview and the JetBrains host actually load, and because
 * the pure helpers a page exports only reach a test through it.
 *
 * The bundle is a build output rather than a checked-in file, so this builds it on demand: a run
 * that starts with none, or with one older than the sources, builds first. Vitest gives each test
 * file its own worker, so the check has to be cheap when there is nothing to do, which is why it
 * compares timestamps rather than rebuilding every time.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const MEDIA_SOURCE = join(REPO_ROOT, 'media', 'src');
const MEDIA_DIST = join(REPO_ROOT, 'media', 'dist');

/** The pages the build writes, so one stale page rebuilds them all rather than only itself. */
const PAGES = ['part-grid-editor.js', 'part-table.js', 'shader-preview.js', 'diagram-view.js'];

/** Whether this process has already built, so several bundles in one file cost one check. */
let built = false;

/**
 * The newest modification time under a directory, walked recursively.
 *
 * @param directory the directory to walk.
 * @returns the timestamp in milliseconds, 0 for a directory that does not exist.
 */
function newestUnder(directory: string): number {
    if (!existsSync(directory)) return 0;
    let newest = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        newest = Math.max(newest, entry.isDirectory() ? newestUnder(path) : statSync(path).mtimeMs);
    }
    return newest;
}

/** Whether the built pages are missing or older than the modules they are built from. */
function stale(): boolean {
    const sources = Math.max(newestUnder(MEDIA_SOURCE), statSync(join(REPO_ROOT, 'esbuild.mjs')).mtimeMs);
    for (const page of PAGES) {
        const path = join(MEDIA_DIST, page);
        if (!existsSync(path) || statSync(path).mtimeMs < sources) return true;
    }
    return false;
}

/**
 * The path of a built webview page, building the pages first when they are missing or stale.
 *
 * @param page the page's file name, such as `part-grid-editor.js`.
 * @returns the absolute path of the bundle.
 */
export function mediaBundle(page: string): string {
    if (!built) {
        if (stale()) {
            execFileSync(process.execPath, ['esbuild.mjs', '--media'], { cwd: REPO_ROOT, stdio: 'inherit' });
        }
        built = true;
    }
    return join(MEDIA_DIST, page);
}
