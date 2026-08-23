import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AbstractNodeDocument, isAssignmentNode, isValueNode } from '../../src/core/ast/ast';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { ParserResultRegistrar } from '../../src/registrar/parser-result-registrar';
import { perfSnapshot } from '../../src/utils/perf-counters';
import { FileWithPath } from '../../src/workspace/cosmoteer-workspace.service';
import {
    beginFsTrustWindow,
    clearFsCaches,
    endFsTrustWindow,
    invalidateFsPath,
    onFsInvalidation,
} from '../../src/workspace/fs-cache';
import { getParsedFileDocument } from '../../src/workspace/parsed-file-cache';

// The pin on a game-tree file node used to be served for the rest of the session once the file had
// been parsed, so a Cosmoteer update installed while the editor is open, a workshop mod updated by
// Steam, or a vanilla file saved under `allowEditingVanillaFiles` kept resolving against the tree
// the session started with. These tests drive the real entry point against real files on disk.

let dir: string;

/** A workspace-tree file node in the shape the workspace service builds, with nothing pinned yet. */
const fileNode = (path: string): FileWithPath => ({
    type: 'File',
    name: basename(path),
    path,
    content: { name: basename(path, '.rules') },
});

/**
 * Writes a file and pushes its timestamp forward, because a rewrite of the same size within the
 * filesystem's mtime granularity is indistinguishable from the previous version.
 *
 * @param path the file to write.
 * @param text the new content.
 */
// Each rewrite is stamped a second later than the one before it. `Date.now()` only counts whole
// milliseconds, and two rewrites in one test land inside the same millisecond on a fast machine,
// which would give a file of unchanged length the mtime it already had and make a real change
// read as no change at all.
let rewriteTick = 0;
const rewrite = async (path: string, text: string): Promise<void> => {
    writeFileSync(path, text);
    await utimes(path, new Date(), new Date(Date.now() + ++rewriteTick * 1_000));
};

/**
 * The right-hand value of a top-level `Name = value` assignment, as source text.
 *
 * @param document the parsed document to read.
 * @param name the assignment's name.
 * @returns the value's text, or undefined when the document has no such assignment.
 */
const valueOf = (document: AbstractNodeDocument, name: string): string | undefined => {
    for (const node of document.elements) {
        if (isAssignmentNode(node) && node.left.name === name && node.right && isValueNode(node.right))
            return String(node.right.valueType.value);
    }
    return undefined;
};

const statCount = (): number => perfSnapshot().counters['fs.stat'] ?? 0;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pin-'));
});
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    clearFsCaches();
});
beforeEach(() => {
    clearFsCaches();
});

describe('parsed-file-cache freshness', () => {
    it('re-parses a game-tree file that changed on disk mid-session', async () => {
        const path = join(dir, 'updated.rules');
        await rewrite(path, 'Version = 1\n');
        const file = fileNode(path);
        const before = await getParsedFileDocument(file);
        expect(valueOf(before, 'Version')).toBe('1');

        await rewrite(path, 'Version = 2\n');
        const after = await getParsedFileDocument(file);
        expect(valueOf(after, 'Version')).toBe('2');
        expect(after).not.toBe(before);
        expect(file.content.parsedDocument).toBe(after);
    });

    it('serves the pinned document while the file is unchanged', async () => {
        const path = join(dir, 'stable.rules');
        await rewrite(path, 'Version = 1\n');
        const file = fileNode(path);
        const first = await getParsedFileDocument(file);
        const second = await getParsedFileDocument(file);
        expect(second).toBe(first);
    });

    it('keeps serving the pin when the file is gone, instead of failing the resolution', async () => {
        const path = join(dir, 'vanishing.rules');
        await rewrite(path, 'Version = 1\n');
        const file = fileNode(path);
        const first = await getParsedFileDocument(file);
        rmSync(path);
        expect(await getParsedFileDocument(file)).toBe(first);
    });

    it('prefers the live editor buffer over the file on disk', async () => {
        const path = join(dir, 'open.rules');
        await rewrite(path, 'Version = 1\n');
        const file = fileNode(path);
        const uri = pathToFileURL(path).href;
        const buffer = parser(lexer('Version = 99\n'), uri).value;
        ParserResultRegistrar.instance.setResult(uri, buffer);
        try {
            expect(await getParsedFileDocument(file)).toBe(buffer);
        } finally {
            ParserResultRegistrar.instance.removeResult(uri);
        }
        // With the buffer closed the pin answers from disk again.
        expect(valueOf(await getParsedFileDocument(file), 'Version')).toBe('1');
    });
});

