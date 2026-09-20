import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNodeDocument,
    AstNode,
    asAstNode,
    childNodesOf,
    descendants,
    isAssignmentNode,
    isGroupNode,
    isValueNode,
} from '../../../src/core/ast/ast';

const parse = (source: string): AbstractNodeDocument => parser(lexer(source), 'file:///t.rules').value;

describe('childNodesOf', () => {
    it('answers a container with its elements and an assignment with its value', () => {
        const document = parse('Part { Name = "x" }');
        const part = document.elements[0];
        expect(isGroupNode(part)).toBe(true);
        expect(childNodesOf(part)).toHaveLength(1);

        const assignment = childNodesOf(part)[0];
        expect(isAssignmentNode(assignment)).toBe(true);
        expect(childNodesOf(assignment)).toHaveLength(1);
        expect(isValueNode(childNodesOf(assignment)[0])).toBe(true);
    });

    it('answers a leaf with nothing', () => {
        const document = parse('Name = "x"');
        const value = childNodesOf(childNodesOf(document)[0])[0];
        expect(childNodesOf(value)).toEqual([]);
    });

    it('answers an assignment with no value with nothing', () => {
        const document = parse('Name =');
        expect(childNodesOf(childNodesOf(document)[0])).toEqual([]);
    });
});

describe('descendants', () => {
    it('yields the node it was given before anything below it', () => {
        const document = parse('Part { Name = "x" }');
        expect([...descendants(document)][0]).toBe(document);
    });

    it('reaches every node of a nested document, parents before children', () => {
        const document = parse('Part { Components { Engine { Power = 5 } } }');
        const names = [...descendants(document)]
            .filter(isGroupNode)
            .map((group) => group.identifier?.name)
            .filter(Boolean);
        expect(names).toEqual(['Part', 'Components', 'Engine']);
    });

    it('walks list elements', () => {
        const document = parse('Sizes [ 1, 2, 3 ]');
        const numbers = [...descendants(document)].filter(isValueNode).map((value) => value.valueType.value);
        expect(numbers).toEqual([1, 2, 3]);
    });

    it('stops descending as soon as the caller stops reading', () => {
        const document = parse('Part { Components { Engine { Power = 5 } } }');
        let seen = 0;
        for (const node of descendants(document)) {
            seen++;
            if (isGroupNode(node) && node.identifier?.name === 'Components') break;
        }
        // Document, Part, Components. Nothing under Components was built.
        expect(seen).toBe(3);
    });

    it('does not reach math operands or call arguments, which childNodesOf leaves out', () => {
        const document = parse('Power = 2 * 3');
        const numbers = [...descendants(document)].filter(isValueNode).map((value) => value.valueType.value);
        expect(numbers).not.toContain(2);
    });

    it('does not reach inheritance bases', () => {
        const document = parse('Part : <base.rules>/Part { Name = "x" }');
        const part = document.elements[0];
        expect(isGroupNode(part) && part.inheritance?.length).toBeTruthy();
        const references = [...descendants(document)].filter(
            (node) => isValueNode(node) && node.valueType.type === 'Reference'
        );
        expect(references).toEqual([]);
    });
});

describe('AstNode', () => {
    it('narrows a switch over every node kind', () => {
        const document = parse('Part { Name = "x" }');
        const kindOf = (node: AstNode): string => {
            switch (node.type) {
                case 'Document':
                    return 'document';
                case 'Group':
                    return 'group';
                case 'List':
                    return 'list';
                case 'Identifier':
                    return 'identifier';
                case 'Value':
                    return 'value';
                case 'Expression':
                    return 'expression';
                case 'FunctionCall':
                    return 'call';
                case 'Assignment':
                    return 'assignment';
                case 'MathExpression':
                    return 'math';
                // No default: the compiler proves the nine cases are every kind there is.
            }
        };
        const kinds = [...descendants(document)].map((node) => kindOf(asAstNode(node)));
        expect(kinds).toEqual(['document', 'group', 'assignment', 'value']);
    });
});
