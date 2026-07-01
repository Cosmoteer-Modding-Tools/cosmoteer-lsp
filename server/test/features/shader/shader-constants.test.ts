import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
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
import { globalSettings } from '../../../src/settings';
import { constantSnippet, shaderConstantCompletions } from '../../../src/features/completion/autocompletion.shader-constants';
import { ShaderConstant } from '../../../src/features/shader/shader-parser';
import { shaderConstantHover } from '../../../src/features/shader/shader-hover';
import { clearShaderCache } from '../../../src/features/shader/shader-index';
import { validateShaderConstants } from '../../../src/features/diagnostics/validator.shader-constants';

// These exercise the end-to-end path: a material group with a `Shader = X` sibling resolves its
// uniforms from the referenced `.shader`. Resolution reads the real shader from disk, so the cases
// that need it self-skip without the game install. The document is placed inside the game's particle
// directory so the relative shader path resolves the same way the game loads it.
const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

// A file URI inside the particle directory so `Shader = "particle_light_emissive.shader"` resolves.
const DOC_URI = pathToFileURL(join(DATA_DIR, 'common_effects/particles/__test__.rules')).href;
const parse = (src: string) => parser(lexer(src), DOC_URI).value;

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

// TurretWeaponRules.BlueprintArcSprite is typed `ISprite` → resolves to the concrete `Sprite`, which
// accepts shader constants. The group sets a real shader and one of its constants.
const partSprite = (body: string) =>
    `Part\n{\n\tComponents\n\t{\n\t\tT\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\tBlueprintArcSprite\n\t\t\t{\n${body}\n\t\t\t}\n\t\t}\n\t}\n}`;

describe('shader-constant completion + hover', () => {
    it.runIf(HAVE_DATA)('offers the referenced shader\'s uniforms as field completions', async () => {
        clearShaderCache();
        const doc = parse(partSprite('\t\t\t\tShader = "particle_light_emissive.shader"'));
        const group = findGroup(doc, 'BlueprintArcSprite')!;
        expect(resolveGroupClass(group)).toBe('Halfling.Graphics.Sprite');
        const present = new Set(['Shader']);
        const labels = (await shaderConstantCompletions(group, DOC_URI, present, token)).map((c) => c.label);
        expect(labels).toContain('_z');
        expect(labels).toContain('_litReflectiveStrength');
        // Engine-bound and already-present constants are not offered.
        expect(labels).not.toContain('_time');
        expect(labels).not.toContain('_color');
        expect(labels).not.toContain('Shader');
    });

    it.runIf(HAVE_DATA)('skips a constant already written in the group', async () => {
        clearShaderCache();
        const doc = parse(partSprite('\t\t\t\tShader = "particle_light_emissive.shader"\n\t\t\t\t_z = 0.2'));
        const group = findGroup(doc, 'BlueprintArcSprite')!;
        const present = new Set(['Shader', '_z']);
        const labels = (await shaderConstantCompletions(group, DOC_URI, present, token)).map((c) => c.label);
        expect(labels).not.toContain('_z');
        expect(labels).toContain('_litReflectiveStrength');
    });

    it.runIf(HAVE_DATA)('enriches the hover of a constant key with its HLSL type', async () => {
        clearShaderCache();
        const doc = parse(partSprite('\t\t\t\tShader = "particle_light_emissive.shader"\n\t\t\t\t_z = 0.2'));
        const group = findGroup(doc, 'BlueprintArcSprite')!;
        const assignment = group.elements.find((e) => isAssignmentNode(e) && e.left.name === '_z');
        const hover = await shaderConstantHover((assignment as { right: AbstractNode }).right, DOC_URI, token);
        expect(hover).toContain('_z');
        expect(hover).toContain('shader constant');
        expect(hover).toContain('float');
    });

    it.runIf(HAVE_DATA)('enriches the hover of a constant written in the group form (`_z { … }`)', async () => {
        clearShaderCache();
        // The group form (`_x { … }`) is an equally valid way to set a constant; hovering its key
        // resolves to the group node, not an assignment, which must still surface the shader info.
        const doc = parse(partSprite('\t\t\t\tShader = "particle_light_emissive.shader"\n\t\t\t\t_z\n\t\t\t\t{\n\t\t\t\t}'));
        const group = findGroup(doc, 'BlueprintArcSprite')!;
        const constantGroup = group.elements.find((e) => isGroupNode(e) && e.identifier?.name === '_z');
        const hover = await shaderConstantHover(constantGroup as AbstractNode, DOC_URI, token);
        expect(hover).toContain('_z');
        expect(hover).toContain('shader constant');
    });

    it('returns nothing for a group that does not accept shader constants', async () => {
        const doc = parse('Part\n{\n\tName = "x"\n}');
        const group = findGroup(doc, 'Part')!;
        const labels = await shaderConstantCompletions(group, DOC_URI, new Set(), token);
        expect(labels).toEqual([]);
    });
});

