import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { applyPlansOver, mirrorTree } from './apply-roundtrip.harness';

// The game's own data, mirrored and then rewritten by its own extractions. The mirror is built at
// `<scratch>/Cosmoteer/Data` because the workspace service only accepts a path shaped like an
// install. Nothing is ever written to the real install.
const DATA_DIR = (process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data')
    .replace(/\\/g, '/');
const MAX_PLANS = Number(process.env.APPLY_ROUNDTRIP_PLANS ?? '5');
// Mirroring a tree and rewriting it takes minutes, so it is asked for rather than run by default,
// the same as the other corpus tests here.
const HAVE = !!process.env.APPLY_ROUNDTRIP && existsSync(DATA_DIR);

describe.skipIf(!HAVE)("extractions applied to the game's own data", () => {
    it('keeps every field of every rewritten group resolving to what it resolved to before', async () => {
        const scratch = mkdtempSync(join(tmpdir(), 'sharedbase-vanilla-')).replace(/\\/g, '/');
        const mirror = `${scratch}/Cosmoteer/Data`;
        try {
            expect(mirrorTree(DATA_DIR, mirror), 'nothing was mirrored').toBeGreaterThan(0);
            await applyPlansOver('vanilla Data', mirror, mirror, true, MAX_PLANS);
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }, 1_800_000);
});
