import { describe, expect, it } from 'vitest';
import { Position } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { isValueNode } from '../../src/core/ast/ast';
import { findNodeAtPosition } from '../../src/utils/ast.utils';

const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;

// Regression: a group's inheritance references were only visited from inside its member loop, so
// an inheriting group with an EMPTY body (`Components : ^/0/Components { }`, common in real mods)
// hid its inheritance reference from every position-based feature (go-to-definition foremost).
describe('findNodeAtPosition: inheritance references of empty containers', () => {
    it('finds the inheritance reference of an empty block-bodied group', () => {
        const src = 'Part\n{\n\tComponents : ^/0/Components\n\t{\n\n\t}\n}';
        // Cursor inside the trailing `Components` of the reference on line 2.
        const node = findNodeAtPosition(parse(src), Position.create(2, 21));
        expect(node && isValueNode(node) && node.valueType.type === 'Reference').toBe(true);
        expect(String((node as any).valueType.value)).toBe('^/0/Components');
    });

    it('finds the inheritance reference of an empty inline group', () => {
        const src = 'Part\n{\n\tDamageResistances : ^/0/DamageResistances {}\n}';
        const node = findNodeAtPosition(parse(src), Position.create(2, 30));
        expect(node && isValueNode(node) && node.valueType.type === 'Reference').toBe(true);
        expect(String((node as any).valueType.value)).toBe('^/0/DamageResistances');
    });

    it('finds the inheritance reference of an empty list', () => {
        const src = 'Part\n{\n\tReceivableBuffs : ^/0/ReceivableBuffs []\n}';
        const node = findNodeAtPosition(parse(src), Position.create(2, 25));
        expect(node && isValueNode(node) && node.valueType.type === 'Reference').toBe(true);
        expect(String((node as any).valueType.value)).toBe('^/0/ReceivableBuffs');
    });

    it('still finds a member inside a non-empty inheriting group', () => {
        const src = 'Part\n{\n\tComponents : ^/0/Components\n\t{\n\t\tX = &Y\n\t}\n}';
        const node = findNodeAtPosition(parse(src), Position.create(4, 7));
        expect(node && isValueNode(node) && node.valueType.type === 'Reference').toBe(true);
        expect(String((node as any).valueType.value)).toBe('&Y');
    });
});
