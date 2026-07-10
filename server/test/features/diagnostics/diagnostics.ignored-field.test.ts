import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateIgnoredFields, isIgnoredSchemaField } from '../../../src/features/diagnostics/validator.ignored-field';
import { isValueNode, ValueNode } from '../../../src/core/ast/ast';
import { walkAst } from '../../helpers';

const token = CancellationToken.None;
const parse = (text: string, uri = 'file:///mod/particles/effect.rules') => parser(lexer(text), uri).value;

// A particle updater that resolves through its own `Type = ValueCurve` discriminator, mirroring the
// vanilla `reactor_shockwave_*.rules` shape that carries the dead dev-editor `Filename` field next
// to the baked `Points` array.
const valueCurve = (...members: string[]) => `Type = Particles
Def
{
    Updaters
    [
        {
            Type = ValueCurve
            Enabled = true
${members.map((m) => `            ${m}`).join('\n')}
            Points [ 1, 0.5 ]
        }
    ]
}
`;

const firstSprite = (text: string): ValueNode => {
    const sprite = [...walkAst(parse(text))].find(
        (n): n is ValueNode => isValueNode(n) && n.valueType.type === 'Sprite'
    );
    expect(sprite).toBeDefined();
    return sprite as ValueNode;
};

describe('ignored-field diagnostics', () => {
    it('hints a field the schema class does not declare and nothing references', async () => {
        const doc = parse(valueCurve('Filename = SmoothFalloffRamp.png', 'MinValue = 9'));
        const errors = await validateIgnoredFields(doc, token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain("'Filename' is not a member of");
        expect(errors[0].severity).toBe('hint');
        expect(errors[0].data?.remove?.title).toBe("Remove 'Filename'");
    });

    it('stays silent when a reference in the file reads the field (constant idiom)', async () => {
        const doc = parse(valueCurve('CUSTOM_MAX = 60', 'MinValue = (&CUSTOM_MAX) / 2'));
        expect(await validateIgnoredFields(doc, token)).toHaveLength(0);
    });

    it('stays silent on declared members, including inherited ones', async () => {
        // Enabled lives on BaseParticleDataUpdater, not ParticleValueCurve itself.
        const doc = parse(valueCurve('LerpIn = life', 'MinValue = 9'));
        expect(await validateIgnoredFields(doc, token)).toHaveLength(0);
    });

    it('stays silent when the group class cannot be resolved', async () => {
        const doc = parse('SomeUnknownThing\n{\n    Filename = foo.png\n}\n', 'file:///mod/unknown.rules');
        expect(await validateIgnoredFields(doc, token)).toHaveLength(0);
    });

    it('stays silent when the class owns only a minority of the group (wrong-class resolution)', async () => {
        // The group carries three foreign members against ParticleValueCurve's two owned ones (Enabled
        // and Points from the helper), so the class fits under half of it. That signals the whole group
        // resolved to the wrong class, the way a beam emitter self-resolves to the media-effect
        // BeamEffectRules, so nothing is flagged rather than reporting the foreign members as dead.
        const doc = parse(valueCurve('Foo = 1', 'Bar = 2', 'Baz = 3'));
        expect(await validateIgnoredFields(doc, token)).toHaveLength(0);
    });

    it('suppresses the asset-not-found check on an ignored field', async () => {
        const sprite = firstSprite(valueCurve('Filename = SmoothFalloffRamp.png'));
        expect(isIgnoredSchemaField(sprite)).toBe(true);
    });

    it('does not suppress the asset check when the class is not authoritative', async () => {
        // StandardQuadRenderer is opaque in the schema (zero known fields), so its Texture group
        // never resolves a class and the missing-asset warning must keep firing (the vanilla
        // disruptor_bolt_hit.png case).
        const sprite = firstSprite(`Type = Particles
Def
{
    Renderers
    [
        {
            Type = StandardQuadRenderer
            Texture
            {
                File = missing.png
            }
        }
    ]
}
`);
        expect(isIgnoredSchemaField(sprite)).toBe(false);
    });
});
