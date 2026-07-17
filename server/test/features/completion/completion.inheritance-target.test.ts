import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { inheritanceTargetCompletions } from '../../../src/features/completion/autocompletion.inheritance-target';
import { Completion } from '../../../src/features/completion/autocompletion.service';

const labels = (cs: Completion[] | undefined): string[] =>
    (cs ?? []).map((c) => (typeof c === 'string' ? c : c.label));

/** Run the completer at the offset right after `marker` (its first occurrence), passing the line
 *  prefix up to that offset the way the server does. */
const completeAfter = (src: string, marker: string): Completion[] | undefined => {
    const document = parser(lexer(src), 'file:///part.rules').value;
    const offset = src.indexOf(marker) + marker.length;
    const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
    return inheritanceTargetCompletions(document, offset, src.slice(lineStart, offset));
};

// A Components map with two declared components and a third that is being written with an
// inheritance base (`Penetrator : `), the cursor sitting right after the colon.
const COMPONENTS = `
Part
{
    Components
    {
        Hit
        {
            Type = Targetable
        }
        HitPool
        {
            Type = DamagePool
        }
        Penetrator : \t
        {
        }
    }
}
`;

describe('inheritance-target completion in a Components map', () => {
    it('offers the sibling component ids and the reference-path prefixes at the empty base slot', () => {
        const names = labels(completeAfter(COMPONENTS, 'Penetrator : '));
        expect(names).toContain('Hit');
        expect(names).toContain('HitPool');
        expect(names).toContain('/');
        expect(names).toContain('<./Data/');
        // The component being declared is never offered as its own base.
        expect(names).not.toContain('Penetrator');
    });

    it('still offers the siblings after a lone `^` (which is not a reference value node)', () => {
        const src = COMPONENTS.replace('Penetrator : \t', 'Penetrator : ^');
        const names = labels(completeAfter(src, 'Penetrator : ^'));
        expect(names).toContain('Hit');
        expect(names).toContain('HitPool');
    });

    it('defers to the reference completer once a real name character is typed', () => {
        const src = COMPONENTS.replace('Penetrator : \t', 'Penetrator : H');
        expect(completeAfter(src, 'Penetrator : H')).toBeUndefined();
    });

    it('defers once a path separator is present', () => {
        const src = COMPONENTS.replace('Penetrator : \t', 'Penetrator : ^/');
        expect(completeAfter(src, 'Penetrator : ^/')).toBeUndefined();
    });

    it('is not triggered by a plain `Key = value` assignment line', () => {
        const src = `
Part
{
    Health = \t
}
`;
        expect(completeAfter(src, 'Health = ')).toBeUndefined();
    });
});

describe('inheritance-target completion offers caret paths for a container that inherits', () => {
    // The enclosing container (`Weapon`) itself inherits a base, so `^/0/` reaches that base's
    // same-named member from the group being declared inside it.
    const NESTED = `
Part
{
    Weapon : /base/Weapon
    {
        Sub : \t
        {
        }
    }
}
`;
    it('offers a `^/N/` caret path per base of the enclosing container', () => {
        const names = labels(completeAfter(NESTED, 'Sub : '));
        expect(names).toContain('^/0/');
    });
});
