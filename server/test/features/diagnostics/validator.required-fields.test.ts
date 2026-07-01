import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateRequiredFields } from '../../../src/features/diagnostics/validator.required-fields';

const token = CancellationToken.None;
const parse = (src: string, uri = 'file:///t.rules') => parser(lexer(src), uri).value;

// A `Components` group dispatched to PartMultiToggleRules, whose only required field is `Mode`.
const toggle = (body: string) =>
    `Part\n{\n\tComponents\n\t{\n\t\tX\n\t\t{\n\t\t\tType = MultiToggle\n${body}\n\t\t}\n\t}\n}`;

describe('validateRequiredFields', () => {
    it('flags a group missing its required field', async () => {
        const errors = await validateRequiredFields(parse(toggle('')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Mode');
        expect(errors[0].message).toContain('PartMultiToggleRules');
        expect(errors[0].severity).toBe('warning');
    });

    it('does not flag when the required field is present', async () => {
        expect(await validateRequiredFields(parse(toggle('\t\t\tMode = All')), token)).toHaveLength(0);
    });

    it('does not flag when the required field is inherited from a resolvable base', async () => {
        const src =
            'Part\n{\n\tComponents\n\t{\n' +
            '\t\tBase\n\t\t{\n\t\t\tType = MultiToggle\n\t\t\tMode = All\n\t\t}\n' +
            '\t\tDerived : &Base\n\t\t{\n\t\t\tType = MultiToggle\n\t\t}\n' +
            '\t}\n}';
        expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
    });

    it('stays silent when an inheritance base cannot be resolved (no false positive)', async () => {
        // Mode is absent here, but the unresolved base might supply it — so the group is skipped.
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tX : &NoSuchBase\n\t\t{\n\t\t\tType = MultiToggle\n\t\t}\n\t}\n}';
        expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
    });

    it('does not flag a template base that another group inherits from (even if it lacks the field)', async () => {
        // BASE_TOGGLE omits Mode but is a template completed by Real, so it must not be flagged.
        const src =
            'Part\n{\n\tComponents\n\t{\n' +
            '\t\tBASE_TOGGLE\n\t\t{\n\t\t\tType = MultiToggle\n\t\t}\n' +
            '\t\tReal : &BASE_TOGGLE\n\t\t{\n\t\t\tType = MultiToggle\n\t\t\tMode = All\n\t\t}\n' +
            '\t}\n}';
        expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
    });

    it('does not flag a group named as a base in the workspace index (cross-file template)', async () => {
        // X has its own Type and lacks Mode, but the project index says its name is an inheritance base.
        const doc = parse(toggle(''));
        const groupName = 'X';
        expect(await validateRequiredFields(doc, token, new Set([groupName]))).toHaveLength(0);
        // Without the index entry it IS flagged (sanity that the set is what suppresses it).
        expect(await validateRequiredFields(doc, token, new Set())).toHaveLength(1);
    });

    it('does not flag a group inheriting from a `~`-rooted runtime template', async () => {
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tX : ~/LIB/TOGGLE\n\t\t{\n\t\t\tType = MultiToggle\n\t\t}\n\t}\n}';
        expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
    });

    it('does not flag groups whose class cannot be resolved', async () => {
        const src = 'Foo\n{\n\tBar\n\t{\n\t\tBaz = 1\n\t}\n}';
        expect(await validateRequiredFields(parse(src), token)).toHaveLength(0);
    });

    it('ignores mod.rules documents', async () => {
        expect(await validateRequiredFields(parse(toggle(''), 'file:///mod.rules'), token)).toHaveLength(0);
    });
});
