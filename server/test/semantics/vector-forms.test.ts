import { describe, expect, it } from 'vitest';
import { AbstractNodeDocument, GroupNode, isGroupNode, isValueNode } from '../../src/core/ast/ast';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { childNamed, readVector } from '../../src/semantics/vector-forms';
import { walkAst } from '../helpers';

/** Parses an inline source under a throwaway uri. */
const parse = (source: string): AbstractNodeDocument => parser(lexer(source), 'file:///inline.rules').value;

/** The first group with the given identifier. */
const group = (doc: AbstractNodeDocument, name: string): GroupNode => {
    for (const node of walkAst(doc)) if (isGroupNode(node) && node.identifier?.name === name) return node;
    throw new Error(`group ${name} not found`);
};

/** The plain number a read member carries. */
const numberIn = (doc: AbstractNodeDocument, name: string, member: string): unknown => {
    const found = childNamed(group(doc, name), member);
    return found && isValueNode(found) ? found.valueType.value : undefined;
};

// `OTGroupNode` keys its children case-insensitively, which is how vanilla's `OffSet` spelling is
// read as `Offset` by the game.
describe('a member read by name', () => {
    it('finds a member the file spells with different casing', () => {
        const doc = parse(['Sprites', '{', '\tOffSet = 3', '}', ''].join('\n'));
        expect(numberIn(doc, 'Sprites', 'Offset')).toBe(3);
    });

    it('prefers the exact spelling when both are written', () => {
        // Two members differing only by case still resolve precisely, the rule `stepIntoNode`
        // already follows for reference paths.
        const doc = parse(['Sprites', '{', '\tOffSet = 3', '\tOffset = 7', '}', ''].join('\n'));
        expect(numberIn(doc, 'Sprites', 'Offset')).toBe(7);
        expect(numberIn(doc, 'Sprites', 'OffSet')).toBe(3);
    });

    it('reads a vector written in the named form with either casing', () => {
        const doc = parse(['Point', '{', '\tx = 1', '\ty = 2', '}', ''].join('\n'));
        const vector = readVector(group(doc, 'Point'));
        expect(vector && [vector.x, vector.y]).toEqual([1, 2]);
    });

    it('still answers nothing for a member that is simply not there', () => {
        // The negative control: folding case must not turn a missing member into a near match.
        const doc = parse(['Sprites', '{', '\tOffSet = 3', '}', ''].join('\n'));
        expect(childNamed(group(doc, 'Sprites'), 'Offsets')).toBeNull();
        expect(childNamed(group(doc, 'Sprites'), 'Size')).toBeNull();
    });
});
