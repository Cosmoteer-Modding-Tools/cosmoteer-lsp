import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    ValueNode,
} from '../../../src/core/ast/ast';

/*
 * An unescaped `"` inside a quoted value splits it into segments with bare source between them. The
 * game reads the whole run as one value, so anything in that run belongs to the string. Every
 * expectation here was taken from the game's own parser (`OTFile` in HalflingCore.dll), including
 * the two shapes it refuses.
 */

/**
 * Parse a source string into its document node.
 *
 * @param src the .rules source to parse.
 * @returns the parsed document node.
 */
const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///x.rules').value;

/**
 * The name of each member of a group, list or document, in source order.
 *
 * @param node the container whose members are wanted.
 * @returns each member's identifier name, an anonymous marker for an unnamed container, or the
 * bracketed node type for anything else.
 */
const memberNames = (node: { elements: AbstractNode[] }): string[] =>
    node.elements.map((el) => {
        if (isGroupNode(el) || isListNode(el)) return el.identifier?.name ?? '<anon>';
        if (isAssignmentNode(el)) return el.left.name;
        return `<${el.type}>`;
    });

/**
 * A named top-level group of a document.
 *
 * @param doc the parsed document to search.
 * @param name the group's identifier name.
 * @returns the group node.
 */
const groupNamed = (doc: AbstractNodeDocument, name: string) =>
    doc.elements.find((e) => isGroupNode(e) && e.identifier?.name === name) as AbstractNode & {
        elements: AbstractNode[];
    };

/**
 * The value written for a group's field.
 *
 * @param group the group holding the field.
 * @param key the field name.
 * @returns the field's value as text, or undefined when the group has no such field.
 */
const valueOf = (group: { elements: AbstractNode[] }, key: string): string | undefined => {
    const assignment = group.elements.find((e) => isAssignmentNode(e) && e.left.name === key);
    if (!assignment || !isAssignmentNode(assignment) || !assignment.right) return undefined;
    return String((assignment.right as ValueNode).valueType.value);
};

describe('parser: bare run between the segments of an unescaped-quote value', () => {
    it('absorbs punctuation the lexer has no grammar for (`?`) instead of inventing members', () => {
        const doc = parse('G\n{\n\tA = "start "Y" mid "Pourquoi bombes ?" ende"\n\tB = 2\n}\n');
        const g = groupNamed(doc, 'G');
        expect(memberNames(g)).toEqual(['A', 'B']);
        // The game's own value for this line, joining two unquoted tokens with a single space.
        expect(valueOf(g, 'A')).toBe('start Y mid Pourquoi bombes ? ende');
    });

    it('keeps a localization line with several inner quotes and a `?` whole (SW-ACD-Factions fr.rules)', () => {
        const src =
            'StarterShips\n{\n' +
            '\tY_Wing = "<s12>Le "Y" signifie "Pourquoi se contenter d\'une bombe ?" Par R2."\n' +
            '\tX_Wing = "<s12>Un chasseur."\n}\n';
        const result = parser(lexer(src), 'file:///x.rules');
        expect(result.parserErrors).toEqual([]);
        expect(memberNames(groupNamed(result.value, 'StarterShips'))).toEqual(['Y_Wing', 'X_Wing']);
    });

    it('absorbs a colon, parentheses and the boolean words', () => {
        const doc = parse('G\n{\n\tA = "start "note: (voir) true" ende"\n\tB = 2\n}\n');
        const g = groupNamed(doc, 'G');
        expect(memberNames(g)).toEqual(['A', 'B']);
        expect(valueOf(g, 'A')).toBe('start note: (voir) true ende');
    });

    it('does not absorb a `,` (the game refuses that file, so the run must stay visible)', () => {
        const doc = parse('G\n{\n\tA = "start "word, more" ende"\n}\n');
        expect(valueOf(groupNamed(doc, 'G'), 'A')).toBe('start ');
    });

    it('does not absorb a `}` (it closes the parent for the game)', () => {
        const doc = parse('G\n{\n\tA = "start "word } more" ende"\n}\n');
        expect(valueOf(groupNamed(doc, 'G'), 'A')).toBe('start ');
    });

    it('still leaves a genuine following member alone across a line break', () => {
        const doc = parse('G\n{\n\tA = "x ? y"\n\tB = "z"\n}\n');
        const g = groupNamed(doc, 'G');
        expect(memberNames(g)).toEqual(['A', 'B']);
        expect(valueOf(g, 'A')).toBe('x ? y');
    });
});
