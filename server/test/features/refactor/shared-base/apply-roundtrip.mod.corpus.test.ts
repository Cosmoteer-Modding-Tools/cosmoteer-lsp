import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { applyPlansOver, mirrorTree } from './apply-roundtrip.harness';

// A real mod's extractions applied for real, against a mirror of it. See the harness for what is
// proven and why the trees are mirrored rather than touched.
const DATA_DIR = (process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data')
    .replace(/\\/g, '/');
const MOD_DIR = (process.env.APPLY_ROUNDTRIP_MOD ?? 'C:/Users/fpabs/Documents/Projekte/Star-Wars-A-Cosmos-Divided')
    .replace(/\\/g, '/');
const MAX_PLANS = Number(process.env.APPLY_ROUNDTRIP_PLANS ?? '5');
// Mirroring a tree and rewriting it takes minutes, so it is asked for rather than run by default,
// the same as the other corpus tests here.
const HAVE =
    !!process.env.APPLY_ROUNDTRIP && existsSync(DATA_DIR) && existsSync(MOD_DIR) && statSync(MOD_DIR).isDirectory();

describe.skipIf(!HAVE)('extractions applied to a real mod', () => {
    it('keeps every field of every rewritten group resolving to what it resolved to before', async () => {
        const scratch = mkdtempSync(join(tmpdir(), 'sharedbase-mod-')).replace(/\\/g, '/');
        try {
            expect(mirrorTree(MOD_DIR, scratch), 'nothing was mirrored').toBeGreaterThan(0);
            await applyPlansOver(MOD_DIR.split('/').pop()!, scratch, DATA_DIR, false, MAX_PLANS);
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }, 1_800_000);
});
