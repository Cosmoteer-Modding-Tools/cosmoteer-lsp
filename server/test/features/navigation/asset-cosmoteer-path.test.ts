import { beforeAll, describe, expect, it } from 'vitest';
import { resolveAsset } from '../../../src/features/navigation/navigate-asset';
import { globalSettings } from '../../../src/settings';
import { WORKSPACE_DATA_DIR } from '../../workspace-helper';

// `./Data/…` asset paths are absolute from the Cosmoteer install root. Mods write the
// prefix in any case (`./data/…`, `./Data/…`); resolution must be case-insensitive.
const someFile = WORKSPACE_DATA_DIR + '/effects/x.rules';

beforeAll(() => {
    // CosmoteerWorkspacePath derives from this; point it at the fixture Data root.
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
});

describe('cosmoteer `./Data/...` asset paths (case-insensitive)', () => {
    it('resolves a lowercase `./data/...` asset path (the reported bug)', async () => {
        const found = await resolveAsset('./data/sounds/fx/beep.wav', someFile);
        expect(found).not.toBeNull();
    });

    it('still resolves the canonical `./Data/...` casing', async () => {
        const found = await resolveAsset('./Data/sounds/fx/beep.wav', someFile);
        expect(found).not.toBeNull();
    });

    it('returns false for a `./data/...` asset that does not exist', async () => {
        const found = await resolveAsset('./data/sounds/fx/missing.wav', someFile);
        expect(found).toBeNull();
    });
});
