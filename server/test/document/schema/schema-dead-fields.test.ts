import { describe, expect, it } from 'vitest';
import bundle from '../../../src/document/schema/cosmoteer.schema.json';
import { SchemaBundle } from '../../../src/document/schema/schema.types';

// Pins the complete set of `dead`-flagged fields in the SHIPPED schema: members the game declares
// but whose value schemagen's whole-assembly read scan proved no game code ever reads (see
// tools/schemagen/SchemaGen.DeadFields.cs). Every pair below was audit-verified against the fully
// decompiled game on 2026-07-12: the member name occurs only at its declaration, or every other
// occurrence belongs to a different same-named member. A schema regeneration after a game update
// that changes this set fails here, so the new set gets reviewed instead of shipping silently.
const schema = bundle as unknown as SchemaBundle;

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
