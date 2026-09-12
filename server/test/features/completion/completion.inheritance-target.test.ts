import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { inheritanceTargetCompletionsAt } from '../../../src/features/completion/autocompletion.inheritance-target';
import { Completion } from '../../../src/features/completion/autocompletion.service';

const labels = (cs: Completion[] | undefined): string[] =>
    (cs ?? []).map((c) => (typeof c === 'string' ? c : c.label));

/** Run the completer at the offset right after `marker` (its first occurrence), passing the line
 *  prefix and the cursor position up to that offset the way the server does. */
const completeAfter = async (src: string, marker: string): Promise<Completion[] | undefined> => {
    const document = parser(lexer(src), 'file:///part.rules').value;
    const offset = src.indexOf(marker) + marker.length;
    const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
    const head = src.slice(0, offset);
    const position = { line: (head.match(/\n/g) ?? []).length, character: offset - lineStart };
    return inheritanceTargetCompletionsAt(
        document,
        offset,
        src.slice(lineStart, offset),
        position,
        CancellationToken.None
    );
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
    it('offers the sibling component ids and the reference-path prefixes at the empty base slot', async () => {
        const names = labels(await completeAfter(COMPONENTS, 'Penetrator : '));
        expect(names).toContain('Hit');
        expect(names).toContain('HitPool');
        expect(names).toContain('/');
        expect(names).toContain('<./Data/');
        expect(names).toContain('&<');
        // The component being declared is never offered as its own base.
        expect(names).not.toContain('Penetrator');
    });

    it('still offers the siblings after a lone `^` (which is not a reference value node)', async () => {
        const src = COMPONENTS.replace('Penetrator : \t', 'Penetrator : ^');
        const names = labels(await completeAfter(src, 'Penetrator : ^'));
        expect(names).toContain('Hit');
        expect(names).toContain('HitPool');
    });

    it('replaces the lone `^` rather than appending the caret path to it', async () => {
        const src = COMPONENTS.replace('Penetrator : \t', 'Penetrator : ^');
        const caretPath = (await completeAfter(src, 'Penetrator : ^'))?.find(
            (c) => typeof c !== 'string' && c.label === '/'
        );
        expect(caretPath).toBeDefined();
        const range = typeof caretPath === 'string' ? undefined : caretPath?.range;
        expect(range?.end.character).toBe(range!.start.character + 1);
    });

    it('offers the siblings for a half-typed name instead of the schema field names', async () => {
        const src = COMPONENTS.replace('Penetrator : \t', 'Penetrator : H');
        const names = labels(await completeAfter(src, 'Penetrator : H'));
        expect(names).toContain('Hit');
        expect(names).toContain('HitPool');
    });

    it('walks a typed path through the container', async () => {
        const src = COMPONENTS.replace('Penetrator : \t', 'Penetrator : Hit/');
        const names = labels(await completeAfter(src, 'Penetrator : Hit/'));
        expect(names).toEqual(['Type']);
    });

    it('is not triggered by a plain `Key = value` assignment line', async () => {
        const src = `
Part
{
    Health = \t
}
`;
        expect(await completeAfter(src, 'Health = ')).toBeUndefined();
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
    it('offers a `^/N/` caret path per base of the enclosing container', async () => {
        const names = labels(await completeAfter(NESTED, 'Sub : '));
        expect(names).toContain('^/0/');
    });
});

describe('inheritance-target completion without a body', () => {
    // The parser keeps a header whose braces are not written yet, so the base path has to complete
    // there as well: that is the state every inheriting member passes through while being typed.
    const BODYLESS = `
Part
{
    ID = test.part
    Components
    {
        Hit
        {
            Type = Targetable
        }
    }
    Foo : \t
    MaxHealth = 3000
}
`;
    it('offers the siblings at an empty base slot with no body written yet', async () => {
        const names = labels(await completeAfter(BODYLESS, 'Foo : '));
        expect(names).toContain('Components');
        expect(names).toContain('ID');
        expect(names).not.toContain('Foo');
    });

    it('walks a typed path with no body written yet', async () => {
        const src = BODYLESS.replace('Foo : \t', 'Foo : Components/');
        const names = labels(await completeAfter(src, 'Foo : Components/'));
        expect(names).toEqual(['Hit']);
    });

    it('completes a header at the file top level against the document', async () => {
        const src = 'Base\n{\n\tX = 1\n}\nDerived : \t\n';
        const names = labels(await completeAfter(src, 'Derived : '));
        expect(names).toContain('Base');
    });
});
