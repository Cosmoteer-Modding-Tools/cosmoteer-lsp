import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { MentionIndex } from '../../../src/features/navigation/mention.index';
import { validateUnusedConstants } from '../../../src/features/diagnostics/validator.unused-constant';

// Scan of the unused-constant check over the whole vanilla install. Vanilla may legitimately ship a
// constant nothing reads, so this is a review harness rather than a zero contract: it reports what
// the check finds (and writes the list when FPSCAN_OUT_DIR names a directory), and only guards the
// count against a sudden jump, which is what a broken gate would look like. Needs the install,
// self-skips without it.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;
const OUT_DIR = process.env.FPSCAN_OUT_DIR ?? '';

/** Ceiling on vanilla findings. The install ships a handful of genuinely unread constants, and a
 *  regression in the cross-file gate would flag hundreds. */
const MAX_FINDINGS = 40;

const rulesFilesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (entry.endsWith('.rules')) out.push(path);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE_DATA)('unused constants over vanilla Data', () => {
    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        MentionIndex.instance.reset();
        await MentionIndex.instance.ensureBuilt([DATA_DIR], token);
    }, 300_000);

    it('flags no more than a handful of vanilla constants', async () => {
        const findings: string[] = [];
        for (const file of rulesFilesUnder(DATA_DIR)) {
            let document;
            try {
                document = parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value;
            } catch {
                continue;
            }
            for (const error of await validateUnusedConstants(document, [DATA_DIR], token)) {
                findings.push(`${relative(DATA_DIR, file)}: ${error.message}`);
            }
        }
        console.log(`\n[unused-constants] ${findings.length} findings\n` + findings.slice(0, 50).join('\n'));
        if (OUT_DIR) writeFileSync(join(OUT_DIR, 'fpscan-unused-constants.txt'), findings.join('\n'), 'utf8');
        expect(findings.length).toBeLessThanOrEqual(MAX_FINDINGS);
    }, 900_000);
});
