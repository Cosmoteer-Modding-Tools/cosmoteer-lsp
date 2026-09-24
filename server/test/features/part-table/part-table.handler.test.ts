import { describe, expect, it, vi } from 'vitest';
import { CancellationToken, CancellationTokenSource } from 'vscode-languageserver';
import { COSMOTEER_METHOD } from '../../../../shared/lsp-methods';
import { PartTableData, PartTableRow } from '../../../src/features/part-table/part-table.types';

/**
 * The part table requests against a stand-in connection. A walk the reader has already moved on
 * from still answers with the rows it managed, which is better than an empty table on screen, and
 * the formula columns are computed over the last whole table rather than over that remnant.
 */

const harness = vi.hoisted(() => {
    const requests: Record<string, (params: unknown, token: unknown) => unknown> = {};
    let answer: { rows: readonly PartTableRow[] } = { rows: [] };
    return {
        requests,
        connection: {
            onRequest: (method: string, handler: (params: unknown, token: unknown) => unknown) => {
                requests[method] = handler;
            },
            sendNotification: () => Promise.resolve(undefined),
            console: { error: () => undefined, warn: () => undefined, info: () => undefined, log: () => undefined },
        },
        build: () => answer,
        setAnswer: (rows: readonly PartTableRow[]) => (answer = { rows }),
    };
});

vi.mock('../../../src/lsp/context', () => ({ connection: harness.connection, documents: { get: () => undefined } }));
vi.mock('../../../src/lsp/fragment-rooting', () => ({ ensureFragmentRooting: () => Promise.resolve(undefined) }));
vi.mock('../../../src/lsp/ship-layers', () => ({
    shipLayerContext: () => Promise.resolve({ gameRootDocument: undefined, gameRootPath: undefined, folderPaths: [] }),
}));
vi.mock('../../../src/features/part-table/part-table.service', () => ({
    buildPartTable: () => Promise.resolve(harness.build() as unknown as PartTableData),
    invalidatePartTable: () => undefined,
    onPartTableChange: () => undefined,
    onPartTableProgress: () => undefined,
}));

/** One row of a table, as little of one as the formula evaluator needs. */
const rowOf = (id: string, health: number): PartTableRow =>
    ({
        key: `c:/game/${id}.rules#part`,
        id,
        name: id,
        file: `${id}.rules`,
        uri: `file:///c%3A/game/${id}.rules`,
        line: 0,
        character: 0,
        source: 'Cosmoteer',
        categories: [],
        components: [],
        editorGroups: [],
        ships: [],
        cells: { MaxHealth: { text: String(health), value: health } },
    }) as unknown as PartTableRow;

describe('the part table requests', () => {
    it('computes a formula over the last whole table rather than over a cancelled one', async () => {
        const { register } = await import('../../../src/lsp/handlers/custom-request.handlers');
        register();
        const table = harness.requests[COSMOTEER_METHOD.partTable];
        const formula = harness.requests[COSMOTEER_METHOD.partTableFormula];
        harness.setAnswer([rowOf('cosmoteer.armor', 450), rowOf('cosmoteer.shield', 800)]);
        await table({}, CancellationToken.None);
        // The reader types on, so the walk behind this ask is dropped and answers a part of itself.
        const cancelled = new CancellationTokenSource();
        cancelled.cancel();
        harness.setAnswer([rowOf('cosmoteer.armor', 450)]);
        await table({}, cancelled.token);
        const computed = formula({ formula: '[MaxHealth]' }, CancellationToken.None) as {
            values: Record<string, number>;
        };
        expect(Object.keys(computed.values)).toEqual([
            'c:/game/cosmoteer.armor.rules#part',
            'c:/game/cosmoteer.shield.rules#part',
        ]);
    }, 60000);
});
