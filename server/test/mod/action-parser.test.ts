import { describe, expect, it } from 'vitest';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { isActionFragmentDocument, parseModActions } from '../../src/mod/action-parser';
import { Action, isActionEntryGroup, isActionTargetValueNode } from '../../src/mod/action';
import { AbstractNodeDocument, AssignmentNode, isGroupNode } from '../../src/core/ast/ast';

const parseDoc = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///mod.rules').value;
const parseActions = (src: string): Action[] => parseModActions(parseDoc(src));

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
        expect(action.presentFields.has('foo')).toBe(true);
    });

    it('recognizes an included action fragment file (root Actions list of action entries)', () => {
        // launcher.rules / register.rules shape: a non-manifest file whose top-level `Actions`
        // list holds `{ Action = … }` entries, concatenated into a manifest via `&<file>/Actions`.
        expect(isActionFragmentDocument(parseDoc(ALL_VERBS))).toBe(true);
        // A file with no Actions list is not a fragment.
        expect(isActionFragmentDocument(parseDoc('ID = x\nFoo = 1\n'))).toBe(false);
        // An `Actions` list whose members carry no `Action` field is not an action fragment.
        expect(isActionFragmentDocument(parseDoc('Actions\n[\n\t{\n\t\tFoo = 1\n\t}\n]\n'))).toBe(false);
    });

    it('identifies action target value nodes anywhere an action lives', () => {
        // Every parsed target sits in a real action entry, so it is an action target.
        for (const action of parseActions(ALL_VERBS)) {
            for (const target of action.targets) expect(isActionTargetValueNode(target)).toBe(true);
        }
    });

    it('does not treat a target-named field OUTSIDE an action entry as an action target', () => {
        // A group with `AddTo = …` but no `Action` field, not inside an Actions list, must not be
        // exempted from the generic reference checks.
        const doc = parseDoc('Root\n{\n\tAddTo = "<a.rules>/X"\n}\n');
        const root = doc.elements.find(isGroupNode)!;
        expect(isActionEntryGroup(root)).toBe(false);
        const addTo = root.elements.find((e): e is AssignmentNode => e.type === 'Assignment' && e.left.name === 'AddTo')!;
        expect(isActionTargetValueNode(addTo.right)).toBe(false);
    });

    it('matches the Actions list and field names case-insensitively like the game', () => {
        // Seen in a published mod (Feuerhai's Coilgun Tech): lowercase `actions`. The game keys
        // node children with InvariantCultureIgnoreCase, so this loads fine in game.
        const lowercase = `
ID = author.mod
actions
[
	{
		action = AddMany
		addto = "<ships/terran/terran.rules>/Terran/Parts"
		manytoadd
		[
			&<Parts/coilgun/coilgun.rules>/Part
		]
	}
]
`;
        const [action] = parseActions(lowercase);
        expect(action.type).toBe('AddMany');
        expect(action.targets.map((t) => String(t.valueType.value))).toEqual(['<ships/terran/terran.rules>/Terran/Parts']);
        expect(action.sources).toHaveLength(1);
    });
});
