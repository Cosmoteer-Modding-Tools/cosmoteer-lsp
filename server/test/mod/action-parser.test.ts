import { describe, expect, it } from 'vitest';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { parseModActions } from '../../src/mod/action-parser';
import { Action } from '../../src/mod/action';

const parseActions = (src: string): Action[] => parseModActions(parser(lexer(src), 'file:///mod.rules').value);

// Shapes mirror cosmoteer Standard Mods/example_mod/mod.rules. Fields are on separate
// lines because the lexer treats spaces as part of a VALUE token (real .rules files do this).
const ALL_VERBS = `
ID = author.mod
Actions
[
	{
		Action = Add
		AddTo = "<a.rules>/List"
		Name = Density
		ToAdd = 3.0
		OnlyIfNotExisting = true
	}
	{
		Action = AddMany
		AddTo = "<a.rules>/List"
		ManyToAdd
		[
			&<x.rules>/Part
			&<y.rules>/Part
		]
	}
	{
		Action = Overrides
		OverrideIn = "<a.rules>/Group"
		Overrides
		{
			Foo = 1
		}
	}
	{
		Action = Replace
		Replace = "<modes/career/career.rules>/EconDifficultyLevels/1/StartingMoney"
		With = 200000
	}
	{
		Action = Remove
		Remove = "<a.rules>/Old"
		IgnoreIfNotExisting = true
	}
	{
		Action = RemoveMany
		RemoveMany
		[
			"<a.rules>/A"
			"<b.rules>/B"
			"<c.rules>/C"
		]
	}
	{
		Action = AddBase
		AddBaseTo = "<a.rules>/Comp"
		BaseToAdd = &<base.rules>
	}
]
`;

describe('parseModActions', () => {
    it('returns [] when there is no Actions list', () => {
        expect(parseActions('ID = author.mod\nName = "X"\n')).toEqual([]);
    });

    it('parses all seven verbs with the correct type', () => {
        const actions = parseActions(ALL_VERBS);
        expect(actions.map((a) => a.type)).toEqual([
            'Add',
            'AddMany',
            'Overrides',
            'Replace',
            'Remove',
            'RemoveMany',
            'AddBase',
        ]);
    });

    it('captures the Replace target path verbatim and its source', () => {
        const replace = parseActions(ALL_VERBS).find((a) => a.type === 'Replace')!;
        expect(replace.targets).toHaveLength(1);
        expect(String(replace.targets[0].valueType.value)).toBe(
            '<modes/career/career.rules>/EconDifficultyLevels/1/StartingMoney'
        );
        expect(replace.sources).toHaveLength(1);
    });

    it('expands RemoveMany into one target node per list element', () => {
        const removeMany = parseActions(ALL_VERBS).find((a) => a.type === 'RemoveMany')!;
        expect(removeMany.targets.map((t) => String(t.valueType.value))).toEqual([
            '<a.rules>/A',
            '<b.rules>/B',
            '<c.rules>/C',
        ]);
    });

    it('captures Add Name, flags, and the inline/list sources', () => {
        const actions = parseActions(ALL_VERBS);
        const add = actions.find((a) => a.type === 'Add')!;
        expect(add.nameNode && String(add.nameNode.valueType.value)).toBe('Density');
        expect(add.flags.OnlyIfNotExisting).toBe(true);

        const addMany = actions.find((a) => a.type === 'AddMany')!;
        expect(addMany.sources).toHaveLength(1); // the ManyToAdd list node
        expect(addMany.sources[0].type).toBe('List');

        const overrides = actions.find((a) => a.type === 'Overrides')!;
        expect(overrides.sources[0].type).toBe('Group');

        const addBase = actions.find((a) => a.type === 'AddBase')!;
        expect(addBase.targets).toHaveLength(1);
        expect(addBase.sources).toHaveLength(1);
    });

    it('marks an unknown verb as Unknown but keeps its text', () => {
        const [action] = parseActions('Actions\n[\n\t{\n\t\tAction = Frobnicate\n\t\tFoo = 1\n\t}\n]\n');
        expect(action.type).toBe('Unknown');
        expect(action.verbText).toBe('Frobnicate');
        expect(action.presentFields.has('Foo')).toBe(true);
    });
});
