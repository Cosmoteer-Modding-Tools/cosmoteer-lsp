import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { formatRulesDocument } from '../../../src/features/formatting/rules-formatter';
import { formatShaderDocument } from '../../../src/features/formatting/shader-formatter';

// Whole-corpus safety net for the formatter: across every vanilla file the lexical-equivalence
// guard must never trip (a bail means we produced output that would lex differently and threw it
// away) and formatting must be idempotent. Skipped when no game install is present (CI).
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);

const filesWithExtension = (root: string, extension: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            if (statSync(p).isDirectory()) walk(p);
            else if (entry.endsWith(extension)) out.push(p);
        }
    };
    walk(root);
    return out;
};

const tabs = { tabSize: 4, insertSpaces: false };

describe.skipIf(!HAVE_DATA)('formatter over vanilla Data', () => {
    it('formats every vanilla .rules file without bailing and idempotently', () => {
        const files = filesWithExtension(DATA_DIR, '.rules');
        expect(files.length).toBeGreaterThan(900);
        const bailed: string[] = [];
        const diverged: string[] = [];
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            const once = formatRulesDocument(text, tabs);
            if (once === null) {
                bailed.push(relative(DATA_DIR, file));
                continue;
            }
            if (formatRulesDocument(once, tabs) !== once) diverged.push(relative(DATA_DIR, file));
        }
        expect(bailed, `equivalence guard tripped on:\n${bailed.join('\n')}`).toEqual([]);
        expect(diverged, `not idempotent on:\n${diverged.join('\n')}`).toEqual([]);
        // Formatting ~950 files twice takes 2s alone but can exceed the default 5s timeout when the
        // whole suite runs in parallel workers, so give the corpus walk explicit headroom.
    }, 60000);

    it('formats every vanilla .shader file idempotently without changing line content', () => {
        const files = filesWithExtension(DATA_DIR, '.shader');
        expect(files.length).toBeGreaterThan(100);
        const broken: string[] = [];
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            const once = formatShaderDocument(text, tabs);
            const contentOf = (s: string) => s.split('\n').map((l) => l.trim()).filter((l) => l.length);
            if (JSON.stringify(contentOf(text)) !== JSON.stringify(contentOf(once))) {
                broken.push(relative(DATA_DIR, file));
                continue;
            }
            if (formatShaderDocument(once, tabs) !== once) broken.push(relative(DATA_DIR, file) + ' (not idempotent)');
        }
        expect(broken, `shader formatter broke:\n${broken.join('\n')}`).toEqual([]);
    });
});
