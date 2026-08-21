import { describe, expect, it } from 'vitest';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isGroupNode, isListNode } from '../../src/core/ast/ast';
import { memberPathOf, memberPathStringOf, targetableContainerOf } from '../../src/semantics/node-path';
import { memberNameOf, memberValueOf, stepIntoNode } from '../../src/semantics/reference-resolver';
import { parseText } from '../../src/utils/ast.utils';

const parse = (text: string): AbstractNodeDocument => parseText(text, 'file:///probe.rules');

/** Every node in the document that a member path could be asked for. */
const walk = (node: AbstractNode, out: AbstractNode[] = []): AbstractNode[] => {
    out.push(node);
    const elements = (node as { elements?: AbstractNode[] }).elements;
    if (elements) for (const element of elements) walk(element, out);
    const right = (node as { right?: AbstractNode }).right;
    if (right) walk(right, out);
    return out;
};

/** The member a path lands on when walked segment by segment from the document root. */
const resolve = (document: AbstractNodeDocument, segments: string[]): AbstractNode | null => {
    let current: AbstractNode | null = document;
    for (const segment of segments) {
        if (!current) return null;
        current = stepIntoNode(current, segment) ?? null;
    }
    return current;
};

describe('memberPathOf', () => {
    it('names a scalar member of a group', () => {
        const document = parse('Part\n{\n\tDensity = 5\n}\n');
        const part = document.elements[0] as AbstractNode & { elements: AbstractNode[] };
        const density = memberValueOf(part.elements[0])!;
        expect(memberPathOf(density).segments).toEqual(['Part', 'Density']);
    });

    it('names a member of a nested group', () => {
        const document = parse('Part\n{\n\tComponents\n\t{\n\t\tWeapon\n\t\t{\n\t\t\tDamage = 3\n\t\t}\n\t}\n}\n');
        const damage = walk(document).find((node) => memberPathStringOf(node) === 'Part/Components/Weapon/Damage');
        expect(damage).toBeDefined();
    });

    // A group written as an assignment carries no identifier of its own, so a builder that reads
    // `identifier` drops it. The game keys it by the assignment's name like any other member.
    it('names a group written as an assignment, and its members', () => {
        const document = parse('Part\n{\n\tX = { Y = 1 }\n}\n');
        const paths = walk(document).map(memberPathStringOf).filter(Boolean);
        expect(paths).toContain('Part/X');
        expect(paths).toContain('Part/X/Y');
    });

    it('names a bare void field', () => {
        const document = parse('Part\n{\n\tv_Faction\n}\n');
        const paths = walk(document).map(memberPathStringOf).filter(Boolean);
        expect(paths).toContain('Part/v_Faction');
    });

    it('names a top level member of the file', () => {
        const document = parse('Part\n{\n}\n');
        expect(memberPathStringOf(document.elements[0])).toBe('Part');
    });

    it('gives the document itself the empty path', () => {
        const document = parse('Part\n{\n}\n');
        expect(memberPathOf(document).segments).toEqual([]);
    });

    it('refuses a list element, because its index moves when another mod loads first', () => {
        const document = parse('Part\n{\n\tSize [ 2, 3 ]\n}\n');
        const list = walk(document).find(isListNode)!;
        expect(memberPathOf(list.elements[0]).refusal).toBe('listElement');
    });

    it('refuses every node under a list, at any depth', () => {
        const document = parse('Part\n{\n\tParts\n\t[\n\t\t{ ID = a }\n\t]\n}\n');
        const inner = walk(document).find((node) => isGroupNode(node) && node.parent && isListNode(node.parent))!;
        expect(memberPathOf(inner).refusal).toBe('listElement');
        const id = (inner as AbstractNode & { elements: AbstractNode[] }).elements[0];
        expect(memberPathOf(id).refusal).toBe('listElement');
    });

    it('refuses an anonymous block, which no name reaches', () => {
        const document = parse('Part\n{\n\t{\n\t\tY = 1\n\t}\n}\n');
        const anonymous = walk(document).find(
            (node) => isGroupNode(node) && !node.identifier && node.parent && isGroupNode(node.parent)
        );
        expect(anonymous && memberPathOf(anonymous).refusal).toBe('unnamed');
    });

    // A reference path resolves a name to the first member declaring it, so a path built through a
    // later duplicate would hand the caller a path that lands on the earlier one.
    it('refuses a member whose name an earlier sibling already takes', () => {
        const document = parse('Part\n{\n\tA = 1\n\tA = 2\n}\n');
        const part = document.elements[0] as AbstractNode & { elements: AbstractNode[] };
        expect(memberPathOf(memberValueOf(part.elements[0])!).segments).toEqual(['Part', 'A']);
        expect(memberPathOf(memberValueOf(part.elements[1])!).refusal).toBe('shadowedName');
    });

    // The game reads a digit for a member name as a position, so a path through one names a slot
    // rather than a member, which is the same load-order hazard a list index carries.
    it('refuses a member whose name is a digit', () => {
        const document = parse('BulletEmitter\n{\n\t0\n\t{\n\t\tType = BulletEmitter\n\t}\n}\n');
        const inner = walk(document).find((node) => isGroupNode(node) && node.identifier?.name === '0')!;
        expect(memberPathOf(inner).refusal).toBe('indexName');
        const type = (inner as AbstractNode & { elements: AbstractNode[] }).elements[0];
        expect(memberPathOf(type).refusal).toBe('indexName');
    });

    it('refuses a node that belongs to no document', () => {
        const document = parse('Part\n{\n}\n');
        const orphan = { ...(document.elements[0] as object), parent: undefined } as AbstractNode;
        expect(memberPathOf(orphan).refusal).toBe('detached');
    });
});

