import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, GroupNode, isAssignmentNode, isDocumentNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';
import { memberTypeIn, resolveGroupClass } from '../../../src/document/schema/schema-context';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service';

// The engine's Range<T> reads four written forms: a scalar, a 1/2-element list, a group with
// `Value` or `Min`/`Max` keys (each the element type), and otherwise the whole group AS the element
// (verified in HalflingCore Range.ReadContentFrom). A bullet's `Speed { BaseValue = … }` is the
// element-as-group form of a range<Modifiable>, and a background's `TwinkleAddColor { Min Max }` is
// the range-keys form. Both used to resolve to nothing, going completely dark.
const token = CancellationToken.None;
const parse = (src: string, uri = 'file:///data/shots/t.rules') => parser(lexer(src), uri).value;
const labelsOf = (cs: Completion[]) => cs.map((c) => (typeof c === 'string' ? c : c.label));

const findGroup = (node: AbstractNode, id: string): GroupNode | undefined => {
    if (isGroupNode(node) && node.identifier?.name === id) return node;
    const kids =
        isGroupNode(node) || isListNode(node) || isDocumentNode(node)
            ? node.elements
            : isAssignmentNode(node)
              ? (node.right ? [node.right] : [])
              : [];
    for (const kid of kids) {
        const found = findGroup(kid, id);
        if (found) return found;
    }
    return undefined;
};

describe('range slot group forms', () => {
    // The uri roots the file as BulletRules via the /shots/ folder rule; Speed is range<Modifiable>.
    it('resolves an element-shaped group in a range slot to the element group class', () => {
        const doc = parse('Speed\n{\n\tBaseValue = 240\n\tBuffType = Overclock\n}\nRange = 100\n');
        const speed = findGroup(doc, 'Speed');
        expect(resolveGroupClass(speed!)).toBe('Cosmoteer.Ships.ModifiableValue');
    });

    it('offers the element group-form fields inside the block', async () => {
        const SRC = 'Speed\n{\n\t\n}\nRange = 100\n';
        const doc = parse(SRC);
        const labels = labelsOf(await schemaFieldNameCompletions(doc, SRC.indexOf('{') + 2, token));
        expect(labels).toContain('BaseValue');
    });

    it('keeps a Min/Max-form group class-less but types its range keys as the element', () => {
        const doc = parse('Speed\n{\n\tMin = 100\n\tMax = 200\n}\nRange = 100\n');
        const speed = findGroup(doc, 'Speed');
        // The Min/Max keys are the engine's own range form, not element fields, so no class applies.
        expect(resolveGroupClass(speed!)).toBeUndefined();
        expect(memberTypeIn(speed!, 'Min')?.kind).toBe('number');
        expect(memberTypeIn(speed!, 'Max')?.kind).toBe('number');
        expect(memberTypeIn(speed!, 'Value')?.kind).toBe('number');
        // A non-range key stays untyped rather than leaking the element type.
        expect(memberTypeIn(speed!, 'Bogus')).toBeUndefined();
    });
});