describe('parsed-file-cache trust window', () => {
    it('stats a pinned file once per window instead of once per read', async () => {
        const path = join(dir, 'windowed.rules');
        await rewrite(path, 'Version = 1\n');
        const file = fileNode(path);
        await getParsedFileDocument(file);

        beginFsTrustWindow();
        try {
            const before = statCount();
            await getParsedFileDocument(file);
            const afterFirst = statCount();
            await getParsedFileDocument(file);
            await getParsedFileDocument(file);
            expect(afterFirst - before).toBe(1);
            expect(statCount()).toBe(afterFirst);
        } finally {
            endFsTrustWindow();
        }

        // The window is closed, so the next read validates against disk again.
        const before = statCount();
        await getParsedFileDocument(file);
        expect(statCount() - before).toBe(1);
    });

    it('does not hide a watched change that lands inside a window', async () => {
        const path = join(dir, 'watched.rules');
        await rewrite(path, 'Version = 1\n');
        const file = fileNode(path);

        beginFsTrustWindow();
        try {
            const first = await getParsedFileDocument(file);
            expect(valueOf(first, 'Version')).toBe('1');
            await rewrite(path, 'Version = 2\n');
            // What the client file watcher reports for a changed file.
            invalidateFsPath(path);
            expect(valueOf(await getParsedFileDocument(file), 'Version')).toBe('2');
        } finally {
            endFsTrustWindow();
        }
    });
});

describe('parsed-file-cache eviction exemption', () => {
    it('leaves cosmoteer.rules pinned across a refresh, for super-path resolution', async () => {
        const path = join(dir, 'cosmoteer.rules');
        await rewrite(path, 'Version = 1\n');
        const file = fileNode(path);
        await getParsedFileDocument(file);
        await rewrite(path, 'Version = 2\n');
        const refreshed = await getParsedFileDocument(file);
        // Consumers read the pin directly off the tree node, so it must be present and current.
        expect(file.content.parsedDocument).toBe(refreshed);
        expect(valueOf(refreshed, 'Version')).toBe('2');
    });
});

// Everything the editor works out from a file is cached against that file: the reference resolution
// memo, the asset memo, the shared-base analyses. Those caches are keyed by path, and a change the
// pin discovers by itself arrives with no watcher event behind it, so nothing else would ever hear
// about it and they would keep answering from the tree the session started with.
describe('parsed-file-cache change announcement', () => {
    it('tells the caches derived from a file when it discovers the file changed', async () => {
        const path = join(dir, 'announce.rules');
        await rewrite(path, 'Version = 1\n');
        const file = fileNode(path);
        await getParsedFileDocument(file);
        let heard = 0;
        onFsInvalidation(() => heard++);
        await rewrite(path, 'Version = 2\n');
        expect(valueOf(await getParsedFileDocument(file), 'Version')).toBe('2');
        expect(heard).toBe(1);
    });

    it('says nothing when it reads a file for the first time', async () => {
        const path = join(dir, 'first-read.rules');
        await rewrite(path, 'Version = 1\n');
        let heard = 0;
        onFsInvalidation(() => heard++);
        await getParsedFileDocument(fileNode(path));
        expect(heard).toBe(0);
    });

    it('says nothing when the file is unchanged', async () => {
        const path = join(dir, 'unchanged.rules');
        await rewrite(path, 'Version = 1\n');
        const file = fileNode(path);
        await getParsedFileDocument(file);
        let heard = 0;
        onFsInvalidation(() => heard++);
        await getParsedFileDocument(file);
        expect(heard).toBe(0);
    });
});
