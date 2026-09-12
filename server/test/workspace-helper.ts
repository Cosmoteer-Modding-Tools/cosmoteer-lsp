import { join, resolve } from 'path';
import { Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { CosmoteerWorkspaceService } from '../src/workspace/cosmoteer-workspace.service';
import { AbstractNode } from '../src/core/ast/ast';
import { FIXTURES_DIR } from './helpers';

/** Absolute path of the on-disk fixture workspace (its `Data/` root). */
export const WORKSPACE_DATA_DIR = join(FIXTURES_DIR, 'workspace', 'Data');

/** Absolute path of a file inside the fixture workspace. */
export const workspaceFile = (...segments: string[]): string => join(WORKSPACE_DATA_DIR, ...segments);

/**
 * An absolute path for the platform the tests are running on, written in forward slashes.
 *
 * Use this wherever a made-up path is handed to something that resolves it, meaning `resolve`,
 * `dirname`, or any function built on them, and the resolved answer is what gets asserted. Written
 * as a `C:/…` literal such a test passes on Windows and fails on the Linux runner, where a drive
 * letter is not absolute and the path resolves against the working directory instead, giving
 * `/home/runner/work/…/C:/…`. Putting both the inputs and the expected answer through this states
 * how the paths relate rather than how one platform spells them.
 *
 * A path that is only carried, parsed or compared as text does not need it, and a test asserting
 * Windows behaviour on purpose, such as reading a path out of a game log or a Steam library file,
 * must keep its literal.
 *
 * @param path an absolute POSIX-style path, for example `/mods/my_mod/effects/fire.shader`.
 * @returns the same path made absolute for this platform, with forward slashes.
 */
export const platformPath = (path: string): string => resolve(path).replace(/\\/g, '/');

const noopProgress: WorkDoneProgressReporter = {
    begin: () => undefined,
    report: () => undefined,
    done: () => undefined,
};

const mockConnection = {
    languages: { diagnostics: { refresh: () => undefined } },
    window: { showWarningMessage: () => undefined },
} as unknown as Connection;

let initialized: Promise<CosmoteerWorkspaceService> | undefined;

/**
 * Initialize the singleton {@link CosmoteerWorkspaceService} against the on-disk
 * fixture workspace exactly once. Subsequent calls return the same instance, so
 * `findFile`/`getCosmoteerRules` (and therefore `<./Data/…>` / `/…` references)
 * resolve against real fixture files.
 */
export const initWorkspace = (): Promise<CosmoteerWorkspaceService> => {
    if (!initialized) {
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection(mockConnection);
        initialized = service.initialize(WORKSPACE_DATA_DIR, noopProgress).then(() => service);
    }
    return initialized;
};

/** The plain value carried by a resolved Value node (e.g. the number behind `Leaf = 300`). */
export const valueOf = (node: AbstractNode | null | undefined | { type: string }): unknown =>
    node && 'valueType' in node ? (node as { valueType: { value: unknown } }).valueType.value : undefined;
