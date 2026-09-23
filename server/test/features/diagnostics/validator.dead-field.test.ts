import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateIgnoredFields } from '../../../src/features/diagnostics/validator.ignored-field';

// Fields the game declares and then does nothing with (the schema's `dead` flag, from schemagen's
// whole-assembly read scan plus the curated overlay) get the same dead-weight hint as unknown
// members, with the remove fix.
// Deleted fields recorded in the deprecations registry upgrade the hint with the game version and
// the migration, and carry the fix the workspace migration applies.
const token = CancellationToken.None;
const parse = (src: string) => parser(lexer(src), 'file:///data/parts/t.rules').value;
/** A status type, whose `ContinuousMediaEffects` list holds media-effect groups (vanilla's `scorched`). */
const parseStatus = (src: string) => parser(lexer(src), 'file:///data/statuses/scorched/scorched.rules').value;
/** The crew rules file, whose members the document itself is keyed by rather than a group. */
const crewRules = (src: string) => parser(lexer(src), 'file:///data/crew/crew.rules').value;

/** The text a fix's byte-offset edits produce, applied back to front so earlier spans keep place. */
const applyRewrite = (source: string, edits: { start: number; end: number; newText: string }[]): string =>
    [...edits]
        .sort((a, b) => b.start - a.start)
        .reduce((text, edit) => text.slice(0, edit.start) + edit.newText + text.slice(edit.end), source);

/** The text the remove fix produces, with the line it emptied taken out the way the editor takes it. */
const applyRemoval = (source: string, remove: { start: number; end: number }): string =>
    applyRewrite(source, [{ ...remove, newText: '' }]).replace(/^[ \t]*\r?\n/m, '');

