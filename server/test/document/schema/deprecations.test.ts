import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    allDeprecationSymbols,
    deprecatedDiscriminator,
    deprecatedField,
    deprecatedEnumValue,
    DEPRECATED_ENUM_VALUES,
    deprecationBySymbol,
    obsoleteField,
    RENAMED_MOD_RULES_FIELDS,
    renamedFieldAlias,
} from '../../../src/document/schema/deprecations';
import { enumDef } from '../../../src/document/schema/schema';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';

// Every deprecation lookup is keyed by a name the modder wrote, so the key can be anything a file
// can spell, including the name of a member that a plain object inherits from `Object.prototype`.
// Lower-casing leaves `constructor` and `__proto__` unchanged, which used to make the lookup answer
// with an inherited member: truthy, without the fields of an entry, so reading the entry threw and
// took the whole validation pass of that file with it.
const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;
const PROTOTYPE_NAMES = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];
const KINDS = ['discriminator', 'deletedField', 'renamedAlias', 'obsoleteField', 'manifestField', 'enumValue'];
const PART_RULES = 'Cosmoteer.Ships.Parts.PartRules';

describe('deprecation registries', () => {
    it('treats an inherited member name as an unknown name', () => {
        for (const name of PROTOTYPE_NAMES) {
            expect(deprecatedDiscriminator(name), name).toBeUndefined();
            expect(deprecatedField(PART_RULES, name), name).toBeUndefined();
            expect(renamedFieldAlias(PART_RULES, name), name).toBeUndefined();
            expect(obsoleteField(PART_RULES, name), name).toBeUndefined();
            expect(RENAMED_MOD_RULES_FIELDS[name], name).toBeUndefined();
        }
    });

    it('treats a migration symbol carrying an inherited member name as unknown', () => {
        for (const kind of KINDS)
            for (const name of PROTOTYPE_NAMES) {
                const symbol = `${kind}:${name.toLowerCase()}`;
                expect(deprecationBySymbol(symbol), symbol).toBeUndefined();
            }
    });

    it('still resolves the entries it holds', () => {
        expect(deprecatedDiscriminator('AmmoDrain')?.replacement).toBe('ResourceDrain');
        expect(deprecatedField(PART_RULES, 'Flammable')?.name).toBe('Flammable');
        expect(renamedFieldAlias(PART_RULES, 'CreatePartWhenDestroyed')?.replacement).toBe('UnderlyingPart');
        expect(obsoleteField(PART_RULES, 'ExplosiveDamageResistance')?.replacement).toBe('DamageResistances');
        expect(RENAMED_MOD_RULES_FIELDS['modifiesmultiplayer']?.replacement).toBe('ModifiesGameplay');
        expect(deprecationBySymbol('renamedAlias:createpartwhendestroyed')?.replacement).toBe('UnderlyingPart');
    });

    it('keeps its keys enumerable', () => {
        expect(Object.keys(RENAMED_MOD_RULES_FIELDS)).toEqual(['modifiesmultiplayer']);
        expect(Object.entries(RENAMED_MOD_RULES_FIELDS)[0][1].replacement).toBe('ModifiesGameplay');
        expect(allDeprecationSymbols()).toContain('deletedField:flammable');
        expect(allDeprecationSymbols()).toContain('discriminator:ammodrain');
        expect(allDeprecationSymbols().every((symbol) => deprecationBySymbol(symbol))).toBe(true);
    });

    // The enum-rename registry is empty, so this guards whatever is added to it rather than what it
    // holds today: an entry naming a member the enum still has, or a replacement it does not, would
    // report a rename the game never made.
    it('keeps every recorded enum rename pointing from a gone member to a real one', () => {
        for (const [key, entry] of Object.entries(DEPRECATED_ENUM_VALUES)) {
            expect(key, key).toBe(entry.name.toLowerCase());
            for (const enumName of entry.enumNames) {
                const members = enumDef(enumName)?.members ?? [];
                expect(members, enumName).not.toHaveLength(0);
                expect(members, `${enumName}.${entry.name}`).not.toContain(entry.name);
                expect(members, `${enumName}.${entry.replacement}`).toContain(entry.replacement);
            }
            expect(deprecatedEnumValue(entry.enumNames[0], entry.name)?.replacement).toBe(entry.replacement);
        }
    });

    it('validates a part that assigns fields named after inherited members', async () => {
        const SRC = 'Part\n{\n\tconstructor = 1\n\t__proto__ = 2\n\tCreatePartWhenDestroyed = something\n}';
        const errors = await validateSchema(parse(SRC), token);
        // The rename written beside them is still reported, so the file did reach the lookups.
        expect(errors.some((error) => error.message.includes("'CreatePartWhenDestroyed' was renamed"))).toBe(true);
    });
});
