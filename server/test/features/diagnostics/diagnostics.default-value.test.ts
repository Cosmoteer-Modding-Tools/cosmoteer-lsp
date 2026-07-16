import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateDefaultValuedFields } from '../../../src/features/diagnostics/validator.default-value';
import { isAssignmentNode, isGroupNode } from '../../../src/core/ast/ast';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';
import { fieldOf } from '../../../src/document/schema/schema';
import { walkAst } from '../../helpers';

const token = CancellationToken.None;
const parse = (text: string, uri = 'file:///mod/particles/effect.rules') => parser(lexer(text), uri).value;

// A particle renderer that resolves through its own `Type =` discriminator, mirroring the vanilla
// lightning shape. ParticleLightningRenderer is purelyReflective and declares
// `AnimationIntensity = 1f` / `LightningShaderAnimationSegments = 1` as field initializers, so an
// absent field provably falls back to 1.
const lightning = (...members: string[]) => `Type = Particles
Def
{
    Renderers
    [
        {
            Type = LightningRenderer
${members.map((m) => `            ${m}`).join('\n')}
        }
    ]
}
`;

describe('default-value diagnostics', () => {
    it('fades a field written at its own default', async () => {
        const errors = await validateDefaultValuedFields(parse(lightning('AnimationIntensity = 1')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("'AnimationIntensity' is already 1 by default");
        expect(errors[0].severity).toBe('hint');
        expect(errors[0].unnecessary).toBe(true);
        expect(errors[0].data?.remove?.title).toBe("Remove 'AnimationIntensity'");
    });

    it('fades a default written in a different but equal numeric spelling', async () => {
        const errors = await validateDefaultValuedFields(parse(lightning('AnimationIntensity = 1.0')), token);
        expect(errors).toHaveLength(1);
    });

    it('spans the whole assignment so the value fades with the key', async () => {
        const text = lightning('AnimationIntensity = 1');
        const errors = await validateDefaultValuedFields(parse(text), token);
        expect(text.slice(errors[0].range!.start, errors[0].range!.end)).toBe('AnimationIntensity = 1');
    });

    it('stays silent on a value that differs from the default', async () => {
        expect(await validateDefaultValuedFields(parse(lightning('AnimationIntensity = 2')), token)).toHaveLength(0);
    });

    it('stays silent inside a group that inherits, where the default can override a base', async () => {
        // The base may set AnimationIntensity = 5. Writing the default back is then load-bearing.
        const doc = parse(`Type = Particles
Def
{
    Renderers
    [
        :/Base/Lightning
        {
            Type = LightningRenderer
            AnimationIntensity = 1
        }
    ]
}
`);
        // Pin that the inheritance guard is what silences this, not a resolution failure: the group
        // really does carry an inheritance list, and its class still resolves to the renderer whose
        // AnimationIntensity default is 1, so nothing but the guard can be suppressing the hint.
        const inheriting = [...walkAst(doc)].filter(isGroupNode).filter((g) => g.inheritance?.length);
        expect(inheriting).toHaveLength(1);
        expect(resolveGroupClass(inheriting[0])).toBe(
            'Cosmoteer.Simulation.MediaEffects.ParticleRenderers.ParticleLightningRenderer'
        );
        expect(await validateDefaultValuedFields(doc, token)).toHaveLength(0);
    });

    it('stays silent when a reference in the file reads the field', async () => {
        const doc = parse(lightning('AnimationIntensity = 1', 'LightningShaderAnimationSegments = (&AnimationIntensity)'));
        const errors = await validateDefaultValuedFields(doc, token);
        expect(errors.map((e) => e.message)).toEqual([]);
    });

    it('fades an attribute-sourced default on a class that is not purelyReflective', async () => {
        // TargetBlendMode has its own ReadContentFrom (so it is not purelyReflective), but the group
        // form delegates to ReflectiveRead, which applies each [Serialize(DefaultValue = …)]. Only the
        // fields written at their default fade. The two that differ stay untouched.
        // The vanilla shape (shots/ion_beam/particles/*.rules): Material is a field of the Def group
        // (ParticleSystemDef), a sibling of Renderer rather than a child of it.
        const doc = parse(`Type = Particles
Def
{
    Material
    {
        TargetBlendMode
        {
            SourceRgbFactor = InverseDestColor
            RgbOperator = Add
            AlphaOperator = Add
        }
    }
}
`);
        const errors = await validateDefaultValuedFields(doc, token);
        const names = errors.map((e) => /'([A-Za-z]+)'/.exec(e.message)?.[1]).sort();
        expect(names).toEqual(['AlphaOperator', 'RgbOperator']);
        expect(errors.every((e) => e.unnecessary)).toBe(true);
    });

    it('stays silent on a field the deserializer requires, even at its default', async () => {
        // PartMultiColorRules.RGBMode is `[Serialize] public MultiValueMode RGBMode = Multiply;`. The
        // ctor initializer makes schemagen call it `optional` and gives it a default, but the bare
        // [Serialize] means the game throws on a missing value rather than applying that default.
        // Fading it would invite a deletion that breaks the load, so absentThrows must win.
        const doc = parse(`Part
{
    Components
    {
        Colors
        {
            Type = MultiColor
            RGBMode = Multiply
        }
    }
}
`, 'file:///mod/parts/thing.rules');
        // Pin that absentThrows is what silences this, not a resolution failure: the group resolves,
        // and the field meets every other condition for a hint (a default equal to the written value,
        // and `optional` true). Without the absentThrows guard this would be flagged.
        const group = [...walkAst(doc)]
            .filter(isGroupNode)
            .find((g) => g.elements.some((e) => isAssignmentNode(e) && e.left.name === 'RGBMode'));
        const cls = resolveGroupClass(group!);
        expect(cls).toBe('Cosmoteer.Ships.Parts.Graphics.PartMultiColorRules');
        expect(fieldOf(cls!, 'RGBMode')).toMatchObject({ default: 'Multiply', optional: true, absentThrows: true });

        const errors = await validateDefaultValuedFields(doc, token);
        expect(errors.map((e) => e.message)).toEqual([]);
    });

    it('stays silent when the group class cannot be resolved', async () => {
        const doc = parse('SomeUnknownThing\n{\n    AnimationIntensity = 1\n}\n', 'file:///mod/unknown.rules');
        expect(await validateDefaultValuedFields(doc, token)).toHaveLength(0);
    });

    it('stays silent on mod.rules', async () => {
        const doc = parse(lightning('AnimationIntensity = 1'), 'file:///mod/mod.rules');
        expect(await validateDefaultValuedFields(doc, token)).toHaveLength(0);
    });
});
