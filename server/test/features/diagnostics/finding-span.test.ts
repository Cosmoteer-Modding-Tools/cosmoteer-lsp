import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, isAssignmentNode } from '../../../src/core/ast/ast';
import { findingSpanOf } from '../../../src/features/diagnostics/validator';

// Every finding has to reach the editor as a span of text. An assignment is the one node the parser
// gives no span of its own, so a pass anchoring on one has to be placed rather than dereferenced:
// reading its missing span as an offset used to take the whole workspace pass down with a TypeError.
const parse = (source: string): AbstractNode[] =>
    parser(lexer(source), pathToFileURL('C:/mod/probe.rules').href).value.elements;

describe('where a finding is underlined', () => {
    it('takes the span the finding names over the node it is anchored on', () => {
        const [element] = parse('Greeting = "Hello"\n');
        expect(findingSpanOf({ message: 'm', node: element, range: { start: 3, end: 7 } })).toEqual({
            start: 3,
            end: 7,
        });
    });

    it('takes a node with a span of its own', () => {
        const [element] = parse('Greeting = "Hello"\n');
        expect(isAssignmentNode(element)).toBe(true);
        const value = isAssignmentNode(element) ? element.right! : element;
        expect(findingSpanOf({ message: 'm', node: value })).toEqual({
            start: value.position.start,
            end: value.position.end,
        });
    });

    it('covers an assignment from its written name to the end of its value', () => {
        const [element] = parse('Greeting = "Hello"\n');
        const span = findingSpanOf({ message: 'm', node: element });
        expect(span).not.toBeNull();
        const assignment = isAssignmentNode(element) ? element : undefined;
        expect(span!.start).toBe(assignment!.left.position.start);
        expect(span!.end).toBe(assignment!.right!.position.end);
    });

    it('covers an assignment whose value was never written', () => {
        const [element] = parse('Greeting = ;\n');
        const assignment = isAssignmentNode(element) ? element : undefined;
        expect(assignment?.right ?? null).toBeNull();
        expect(findingSpanOf({ message: 'm', node: element })).toEqual({
            start: assignment!.left.position.start,
            end: assignment!.left.position.end,
        });
    });

    it('answers nothing for a finding that carries no placeable node at all', () => {
        expect(findingSpanOf({ message: 'm', node: undefined as unknown as AbstractNode })).toBeNull();
    });
});
