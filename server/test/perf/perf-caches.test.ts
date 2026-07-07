import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { stepIntoNode } from '../../src/semantics/reference-resolver';
import { getStartOfAstNode } from '../../src/utils/ast.utils';
import { cachedParseFilePath, cachedReaddir, clearFsCaches, invalidateFsPath } from '../../src/workspace/fs-cache';
import { ParserResultRegistrar } from '../../src/registrar/parser-result-registrar';
import { GroupNode, isValueNode } from '../../src/core/ast/ast';

// Performance regression tests for the caching layers added in the 2026-07 performance pass.
// Timing bounds are deliberately generous (an order of magnitude above a warm run) so they stay
// green on slow CI machines while still failing hard if a cache silently stops caching.

let dir: string;

const parse = (source: string, uri = 'file:///perf.rules') => parser(lexer(source), uri).value;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'perf-'));
});
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    clearFsCaches();
});

describe('fs-cache parsed documents', () => {
    it('serves an unchanged file from cache and re-reads it after a change', async () => {
        const file = join(dir, 'cached.rules');
        writeFileSync(file, 'A = 1\n');
        const first = await cachedParseFilePath(file);
        const second = await cachedParseFilePath(file);
        expect(second).toBe(first);

        writeFileSync(file, 'A = 2\n');
        // A same-length rewrite can land within the mtime granularity, so age the timestamp
        // explicitly. The real server additionally invalidates through the file watcher.
        await utimes(file, new Date(), new Date(Date.now() + 5_000));
        const third = await cachedParseFilePath(file);
        expect(third).not.toBe(first);
    });

    it('prefers the live editor buffer over the on-disk content', async () => {
        const file = join(dir, 'open.rules');
        writeFileSync(file, 'OnDisk = 1\n');
        const uri = pathToFileURL(file).href;
        const liveDocument = parse('InBuffer = 2\n', uri);
        ParserResultRegistrar.instance.setResult(uri, liveDocument);
        try {
            const resolved = await cachedParseFilePath(file);
            expect(resolved).toBe(liveDocument);
        } finally {
            ParserResultRegistrar.instance.removeResult(uri);
        }
    });
});

describe('fs-cache directory listings', () => {
    it('sees a newly created file immediately (mtime-validated, no stale window)', async () => {
        const sub = join(dir, 'listing');
        writeFileSync(join(dir, 'seed.rules'), 'X = 1\n');
        rmSync(sub, { recursive: true, force: true });
        const { mkdirSync } = await import('fs');
        mkdirSync(sub);
        writeFileSync(join(sub, 'first.rules'), 'A = 1\n');
        const before = await cachedReaddir(sub);
        expect(before.map((entry) => entry.name)).toContain('first.rules');

        writeFileSync(join(sub, 'second.rules'), 'B = 2\n');
        const after = await cachedReaddir(sub);
        expect(after.map((entry) => entry.name)).toContain('second.rules');
    });

    it('drops entries on explicit invalidation', async () => {
        const file = join(dir, 'inval.rules');
        writeFileSync(file, 'A = 1\n');
        await cachedParseFilePath(file);
        invalidateFsPath(file);
        // After invalidation the next call re-reads. Observable as a fresh object.
        const first = await cachedParseFilePath(file);
        invalidateFsPath(file);
        const second = await cachedParseFilePath(file);
        expect(second).not.toBe(first);
    });
});

describe('per-container member lookup index', () => {
    const memberCount = 2_000;
    const buildWideGroup = (): GroupNode => {
        const members = Array.from({ length: memberCount }, (_, i) => `\tField${i} = ${i}`).join('\n');
        const document = parse(`Wide\n{\n${members}\n}\n`);
        return document.elements[0] as GroupNode;
    };

    it('resolves case-insensitive member lookups correctly through the index', () => {
        const group = buildWideGroup();
        const exact = stepIntoNode(group, 'Field42');
        const folded = stepIntoNode(group, 'fIeLd42');
        expect(exact && isValueNode(exact) ? exact.valueType.value : undefined).toBe(42);
        expect(folded).toBe(exact);
        expect(stepIntoNode(group, 'NoSuchField')).toBeNull();
    });

    it('stays fast on repeated lookups over a wide group', () => {
        const group = buildWideGroup();
        const start = performance.now();
        for (let round = 0; round < 25; round++) {
            for (let i = 0; i < memberCount; i++) {
                stepIntoNode(group, `field${i}`);
            }
        }
        const elapsed = performance.now() - start;
        // 50k lookups. The linear scan this replaced took whole seconds here.
        expect(elapsed).toBeLessThan(1_000);
    });
});

describe('owning-document lookup', () => {
    it('answers repeated deep getStartOfAstNode calls quickly and correctly', () => {
        const depth = 200;
        const source = `${'A {\n'.repeat(depth)}Leaf = 1\n${'}\n'.repeat(depth)}`;
        const document = parse(source);
        let node = document.elements[0] as GroupNode;
        while (node.elements.length > 0 && node.elements[0].type === 'Group') {
            node = node.elements[0] as GroupNode;
        }
        expect(getStartOfAstNode(node)).toBe(document);
        const start = performance.now();
        let matches = 0;
        for (let i = 0; i < 100_000; i++) {
            if (getStartOfAstNode(node) === document) matches++;
        }
        expect(matches).toBe(100_000);
        // 100k root lookups from 200 levels deep. The uncached walk took whole seconds here.
        expect(performance.now() - start).toBeLessThan(2_000);
    });
});

describe('whole-document lex+parse throughput', () => {
    it('lexes and parses a large synthetic document within budget', () => {
        const groups = Array.from(
            { length: 400 },
            (_, i) => `Group${i}\n{\n\tName = "Value ${i}"\n\tCost = ${i} * 2 + 1\n\tRef = &<other.rules>/X\n}\n`
        ).join('\n');
        const start = performance.now();
        for (let i = 0; i < 10; i++) parse(groups);
        const elapsed = performance.now() - start;
        // Ten parses of a ~2000-assignment document. Warm runs take well under a second.
        expect(elapsed).toBeLessThan(5_000);
    });
});
