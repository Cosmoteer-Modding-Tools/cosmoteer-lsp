import { describe, expect, it } from 'vitest';
import bundle from '../../../src/document/schema/cosmoteer.schema.json';
import { applySchemaOverlay } from '../../../src/document/schema/schema-overlay';
import { SchemaBundle } from '../../../src/document/schema/schema.types';

// Pins the complete set of `dead`-flagged fields in the SHIPPED schema: members the game declares
// but whose value schemagen's whole-assembly read scan proved no game code ever reads (see
// tools/schemagen/SchemaGen.DeadFields.cs). Every pair below was audit-verified against the fully
// decompiled game on 2026-07-12: the member name occurs only at its declaration, or every other
// occurrence belongs to a different same-named member. A schema regeneration after a game update
// that changes this set fails here, so the new set gets reviewed instead of shipping silently.
const schema = bundle as unknown as SchemaBundle;

// The overlay mutates its argument, so it runs once on a deep clone shared by the two overlay-delta
// suites below. Computing it per-suite deep-clones the whole schema twice, which starves the default
// 5s test timeout under the full parallel run.
const raw = bundle as unknown as SchemaBundle;
const overlaid = applySchemaOverlay(structuredClone(bundle) as unknown as SchemaBundle);

describe('schema dead fields: the read-scan verdict is pinned', () => {
    it('flags exactly the audited declared-but-never-read fields', () => {
        const flagged: string[] = [];
        for (const [cls, def] of Object.entries(schema.types)) {
            for (const field of def.fields) {
                if (field.dead) flagged.push(`${cls}.${field.name}`);
            }
        }
        expect(flagged.sort()).toEqual([
            'Cosmoteer.Bullets.Graphics.BulletMediaEffectsRules.FactorEffectsExponent',
            'Cosmoteer.Bullets.Hits.BulletVolumeHitRules.FactorEffectsWith',
            'Cosmoteer.Crew.CrewRules.PathfindRadius',
            'Cosmoteer.Game.GameRules.MaxFtlFuelPurchase',
            'Cosmoteer.Gui.WidgetRules.MoverIcon',
            'Cosmoteer.Gui.WidgetRules.ResizerTLBRIcon',
            'Cosmoteer.Modes.Career.Comms.CommsGuiRules.AIHailingIcon',
            'Cosmoteer.Modes.Career.Encounter.EncounterManagerRules.TriggerRadius',
            'Cosmoteer.Modes.Career.Missions.Objectives.DontSurrenderToObjective/Spawner.DisplayTextDisabled',
            'Cosmoteer.Modes.Career.Missions.Objectives.ProtectShipsObjective/Spawner.DisplayTextDisabled',
            'Cosmoteer.Modes.Pvp.BuildBattle.BuildAreaRules.AreaExpand',
            'Cosmoteer.Modes.Pvp.BuildBattle.BuildAreaRules.MinDistanceBuffer',
            'Cosmoteer.Modes.Pvp.BuildBattle.CapturePointRules.AreaExpand',
            'Cosmoteer.Modes.Pvp.BuildBattle.CapturePointRules.MinDistanceBuffer',
            'Cosmoteer.Ships.Parts.Crew.AirlockRules.EntryToggle',
            'Cosmoteer.Ships.Parts.Crew.AirlockRules.ExitToggle',
            'Cosmoteer.Ships.Parts.Graphics.PartBlendSpriteRules.AlwaysBlendWithSelf',
            'Cosmoteer.Ships.Parts.PartRules.FireDamageFactor',
            'Cosmoteer.Ships.Parts.Resources.TypedResourceGridRules.StartingResources',
            'Cosmoteer.Ships.ShipRules.SupplierSearchInterval',
            'Cosmoteer.Simulation.Cameras.CameraRules.BorderClampPanSpeed',
            'Cosmoteer.Simulation.Doodads.CrewDoodadRules.BodyTypeIndex',
            'Cosmoteer.Simulation.Doodads.CrewDoodadRules.HairColorIndex',
            'Cosmoteer.Simulation.Doodads.CrewDoodadRules.SkinColorIndex',
            'Cosmoteer.Simulation.HitEffects.AreaShieldStatusApplicationEffectRules.ApplyFalloffToMaxStatusValue',
            'Cosmoteer.Simulation.HitEffects.AreaShieldStatusApplicationEffectRules.UseMaxValuesForHitShield',
            'Cosmoteer.Simulation.HitEffects.OverrideBulletLifetimeEffectRules.HasTarget',
            'Cosmoteer.Simulation.MediaEffects.MediaEffectRules.IgnoreIntensity',
            'Cosmoteer.Simulation.MediaEffects.TileQuadEffectRules.DisableQuadRotation',
            'Cosmoteer.Simulation.SimGuiRules.TentativeScheduledSalvageNineSlice',
        ]);
    });
});

