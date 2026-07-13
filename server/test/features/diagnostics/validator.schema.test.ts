import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import { fieldOf, schema } from '../../../src/document/schema/schema';

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

const comp = (type: string, body: string) =>
    `Part\n{\n\tComponents\n\t{\n\t\tX\n\t\t{\n\t\t\tType = ${type}\n${body}\n\t\t}\n\t}\n}`;

describe('validateSchema — bare valueless fields (void = null)', () => {
    it('flags a bare field whose C# type is a non-nullable value type (bool)', async () => {
        const errors = await validateSchema(parse(comp('MultiToggle', '\t\t\tInvert')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('no value');
        expect(errors[0].severity).toBe('warning');
    });

    it('flags a bare non-nullable struct group field (Vector2)', async () => {
        const errors = await validateSchema(parse(comp('Airlock', '\t\t\tEnterExitPoint')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('EnterExitPoint');
    });

    it('accepts a bare field whose type tolerates null (nullable member)', async () => {
        expect(await validateSchema(parse(comp('TurretWeapon', '\t\t\tFiringArc')), token)).toHaveLength(0);
    });

    it('stays silent for a bare name the schema does not know', async () => {
        expect(await validateSchema(parse(comp('MultiToggle', '\t\t\tNotAField')), token)).toHaveLength(0);
    });
});

describe('validateSchema — positional elements of a group-typed field in list form', () => {
    it('flags a fractional element in an IntVector2 written as a list', async () => {
        const errors = await validateSchema(parse(comp('DoorPresenceToggle', '\t\t\tAdjacentCell = [1.5, 2]')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('whole number');
    });

    it('checks the identifier-list spelling the same way', async () => {
        const errors = await validateSchema(
            parse(comp('DoorPresenceToggle', '\t\t\tAdjacentCell\n\t\t\t[\n\t\t\t\t1.5\n\t\t\t\t2\n\t\t\t]')),
            token
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('whole number');
    });

    it('accepts whole-number elements', async () => {
        expect(
            await validateSchema(parse(comp('DoorPresenceToggle', '\t\t\tAdjacentCell = [1, 2]')), token)
        ).toHaveLength(0);
    });

    it('leaves float components (Vector2) alone', async () => {
        expect(await validateSchema(parse(comp('Airlock', '\t\t\tEnterExitPoint = [1.5, 2]')), token)).toHaveLength(0);
    });

    // `EditorParentParts` is a `list<EditorParentPart>` whose entries are positional lists
    // (`[part, sortOrder]`), so the sort order reads through the entry class's int digit field `"1"`.
    it('checks positional entries of a list<group> field (EditorParentParts sort order)', async () => {
        const errors = await validateSchema(parse('Part\n{\n\tEditorParentParts = [ [other_part, 1.5] ]\n}'), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('whole number');
        expect(await validateSchema(parse('Part\n{\n\tEditorParentParts = [ [other_part, 1] ]\n}'), token)).toHaveLength(0);
    });

    // An inheriting list appends its local elements after the inherited ones, so local index 0 is
    // not game index 0 and the check must stay silent rather than guess.
    it('skips an inheriting positional list (indexes are shifted by the base)', async () => {
        const src = comp('DoorPresenceToggle', '\t\t\tAdjacentCell : ../SomeBase\n\t\t\t[\n\t\t\t\t1.5\n\t\t\t]');
        expect(await validateSchema(parse(src), token)).toHaveLength(0);
    });

    it('flags extra elements beyond the class’s digit fields as never read (not as fractions)', async () => {
        const src = comp('DoorPresenceToggle', '\t\t\tAdjacentCell = [1, 2, 3.5]');
        const errors = await validateSchema(parse(src), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('never reads');
        expect(errors[0].message).not.toContain('whole number');
    });

    it('leaves percentages and unresolvable references alone', async () => {
        expect(
            await validateSchema(parse(comp('DoorPresenceToggle', '\t\t\tAdjacentCell = [50%, 2]')), token)
        ).toHaveLength(0);
        expect(
            await validateSchema(parse(comp('DoorPresenceToggle', '\t\t\tAdjacentCell = [&/UNKNOWN/REF, 2]')), token)
        ).toHaveLength(0);
    });
});

describe('validateSchema — math in a textual field', () => {
    // ResourceConsumer's OverridePriorityName is a schema `string` field; the game reads its value
    // literally and never evaluates math, so a computable expression there is a silent bug.
    const consumer = (value: string) =>
        `Part\n{\n\tComponents\n\t{\n\t\tX\n\t\t{\n\t\t\tType = ResourceConsumer\n\t\t\tOverridePriorityName = ${value}\n\t\t}\n\t}\n}`;

    it('flags a function call on a string field', async () => {
        const errors = await validateSchema(parse(consumer('ceil(2)')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('OverridePriorityName');
        expect(errors[0].message).toContain('literal text');
        expect(errors[0].severity).toBe('warning');
    });

    it('flags a math expression on a string field', async () => {
        const errors = await validateSchema(parse(consumer('2 * 3')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('literal text');
    });

    it('leaves parenthesized text alone (does not evaluate to a number)', async () => {
        expect(await validateSchema(parse(consumer('Big (Mk2)')), token)).toHaveLength(0);
    });

    it('leaves an expression over unresolved references alone', async () => {
        expect(await validateSchema(parse(consumer('ceil(&Nowhere/Ref)')), token)).toHaveLength(0);
    });

    it('does not flag math on a numeric field', async () => {
        const source =
            'Part\n{\n\tComponents\n\t{\n\t\tX\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\tTargetingRange = ceil(2) * 3\n\t\t}\n\t}\n}';
        expect(await validateSchema(parse(source), token)).toHaveLength(0);
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
        // Def is written in its real group form: a scalar there would now (correctly) trip the
        // structural form check, and this test is about root disambiguation only.
        const doc = parse(
            'Type = Particles\nDef\n{\n}\nBucket = Normal\n',
            'file:///c%3A/mod/doodads/particles/p.rules'
        );
        expect(await validateSchema(doc, token)).toHaveLength(0);
    });
});

describe('validateSchema — named members inside a group-typed list form', () => {
    // EnterExitPoint/UITileRect are group-typed (Vector2/Rect) fields of the Airlock component, so a
    // list value reads through the class's digit or member names; anything else is silently dead.
    const airlock = (body: string) => comp('Airlock', body);

    it('flags a field of the enclosing group written inside the brackets (identified-list spelling)', async () => {
        // The real-world trap this guards: `Offset [Scale2In = offset]` in a particle renderer,
        // where the channel binding belongs one level up and the game never reads it.
        const errors = await validateSchema(parse(airlock('\t\t\tEnterExitPoint [EntryToggle = x]')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('EntryToggle');
        expect(errors[0].message).toContain('Vector2');
        expect(errors[0].message).toContain('outside');
        expect(errors[0].message).toContain('EnterExitPoint');
        expect(errors[0].severity).toBe('warning');
    });

    it('flags the assignment spelling (`Field = [ … ]`) the same way', async () => {
        const errors = await validateSchema(parse(airlock('\t\t\tEnterExitPoint = [EntryToggle = x]')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('outside');
    });

    it('attaches a did-you-mean quick-fix for a near-miss member name', async () => {
        const errors = await validateSchema(parse(airlock('\t\t\tUITileRect [Widht = 1]')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].data?.quickFix?.newText).toBe('Width');
    });

    it('accepts positional elements and the class’s own members written by name', async () => {
        expect(await validateSchema(parse(airlock('\t\t\tEnterExitPoint [0.5, 1]')), token)).toHaveLength(0);
        expect(await validateSchema(parse(airlock('\t\t\tEnterExitPoint [X = 0.5, Y = 1]')), token)).toHaveLength(0);
    });

    it('stays silent when the field itself is unknown to the schema', async () => {
        expect(await validateSchema(parse(airlock('\t\t\tNotAField [Whatever = 1]')), token)).toHaveLength(0);
    });
});

describe('validateSchema — extra positional elements in a group-typed list form', () => {
    const airlock = (body: string) => comp('Airlock', body);

    it('flags every element past the class digit fields (Vector2 reads two)', async () => {
        const errors = await validateSchema(
            parse(airlock('\t\t\tEnterExitPoint [0, 1, 2, 3, 4, 5, 6, 7]')),
            token
        );
        expect(errors).toHaveLength(6);
        expect(errors[0].message).toContain('Vector2');
        expect(errors[0].message).toContain('first 2');
        expect(errors[0].severity).toBe('warning');
    });

    it('accepts a list that exactly fills the digit fields (Rect reads four)', async () => {
        expect(await validateSchema(parse(airlock('\t\t\tUITileRect [1, 2, 3, 4]')), token)).toHaveLength(0);
        expect(await validateSchema(parse(airlock('\t\t\tUITileRect [1, 2, 3, 4, 5]')), token)).toHaveLength(1);
    });

    it('stays silent on an inheriting list, whose local indices are not the game indices', async () => {
        const doc = parse(airlock('\t\t\tBase = [1, 2]\n\t\t\tEnterExitPoint : ~/Base [3, 4, 5]'));
        const errors = await validateSchema(doc, token);
        expect(errors.filter((e) => e.message.includes('list elements'))).toHaveLength(0);
    });
});

describe('validateSchema — structural form mismatches (value shape the deserializer never reads)', () => {
    const airlock = (body: string) => comp('Airlock', body);

    it('flags a list written into a bool field', async () => {
        const errors = await validateSchema(parse(comp('MultiToggle', '\t\t\tInvert = [true]')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('cannot read a list');
        expect(errors[0].severity).toBe('warning');
    });

    it('flags a list written into a string field, in the identified-list spelling too', async () => {
        const errors = await validateSchema(parse('Part\n{\n\tID [a, b]\n}'), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('cannot read a list');
    });

    it('flags a list written into a reference field', async () => {
        const errors = await validateSchema(parse(airlock('\t\t\tEntryToggle = [a, b]')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('cannot read a list');
    });

    it('flags a group written into a plain float field', async () => {
        const errors = await validateSchema(
            parse(airlock('\t\t\tUITileRect\n\t\t\t{\n\t\t\t\tWidth\n\t\t\t\t{\n\t\t\t\t}\n\t\t\t}')),
            token
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('cannot read a group');
    });

    it('accepts a Modifiable scalar written in its group form', async () => {
        const src = `Part\n{\n\tComponents\n\t{\n\t\tT\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\tTargetingRange\n\t\t\t{\n\t\t\t\tBaseValue = 5\n\t\t\t}\n\t\t}\n\t}\n}`;
        expect(await validateSchema(parse(src), token)).toHaveLength(0);
    });

    it('accepts enum lists (flags enums) and map entry lists, which the game reads', async () => {
        expect(await validateSchema(parse('Part\n{\n\tExternalWalls = [Left, Right]\n}'), token)).toHaveLength(0);
        expect(
            await validateSchema(parse('Part\n{\n\tExternalWallsByCell\n\t[\n\t\t[0, 0]\n\t]\n}'), token)
        ).toHaveLength(0);
    });

    it('flags the extra endpoint of a range written with three elements', async () => {
        const errors = await validateSchema(parse(airlock('\t\t\tNuggetEjectVelocity = [1, 2, 3]')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('only 2');
    });

    it('leaves a range with a math element alone (parser sees more elements than the game)', async () => {
        expect(
            await validateSchema(parse(airlock('\t\t\tNuggetEjectVelocity = [1, (7 / 2), 3]')), token)
        ).toHaveLength(0);
    });
});

describe('validateSchema — scalar written into a group-typed field', () => {
    const airlock = (body: string) => comp('Airlock', body);

    it('flags a plain value on a group field without a scalar form (Vector2)', async () => {
        const errors = await validateSchema(parse(airlock('\t\t\tEnterExitPoint = 5')), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('cannot read a plain value');
        expect(errors[0].severity).toBe('warning');
    });

    it('flags a plain value on a map field', async () => {
        const errors = await validateSchema(parse('Part\n{\n\tExternalWallsByCell = 5\n}'), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('cannot read a plain value');
    });

    it('accepts the harvested scalar-form classes (Time reads plain seconds)', async () => {
        expect(
            await validateSchema(parse(airlock('\t\t\tNuggetEjectDoorOpenDuration = 0.5')), token)
        ).toHaveLength(0);
    });

    it('accepts a reference value on any group field', async () => {
        expect(await validateSchema(parse(airlock('\t\t\tEnterExitPoint = &SomeRef')), token)).toHaveLength(0);
    });
});

describe('validateSchema — engine value forms extracted by schemagen', () => {
    it('flags any scalar on a plain Rect field (anchor presets are a per-field override, not a Rect form)', async () => {
        // AnchorPresets.Serializer is attached via [Serialize(OverrideDeserializer = …)] on
        // Widget.AnchorRect only, so a preset name on any other Rect field throws in game.
        expect(await validateSchema(parse(comp('Airlock', '\t\t\tUITileRect = TopLeft')), token)).toHaveLength(1);
        expect(await validateSchema(parse(comp('Airlock', '\t\t\tUITileRect = 5')), token)).toHaveLength(1);
    });

    it('carries the field-level preset form on Widget.AnchorRect in the schema', () => {
        expect(fieldOf('Halfling.Gui.Widget', 'AnchorRect')?.scalarStringForm).toBe(true);
    });

    it('accepts the list spelling of a list-delegating value form and still flags its scalar', async () => {
        // StatusType.ApplicationEffects is a MultiHitEffectRules, whose [Serialize(Alias = "")]
        // member is an effect array: the list spelling is read directly (its members are not the
        // class's fields), while a plain scalar still has nothing to bind to.
        const status = (body: string) =>
            parse(`ID = cosmoteer.test\nLayer = Part\nStatusCombineMode = ApplyNewInstance\n${body}\n`, 'file:///c%3A/mod/statuses/test.rules');
        expect(await validateSchema(status('ApplicationEffects [ Foo = 1 ]'), token)).toHaveLength(0);
        const errors = await validateSchema(status('ApplicationEffects = 5'), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('cannot read a plain value');
    });

    it('models a group-typed empty-alias member as an inline expansion, not a group value form', () => {
        // PartChainableProxyRules embeds the group-only ProxyRules with an empty alias: its fields
        // are written inline (merged at load via `inlineFrom`), and the scalar resolution follows
        // the delegation and still refuses a scalar. A scalar-reading value form (ShipFile's path
        // string) stays a valueForm.
        const proxy = schema.types['Cosmoteer.Ships.Parts.Logic.PartChainableProxyRules'];
        expect(proxy?.valueForm).toBeUndefined();
        expect(proxy?.inlineFrom).toContain('Cosmoteer.Ships.Parts.Logic.ProxyRules');
        // The inline merge happened: the proxy's own field set carries ProxyRules' members.
        expect(proxy?.fields.some((f) => f.name === 'ComponentID')).toBe(true);
        expect(schema.types['Cosmoteer.Ships.ShipFile']?.valueForm?.kind).toBe('string');
    });

    it('merges the full effective field set of an inline source, including its extends ancestry', () => {
        // TextSprite embeds Halfling.Graphics.Sprite with an empty alias, and Sprite extends
        // Halfling.Graphics.Material: the base's members (Texture, Color, Shader, …) are written
        // directly in a TextSprite group (vanilla gui/text_sprites.rules writes Texture that way).
        expect(fieldOf('Cosmoteer.Data.TextSprite', 'Texture')).toBeDefined();
        expect(fieldOf('Cosmoteer.Data.TextSprite', 'Color')).toBeDefined();
        // The source's own fields still merge as before.
        expect(fieldOf('Cosmoteer.Data.TextSprite', 'Size')).toBeDefined();
    });
});

describe('validateSchema — value-form list elements resolve their registry', () => {
    const status = (body: string) =>
        parse(
            `ID = cosmoteer.test\nLayer = Part\nStatusCombineMode = ApplyNewInstance\n${body}\n`,
            'file:///c%3A/mod/statuses/test.rules'
        );

    it('flags an invalid Type inside a delegated effect list', async () => {
        const errors = await validateSchema(status('ApplicationEffects\n[\n\t{\n\t\tType = Nonsense\n\t}\n]'), token);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('Nonsense');
        expect(errors[0].message).toContain('HitEffectRules');
    });

    it('accepts a valid element type', async () => {
        expect(
            await validateSchema(status('ApplicationEffects\n[\n\t{\n\t\tType = ExplosiveDamage\n\t}\n]'), token)
        ).toHaveLength(0);
    });
});
