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

    it('flags foreign members outnumbering owned ones when the slot pins the dispatch', async () => {
        // The Updaters slot declares the particle-updater registry and the group's own Type picks
        // ParticleValueCurve from it, which is exactly how the game dispatches the group. The class
        // cannot be a mis-resolution, so the foreign members are genuinely dead even though they
        // outnumber the owned Enabled and Points, and the class-fit guard must not swallow them.
        const doc = parse(valueCurve('Foo = 1', 'Bar = 2', 'Baz = 3'));
        const errors = await validateIgnoredFields(doc, token);
        expect(errors.map((e) => e.message.match(/'(\w+)'/)?.[1]).sort()).toEqual(['Bar', 'Baz', 'Foo']);
    });

    it('stays silent when a self-resolved class owns only a minority of the group', async () => {
        // A beam-emitter fragment root self-resolves through its own Type = Beam to the media-effect
        // BeamEffectRules, which owns none of its weapon fields. Without a container slot vouching
        // for the registry the resolution is untrusted, so the foreign members signal a wrong-class
        // resolution rather than dead fields and nothing is flagged.
        const doc = parse('Fragment\n{\n\tType = Beam\n\tRange = 300\n\tDuration = 5\n\tHitInterval = .1\n}\n', 'file:///mod/shots/fragment.rules');
        expect(await validateIgnoredFields(doc, token)).toHaveLength(0);
    });

    it('flags the dead copy-paste fields on a slot-pinned beam media effect', async () => {
        // The Star Wars mod's Siege_TurboLaser_beam_blue.rules shape: a BeamMediaEffects element whose
        // five copied fields (none of them ever read by the game) outnumber the four real ones. The
        // BeamMediaEffects slot delegates to the media-effect registry and Type = Beam picks
        // BeamEffectRules from it, so the dead majority must be flagged, not distrusted.
        const doc = parse(`Part
{
    Components
    {
        emitter
        {
            Type = BeamEmitter
            BeamMediaEffects
            [
                {
                    Type = Beam
                    Sprite { Texture { File = "b.png" } }
                    FadeInTime = .25
                    FadeOutTime = .25
                    Bucket = Middle1
                    ExtraEndLength = 1
                    ExtraBeginLength = 2
                    ThicknessOverIntensity = [0, 1]
                    ClampIntensity = [0, 100]
                    IntensityExponent = 0.75
                }
            ]
        }
    }
}
`, 'file:///data/parts/t.rules');
        const errors = await validateIgnoredFields(doc, token);
        const flagged = errors.map((e) => e.message.match(/'(\w+)'/)?.[1]).sort();
        expect(flagged).toEqual([
            'ClampIntensity',
            'ExtraBeginLength',
            'ExtraEndLength',
            'IntensityExponent',
            'ThicknessOverIntensity',
        ]);
        for (const error of errors) expect(error.message).toContain('BeamEffectRules');
    });

    it('spares wrapper-owned fields on a self-resolved group but still flags alien ones', async () => {
        // The Star Wars mod's stat_widgets.rules shape: a fragment wired in through mod.rules AddTo
        // actions, so the file is unrooted and each widget self-resolves through its own
        // Type = StatBar straight to StatBarRules. In the rooted vanilla file the slot types the
        // group as the ToggledShipStatWidgetRules wrapper, whose ToggleButtonID the game reads from
        // the same flat group, so the wrapper-owned field must survive. The suppression is
        // field-specific: a field no possible wrapper owns must still hint.
        const doc = parse(
            `StatWidgets
[
    {
        Type = StatBar
        NameKey = "BuildBox/Hypermatter"
        ToggleButtonID = SW_Hypermatter
        NumberFormat = "0.0"
        RecommendedStat = RecHypermatter
        ProvidedStat = HypermatterGeneration
        BlocksPerValue = 10
        TotallyAlienField = 1
    }
]
`,
            'file:///mod/gui/game/designer/stat_widgets.rules'
        );
        const errors = await validateIgnoredFields(doc, token);
        expect(errors.map((e) => e.message.match(/'(\w+)'/)?.[1])).toEqual(['TotallyAlienField']);
        expect(errors[0].message).toContain('StatBarRules');
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
