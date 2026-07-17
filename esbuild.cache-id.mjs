// Computes the "cache build id": a hash injected into the server bundle that the on-disk index,
// project, scan, and mention caches gate on (see server/src/workspace/index-cache.ts). It replaces
// the old whole-bundle hash so that a change to code which cannot affect any cache's content, such
// as a hover string, a completion label, the formatter, or semantic tokens, no longer invalidates
// every user's caches on upgrade. The id covers exactly the source that determines cache content:
//
//   * the lexer/parser/AST (feeds every index and every diagnostic),
//   * the schema and the document model,
//   * the validators (the scan cache stores their diagnostics) and shader validation,
//   * every index that is serialized or that feeds diagnostics (navigation, mod, workspace, and the
//     two persisted indexes that live under features/completion),
//   * the shared utils and serialization machinery they import,
//   * and package-lock.json, so a dependency version bump still invalidates.
//
// It is the transitive relative-import closure of those seeds. Presentation-only features
// (completion UI, hover, inlay, color, signature, formatting, semantic tokens, part editor,
// refactor) are reached by none of the seeds, so editing them keeps caches valid.
//
// Safety net: a build fails if any `extends WatchedDocumentIndex` class escapes the closure, which
// is the exact shape of a persisted/diagnostic-feeding index the hash must cover.

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

/** Directories whose every `.ts` file seeds the closure (relative to the repo root). */
const SEED_DIRS = [
    'server/src/core',
    'server/src/document',
    'server/src/semantics',
    'server/src/registrar',
    'server/src/mod',
    'server/src/workspace',
    'server/src/utils',
    'server/src/features/diagnostics',
    'server/src/features/shader',
    'server/src/features/navigation',
];

/** A persisted index sets a string `cacheId`, so such a file seeds the closure wherever it lives
 *  (two are under features/completion, which is otherwise excluded). */
const CACHE_ID_MARKER = /cacheId\s*=\s*['"]/;

/** Every index that is serialized or feeds diagnostics extends this, so all must land in the
 *  closure. */
const INDEX_BASE_MARKER = /extends\s+WatchedDocumentIndex/;

const norm = (p) => resolve(p).replace(/\\/g, '/');

/** Recursively lists every `.ts` file under a directory (absolute, normalized). */
function listTsFiles(dir) {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listTsFiles(full));
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(norm(full));
    }
    return out;
}

/** Resolves a relative import specifier to a file on disk, or null for externals / assets. */
function resolveSpec(fromFile, spec) {
    if (!spec.startsWith('.')) return null; // bare specifier: external dependency
    const base = norm(join(dirname(fromFile), spec));
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.json`, join(base, 'index.ts')];
    if (spec.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts')); // ESM `.js` specifier → `.ts` source
    for (const cand of candidates) {
        const c = norm(cand);
        if (existsSync(c) && statSync(c).isFile()) return c;
    }
    return null;
}

/** Extracts every relative import/require/dynamic-import specifier from a source string. */
function importSpecifiers(source) {
    const specs = [];
    const re = /\b(?:from|import|require)\b\s*\(?\s*['"]([^'"\n]+)['"]/g;
    let m;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
    return specs;
}

/**
 * Computes the 16-hex-char cache build id for the server bundle.
 *
 * @param {string} repoRoot the repository root the sources live under.
 * @returns {string} the scoped build id.
 */
export function computeCacheBuildId(repoRoot = process.cwd()) {
    const allServerTs = listTsFiles(norm(join(repoRoot, 'server/src')));

    // Seeds: every file under a seed dir, plus any file carrying a persisted-index marker.
    const seedPrefixes = SEED_DIRS.map((d) => norm(join(repoRoot, d)) + '/');
    const seeds = new Set();
    for (const file of allServerTs) {
        if (seedPrefixes.some((p) => file.startsWith(p))) seeds.add(file);
    }
    for (const file of allServerTs) {
        if (!seeds.has(file) && CACHE_ID_MARKER.test(readFileSync(file, 'utf-8'))) seeds.add(file);
    }

    // Transitive relative-import closure over the seeds.
    const closure = new Set();
    const queue = [...seeds];
    while (queue.length) {
        const file = queue.pop();
        if (closure.has(file)) continue;
        closure.add(file);
        let source;
        try {
            source = readFileSync(file, 'utf-8');
        } catch {
            continue;
        }
        for (const spec of importSpecifiers(source)) {
            const target = resolveSpec(file, spec);
            if (target && !closure.has(target)) queue.push(target);
        }
    }

    // Safety net: every serialized / diagnostic-feeding index must be covered, or the scoping is
    // silently under-inclusive and a stale cache could ship wrong results. Fail the build instead.
    const escaped = allServerTs.filter((f) => INDEX_BASE_MARKER.test(readFileSync(f, 'utf-8')) && !closure.has(f));
    if (escaped.length) {
        throw new Error(
            'Cache build id: these WatchedDocumentIndex files are not in the hashed closure, so a ' +
                'change to them would not invalidate the on-disk caches. Add their directory to ' +
                'SEED_DIRS in esbuild.cache-id.mjs (or ensure a seed imports them):\n  ' +
                escaped.map((f) => relative(repoRoot, f)).join('\n  ')
        );
    }

    // Hash the closure's contents (path-keyed, sorted for determinism) plus dependency versions.
    const hash = createHash('sha1');
    for (const file of [...closure].sort()) {
        hash.update(relative(repoRoot, file).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(readFileSync(file));
        hash.update('\0');
    }
    const lock = join(repoRoot, 'package-lock.json');
    if (existsSync(lock)) hash.update(readFileSync(lock));
    return hash.digest('hex').slice(0, 16);
}