describe('dead declared fields', () => {
    it('hints a declared-but-never-read field with a remove fix', async () => {
        const doc = parse('Part\n{\n\tFireDamageFactor = 2\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('FireDamageFactor'));
        expect(hit).toBeTruthy();
        expect(hit!.message).toContain('does nothing with the value');
        expect(hit!.severity).toBe('hint');
        expect(hit!.data?.remove?.title).toContain('FireDamageFactor');
        expect(hit!.data?.migration).toBeUndefined();
    });

    it('does not claim the code never reads a value the shipped build does load', async () => {
        // The dead set is not one mechanism. `SuppressLocationAssertions` and
        // `SuppressNoTagTargetFound` are loaded into the empty `if` body a `[Conditional("DEBUG")]`
        // call leaves behind, and `IsActivated` reaches a constructor nothing calls. One sentence
        // covers the whole set only while it says what becomes of the value rather than what the
        // code does with it, which a reader can check against the decompile.
        const doc = parse('Part\n{\n\tFireDamageFactor = 2\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('FireDamageFactor'));
        expect(hit!.message).not.toContain("the game's code never reads it");
    });

    // A member the serializer reads without the game ever using its value still has to be in the
    // file. Deleting it makes the game throw at load, and the required-field check of this same
    // server then reports the deletion, so the hint must carry neither the remove fix nor the fade
    // that invites the author to delete the line by hand.
    it('offers no remove fix for a dead field the game refuses to load without', async () => {
        const doc = crewRules('PathfindRadius = 5\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('PathfindRadius'));
        expect(hit).toBeTruthy();
        expect(hit!.data?.remove).toBeUndefined();
    });

    it('does not fade a dead field the game refuses to load without', async () => {
        const doc = crewRules('PathfindRadius = 5\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('PathfindRadius'));
        expect(hit!.unnecessary).toBe(false);
    });

    it('says the key has to stay when the game refuses to load without it', async () => {
        const doc = crewRules('PathfindRadius = 5\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('PathfindRadius'));
        expect(hit!.message).toContain('does nothing with the value');
        expect(hit!.message).toContain('still has to be written');
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

    // Vanilla's `armor_2x1.rules` and a run of workshop parts already carry `non_flammable` in
    // `TypeCategories` and kept `Flammable = false` beside it. Appending a second entry there writes
    // the category twice, so the field is plain dead weight and removing it is the whole migration.
    it('removes Flammable rather than writing a second non_flammable entry', async () => {
        const source = 'Part\n{\n\tTypeCategories = [armor, non_flammable]\n\tFlammable = false\n}\n';
        const doc = parse(source);
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit!.data?.migration?.apply).toBe('remove');
        expect(hit!.data?.rewrite).toBeUndefined();
        const applied = applyRemoval(source, hit!.data!.remove!);
        expect(applied).toContain('TypeCategories = [armor, non_flammable]');
        expect(applied.match(/non_flammable/g)).toHaveLength(1);
        expect(applied).not.toContain('Flammable = false');
    });

    it('matches the category however it is cased', async () => {
        const doc = parse('Part\n{\n\tTypeCategories = [Non_Flammable]\n\tFlammable = false\n}\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit!.data?.migration?.apply).toBe('remove');
    });

    // An element written as a reference names its value in another file, so the list cannot be read
    // as carrying the category. The append stays, since dropping the fireproofing on a guess is the
    // worse of the two mistakes.
    it('still appends when the only element is a reference', async () => {
        const source = 'Part\n{\n\tTypeCategories = [&/Shared/Cat]\n\tFlammable = false\n}\n';
        const doc = parse(source);
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit!.data?.migration?.apply).toBe('rewrite');
        expect(applyRewrite(source, hit!.data!.rewrite!.edits)).toContain(
            'TypeCategories = [&/Shared/Cat, non_flammable]'
        );
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

    it('extends the inherited TypeCategories list when a base declares one', async () => {
        // No local list, but the base chain declares one, so the fix spells the vanilla extension
        // idiom (`: ^/N/TypeCategories`) instead of a fresh assignment that would drop the inherited
        // categories. `N` is the base whose chain declares it, here the second one.
        const doc = parse(
            [
                'Other',
                '{',
                '\tMaxHealth = 1',
                '}',
                'Deep',
                '{',
                '\tTypeCategories = [armor]',
                '}',
                'Base : &Deep',
                '{',
                '}',
                'Part : &Other, &Base',
                '{',
                '\tFlammable = false',
                '}',
                '',
            ].join('\n')
        );
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit!.data?.migration?.apply).toBe('rewrite');
        const edits = hit!.data?.rewrite?.edits ?? [];
        expect(edits).toHaveLength(1);
        expect(edits[0].newText).toBe('TypeCategories : ^/1/TypeCategories [non_flammable]');
    });

    it('stays manual when no base declares TypeCategories either', async () => {
        const doc = parse(
            ['Base', '{', '\tMaxHealth = 1', '}', 'Part : &Base', '{', '\tFlammable = false', '}', ''].join('\n')
        );
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Flammable'));
        expect(hit!.data?.migration?.apply).toBeUndefined();
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
        expect(hit!.data?.rewrite?.edits[0].newText).toBe(
            'SuppressShipWideExplicitTargetsWhenTargetingShipRelativePoints'
        );
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

    it('hints a Z on a part quad effect, whose verdict comes from the overlay', async () => {
        // `Z` is one or two letters, so schemagen's reflection guard (any matching string literal
        // anywhere) suppresses its dead verdict. The overlay carries the hand-traced verdict instead,
        // so the hint has to survive the whole schema-load path, not just the pinned bundle.
        const doc = parseStatus('ContinuousMediaEffects\n[\n\t{\n\t\tType = PartQuad\n\t\tZ = 0.5\n\t}\n]\n');
        const errors = await validateIgnoredFields(doc, token);
        const hit = errors.find((e) => e.message.includes('Z'));
        expect(hit).toBeTruthy();
        expect(hit!.message).toContain('does nothing with the value');
        expect(hit!.severity).toBe('hint');
    });

    it('leaves the same Z on a plain quad effect alone, since QuadEffect reads it', async () => {
        const doc = parseStatus('ContinuousMediaEffects\n[\n\t{\n\t\tType = Quad\n\t\tZ = 0.5\n\t}\n]\n');
        const errors = await validateIgnoredFields(doc, token);
        expect(errors.filter((e) => e.message.includes('Z'))).toEqual([]);
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
