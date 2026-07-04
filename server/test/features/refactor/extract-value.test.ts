import { describe, expect, it } from 'vitest';
import { TextEdit } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { extractValueCodeAction } from '../../../src/features/refactor/extract-value';
import { AbstractNodeDocument, isValueNode, ValueNode } from '../../../src/core/ast/ast';
import { walkAst } from '../../helpers';

// The extract-repeated-value refactoring: hoist a literal appearing in several assignments to a
// shared `NAME = value` root field and replace every occurrence with `&~/NAME`, the
// single-source-of-truth idiom from the game's "Rules Syntax.md" best practices.
const URI = 'file:///extract.rules';

const parse = (src: string): AbstractNodeDocument => parser(lexer(src), URI).value;

const valueNodeOf = (doc: AbstractNodeDocument, value: number): ValueNode => {
    for (const node of walkAst(doc)) {
        if (isValueNode(node) && node.valueType.type === 'Number' && node.valueType.value === value) {
            return node;
        }
    }
    throw new Error(`No number value ${value}`);
};

// A suffixed number (`50%`) is parsed as a String value, so look it up by its literal text.
const literalNodeOf = (doc: AbstractNodeDocument, literal: string): ValueNode => {
    for (const node of walkAst(doc)) {
        if (isValueNode(node) && String(node.valueType.value) === literal) return node;
    }
    throw new Error(`No value ${literal} in document`);
};

const actionAt = (src: string, node: ValueNode) =>
    extractValueCodeAction(parse(src), src, { line: node.position.line, character: node.position.characterStart }, URI);

describe('extractValueCodeAction', () => {
    const src = 'Header = 1\nPart\n{\n\tMaxHealth = 12000\n\tSub\n\t{\n\t\tHealth = 12000\n\t}\n}\n';

    it('offers the extraction on a value repeated in two nested assignments', () => {
        const doc = parse(src);
        const action = actionAt(src, valueNodeOf(doc, 12000));
        expect(action).toBeDefined();
        const edits = action!.edit!.changes![URI] as TextEdit[];
        expect(edits).toHaveLength(3); // 1 insert + 2 replacements
        expect(edits[0].newText).toBe('MAX_HEALTH = 12000\n');
        expect(edits[0].range.start).toEqual({ line: 0, character: 0 }); // above the first root element
        expect(edits.slice(1).every((edit) => edit.newText === '&~/MAX_HEALTH')).toBe(true);
    });

    it('reuses the literal spelling for suffixed numbers (`50%`)', () => {
        const percentSrc = 'A\n{\n\tX = 50%\n}\nB\n{\n\tY = 50%\n}\n';
        const doc = parse(percentSrc);
        const action = actionAt(percentSrc, literalNodeOf(doc, '50%'));
        expect(action).toBeDefined();
        const edits = action!.edit!.changes![URI] as TextEdit[];
        expect(edits[0].newText).toBe('X = 50%\n');
    });

    it('avoids colliding with an existing root member name', () => {
        const collideSrc = 'MAX_HEALTH = 9\nPart\n{\n\tMaxHealth = 12000\n\tSub\n\t{\n\t\tHealth = 12000\n\t}\n}\n';
        const doc = parse(collideSrc);
        const action = actionAt(collideSrc, valueNodeOf(doc, 12000));
        expect(action).toBeDefined();
        const edits = action!.edit!.changes![URI] as TextEdit[];
        expect(edits[0].newText).toBe('MAX_HEALTH_2 = 12000\n');
        expect(edits.slice(1).every((edit) => edit.newText === '&~/MAX_HEALTH_2')).toBe(true);
    });

    it('does not offer the extraction for a value that appears only once', () => {
        const singleSrc = 'Part\n{\n\tMaxHealth = 12000\n\tArmor = 4\n}\n';
        const doc = parse(singleSrc);
        expect(actionAt(singleSrc, valueNodeOf(doc, 12000))).toBeUndefined();
    });

    it('does not offer the extraction on a root-level assignment (already a shared field)', () => {
        const doc = parse(src);
        expect(actionAt(src, valueNodeOf(doc, 1))).toBeUndefined();
    });
});
