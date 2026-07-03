import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';

const token = CancellationToken.None;
const parse = (src: string, uri = 'file:///t.rules') => parser(lexer(src), uri).value;

const wrap = (body: string) => `Part\n{\n\tComponents\n\t{\n\t\tX\n\t\t{\n\t\t\tType = MultiToggle\n${body}\n\t\t}\n\t}\n}`;

describe('validateSchema — invalid enum values', () => {
    it('flags an enum value that is not a member', async () => {
        const doc = parse(wrap('\t\t\tMode = Nonsense'));
        const errors = await validateSchema(doc, token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Nonsense');
        expect(errors[0].message).toContain('MultiToggleMode');
        expect(errors[0].severity).toBe('warning');
    });

    it('accepts a valid enum value written exactly', async () => {
        expect(await validateSchema(parse(wrap('\t\t\tMode = All')), token)).toHaveLength(0);
    });

    it('flags a case-only enum mismatch with a casing quick-fix (Enum.Parse is case-sensitive in game)', async () => {
        const errors = await validateSchema(parse(wrap('\t\t\tMode = any')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('casing');
        expect(errors[0].data?.quickFix?.newText).toBe('Any');
    });

    it('accepts every boolean word the game parses (true/yes/y/false/no/n, any case)', async () => {
        for (const word of ['true', 'YES', 'y', 'false', 'No', 'N']) {
            expect(await validateSchema(parse(wrap(`\t\t\tInvert = ${word}`)), token)).toHaveLength(0);
        }
        const errors = await validateSchema(parse(wrap('\t\t\tInvert = maybe')), token);
        expect(errors).toHaveLength(1);
    });

    it('attaches a did-you-mean quick-fix for a near-miss enum value', async () => {
        const errors = await validateSchema(parse(wrap('\t\t\tMode = Non')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].data?.quickFix?.newText).toBe('None');
    });

    it('does not flag non-enum fields or references', async () => {
        // Invert is a bool, ViaBuffs/Toggles are not enums — none should error.
        const doc = parse(wrap('\t\t\tInvert = true\n\t\t\tMode = &SomeRef'));
        expect(await validateSchema(doc, token)).toHaveLength(0);
    });

    it('ignores mod.rules documents', async () => {
        const doc = parse(wrap('\t\t\tMode = Nonsense'), 'file:///mod.rules');
        expect(await validateSchema(doc, token)).toHaveLength(0);
    });
});

describe('validateSchema — deprecated (renamed) discriminator', () => {
    // A component whose `Type=` is a value that was renamed in a newer game version (a mod written
    // against an older Cosmoteer). `Components` is a PartComponentRules slot, so the discriminator is
    // validated against that registry.
    // A valid sibling (`Known`) pins the container's registry to PartComponentRules (the container is
    // custom-deserialized, so a sibling's valid `Type` is what identifies the registry), then the `X`
    // component's `Type` is validated against it — mirroring how real component files are structured.
    const partWith = (type: string) =>
        `Part\n{\n\tComponents\n\t{\n\t\tKnown\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t}\n\t\tX\n\t\t{\n\t\t\tType = ${type}\n\t\t}\n\t}\n}`;

    it('flags a renamed type with the current name and offers it as a quick fix', async () => {
        const errors = await validateSchema(parse(partWith('AmmoChange')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('AmmoChange');
        expect(errors[0].message).toContain('renamed');
        expect(errors[0].message).toContain('ResourceChange');
        expect(errors[0].severity).toBe('warning');
        expect(errors[0].data?.quickFix?.newText).toBe('ResourceChange');
    });

    it('accepts the current name with no warning', async () => {
        expect(await validateSchema(parse(partWith('ResourceChange')), token)).toHaveLength(0);
    });

    it('still gives a generic did-you-mean for an unrelated invalid type', async () => {
        const errors = await validateSchema(parse(partWith('TurretWeapn')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('is not a valid');
        expect(errors[0].data?.quickFix?.newText).toBe('TurretWeapon');
    });
});

describe('validateSchema — invalid boolean values', () => {
    // ReturnToCenter is a bool field on TurretWeaponRules.
    const turret = (body: string) =>
        `Part\n{\n\tComponents\n\t{\n\t\tT\n\t\t{\n\t\t\tType = TurretWeapon\n${body}\n\t\t}\n\t}\n}`;

    it('flags a bool field written as a non-true/false bare word, with a did-you-mean', async () => {
        const errors = await validateSchema(parse(turret('\t\t\tReturnToCenter = Tru')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Tru');
        expect(errors[0].message).toContain('boolean');
        expect(errors[0].data?.quickFix?.newText).toBe('true');
    });

    it('accepts true/false case-insensitively', async () => {
        expect(await validateSchema(parse(turret('\t\t\tReturnToCenter = true')), token)).toHaveLength(0);
        expect(await validateSchema(parse(turret('\t\t\tReturnToCenter = False')), token)).toHaveLength(0);
    });
});

describe('validateSchema — non-numeric value in a numeric field', () => {
    // RotateSpeed/FiringArc are numeric (angle) fields on TurretWeaponRules; `Direction` and `Angle`
    // both map to the `number` kind, so a bare word that is not a number/reference/expression is wrong.
    const turret = (body: string) =>
        `Part\n{\n\tComponents\n\t{\n\t\tT\n\t\t{\n\t\t\tType = TurretWeapon\n${body}\n\t\t}\n\t}\n}`;

    it('flags a numeric field written as a bare word', async () => {
        const errors = await validateSchema(parse(turret('\t\t\tRotateSpeed = Fast')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Fast');
        expect(errors[0].message).toContain('valid number');
        expect(errors[0].severity).toBe('warning');
    });

    it('accepts numbers, the degree suffix, references and parenthesized expressions', async () => {
        expect(await validateSchema(parse(turret('\t\t\tRotateSpeed = 90')), token)).toHaveLength(0);
        expect(await validateSchema(parse(turret('\t\t\tFiringArc = 45d')), token)).toHaveLength(0);
        expect(await validateSchema(parse(turret('\t\t\tFiringArc = -90d')), token)).toHaveLength(0);
        expect(await validateSchema(parse(turret('\t\t\tRotateSpeed = &SomeAngle')), token)).toHaveLength(0);
        expect(await validateSchema(parse(turret('\t\t\tFiringArc = (90d * 2)')), token)).toHaveLength(0);
    });

    it('does not flag a bare math keyword/constant (it is a valid expression)', async () => {
        expect(await validateSchema(parse(turret('\t\t\tFiringArc = max')), token)).toHaveLength(0);
        expect(await validateSchema(parse(turret('\t\t\tFiringArc = pi')), token)).toHaveLength(0);
    });
});

describe('validateSchema — integer-only field resolving to a fraction', () => {
    // BlueprintArcSpriteSegments is an `int` primitive and TargetChecksPerSearch a `ModifiableInt` on
    // TurretWeaponRules — both require a whole number. The check RESOLVES the value (math + references)
    // before judging it, and stays silent on anything it cannot reduce to a concrete number.
    const turret = (body: string) =>
        `Part\n{\n\tComponents\n\t{\n\t\tT\n\t\t{\n\t\t\tType = TurretWeapon\n${body}\n\t\t}\n\t}\n}`;

    it('flags a fractional literal', async () => {
        const errors = await validateSchema(parse(turret('\t\t\tBlueprintArcSpriteSegments = 3.5')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('whole number');
        expect(errors[0].message).toContain('3.5');
        expect(errors[0].severity).toBe('warning');
    });

    it('flags a math expression that evaluates to a fraction', async () => {
        const errors = await validateSchema(parse(turret('\t\t\tBlueprintArcSpriteSegments = (7 / 2)')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('3.5');
    });

    it('flags a fractional value reached through a reference', async () => {
        const errors = await validateSchema(
            parse(turret('\t\t\tHalf = 3.5\n\t\t\tBlueprintArcSpriteSegments = &Half')),
            token
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('3.5');
    });

    it('flags a ModifiableInt field too', async () => {
        const errors = await validateSchema(parse(turret('\t\t\tTargetChecksPerSearch = 2.5')), token);
        expect(errors).toHaveLength(1);
    });

    it('accepts whole numbers, whole-valued expressions and the percent escape', async () => {
        expect(await validateSchema(parse(turret('\t\t\tBlueprintArcSpriteSegments = 4')), token)).toHaveLength(0);
        expect(await validateSchema(parse(turret('\t\t\tBlueprintArcSpriteSegments = (8 / 2)')), token)).toHaveLength(0);
        expect(await validateSchema(parse(turret('\t\t\tBlueprintArcSpriteSegments = 50%')), token)).toHaveLength(0);
    });

    it('stays silent on an unresolvable reference (no false positive)', async () => {
        expect(
            await validateSchema(parse(turret('\t\t\tBlueprintArcSpriteSegments = &NoSuchThing')), token)
        ).toHaveLength(0);
    });

    it('stays silent on a bare named constant in an int field (e.g. an enum-like int)', async () => {
        // `int`-kind primitives accept named values that resolve to nothing numeric — never flagged.
        expect(
            await validateSchema(parse(turret('\t\t\tDefaultDirectControlBinding = SomeName')), token)
        ).toHaveLength(0);
    });
});

describe('validateSchema — Range<int> endpoints', () => {
    // ModeRange is a `Range<int>` on PartModeCycleRules (a `Components` member, Type = ModeCycle).
    const cycle = (body: string) =>
        `Part\n{\n\tComponents\n\t{\n\t\tM\n\t\t{\n\t\t\tType = ModeCycle\n${body}\n\t\t}\n\t}\n}`;

    it('flags a fractional endpoint in a [from, to] list', async () => {
        const errors = await validateSchema(parse(cycle('\t\t\tModeRange = [1, 2.5]')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('2.5');
        expect(errors[0].message).toContain('whole number');
    });

    it('flags a fractional endpoint reached through math', async () => {
        const errors = await validateSchema(parse(cycle('\t\t\tModeRange = [1, (7 / 2)]')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('3.5');
    });

    it('flags a fractional endpoint reached through a reference', async () => {
        const errors = await validateSchema(parse(cycle('\t\t\tHalf = 3.5\n\t\t\tModeRange = [1, &Half]')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('3.5');
    });

    it('flags a fractional scalar (min == max) range value', async () => {
        const errors = await validateSchema(parse(cycle('\t\t\tModeRange = 2.5')), token);
        expect(errors).toHaveLength(1);
    });

    it('accepts whole-number endpoints', async () => {
        expect(await validateSchema(parse(cycle('\t\t\tModeRange = [1, 3]')), token)).toHaveLength(0);
        expect(await validateSchema(parse(cycle('\t\t\tModeRange = 4')), token)).toHaveLength(0);
    });

    it('does NOT flag a descending [from, to] pair (ordering is not a range constraint)', async () => {
        expect(await validateSchema(parse(cycle('\t\t\tModeRange = [3, 1]')), token)).toHaveLength(0);
    });

    it('stays silent on an unresolvable endpoint (no false positive)', async () => {
        expect(await validateSchema(parse(cycle('\t\t\tModeRange = [1, &Unknown]')), token)).toHaveLength(0);
    });
});

describe('validateSchema — invalid Type= discriminators', () => {
    // A Components container whose registry (PartComponentRules) is proven by a valid sibling.
    const comps = (typo: string) =>
        `Part\n{\n\tComponents\n\t{\n\t\tIsOp\n\t\t{\n\t\t\tType = MultiToggle\n\t\t}\n\t\tTurret\n\t\t{\n\t\t\tType = ${typo}\n\t\t}\n\t}\n}`;

    it('flags a Type value that is not a registry member, with a did-you-mean', async () => {
        const errors = await validateSchema(parse(comps('TurretWeapn')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('TurretWeapn');
        expect(errors[0].message).toContain('PartComponentRules');
        expect(errors[0].severity).toBe('warning');
        expect(errors[0].data?.quickFix?.newText).toBe('TurretWeapon');
    });

    it('does not flag a valid Type (nor the proving sibling)', async () => {
        expect(await validateSchema(parse(comps('TurretWeapon')), token)).toHaveLength(0);
    });

    it('does not flag when the container registry cannot be inferred (lone unknown group)', async () => {
        // No slot, no valid sibling → registry unknown → conservatively silent.
        const doc = parse('Foo\n{\n\tBar\n\t{\n\t\tType = Whatever\n\t}\n}');
        expect(await validateSchema(doc, token)).toHaveLength(0);
    });
});

describe('validateSchema — whole-file-root top-level Type=', () => {
    const doodad = (type: string) => parse(`ID = test\nType = ${type}\nAllegiance = Neutral\n`, 'file:///c%3A/mod/doodads/x/test.rules');

    it('flags an invalid top-level Type in a doodad file, with a did-you-mean', async () => {
        const errors = await validateSchema(doodad('GeneratedShp'), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('GeneratedShp');
        expect(errors[0].message).toContain('DoodadRules');
        expect(errors[0].data?.quickFix?.newText).toBe('GeneratedShip');
    });

    it('accepts a valid top-level Type', async () => {
        expect(await validateSchema(doodad('GeneratedShip'), token)).toHaveLength(0);
    });

    it('does not flag an effect file living under /doodads/ (content pins MediaEffect, not DoodadRules)', async () => {
        const doc = parse('Type = Particles\nDef = "x"\nBucket = Normal\n', 'file:///c%3A/mod/doodads/particles/p.rules');
        expect(await validateSchema(doc, token)).toHaveLength(0);
    });
});
