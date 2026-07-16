import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateInheritanceCycles } from '../../../src/features/diagnostics/validator.inheritance-cycle';
import { parseFixture } from '../../helpers';

const token = CancellationToken.None;
const cycles = (src: string) => validateInheritanceCycles(parser(lexer(src), 'file:///c.rules').value, token);

describe('circular inheritance diagnostics', () => {
    it('flags a direct two-group cycle once', async () => {
        const errors = await cycles('A : &B\n{\n\tOwnA = 1\n}\nB : &A\n{\n\tOwnB = 2\n}\n');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Circular inheritance');
        expect(errors[0].additionalInfo).toContain('refers back to itself');
    });

    it('flags a group that inherits from itself', async () => {
        const errors = await cycles('A : &A\n{\n\tX = 1\n}\n');
        expect(errors).toHaveLength(1);
    });

    it('flags a longer cycle once (A → B → C → A)', async () => {
        const errors = await cycles('A : &B\n{\n}\nB : &C\n{\n}\nC : &A\n{\n}\n');
        expect(errors).toHaveLength(1);
    });

    it('does not flag a valid linear inheritance chain', async () => {
        expect(await cycles('Base\n{\n\tX = 1\n}\nChild : &Base\n{\n}\n')).toEqual([]);
    });

    it('does not flag a diamond (same base reached by two paths)', async () => {
        expect(await cycles('Base\n{\n}\nL : &Base\n{\n}\nR : &Base\n{\n}\n')).toEqual([]);
    });

    it('does not crash or false-positive on a benign member-path loop whose member is missing', async () => {
        // `&CycleB/Shared` resolves to nothing (Shared is undefined), so there is no concrete
        // group edge to loop on. The resolver already returns null and we must stay quiet here.
        const doc = parseFixture('inheritance-cycle.rules');
        expect(await validateInheritanceCycles(doc, token)).toEqual([]);
    });
});
