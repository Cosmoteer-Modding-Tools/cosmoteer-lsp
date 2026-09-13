import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { GroupNode, isGroupNode } from '../../../src/core/ast/ast';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';

// A `Components` group written at a fragment file's root (the Star Wars shields are written this way,
// then inherited into the real part) has no slot and no differently-typed sibling, so a colliding
// `Type=` used to resolve to whichever registry declares the name first. `ArcShield` is both a part
// component and a media effect, and the effect class won.
const parse = (src: string) => parser(lexer(src), 'file:///mod/ships/shield_base.rules').value;

const componentGroup = (src: string, name: string): GroupNode => {
    const components = parse(src).elements.find((e) => isGroupNode(e) && e.identifier?.name === 'Components');
    const group = (components as GroupNode).elements.find((e) => isGroupNode(e) && e.identifier?.name === name);
    expect(group, name).toBeDefined();
    return group as GroupNode;
};

describe('component fragment with a colliding discriminator', () => {
    it('prefers the candidate that owns the written members', () => {
        const src = [
            'Components',
            '{',
            '\tArcShield',
            '\t{',
            '\t\tType = ArcShield',
            '\t\tArc = 90d',
            '\t\tPenetrationResistance = 1',
            '\t\tOperationalToggle = PowerToggle',
            '\t}',
            '}',
            '',
        ].join('\n');
        expect(resolveGroupClass(componentGroup(src, 'ArcShield'))).toBe('Cosmoteer.Ships.Parts.Defenses.ArcShieldRules');
    });

    it('leaves the effect reading as the effect when the effect fields are the written ones', () => {
        const src = [
            'Components',
            '{',
            '\tArcShield',
            '\t{',
            '\t\tType = ArcShield',
            '\t\tFadeInTime = .2',
            '\t\tFadeFromScale = 1',
            '\t\tArcSpriteSegments = 8',
            '\t}',
            '}',
            '',
        ].join('\n');
        expect(resolveGroupClass(componentGroup(src, 'ArcShield'))).toBe(
            'Cosmoteer.Simulation.MediaEffects.ArcShieldEffectRules'
        );
    });
});
