import { join } from 'path';
import { Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { CosmoteerWorkspaceService } from '../src/workspace/cosmoteer-workspace.service';
import { AbstractNode } from '../src/core/ast/ast';
import { FIXTURES_DIR } from './helpers';

/** Absolute path of the on-disk fixture workspace (its `Data/` root). */
export const WORKSPACE_DATA_DIR = join(FIXTURES_DIR, 'workspace', 'Data');

/** Absolute path of a file inside the fixture workspace. */
export const workspaceFile = (...segments: string[]): string => join(WORKSPACE_DATA_DIR, ...segments);

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
