import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateIgnoredFields } from '../../../src/features/diagnostics/validator.ignored-field';

// Fields the game declares but provably never reads (decomp-verified, curated in deprecations.ts)
// get the same dead-weight hint as unknown members, with the remove quick fix.
const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///data/parts/t.rules').value;

describe('dead declared fields', () => {
    it('hints a declared-but-never-read field with a remove fix', async () => {
        const doc = parse('Part\n{\n\tFireDamageFactor = 2\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('FireDamageFactor'));
        expect(hit).toBeTruthy();
        expect(hit!.message).toContain('never reads');
        expect(hit!.severity).toBe('hint');
        expect(hit!.data?.remove?.title).toContain('FireDamageFactor');
    });

    it('leaves a live sibling field alone', async () => {
        const doc = parse('Part\n{\n\tMaxHealth = 100\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        expect(errors.filter((e) => e.message.includes('MaxHealth'))).toEqual([]);
    });
});