// The property that makes the builder usable as an action-target generator: a path it emits is a
// path the reference resolver walks back to the very node it was built from.
describe('memberPathOf round trip', () => {
    const source = [
        'Part',
        '{',
        '\tID = probe.part',
        '\tDensity = 5',
        '\tX = { Y = 1 }',
        '\tComponents',
        '\t{',
        '\t\tWeapon',
        '\t\t{',
        '\t\t\tDamage = 3',
        '\t\t\tShots [ 1, 2 ]',
        '\t\t}',
        '\t}',
        '\tv_Faction',
        '}',
        'Other',
        '{',
        '\tDensity = 9',
        '}',
        '',
    ].join('\n');

    it('resolves every emitted path back to its own node', () => {
        const document = parse(source);
        let checked = 0;
        for (const node of walk(document)) {
            const path = memberPathOf(node);
            if (!path.segments || !path.segments.length) continue;
            // A path names a member, and resolving a member yields its value, so the path of an
            // assignment lands on its right-hand side rather than on the assignment itself.
            const landing = resolve(document, path.segments);
            expect(landing === node || (isAssignmentNode(node) && landing === node.right), path.segments.join('/')).toBe(true);
            checked++;
        }
        expect(checked).toBeGreaterThan(8);
    });

    it('refuses everything it cannot address, and never emits an index segment', () => {
        const document = parse(source);
        for (const node of walk(document)) {
            const path = memberPathOf(node);
            if (path.segments) expect(path.segments.every((segment) => !/^\d+$/.test(segment))).toBe(true);
            else expect(['listElement', 'indexName', 'unnamed', 'shadowedName', 'detached']).toContain(path.refusal);
        }
    });

    it('reaches every named member of a group', () => {
        const document = parse(source);
        const part = document.elements[0] as AbstractNode & { elements: AbstractNode[] };
        const named = part.elements.map(memberNameOf).filter(Boolean);
        expect(named).toEqual(['ID', 'Density', 'X', 'Components', 'v_Faction']);
        for (const name of named) {
            expect(resolve(document, ['Part', name!])).not.toBeNull();
        }
    });
});

describe('targetableContainerOf', () => {
    it('answers the innermost enclosing group', () => {
        const document = parse('Part\n{\n\tComponents\n\t{\n\t\tW = 5\n\t}\n}\n');
        const value = walk(document).find((node) => memberPathStringOf(node) === 'Part/Components/W')!;
        expect(memberPathStringOf(targetableContainerOf(value)!)).toBe('Part/Components');
    });

    it('answers the document for a top level member', () => {
        const document = parse('Part\n{\n}\n');
        expect(targetableContainerOf(document.elements[0])).toBe(document.elements[0]);
    });

    // The game throws while loading an `Overrides` action whose target is not a group or a file, so
    // a caret inside a list has no target to offer.
    it('refuses a node inside a list', () => {
        const document = parse('Part\n{\n\tSize [ 2, 3 ]\n}\n');
        const list = walk(document).find(isListNode)!;
        expect(targetableContainerOf(list.elements[0])).toBeUndefined();
    });
});