// The overlay carries the verdicts the IL scan cannot reach: a member whose name is one or two
// letters always collides with some unrelated string literal, which trips the scan's reflection
// guard and suppresses the flag (see `OVERLAY_DEAD_FIELDS` in schema-overlay.ts). Each was traced by
// hand in the decompiled game. Pinning the post-overlay delta keeps a typo or a renamed member from
// silently dropping a verdict, and lets an entry retire the moment schemagen learns to flag it.
describe('schema dead fields: the overlay adds the hand-traced verdicts', () => {
    const deadOf = (schema: SchemaBundle) => {
        const flagged = new Set<string>();
        for (const [cls, def] of Object.entries(schema.types))
            for (const field of def.fields) if (field.dead) flagged.add(`${cls}.${field.name}`);
        return flagged;
    };

    /** Whether the extracted bundle already declares this member, so the overlay only re-flagged it. */
    const isExtracted = (pair: string) => {
        const cut = pair.lastIndexOf('.');
        return Boolean(raw.types[pair.slice(0, cut)]?.fields.some((f) => f.name === pair.slice(cut + 1)));
    };

    // A generous timeout: the assertion itself is sub-millisecond, but under the full parallel run this
    // fast test can be starved of its worker thread past the default 5s and time out spuriously.
    it('flags the members the read scan misses', { timeout: 30_000 }, () => {
        // Members the overlay invents (the deleted-by-a-game-update ones like `Flammable`) arrive
        // already dead, so only a verdict laid on an extracted member belongs to this list.
        const added = [...deadOf(overlaid)].filter((pair) => !deadOf(raw).has(pair) && isExtracted(pair)).sort();
        expect(added).toEqual([
            'Cosmoteer.Generators.Simulation.ShipSpawner/ShipCommand.SuppressNoTagTargetFound',
            'Cosmoteer.Generators.Simulation.SimObjectSpawner.SuppressLocationAssertions',
            'Cosmoteer.Modes.Career.CombatDifficultyRules.StatusFactorsFromEnemies',
            'Cosmoteer.Modes.Career.CombatDifficultyRules.StatusFactorsVsEnemies',
            'Cosmoteer.Modes.Pvp.BuildBattle.BuildBattleTechRules.DescriptionKey',
            'Cosmoteer.Ships.AI.StrategyModules.AIExitSectorModuleRules.IsActivated',
            'Cosmoteer.Ships.Rendering.AtlasSprite.FixTransparentColors',
            'Cosmoteer.Ships.Rendering.AtlasSprite.MipLevels',
            'Cosmoteer.Ships.Rendering.AtlasSprite.PreMultiplyByAlpha',
            'Cosmoteer.Ships.Rendering.AtlasSprite.SampleMode',
            'Cosmoteer.Simulation.MediaEffects.PartQuadEffectRules.Z',
            'Cosmoteer.Simulation.MediaEffects.TileQuadEffectRules.Z',
        ]);
    });

    it('keeps the sibling QuadEffectRules.Z live, since QuadEffect reads it', () => {
        const quad = overlaid.types['Cosmoteer.Simulation.MediaEffects.QuadEffectRules'];
        expect(quad.fields.find((f) => f.name === 'Z')?.dead).toBeUndefined();
    });
});

// schemagen marks every collection optional, but a handful crash the load when absent because a
// constructor or consumer dereferences them without a null guard. The overlay flips exactly those to
// required (see `OVERLAY_REQUIRED_FIELDS` in schema-overlay.ts). Pinning the delta keeps the set
// reviewed.
describe('schema required fields: the overlay flips the crash-on-absence collections', () => {
    const requiredOf = (schema: SchemaBundle) => {
        const flagged = new Set<string>();
        for (const [cls, def] of Object.entries(schema.types))
            for (const field of def.fields) if (field.optional === false) flagged.add(`${cls}.${field.name}`);
        return flagged;
    };

    // Generous timeout for the same starvation reason as the dead-field scan above.
    it('makes exactly the three music track collections required', { timeout: 30_000 }, () => {
        const added = [...requiredOf(overlaid)].filter((pair) => !requiredOf(raw).has(pair)).sort();
        expect(added).toEqual([
            'Cosmoteer.Music.MusicFsmTrackRules.IntroTracks',
            'Cosmoteer.Music.MusicLayersTrackRules.Layers',
            'Cosmoteer.Music.MusicSequenceTrackRules.Tracks',
        ]);
    });

    it('leaves the nullable sibling FirstBootIntroTracks optional', () => {
        const fsm = overlaid.types['Cosmoteer.Music.MusicFsmTrackRules'];
        expect(fsm.fields.find((f) => f.name === 'FirstBootIntroTracks')?.optional).toBe(true);
    });
});
