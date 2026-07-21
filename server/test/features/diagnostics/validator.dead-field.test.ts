import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateIgnoredFields } from '../../../src/features/diagnostics/validator.ignored-field';

// Fields the game declares but provably never reads (the schema's `dead` flag, from schemagen's
// whole-assembly read scan) get the same dead-weight hint as unknown members, with the remove fix.
// Deleted fields recorded in the deprecations registry upgrade the hint with the game version and
// the migration, and carry the fix the workspace migration applies.
const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///data/parts/t.rules').value;

describe('dead declared fields', () => {
    it('hints a declared-but-never-read field with a remove fix', async () => {
        const doc = parse('Part\n{\n\tFireDamageFactor = 2\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('FireDamageFactor'));
        expect(hit).toBeTruthy();
        expect(hit!.message).toContain('never reads');
        expect(hit!.severity).toBe('hint');
        expect(hit!.data?.remove?.title).toContain('FireDamageFactor');
        expect(hit!.data?.migration).toBeUndefined();
    });

    it('hints a deleted field with its game version, migration note, and a remove fix', async () => {
        // The Meltdown update (0.30.0) deleted `Flammable` from PartRules and moved fire immunity
        // to the `non_flammable` part category. The hint must teach the migration, not just the
        // removal.
        const doc = parse('Part\n{\n\tFlammable = false\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit).toBeTruthy();
        expect(hit!.message).toContain('removed in game version 0.30.0');
        expect(hit!.message).toContain('TypeCategories = [non_flammable]');
        expect(hit!.severity).toBe('hint');
        expect(hit!.data?.remove?.title).toContain('Flammable');
    });

    it('rewrites Flammable = false into the local TypeCategories list', async () => {
        const doc = parse('Part\n{\n\tTypeCategories = [ammo_factory]\n\tFlammable = false\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit).toBeTruthy();
        expect(hit!.data?.migration?.apply).toBe('rewrite');
        const edits = hit!.data?.rewrite?.edits ?? [];
        expect(edits).toHaveLength(2);
        // One edit deletes the Flammable assignment, the other appends before the list closer.
        expect(edits[0].newText).toBe('');
        expect(edits[1].newText).toBe(', non_flammable');
    });

    it('appends into a bare-form TypeCategories list too', async () => {
        const doc = parse('Part\n{\n\tTypeCategories [ammo_factory]\n\tFlammable = false\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit!.data?.migration?.apply).toBe('rewrite');
    });

    it('reports Flammable = false without a local TypeCategories for manual review', async () => {
        // Writing a fresh `TypeCategories = [non_flammable]` would override an inherited category
        // list, so the migration must not fabricate one and the finding stays manual.
        const doc = parse('Part\n{\n\tFlammable = false\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit!.data?.migration).toBeTruthy();
        expect(hit!.data?.migration?.apply).toBeUndefined();
        expect(hit!.data?.rewrite).toBeUndefined();
    });

    it('sanctions plain removal for Flammable = true (the old default restated)', async () => {
        const doc = parse('Part\n{\n\tFlammable = true\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit!.data?.migration?.apply).toBe('remove');
    });

    it('renames a deleted field onto its same-shaped successor', async () => {
        // 0.26.1 deleted the two SuppressWholeShipTargetOverlays* weapon fields and folded their
        // functionality into existing same-shaped fields, so the migration renames instead of
        // removing.
        // TurretWeapon derives from WeaponRules, so the registry entry is found via the ancestry walk.
        const doc = parse(
            'Part\n{\n\tComponents\n\t{\n\t\tGun\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t\tSuppressWholeShipTargetOverlaysWhenTargetingShipRelativePoints = true\n\t\t}\n\t}\n}\n'
        );
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('SuppressWholeShipTargetOverlays'));
        expect(hit).toBeTruthy();
        expect(hit!.message).toContain('removed in game version 0.26.1');
        expect(hit!.data?.migration?.apply).toBe('rewrite');
        expect(hit!.data?.rewrite?.edits[0].newText).toBe('SuppressShipWideExplicitTargetsWhenTargetingShipRelativePoints');
    });

    it('sanctions removal for the officially unused PenetrationRectType', async () => {
        const doc = parse(
            'Bullet\n{\n\tHits\n\t{\n\t\tHitShipShields\n\t\t{\n\t\t\tType = PenetratingHit\n\t\t\tPenetrationRectType = Square\n\t\t}\n\t}\n}\n'
        );
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('PenetrationRectType'));
        expect(hit).toBeTruthy();
        expect(hit!.message).toContain('removed in game version 0.24.1');
        expect(hit!.data?.migration?.apply).toBe('remove');
    });

    it('leaves a live sibling field alone', async () => {
        const doc = parse('Part\n{\n\tMaxHealth = 100\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        expect(errors.filter((e) => e.message.includes('MaxHealth'))).toEqual([]);
    });

    it('stays silent when a reference in the file reads the dead field', async () => {
        // References resolve at parse time in ObjectText, so a mod that writes a dead field and reads
        // it via `(&~/…)` in the same file uses it for real; the remove fix would break the mod.
        const doc = parse('Part\n{\n\tFireDamageFactor = 1.5\n\tMaxHealth = (&~/Part/FireDamageFactor) * 100\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        expect(errors.filter((e) => e.message.includes('FireDamageFactor'))).toEqual([]);
    });
});
