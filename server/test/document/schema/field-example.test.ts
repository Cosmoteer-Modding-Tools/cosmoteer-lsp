import { describe, expect, it } from 'vitest';
import { fieldExampleMarkdown, fieldOf, fieldSignatureMarkdown } from '../../../src/document/schema/schema';

// A group-typed field's hover shows only the class name (`ISoundEffect`), which tells a modder
// nothing about the `{ … }` shape the game expects. fieldExampleMarkdown renders that shape from
// the schema; these tests pin its behavior per value-type family against the real bundle.
describe('fieldExampleMarkdown', () => {
    it('renders a { … } example for a group-typed field, showing optional fields when nothing is required', () => {
        const field = fieldOf('Cosmoteer.Simulation.SimGuiRules', 'ShipSelectSound')!;
        const example = fieldExampleMarkdown(field)!;
        expect(example).toContain('```rules');
        expect(example).toContain('ShipSelectSound');
        expect(example).toContain('{');
        // ISoundEffect requires nothing, so the example shows a few optional fields and counts the rest.
        expect(example).toContain('Sounds');
        expect(example).toMatch(/more optional fields/);
    });

    it('renders a Type = discriminator plus the required fields for a polymorphic slot', () => {
        const field = fieldOf('Cosmoteer.Ships.ShipRules', 'LinearDrag')!;
        const example = fieldExampleMarkdown(field)!;
        expect(example).toContain('Type = Exponential');
        expect(example).toContain('// one of 2 types');
        // The example member's required fields, each with a placeholder value.
        expect(example).toMatch(/Coefficient = /);
        expect(example).toMatch(/Exponent = /);
    });

    it('wraps a list-of-groups example in [ … ] with one element', () => {
        const field = fieldOf('Cosmoteer.Simulation.MediaEffects.MultiMediaEffectRules', 'Effects')!;
        const example = fieldExampleMarkdown(field)!;
        const lines = example.split('\n');
        expect(lines).toContain('Effects');
        expect(lines).toContain('[');
        expect(lines).toContain(']');
        expect(example).toContain('Type = ');
    });

    it('shows both accepted shapes for a Modifiable dual-form scalar', () => {
        const field = fieldOf('Cosmoteer.Ships.Parts.Weapons.TurretWeaponRules', 'TargetingRange')!;
        const example = fieldExampleMarkdown(field)!;
        expect(example).toContain('TargetingRange = 0');
        expect(example).toContain('// or with inline modifiers:');
        expect(example).toContain('BaseValue');
    });

    it('renders an inline example for a list of reference ids, seeded with builtin ids', () => {
        const field = fieldOf('Cosmoteer.Simulation.EffectFilter', 'ExcludePartCategories')!;
        const example = fieldExampleMarkdown(field)!;
        expect(example).toContain('ExcludePartCategories = [ftl, ...]');
        expect(example).toContain('// PartCategory ids');
    });

    it('lists the element enum members, capped, in the signature of a list<enum> field', () => {
        const field = fieldOf('Cosmoteer.Ships.Parts.PartRules', 'DefaultEditorHotkey')!;
        expect(field.valueType.kind).toBe('list');
        const markdown = fieldSignatureMarkdown(field, 'Cosmoteer.Ships.Parts.PartRules');
        expect(markdown).toContain('one of:');
        // ViKey has 103 members; the listing caps and states the total instead of dumping all.
        expect(markdown).toContain('(103 total)');
        // And the example line shows the inline list form with real members.
        expect(markdown).toMatch(/DefaultEditorHotkey = \[\w+, \w+\]/);
    });

    it('renders a written-form example for a single asset field, naming the resolution rule', () => {
        const field = fieldOf('Cosmoteer.Ships.ShipRoofRules', 'DecalsShader')!;
        expect(field.valueType.kind).toBe('asset');
        const example = fieldExampleMarkdown(field)!;
        expect(example).toContain('DecalsShader = "effect.shader"');
        expect(example).toContain('// path relative to this file');
    });

    it('renders all three Color forms: positional, named color, and group', () => {
        const field = fieldOf('Halfling.Graphics.Sprite', 'VertexColor')!;
        const example = fieldExampleMarkdown(field)!;
        expect(example).toContain('VertexColor = [255, 255, 255, 255]');
        expect(example).toContain('// R, G, B, A');
        expect(example).toContain('// or a named color: VertexColor = White');
        expect(example).toContain('// or a group: VertexColor { Rf = 1, Gf = 1, Bf = 1, Af = 1 }');
    });

    it('uses the inline positional form for vector placeholders inside a block example', () => {
        const field = fieldOf('Cosmoteer.Ships.Parts.Weapons.TurretWeaponRules', 'BlueprintArcSprite')!;
        const example = fieldExampleMarkdown(field)!;
        // Sprite's Size is a Vector2: shown as `Size = [0, 0]`, not an opaque `Size { ... }`.
        expect(example).toMatch(/Size = \[0, 0\]/);
    });

    it('names the group alternative for a positional-form vector field', () => {
        const field = fieldOf('Halfling.Graphics.Sprite', 'Size')!;
        const example = fieldExampleMarkdown(field)!;
        expect(example).toContain('Size = [0, 0]');
        expect(example).toContain('// or: Size { X = 0, Y = 0 }');
    });

    it('renders no example for a plain scalar field', () => {
        const field = fieldOf('Cosmoteer.Bullets.BulletRules', 'ForgetTarget')!;
        expect(field.valueType.kind).toBe('bool');
        expect(fieldExampleMarkdown(field)).toBeUndefined();
    });

    it('flows into fieldSignatureMarkdown so hover and completion carry the example', () => {
        const field = fieldOf('Cosmoteer.Simulation.SimGuiRules', 'ShipSelectSound')!;
        const markdown = fieldSignatureMarkdown(field, 'Cosmoteer.Simulation.SimGuiRules');
        expect(markdown).toContain('```rules');
        // The signature head still leads the hover.
        expect(markdown).toContain('**ShipSelectSound**');
    });
});
