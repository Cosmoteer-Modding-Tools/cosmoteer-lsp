import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, GroupNode, ListNode, isGroupNode, isListNode, isValueNode } from '../../src/core/ast/ast';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { EffectiveListEntry, flattenGroup, flattenList, flattenListMember } from '../../src/semantics/effective-group';
import { walkAst } from '../helpers';
import { initWorkspace, workspaceFile } from '../workspace-helper';
import { readFileSync } from 'fs';
import { filePathToUri } from '../../src/features/navigation/navigation-strategy';

const token = CancellationToken.None;

/** Parses an inline source under a throwaway uri. */
const parse = (source: string): AbstractNodeDocument => parser(lexer(source), 'file:///inline.rules').value;

/** Parses a fixture file under its real uri, so its cross-file references resolve. */
const parseFixture = (...segments: string[]): AbstractNodeDocument => {
    const path = workspaceFile(...segments);
    return parser(lexer(readFileSync(path, 'utf8')), filePathToUri(path)).value;
};

/** The first group with the given identifier. */
const group = (doc: AbstractNodeDocument, name: string): GroupNode => {
    for (const node of walkAst(doc)) if (isGroupNode(node) && node.identifier?.name === name) return node;
    throw new Error(`group ${name} not found`);
};

/** The first list with the given identifier. */
const list = (doc: AbstractNodeDocument, name: string): ListNode => {
    for (const node of walkAst(doc)) if (isListNode(node) && node.identifier?.name === name) return node;
    throw new Error(`list ${name} not found`);
};

/** The effective member names, in the order the game would enumerate them. */
const namesOf = async (node: GroupNode): Promise<string[]> =>
    (await flattenGroup(node, token)).members.map((member) => member.name);

/** The written text of every entry of a flattened list. */
const entryValues = (entries: ReadonlyArray<EffectiveListEntry>): unknown[] =>
    entries.map((entry) => (isValueNode(entry.value) ? entry.value.valueType.value : undefined));

// The engine reproduces what Halfling.ObjectText does at read time, so each test names the rule it
// pins rather than the shape of our own output.
describe('effective group flattening', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('puts inherited members before local ones, as the game enumerates them', async () => {
        const doc = parse(['Base', '{', '\tA = 1', '\tB = 2', '}', 'Derived : &Base', '{', '\tC = 3', '}', ''].join('\n'));
        expect(await namesOf(group(doc, 'Derived'))).toEqual(['A', 'B', 'C']);
    });

    it('lets a local declaration shadow the inherited one and records what it hid', async () => {
        const doc = parse(['Base', '{', '\tA = 1', '\tB = 2', '}', 'Derived : &Base', '{', '\tB = 9', '}', ''].join('\n'));
        const flattened = await flattenGroup(group(doc, 'Derived'), token);
        // The shadowed member does not appear twice: the game yields the inherited set minus every
        // name the deriving level declares.
        expect(flattened.members.map((member) => member.name)).toEqual(['A', 'B']);
        const b = flattened.members.find((member) => member.name === 'B')!;
        expect(b.origin.inherited).toBe(false);
        expect(b.shadows).toHaveLength(1);
        expect(b.shadows[0].inherited).toBe(true);
    });

    it('reads multiple bases in written order, the first declaring a name winning', async () => {
        const doc = parse(
            ['One', '{', '\tX = 1', '}', 'Two', '{', '\tX = 2', '\tY = 2', '}', 'Derived : &One, &Two', '{', '}', ''].join(
                '\n'
            )
        );
        const flattened = await flattenGroup(group(doc, 'Derived'), token);
        expect(flattened.members.map((member) => member.name)).toEqual(['X', 'Y']);
        // `Two` also declares X, which the first base already supplied.
        expect(flattened.members.find((member) => member.name === 'X')!.shadows).toHaveLength(1);
    });

    it('matches member names case-insensitively, like the game keys its children', async () => {
        const doc = parse(['Base', '{', '\tvalue = 1', '}', 'Derived : &Base', '{', '\tValue = 2', '}', ''].join('\n'));
        const flattened = await flattenGroup(group(doc, 'Derived'), token);
        expect(flattened.members.map((member) => member.name)).toEqual(['Value']);
        expect(flattened.members[0].shadows).toHaveLength(1);
    });

    it('flattens a whole-file base into the inheriting group', async () => {
        const doc = parseFixture('whole_file_consumer.rules');
        const names = await namesOf(group(doc, 'WFComp'));
        expect(names).toContain('WFRootLeaf');
        expect(names).toContain('WFRootGroup');
        expect(names).toContain('UsesRoot');
    });

    it('follows a cross-file caret base', async () => {
        const doc = parseFixture('parts', 'derived_part.rules');
        const flattened = await flattenGroup(group(doc, 'IsOperational'), token);
        expect(flattened.complete).toBe(true);
        const names = flattened.members.map((member) => member.name);
        // Type comes from the base file, Mode is overridden locally.
        expect(names).toEqual(['Type', 'Mode']);
        expect(flattened.members.find((member) => member.name === 'Type')!.origin.inherited).toBe(true);
        expect(flattened.members.find((member) => member.name === 'Mode')!.origin.inherited).toBe(false);
    });

    it('reports an unresolved base instead of presenting a partial chain as whole', async () => {
        const doc = parse(['Derived : &NoSuchBase', '{', '\tA = 1', '}', ''].join('\n'));
        const flattened = await flattenGroup(group(doc, 'Derived'), token);
        expect(flattened.complete).toBe(false);
        expect(flattened.unreadable).toHaveLength(1);
        expect(flattened.unreadable[0].reason).toBe('unresolved');
        expect(flattened.unreadable[0].reference).toBe('&NoSuchBase');
        // What it could read is still returned, so a view can show it as partial.
        expect(flattened.members.map((member) => member.name)).toEqual(['A']);
    });

    it('reports a base of the wrong kind, which the game refuses outright', async () => {
        const doc = parse(['Other', '[', '\t1', ']', 'Derived : &Other', '{', '\tA = 1', '}', ''].join('\n'));
        const flattened = await flattenGroup(group(doc, 'Derived'), token);
        expect(flattened.complete).toBe(false);
        expect(flattened.unreadable[0].reason).toBe('wrong-kind');
    });

    it('terminates on a self-inheriting chain and reports the cycle', async () => {
        const doc = parse(['A : &B', '{', '\tX = 1', '}', 'B : &A', '{', '\tY = 2', '}', ''].join('\n'));
        const flattened = await flattenGroup(group(doc, 'A'), token);
        expect(flattened.complete).toBe(false);
        expect(flattened.unreadable.some((base) => base.reason === 'cycle')).toBe(true);
        expect(flattened.members.map((member) => member.name)).toEqual(['Y', 'X']);
    });
});

