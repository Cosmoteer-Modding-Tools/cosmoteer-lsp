import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { ReferenceAutoCompletionStrategy } from '../../../src/features/completion/strategy/reference.autocompletion-strategy';
import { AbstractNode, AbstractNodeDocument, ValueNode } from '../../../src/core/ast/ast';
import { Completion } from '../../../src/features/completion/autocompletion.service';

// The game reads a node as the union of its own members and the ones its bases supply, so a
// reference path walking into such a node has to offer both. A Star Wars part whose `Components`
// block inherits nearly everything used to complete to nothing on a path that validated clean.
const strategy = new ReferenceAutoCompletionStrategy();
const token = CancellationToken.None;
const pos = { line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 };

const SRC = `Base
{
	Inner
	{
		FromBase = 1
	}
	OnlyOnBase = 2
}
Middle : Base
{
	OnlyOnMiddle = 3
}
Derived : Middle
{
	Inner : ^/0/Inner
	{
		FromDerived = 4
	}
}
`;

const parse = (): AbstractNodeDocument => parser(lexer(SRC), 'file:///inheritance-path.rules').value;

const refNode = (value: string, parent: AbstractNode): ValueNode => ({
    type: 'Value',
    valueType: { type: 'Reference', value },
    position: pos,
    parent: parent as ValueNode['parent'],
});

const labels = (options: Completion[]): string[] =>
    options.map((option) => (typeof option === 'string' ? option : option.label));

const complete = async (value: string): Promise<Completion[]> => {
    const document = parse();
    return strategy.complete({
        node: refNode(value, document),
        isInheritanceNode: false,
        cancellationToken: token,
    });
};

describe('reference-path completion through inheritance', () => {
    it('offers the members the whole chain supplies, not only the node`s own', async () => {
        const names = labels(await complete('&Derived/'));
        expect(names).toContain('Inner');
        expect(names).toContain('OnlyOnMiddle');
        expect(names).toContain('OnlyOnBase');
    });

    it('marks an inherited member with the file it comes from', async () => {
        const inherited = (await complete('&Derived/')).find(
            (option) => typeof option !== 'string' && option.label === 'OnlyOnBase'
        );
        expect(typeof inherited === 'string' ? undefined : inherited?.detail).toContain('inherited from');
    });

    it('offers a member the node redeclares as its own rather than as inherited', async () => {
        const own = (await complete('&Derived/')).find(
            (option) => typeof option !== 'string' && option.label === 'Inner'
        );
        expect(own === undefined || typeof own === 'string').toBe(true);
    });

    it('walks a segment that resolves only through the chain', async () => {
        const names = labels(await complete('&Middle/Inner/'));
        expect(names).toContain('FromBase');
    });

    it('lists both levels of a member that overrides an inherited one', async () => {
        const names = labels(await complete('&Derived/Inner/'));
        expect(names).toContain('FromDerived');
        expect(names).toContain('FromBase');
    });

    it('answers nothing for a path whose middle segment names nothing', async () => {
        expect(await complete('&Base/NotThere/')).toEqual([]);
    });
});
