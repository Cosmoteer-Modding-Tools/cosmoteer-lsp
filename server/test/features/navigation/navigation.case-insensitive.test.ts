import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { FullNavigationStrategy } from '../../../src/features/navigation/full.navigation-strategy';
import { MentionIndex } from '../../../src/features/navigation/mention.index';
import { findNodeByIdentifier } from '../../../src/utils/ast.utils';
import { isAssignmentNode, isGroupNode, isValueNode } from '../../../src/core/ast/ast';
import { findReferenceNode, FIXTURES_DIR } from '../../helpers';

const nav = new FullNavigationStrategy();
const token = CancellationToken.None;
const parse = (src: string, uri = 'file:///t.rules') => parser(lexer(src), uri).value;

// The game resolves reference path segments through the same case-insensitive dictionary as field
// names (OTGroupNode._childrenByName, InvariantCultureIgnoreCase), so `&base/value` reaches a
// group written `Base { Value = 5 }` in game and every resolver here must match.
describe('reference navigation ignores case like the game', () => {
    const SRC = 'Base\n{\n\tValue = 5\n}\nUse = &base/value\n';

    it('resolves a case-mismatched in-file path', async () => {
        const doc = parse(SRC);
        const node = findReferenceNode(doc, '&base/value');
        const result = await nav.navigate(String(node.valueType.value), node, doc.uri, token);
        expect(result).toBeTruthy();
        expect(isValueNode(result as never) && (result as unknown as { valueType: { value: unknown } }).valueType.value).toBe(5);
    });

    it('prefers the exact-case member when two differ only by case', async () => {
        const doc = parse('foo = 1\nFoo = 2\nUse = &Foo\n');
        const node = findReferenceNode(doc, '&Foo');
        const result = await nav.navigate('&Foo', node, doc.uri, token);
        expect(isValueNode(result as never) && (result as unknown as { valueType: { value: unknown } }).valueType.value).toBe(2);
    });
});

describe('findNodeByIdentifier ignores case with exact preference', () => {
    it('finds a group member written in a different case', () => {
        const doc = parse('Base\n{\n\tValue = 5\n}\n');
        const base = findNodeByIdentifier(doc, 'base');
        expect(base && isGroupNode(base)).toBe(true);
        const value = findNodeByIdentifier(base!, 'VALUE');
        expect(value && isAssignmentNode(value)).toBe(true);
    });

    it('prefers the exact-case member and keeps numeric list indexing', () => {
        const doc = parse('foo = 1\nFoo = 2\nList\n[\n\t7\n\t8\n]\n');
        const exact = findNodeByIdentifier(doc, 'Foo');
        expect(exact && isAssignmentNode(exact) && exact.left.name).toBe('Foo');
        const list = findNodeByIdentifier(doc, 'list')!;
        const second = findNodeByIdentifier(list, '1');
        expect(second && isValueNode(second) && second.valueType.value).toBe(8);
    });
});

describe('MentionIndex candidate matching ignores case', () => {
    it('returns a file whose mention differs in case from the searched name', async () => {
        // reachability-mod/orphan/dead.rules contains `Dead = 1`; search the upper-cased name.
        const folder = join(FIXTURES_DIR, 'reachability-mod');
        const paths = await MentionIndex.instance.candidateFiles('DEAD', [folder], token);
        expect(paths).toBeDefined();
        expect(paths!.some((p) => p.replace(/\\/g, '/').endsWith('orphan/dead.rules'))).toBe(true);
    });
});
