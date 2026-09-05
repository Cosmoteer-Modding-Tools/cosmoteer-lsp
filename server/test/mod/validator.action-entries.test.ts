import { describe, expect, it } from 'vitest';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { findActionsList } from '../../src/mod/action-parser';
import { validateActionEntries } from '../../src/features/diagnostics/validator.mod-action';

const MANIFEST_URI = 'file:///c%3A/mod/mod.rules';
const HEAD = 'ID = author.mod\nName = Mod\n';

const check = (src: string) =>
    validateActionEntries(findActionsList(parser(lexer(HEAD + src), MANIFEST_URI).value));

describe('mod action entry shapes', () => {
    it('accepts entries written as their own group', () => {
        expect(
            check('Actions\n[\n\t{ Action = Remove\n\t  Remove = "<a.rules>/X" }\n\t{ Action = Remove\n\t  Remove = "<a.rules>/Y" }\n]\n')
        ).toHaveLength(0);
    });

    it('flags an action written without its braces', () => {
        const errors = check('Actions\n[\n\tAction = Add\n\tAddTo = "<a.rules>/L"\n\tToAdd = &<b.rules>/Y\n]\n');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('Mod action entry is not a group');
        expect(errors[0].additionalInfo).toContain('dropped with a load error');
    });

    it('reports one finding per unbraced action rather than one per loose field', () => {
        const errors = check(
            'Actions\n[\n\tAction = Remove\n\tRemove = "<a.rules>/X"\n\t{ Action = Remove\n\t  Remove = "<a.rules>/Y" }\n\tAction = Remove\n\tRemove = "<a.rules>/Z"\n]\n'
        );
        expect(errors).toHaveLength(2);
    });

    it('flags a plain value entry', () => {
        expect(check('Actions\n[\n\tsomething\n]\n')).toHaveLength(1);
    });

    it('flags a list entry', () => {
        expect(check('Actions\n[\n\t[ 1, 2 ]\n]\n')).toHaveLength(1);
    });

    it('leaves a reference entry alone, since it stands for the group it points at', () => {
        expect(check('Actions\n[\n\t&<fragment.rules>/SomeAction\n]\n')).toHaveLength(0);
    });

    it('reports nothing for a file that declares no actions list', () => {
        expect(check('Description = none\n')).toHaveLength(0);
    });
});
