import { beforeAll, describe, expect, it } from 'vitest';
import { AssetNavigationStrategy } from '../../../src/features/navigation/asset.navigation-strategy';
import { AbstractNode } from '../../../src/core/ast/ast';
import { globalSettings } from '../../../src/settings';
import { WORKSPACE_DATA_DIR } from '../../workspace-helper';

// `./Data/…` asset paths are absolute from the Cosmoteer install root. Mods write the
// prefix in any case (`./data/…`, `./Data/…`); resolution must be case-insensitive.
const assetNav = new AssetNavigationStrategy();
const dummyNode = { type: 'Value' } as unknown as AbstractNode;
const someFile = WORKSPACE_DATA_DIR + '/effects/x.rules';

beforeAll(() => {
    // CosmoteerWorkspacePath derives from this; point it at the fixture Data root.
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
});

describe('cosmoteer `./Data/...` asset paths (case-insensitive)', () => {
    it('resolves a lowercase `./data/...` asset path (the reported bug)', async () => {
        const found = await assetNav.navigate('./data/sounds/fx/beep.wav', dummyNode, someFile);
        expect(found).toBe(true);
    });

    it('still resolves the canonical `./Data/...` casing', async () => {
        const found = await assetNav.navigate('./Data/sounds/fx/beep.wav', dummyNode, someFile);
        expect(found).toBe(true);
    });

    it('returns false for a `./data/...` asset that does not exist', async () => {
        const found = await assetNav.navigate('./data/sounds/fx/missing.wav', dummyNode, someFile);
        expect(found).toBe(false);
    });
});
