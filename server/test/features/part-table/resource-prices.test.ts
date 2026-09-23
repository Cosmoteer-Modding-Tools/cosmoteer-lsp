import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { collectResourcePrices, priceOf } from '../../../src/features/part-table/resource-prices';

/**
 * What one unit of a resource costs, read from a registry holding the three shapes a resource file
 * comes in: a price written out, no price at all, and a price written as a reference that leads
 * nowhere. The game reads `BuyPrice` as an optional int, so only the third is unknown.
 */

const GAME_ROOT = resolve(__dirname, 'fixtures', 'resources-game', 'cosmoteer.rules');

const collect = () =>
    collectResourcePrices(
        { gameRootDocument: undefined, gameRootPath: GAME_ROOT, folderPaths: [] },
        CancellationToken.None
    );

describe('the resource prices the part table costs a part with', () => {
    it('reads the price a resource writes', async () => {
        expect(priceOf(await collect(), 'steel')).toBe(25);
    });

    it('buys a registered resource that writes no price for nothing', async () => {
        expect(priceOf(await collect(), 'battery')).toBe(0);
    });

    it('leaves a price it cannot read unknown', async () => {
        expect(priceOf(await collect(), 'mystery')).toBeUndefined();
    });
});
