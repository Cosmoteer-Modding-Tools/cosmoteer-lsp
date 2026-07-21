import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';

// Fields the game renamed but still accepts under the old spelling (schema aliases), and fields
// superseded by richer ones. Both deserialize fine, so only the deprecations registry surfaces
// them, as version-carrying modernization hints with a mechanical fix where one is safe.
const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///data/parts/t.rules').value;

describe('renamed field aliases', () => {
    it('hints the pre-rename spelling with the game version and a rename fix', async () => {
        const doc = parse('Part\n{\n\tCreatePartWhenDestroyed = cosmoteer.structure\n}\n');
        const errors = await validateSchema(doc, token);
        const hit = errors.find((e) => e.message.includes('CreatePartWhenDestroyed'));
        expect(hit).toBeTruthy();
        expect(hit!.message).toContain("renamed to 'UnderlyingPart' in game version 0.23.0");
        expect(hit!.severity).toBe('hint');
        expect(hit!.data?.quickFix?.newText).toBe('UnderlyingPart');
        expect(hit!.data?.migration?.apply).toBe('quickFix');
    });

    it('stays silent on the modern spelling', async () => {
        const doc = parse('Part\n{\n\tUnderlyingPart = cosmoteer.structure\n}\n');
        const errors = await validateSchema(doc, token);
        expect(errors.filter((e) => e.message.includes('UnderlyingPart'))).toEqual([]);
    });

    it('finds the rename on a derived weapon class via the ancestry walk', async () => {
        const doc = parse(
            'Part\n{\n\tComponents\n\t{\n\t\tGun\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\tIgnoreSourceShipLowLOSChecks = true\n\t\t}\n\t}\n}\n'
        );
        const errors = await validateSchema(doc, token);
        const hit = errors.find((e) => e.message.includes('IgnoreSourceShipLowLOSChecks'));
        expect(hit).toBeTruthy();
        expect(hit!.data?.quickFix?.newText).toBe('IgnoreFriendlyShipLowLOSChecks');
    });

    it('reports for manual review when the modern spelling is already assigned beside it', async () => {
        const doc = parse(
            'Part\n{\n\tCreatePartWhenDestroyed = cosmoteer.structure\n\tUnderlyingPart = cosmoteer.structure\n}\n'
        );
        const errors = await validateSchema(doc, token);
        const hit = errors.find((e) => e.message.includes('CreatePartWhenDestroyed'));
        expect(hit).toBeTruthy();
        expect(hit!.data?.quickFix).toBeUndefined();
        expect(hit!.data?.migration?.apply).toBeUndefined();
    });
});

describe('obsolete fields', () => {
    it('rewrites ExplosiveDamageResistance into a DamageResistances map', async () => {
        const doc = parse('Part\n{\n\tExplosiveDamageResistance = 0.4\n}\n');
        const errors = await validateSchema(doc, token);
        const hit = errors.find((e) => e.message.includes('ExplosiveDamageResistance'));
        expect(hit).toBeTruthy();
        expect(hit!.message).toContain("superseded by 'DamageResistances' in game version 0.24.0");
        expect(hit!.severity).toBe('hint');
        expect(hit!.data?.migration?.apply).toBe('rewrite');
        const edits = hit!.data?.rewrite?.edits ?? [];
        expect(edits.map((e) => e.newText)).toEqual(['DamageResistances', '{ explosive = ', ' }']);
    });

    it('reports for manual review when a DamageResistances map already exists beside it', async () => {
        const doc = parse('Part\n{\n\tExplosiveDamageResistance = 0.4\n\tDamageResistances { fire = 0.5 }\n}\n');
        const errors = await validateSchema(doc, token);
        const hit = errors.find((e) => e.message.includes('ExplosiveDamageResistance'));
        expect(hit).toBeTruthy();
        expect(hit!.data?.rewrite).toBeUndefined();
        expect(hit!.data?.migration?.apply).toBeUndefined();
    });
});

describe('deprecated discriminators', () => {
    it('keeps the Ammo→Resource rename hint with its fix and migration tag', async () => {
        const doc = parse('Part\n{\n\tComponents\n\t{\n\t\tStore\n\t\t{\n\t\t\tType = AmmoStorage\n\t\t}\n\t}\n}\n');
        const errors = await validateSchema(doc, token);
        const hit = errors.find((e) => e.message.includes('AmmoStorage'));
        expect(hit).toBeTruthy();
        // The rename predates the recorded changelogs, so the message stays versionless.
        expect(hit!.message).toContain('a newer game version');
        expect(hit!.data?.quickFix?.newText).toBe('ResourceStorage');
        expect(hit!.data?.migration?.apply).toBe('quickFix');
    });
});
