import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';

// False-positive scan of every parse error the server can raise, over everything the game installs.
// A parse error says the game refuses the file, and the game loads all of this on every launch, so
// one finding here is a false positive by definition. This is the gate the syntax-level checks are
// held to: the dangling `=` in front of a `}`, the separator that ends nothing, the invisible
// character in front of a member name, the digit-keyed member, the unterminated `@"…"` and the
// backslash inside a quoted value. Needs the install, self-skips without it.
const GAME_DIR =
    process.env.COSMOTEER_GAME_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer';
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? join(GAME_DIR, 'Data');
const STANDARD_MODS_DIR = join(GAME_DIR, 'Standard Mods');
const HAVE_DATA = existsSync(DATA_DIR);

const rulesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (entry.toLowerCase().endsWith('.rules')) out.push(path);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE_DATA)('parse errors over the installed game', () => {
    it.each([
        ['Data', DATA_DIR],
        ['Standard Mods', STANDARD_MODS_DIR],
    ])('finds nothing to say about %s', (_label, root) => {
        if (!existsSync(root)) return;
        const findings: string[] = [];
        let scanned = 0;
        for (const file of rulesUnder(root)) {
            const text = readFileSync(file, 'utf8');
            scanned++;
            for (const error of parser(lexer(text), pathToFileURL(file).href).parserErrors) {
                findings.push(
                    `${relative(root, file)}:${error.token.lineNumber + 1}:${error.token.lineOffset + 1} ${error.message}`
                );
            }
        }
        expect(scanned).toBeGreaterThan(0);
        expect(findings).toEqual([]);
        // A whole pass over the installed game does not fit the default budget on a busy machine,
        // and running out of it reads as a parse regression rather than as the clock.
    }, 120_000);
});
