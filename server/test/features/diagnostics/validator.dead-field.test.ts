import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateIgnoredFields } from '../../../src/features/diagnostics/validator.ignored-field';

// Fields the game declares but provably never reads (the schema's `dead` flag, from schemagen's
// whole-assembly read scan) get the same dead-weight hint as unknown members, with the remove fix.
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

    it('hints a deleted field with its migration note and a remove fix', async () => {
        // The Meltdown update deleted `Flammable` from PartRules; fire immunity moved to the
        // `non_flammable` part category. The hint must teach the migration, not just the removal.
        const doc = parse('Part\n{\n\tFlammable = false\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit).toBeTruthy();
        expect(hit!.message).toContain('removed in a newer game version');
        expect(hit!.message).toContain('TypeCategories = [non_flammable]');
        expect(hit!.severity).toBe('hint');
        expect(hit!.data?.remove?.title).toContain('Flammable');
    });

    it('leaves a live sibling field alone', async () => {
        const doc = parse('Part\n{\n\tMaxHealth = 100\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        expect(errors.filter((e) => e.message.includes('MaxHealth'))).toEqual([]);
    });

    it('stays silent when a reference in the file reads the dead field', async () => {
        // References resolve at parse time in ObjectText, so a mod that writes a dead field and reads
        // it via `(&~/…)` in the same file uses it for real; the remove fix would break the mod.
        const doc = parse('Part\n{\n\tFireDamageFactor = 1.5\n\tMaxHealth = (&~/Part/FireDamageFactor) * 100\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        expect(errors.filter((e) => e.message.includes('FireDamageFactor'))).toEqual([]);
    });
});
