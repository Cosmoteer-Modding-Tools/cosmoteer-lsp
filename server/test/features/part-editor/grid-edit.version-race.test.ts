import { describe, expect, it, vi } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { COSMOTEER_METHOD } from '../../../../shared/lsp-methods';
import { PartGridEditParams, PartGridEditResult } from '../../../src/features/part-editor/part-grid.types';

/**
 * The part grid edit request against a stand-in connection, driving the transition the editor can
 * really hit: the mutation is judged fresh, the rooting await yields, a didChange advances the open
 * buffer while it runs, and the edit would then be built from a tree and a text that disagree.
 */

const harness = vi.hoisted(() => {
    const requests: Record<string, (params: unknown, token: unknown) => unknown> = {};
    // The open buffer, which the document manager mutates in place on a didChange exactly as this
    // stand-in does.
    const document = { version: 7, getText: () => 'Part {}', offsetAt: () => 0 };
    let releaseRooting: () => void = () => undefined;
    let rootingEntered: () => void = () => undefined;
    return {
        requests,
        document,
        connection: {
            onRequest: (method: string, handler: (params: unknown, token: unknown) => unknown) => {
                requests[method] = handler;
            },
            sendNotification: () => Promise.resolve(undefined),
            console: { error: () => undefined, warn: () => undefined, info: () => undefined, log: () => undefined },
        },
        /** Blocks in the rooting until {@link release} is called, announcing that it was entered. */
        rooting: (): Promise<void> =>
            new Promise<void>((resolve) => {
                releaseRooting = resolve;
                rootingEntered();
            }),
        entered: (): Promise<void> =>
            new Promise<void>((resolve) => {
                rootingEntered = resolve;
            }),
        release: () => releaseRooting(),
    };
});

vi.mock('../../../src/lsp/context', () => ({
    connection: harness.connection,
    documents: { get: () => harness.document },
}));
vi.mock('../../../src/lsp/fragment-rooting', () => ({ ensureFragmentRooting: () => harness.rooting() }));
vi.mock('../../../src/lsp/open-documents', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    ensureParserResult: () => ({ children: [] }),
    openBufferReadOverride: () => () => undefined,
}));
vi.mock('../../../src/features/part-editor/grid-edit.service', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    buildPartGridEdit: () => Promise.resolve({ status: 'ok', edit: { changes: {} } }),
}));

const params: PartGridEditParams = {
    textDocument: { uri: 'file:///c%3A/game/part.rules' },
    anchor: { line: 0, character: 0 },
    dataVersion: 7,
    mutation: { op: 'addCell', layerId: 'AllowedDoorLocations', cell: { x: 0, y: 0 } },
};

describe('the part grid edit request', () => {
    it('answers stale when a didChange lands while the rooting runs', async () => {
        const { register } = await import('../../../src/lsp/handlers/custom-request.handlers');
        register();
        const edit = harness.requests[COSMOTEER_METHOD.partGridEdit];
        const entered = harness.entered();
        const answer = edit(params, CancellationToken.None) as Promise<PartGridEditResult>;
        await entered;
        // The editor is typed in while the request waits: the manager advances the same buffer the
        // handler is holding, and the tree it read before the await is now a version behind.
        harness.document.version = 8;
        harness.release();
        expect((await answer).status).toBe('stale');
    }, 60000);

    it('answers an edit when nothing changes while the rooting runs', async () => {
        const { register } = await import('../../../src/lsp/handlers/custom-request.handlers');
        register();
        const edit = harness.requests[COSMOTEER_METHOD.partGridEdit];
        harness.document.version = 7;
        const entered = harness.entered();
        const answer = edit(params, CancellationToken.None) as Promise<PartGridEditResult>;
        await entered;
        harness.release();
        const result = await answer;
        expect(result.status).toBe('ok');
        expect(result.edit).toBeTruthy();
    }, 60000);
});
