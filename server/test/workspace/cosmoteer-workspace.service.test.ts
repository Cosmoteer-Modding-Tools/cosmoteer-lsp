import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { CosmoteerWorkspaceService } from '../../src/workspace/cosmoteer-workspace.service';

// The game tree used to be built once per process: `initialize` returned early the moment it had
// any tree, so a session that pointed the setting at a second install (a beta branch, a moved
// install) kept resolving every reference against the first one for good, while everything reading
// the live setting followed the new path. Rebuilding has to keep the old tree serving until the new
// one is whole, and keep it rather than nothing when the new path cannot be read.

const warnings: string[] = [];

const progress: WorkDoneProgressReporter = {
    begin: () => undefined,
    report: () => undefined,
    done: () => undefined,
};

const connection = {
    window: {
        showWarningMessage: (message: string) => {
            warnings.push(message);
            return Promise.resolve(undefined);
        },
    },
    languages: { diagnostics: { refresh: () => undefined } },
} as unknown as Connection;

let root: string;

/**
 * Writes a Cosmoteer-shaped install with one file under it.
 *
 * @param name the install folder's name.
 * @param file the basename of the single rules file under `Data/resources`.
 * @returns the install's `Data` root.
 */
const install = (name: string, file: string): string => {
    const dataRoot = join(root, name, 'Data');
    mkdirSync(join(dataRoot, 'resources'), { recursive: true });
    writeFileSync(join(dataRoot, 'resources', file), 'Thing {\n    VALUE = 1\n}\n');
    return dataRoot;
};

describe('the game tree when the configured install changes', () => {
    let first: string;
    let second: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'cosmoteer-install-'));
        first = install('first', 'first.rules');
        second = install('second', 'second.rules');
        CosmoteerWorkspaceService.instance.setConnection(connection);
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('reads the install it is first pointed at', async () => {
        await CosmoteerWorkspaceService.instance.initialize(first, progress);
        expect(CosmoteerWorkspaceService.instance.dataRootPath).toBe(first);
        expect(CosmoteerWorkspaceService.instance.findFile(['resources', 'first.rules'])).toBeDefined();
    });

    it('stays on the same tree when pointed at the same install again', async () => {
        const before = CosmoteerWorkspaceService.instance.findFile(['resources', 'first.rules']);
        await CosmoteerWorkspaceService.instance.initialize(first, progress);
        expect(CosmoteerWorkspaceService.instance.findFile(['resources', 'first.rules'])).toBe(before);
    });

    it('rebuilds against a second install the setting is moved to', async () => {
        await CosmoteerWorkspaceService.instance.initialize(second, progress);
        expect(CosmoteerWorkspaceService.instance.dataRootPath).toBe(second);
        expect(CosmoteerWorkspaceService.instance.findFile(['resources', 'second.rules'])).toBeDefined();
        expect(CosmoteerWorkspaceService.instance.findFile(['resources', 'first.rules'])).toBeUndefined();
    });

    it('keeps the tree it has and says so when the new path is not an install', async () => {
        warnings.length = 0;
        await CosmoteerWorkspaceService.instance.initialize(join(root, 'somewhere-else'), progress);
        expect(warnings.join(' ')).toContain('Invalid cosmoteer path');
        expect(CosmoteerWorkspaceService.instance.dataRootPath).toBe(second);
        expect(CosmoteerWorkspaceService.instance.findFile(['resources', 'second.rules'])).toBeDefined();
    });

    it('keeps the tree it has and says so when the new path holds no files', async () => {
        warnings.length = 0;
        const empty = join(root, 'empty', 'Data');
        mkdirSync(empty, { recursive: true });
        await CosmoteerWorkspaceService.instance.initialize(empty, progress);
        expect(warnings.join(' ')).toContain('holds no files');
        expect(CosmoteerWorkspaceService.instance.dataRootPath).toBe(second);
        expect(CosmoteerWorkspaceService.instance.findFile(['resources', 'second.rules'])).toBeDefined();
    });

    it('keeps the tree it has and says so when the new path cannot be read', async () => {
        warnings.length = 0;
        await CosmoteerWorkspaceService.instance.initialize(join(root, 'gone', 'Data'), progress);
        expect(warnings.join(' ')).toContain('Could not read');
        expect(CosmoteerWorkspaceService.instance.dataRootPath).toBe(second);
        expect(CosmoteerWorkspaceService.instance.findFile(['resources', 'second.rules'])).toBeDefined();
    });
});
