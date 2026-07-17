import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    AbstractNode,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
} from '../../../src/core/ast/ast';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service';

// A member of a map-typed slot takes the map's value type, so its `Type=` dispatches in the map's
// declared registry even when the discriminator collides across registries. The regression case is a
// `ToggledComponents` part component, whose `Components` map (schema overlay, custom-deserialized in
// C#) holds part components. Its first child writing `Type = ArcShield` must resolve to the part
// component `ArcShieldRules`, not the media effect `ArcShieldEffectRules` that sibling registry
// inference used to pick when the child is the container's first typed group.
const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;
const labelsOf = (cs: Completion[]) => cs.map((c) => (typeof c === 'string' ? c : c.label));

const findGroup = (node: AbstractNode, id: string): GroupNode | undefined => {
    if (isGroupNode(node) && node.identifier?.name === id) return node;
    const kids =
        isGroupNode(node) || isListNode(node) || isDocumentNode(node)
            ? node.elements
            : isAssignmentNode(node) && node.right
              ? [node.right]
              : [];
    for (const k of kids) {
        const found = findGroup(k, id);
        if (found) return found;
    }
    return undefined;
};

const SRC = [
    'Part',
    '{',
    '\tComponents',
    '\t{',
    '\t\tToggled',
    '\t\t{',
    '\t\t\tType = ToggledComponents',
    '\t\t\tToggle = SomeToggle',
    '\t\t\tComponents',
    '\t\t\t{',
    '\t\t\t\tMyShield',
    '\t\t\t\t{',
    '\t\t\t\t\tType = ArcShield',
    '\t\t\t\t\t',
    '\t\t\t\t}',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}',
].join('\n');

describe('map-typed slot member resolution', () => {
    it('resolves an ambiguous Type inside a ToggledComponents Components map to the part component class', () => {
        const doc = parse(SRC);
        const group = findGroup(doc, 'MyShield');
        expect(resolveGroupClass(group!)).toBe('Cosmoteer.Ships.Parts.Defenses.ArcShieldRules');
    });

    it('offers the part component fields for completion inside the member', async () => {
        const gapOffset = SRC.indexOf('Type = ArcShield') + 'Type = ArcShield\n\t\t\t\t\t'.length;
        const labels = labelsOf(await schemaFieldNameCompletions(parse(SRC), gapOffset, token));
        expect(labels).toContain('Radius');
        expect(labels).toContain('OperationalToggle');
        expect(labels).not.toContain('Bucket');
    });
});