// The list rule is the one the rest of the codebase records as undecidable: a list merges only when
// it declares an inheritance reference of its own.
describe('effective list flattening', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('prepends the base entries when the list inherits', async () => {
        const doc = parse(
            ['Base', '{', '\tItems', '\t[', '\t\tA', '\t\tB', '\t]', '}', 'Derived : &Base', '{', '\tItems : ^/0/Items', '\t[', '\t\tC', '\t]', '}', ''].join('\n')
        );
        const flattened = await flattenListMember(group(doc, 'Derived'), 'Items', token);
        expect(flattened!.complete).toBe(true);
        expect(flattened!.inherits).toBe(true);
        expect(entryValues(flattened!.entries)).toEqual(['A', 'B', 'C']);
    });

    it('replaces the base entries when the list declares no inheritance', async () => {
        const doc = parse(
            ['Base', '{', '\tItems', '\t[', '\t\tA', '\t\tB', '\t]', '}', 'Derived : &Base', '{', '\tItems', '\t[', '\t\tC', '\t]', '}', ''].join('\n')
        );
        const flattened = await flattenListMember(group(doc, 'Derived'), 'Items', token);
        expect(flattened!.inherits).toBe(false);
        expect(entryValues(flattened!.entries)).toEqual(['C']);
    });

    it('reads a list the deriving group never mentions straight off the base', async () => {
        const doc = parse(['Base', '{', '\tItems', '\t[', '\t\tA', '\t]', '}', 'Derived : &Base', '{', '}', ''].join('\n'));
        const flattened = await flattenListMember(group(doc, 'Derived'), 'Items', token);
        expect(entryValues(flattened!.entries)).toEqual(['A']);
    });

    it('answers null for a member no hop of the chain declares', async () => {
        const doc = parse(['Base', '{', '\tItems', '\t[', '\t\tA', '\t]', '}', 'Derived : &Base', '{', '}', ''].join('\n'));
        expect(await flattenListMember(group(doc, 'Derived'), 'Absent', token)).toBeNull();
    });

    it('answers an incomplete result, not null, when the chain itself could not be read', async () => {
        const doc = parse(['Derived : &NoSuchBase', '{', '}', ''].join('\n'));
        const flattened = await flattenListMember(group(doc, 'Derived'), 'Items', token);
        // An absent member and an unreadable chain must never look the same to a diagnostic.
        expect(flattened).not.toBeNull();
        expect(flattened!.complete).toBe(false);
    });

    it('folds a chain of inheriting lists farthest base first', async () => {
        const doc = parse(
            [
                'Root',
                '{',
                '\tItems',
                '\t[',
                '\t\tA',
                '\t]',
                '}',
                'Middle : &Root',
                '{',
                '\tItems : ^/0/Items',
                '\t[',
                '\t\tB',
                '\t]',
                '}',
                'Leaf : &Middle',
                '{',
                '\tItems : ^/0/Items',
                '\t[',
                '\t\tC',
                '\t]',
                '}',
                '',
            ].join('\n')
        );
        const flattened = await flattenListMember(group(doc, 'Leaf'), 'Items', token);
        expect(entryValues(flattened!.entries)).toEqual(['A', 'B', 'C']);
    });

    it('flattens a list node directly', async () => {
        const doc = parse(
            ['Base', '{', '\tItems', '\t[', '\t\tA', '\t]', '}', 'Derived : &Base', '{', '\tItems : ^/0/Items', '\t[', '\t\tB', '\t]', '}', ''].join('\n')
        );
        const derived = group(doc, 'Derived');
        const items = derived.elements.find((element) => isListNode(element)) as ListNode;
        expect(entryValues((await flattenList(items, token)).entries)).toEqual(['A', 'B']);
        // The base's own list, read on its own, is just its own entries.
        expect(entryValues((await flattenList(list(doc, 'Items'), token)).entries)).toEqual(['A']);
    });
});
