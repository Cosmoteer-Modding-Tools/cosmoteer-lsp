import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { clearShaderCache } from '../../../src/features/shader/shader-index';
import { validateShaderConstants } from '../../../src/features/diagnostics/validator.shader-constants';

// The shader-constant validator flags an inline `_`-key the referenced shader declares no uniform for,
// and a value of the wrong shape for its type. The contract this guards (it runs by default, so the
// bar is zero warnings on shipping data):
//   - zero type-mismatch warnings on vanilla (every vanilla value is correctly typed, so any such
//     warning is a false positive from the type check being too aggressive).
//   - zero "unknown constant" warnings: the handful of dead keys the game itself ships are skipped by
//     the validator's VANILLA_DEAD_KEYS set. A new dead key in a game update, or a parser regression
//     that broke constant extraction (which would flag hundreds of real constants), both surface here.
// Needs the install, self-skips without it.
const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

const rulesFiles = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            if (statSync(p).isDirectory()) walk(p);
            else if (entry.endsWith('.rules')) out.push(p);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE_DATA)('shader-constant validation over vanilla Data', () => {
    beforeAll(() => {
        // Point the workspace at the game install so root-anchored shader includes resolve.
        globalSettings.cosmoteerPath = DATA_DIR;
        clearShaderCache();
    });

    it('produces zero warnings of any kind across vanilla', async () => {
        const warnings: string[] = [];
        for (const file of rulesFiles(DATA_DIR)) {
            let doc;
            try {
                doc = parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value;
            } catch {
                continue;
            }
            for (const error of await validateShaderConstants(doc, token)) {
                warnings.push(`${file}: ${error.message}`);
            }
        }
        expect(warnings.slice(0, 30)).toEqual([]);
        // This walks and parses every vanilla `.rules` file and reads each referenced shader cold (the
        // cache is cleared in beforeAll), which is far more than the 5s default unit-test budget allows
        // on a cold file cache or under full-suite parallel load — give the whole-install scan room.
    }, 60_000);
});
