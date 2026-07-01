import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, GroupNode, isAssignmentNode, isDocumentNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';
import { acceptsShaderConstants, fieldOf, isShaderConstantField } from '../../../src/document/schema/schema';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { schemaFieldHover } from '../../../src/features/hover/schema-hover';

// The sprite/material slots are typed as the abstract `ISprite`/`IMaterial`/`IAnimatedSprite`
// interfaces, which reflect only a subset of fields. The concrete impl (Sprite extends Material; the
// AnimatedSprite frame set) is what is actually written, and the shader's uniforms are written inline
// as `_`-prefixed keys. This locks in the interface→concrete redirect and shader-constant handling.
const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;
const labelsOf = (cs: Array<string | { label: string }>) => cs.map((c) => (typeof c === 'string' ? c : c.label));

const findGroup = (node: AbstractNode, id: string): GroupNode | undefined => {
    if (isGroupNode(node) && node.identifier?.name === id) return node;
    const kids =
        isGroupNode(node) || isListNode(node) || isDocumentNode(node)
            ? node.elements
            : isAssignmentNode(node)
              ? [node.right]
              : [];
    for (const k of kids) {
        const found = findGroup(k, id);
        if (found) return found;
    }
    return undefined;
};

// TurretWeaponRules.BlueprintArcSprite is typed `ISprite` → must resolve to the concrete `Sprite`.
const partSprite = (body: string) =>
    `Part\n{\n\tComponents\n\t{\n\t\tT\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\tBlueprintArcSprite\n\t\t\t{\n${body}\n\t\t\t}\n\t\t}\n\t}\n}`;

describe('sprite/material hierarchy', () => {
    it('resolves an ISprite slot to the concrete Sprite (with Material fields)', () => {
        const doc = parse(partSprite('\t\t\t\tShader = wave.shader'));
        const group = findGroup(doc, 'BlueprintArcSprite');
        const cls = resolveGroupClass(group!);
        expect(cls).toBe('Halfling.Graphics.Sprite');
        // Sprite extends Material, so the material fields are reachable through inheritance.
        expect(fieldOf(cls!, 'Shader')).toBeDefined();
        expect(fieldOf(cls!, 'Texture')).toBeDefined();
        expect(fieldOf(cls!, 'VertexColor')).toBeDefined();
    });

    it('offers the concrete Sprite/Material fields for completion in an ISprite slot', async () => {
        const SRC = partSprite('\t\t\t\t');
        const offset = SRC.indexOf('BlueprintArcSprite');
        const gap = SRC.indexOf('{', offset) + 3;
        const labels = labelsOf(await schemaFieldNameCompletions(parse(SRC), gap, token));
        expect(labels).toContain('Shader');
        expect(labels).toContain('Texture');
        expect(labels).toContain('VertexColor');
    });

    it('recognizes inline `_`-prefixed shader constants on a material/sprite', () => {
        expect(acceptsShaderConstants('Halfling.Graphics.Sprite')).toBe(true);
        expect(acceptsShaderConstants('Halfling.Graphics.Material')).toBe(true);
        expect(isShaderConstantField('Halfling.Graphics.Sprite', '_hotColor')).toBe(true);
        // a non-underscore unknown is NOT a shader constant, and a non-material class never accepts them
        expect(isShaderConstantField('Halfling.Graphics.Sprite', 'NotAConstant')).toBe(false);
        expect(isShaderConstantField('Cosmoteer.Ships.Parts.PartRules', '_x')).toBe(false);
    });

    it('hovers an inline shader-constant key as a shader constant', () => {
        const doc = parse(partSprite('\t\t\t\tShader = wave.shader\n\t\t\t\t_hotColor = {Rf=1 Gf=0 Bf=0}'));
        const group = findGroup(doc, 'BlueprintArcSprite');
        const constant = group!.elements.find(
            (e) => isAssignmentNode(e) && e.left.name === '_hotColor'
        ) as AbstractNode & { right: AbstractNode };
        const hover = schemaFieldHover(constant.right);
        expect(hover).toContain('_hotColor');
        expect(hover).toContain('shader constant');
    });
});
