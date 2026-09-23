import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { FIXTURES_DIR } from '../../helpers';

/** The repository root, two levels above the server package the tests live in. */
const REPO_ROOT = resolve(FIXTURES_DIR, '..', '..', '..');

/** The TextMate grammar the editors colour `.shader` files with. */
interface Grammar {
    repository: {
        preprocessor: { patterns: Array<{ match: string; captures?: Record<string, { name: string }> }> };
        functions: { match: string; name: string };
    };
}

const grammar: Grammar = JSON.parse(readFileSync(join(REPO_ROOT, 'syntaxes', 'shader.tmLanguage.json'), 'utf8'));

/** The first preprocessor rule that matches a whole line, with what it captured. */
const directiveMatch = (line: string): RegExpExecArray | null => {
    for (const pattern of grammar.repository.preprocessor.patterns) {
        const match = new RegExp(pattern.match).exec(line);
        if (match) return match;
    }
    return null;
};

describe('shader grammar preprocessor rules', () => {
    it('takes a pragma line whole, so its body is not scanned as shader code', () => {
        const line = '#pragma warning( disable : 3571 )';
        const match = directiveMatch(line);
        expect(match?.[0]).toBe(line);
        // The rule the scanner would otherwise reach paints anything before a `(` as a call.
        expect(new RegExp(grammar.repository.functions.match).exec(line)?.[1]).toBe('warning');
    });

    it('leaves an ordinary directive body to the rules that colour it', () => {
        const match = directiveMatch('#define ENABLE_TANGENT');
        expect(match?.[0]).toBe('#define');
    });

    it('still keeps the include path as a string', () => {
        const match = directiveMatch('#include "../base.shader"');
        expect(match?.[2]).toBe('"../base.shader"');
    });
});