describe('shader-constant value-shape snippet', () => {
    const constant = (name: string, kind: ShaderConstant['kind']): ShaderConstant => ({
        name,
        kind,
        hlslType: kind === 'vec4' ? 'float4' : 'float',
    });

    it('scaffolds a colour `float4` as an `{ Rf Gf Bf Af }` group, not a list', () => {
        const snippet = constantSnippet(constant('_centerColor', 'vec4'));
        expect(snippet).toContain('{');
        expect(snippet).toContain('Rf = $1');
        expect(snippet).toContain('Af = $4');
        expect(snippet).not.toContain('[');
    });

    it('scaffolds a non-colour `float4` and other vectors as a bracketed list', () => {
        expect(constantSnippet(constant('_offset4', 'vec4'))).toBe('_offset4 = [$0]');
        expect(constantSnippet(constant('_offset', 'vec2'))).toBe('_offset = [$0]');
    });

    it('scaffolds a scalar as a plain assignment', () => {
        expect(constantSnippet(constant('_z', 'float'))).toBe('_z = $0');
    });
});

describe('shader-constant validation', () => {
    it.runIf(HAVE_DATA)('flags an unknown constant with a did-you-mean quick fix', async () => {
        clearShaderCache();
        globalSettings.cosmoteerPath = DATA_DIR;
        // `_litReflectiveStrengt` is a typo for the real `_litReflectiveStrength`.
        const doc = parse(
            partSprite('\t\t\t\tShader = "particle_light_emissive.shader"\n\t\t\t\t_litReflectiveStrengt = 4')
        );
        const errors = await validateShaderConstants(doc, token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('_litReflectiveStrengt');
        expect(errors[0].data?.quickFix?.newText).toBe('_litReflectiveStrength');
    });

    it.runIf(HAVE_DATA)('does not flag a correctly named constant', async () => {
        clearShaderCache();
        globalSettings.cosmoteerPath = DATA_DIR;
        const doc = parse(partSprite('\t\t\t\tShader = "particle_light_emissive.shader"\n\t\t\t\t_z = 0.2'));
        expect(await validateShaderConstants(doc, token)).toEqual([]);
    });

    it.runIf(HAVE_DATA)('flags a scalar constant given a non-numeric shape', async () => {
        clearShaderCache();
        globalSettings.cosmoteerPath = DATA_DIR;
        // `_z` is a float uniform, a boolean is the wrong shape.
        const doc = parse(partSprite('\t\t\t\tShader = "particle_light_emissive.shader"\n\t\t\t\t_z = true'));
        const errors = await validateShaderConstants(doc, token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('expects a number');
    });

    it('skips a material whose shader cannot be resolved (no false positives)', async () => {
        const doc = parse(partSprite('\t\t\t\tShader = "does_not_exist.shader"\n\t\t\t\t_anything = 1'));
        expect(await validateShaderConstants(doc, token)).toEqual([]);
    });
});
