# Cosmoteer.Ships.Parts.PartComponentRules

Everything a part actually does lives in one of these components, written under the part's `Components` group.

> A group in this slot picks its class with `Type = …`:
>
> - [`Airlock`](./Cosmoteer.Ships.Parts.Crew.AirlockRules.md): Lets crew step outside the ship and back in, and is where ejected crew are thrown from.
> - [`ArcShield`](./Cosmoteer.Ships.Parts.Defenses.ArcShieldRules.md): Projects a shield arc that blocks incoming fire, draining a resource storage for every point of damage it absorbs.
> - [`ArcSprite`](./Cosmoteer.Ships.Blueprints.Graphics.BlueprintPartArcSpriteRules.md): Draws a curved arc around the part in build mode at the given radius and sweep, used to show things like shield coverage.
> - [`AreaBuffProvider`](./Cosmoteer.Ships.Parts.Buffs.PartAreaBuffProviderRules.md): Buffs every part covering a rectangle of cells measured from this part's own position.
> - [`BasePartValueSpritesRules`](./Cosmoteer.Ships.Parts.Graphics.BasePartValueSpritesRules.md): Shared setup for components that choose a sprite from a list according to a number. A modder writes `ValueSprites` or `ResourceSprites`.
> - [`BeamEmitter`](./Cosmoteer.Ships.Parts.Weapons.BeamEmitterRules.md): Fires a continuous beam out to `Range`, with its own hit rules for shields, structure, crew and operational parts.
> - [`BeamEmitterProxy`](./Cosmoteer.Ships.Parts.Weapons.BeamEmitterProxyRules.md): Stands in for a beam emitter in another part, so this part can read its length or hang effects on it.
> - [`BeamRegulator`](./Cosmoteer.Ships.Parts.Weapons.BeamRegulatorRules.md): Turns the length of a beam into a value, which is how a beam reacts to how far away it hit.
> - [`BlendSprite`](./Cosmoteer.Ships.Parts.Graphics.PartBlendSpriteRules.md): Draws a sprite that picks its variant from the parts next to it, which is how armor and hull edges join up.
> - [`BlendSpriteGrid`](./Cosmoteer.Ships.Parts.Graphics.PartBlendSpriteGridRules.md): Repeats a blending sprite across a grid of cells, for parts wider than a single tile.
> - [`BlueprintBlendSprite`](./Cosmoteer.Ships.Blueprints.Graphics.BlueprintPartBlendSpriteRules.md): Draws a build-mode sprite that blends into neighbouring parts, choosing the sprite from a situation code saying which sides must have a match.
> - [`BlueprintNetworkOverlaySignal`](./Cosmoteer.Ships.Blueprints.BlueprintNetworkOverlaySignalRules.md): Sends a named signal out through the part network in build mode, so matching value overlays on connected parts light up.
> - [`BlueprintNetworkValueOverlay`](./Cosmoteer.Ships.Blueprints.BlueprintNetworkValueOverlayRules.md): Draws a number over the part in build mode when a matching signal arrives through the part network, reading the number from another component.
> - [`BlueprintSprite`](./Cosmoteer.Ships.Blueprints.Graphics.BlueprintPartSpriteRules.md): Draws one flat sprite for the part in build mode. The sprite's own fields such as `File` and `Size` are written directly on this component.
> - [`BlueprintToggledBlendSprites`](./Cosmoteer.Ships.Blueprints.Graphics.BlueprintPartToggledBlendSpritesRules.md): Draws a build-mode sprite that blends with its neighbours, picking the variant from the on or off state of the toggles in `SituationToggles`.
> - [`BuffToggle`](./Cosmoteer.Ships.Parts.Buffs.PartBuffToggleRules.md): Switches on while the buff this part receives falls between `MinBuffValue` and `MaxBuffValue`.
> - [`BuffableValue`](./Cosmoteer.Ships.Parts.Buffs.PartBuffableValueRules.md): Provides a number that the part's buffs and statuses can modify, which is how a buffed part changes what it does.
> - [`BulletEmitter`](./Cosmoteer.Ships.Parts.Weapons.BulletEmitterRules.md): Fires the bullet described in `Bullet`, with spread and pellet counts for shotgun-style shots.
> - [`BurstTrigger`](./Cosmoteer.Ships.Parts.Logic.PartBurstTriggerRules.md): Fires `BurstCount` times in a row with `BurstDelay` between the shots once its own trigger goes off.
> - [`ChainableProxy`](./Cosmoteer.Ships.Parts.Logic.PartChainableProxyRules.md): Stands in for a component in another part and copies its location and rotation, so graphics can hang off a neighbor.
> - [`CircleBuffProvider`](./Cosmoteer.Ships.Parts.Buffs.PartCircleBuffProviderRules.md): Buffs the parts inside a circle around this part, with `Falloff` weakening the buff toward the edge.
> - [`CircleCollider`](./Cosmoteer.Ships.Parts.Colliders.CircleColliderRules.md): Gives the part a round hit shape that fire is tested against instead of the part rectangle.
> - [`CommandConsumer`](./Cosmoteer.Ships.Parts.Commands.CommandConsumerRules.md): Adds its `CommandPoints` to what the ship's control rooms must supply, so too many heavy parts leave the ship uncontrollable.
> - [`CommandProvider`](./Cosmoteer.Ships.Parts.Commands.CommandProviderRules.md): Supplies `CommandPoints` to the ship, which is what makes a part a control room.
> - [`CommandToggle`](./Cosmoteer.Ships.Parts.Commands.CommandToggleRules.md): On while the ship has enough command points to be controlled.
> - [`ComponentPresenceToggle`](./Cosmoteer.Ships.Parts.Logic.ComponentPresenceToggleRules.md): On while a named component exists, either on this part or on the part at a given offset.
> - [`ContinuousEffects`](./Cosmoteer.Ships.Parts.Effects.PartContinuousEffectsRules.md): Runs sound and particle effects for as long as the component is operational, with the intensity able to follow another value.
> - [`CrewDestinationProximityToggle`](./Cosmoteer.Ships.Parts.Crew.CrewDestinationProximityToggleRules.md): On while a crew member heading for this part comes within `Distance` of it.
> - [`CrewLocation`](./Cosmoteer.Ships.Parts.Crew.CrewLocationRules.md): Marks the spot where a single crew member stands and which way they face while manning the part.
> - [`CrewSource`](./Cosmoteer.Ships.Parts.Crew.CrewSourceRules.md): Supplies the ship with crew members and gives them a rectangle to idle in, which is what a crew quarters does.
> - [`CustomShipIcon`](./Cosmoteer.Ships.Parts.Graphics.CustomShipIconRules.md): Gives the ship a custom map icon while this part is operational, with `Weight` deciding which part wins.
> - [`DamageTrigger`](./Cosmoteer.Ships.Parts.Logic.PartDamageTriggerRules.md): Fires whenever the part takes a hit between `MinDamage` and `MaxDamage`.
> - [`DeathEffects`](./Cosmoteer.Ships.Parts.Effects.PartDeathEffectsRules.md): Plays the explosion and damage effects when the part is destroyed.
> - [`DebugMode`](./Cosmoteer.Ships.Parts.Logic.PartDebugModeRules.md): Holds a mode number that can be changed by hand in the part debugger, for testing how the part is wired.
> - [`DebugToggle`](./Cosmoteer.Ships.Parts.Logic.PartDebugToggleRules.md): A toggle flipped by hand in the part debugger, for testing how other components react.
> - [`DebugTrigger`](./Cosmoteer.Ships.Parts.Logic.PartDebugTriggerRules.md): A trigger fired by hand in the part debugger, for testing what listens to it.
> - [`DebugValue`](./Cosmoteer.Ships.Parts.Logic.PartDebugValueRules.md): A value typed in by hand in the part debugger, for testing what reads it.
> - [`DelayTrigger`](./Cosmoteer.Ships.Parts.Logic.PartDelayTriggerRules.md): Fires once the trigger it watches has fired and `Delay` has passed.
> - [`DestroyedTrigger`](./Cosmoteer.Ships.Parts.Logic.PartDestroyedTriggerRules.md): Fires once, immediately before its part is destroyed.
> - [`DirectControlToggle`](./Cosmoteer.Ships.Parts.Weapons.DirectControlToggleRules.md): On while the player is firing the named weapon in direct control.
> - [`DistanceThreshold`](./Cosmoteer.Ships.Parts.Logic.DistanceThresholdRules.md): Toggles on and provides a falling-off value depending on how a distance from another component compares to `ThresholdDistance`.
> - [`DoorPresenceToggle`](./Cosmoteer.Ships.Parts.Logic.DoorPresenceToggleRules.md): On while a door sits in the cell named by `AdjacentCell`.
> - [`EmitterProxy`](./Cosmoteer.Ships.Parts.Weapons.EmitterProxyRules.md): Stands in for an emitter in another part or at another spot, so targeting and effects can follow a turret.
> - [`ExplosiveResourceDrainSink`](./Cosmoteer.Ships.Parts.Resources.ExplosiveResourceDrainSinkRules.md): Soaks up part of an explosive resource drain like a lightning rod, then recovers at `RecoveryRate`.
> - [`FanArcController`](./Cosmoteer.Ships.Parts.Logic.FanArcControllerRules.md): Turns a set of components into a fan aimed at a target, spreading them wider as `ArcSizeFactor` grows.
> - [`FixedWeapon`](./Cosmoteer.Ships.Parts.Weapons.FixedWeaponRules.md): A weapon that cannot turn and fires only at targets inside the arc it already faces.
> - [`FlexResourceGrid`](./Cosmoteer.Ships.Parts.Resources.FlexResourceGridRules.md): Holds a grid of resource stacks where each cell may hold any resource, the way a storeroom does.
> - [`FloodFillBuffProvider`](./Cosmoteer.Ships.Parts.Buffs.PartFloodBuffProviderRules.md): Spreads its buff outward from receiver to receiver, reaching parts up to `ChainLengthLimit` links away.
> - [`FtlBeacon`](./Cosmoteer.Ships.Parts.Ftl.FtlBeaconRules.md): Makes the ship a destination that friendly ships with an FTL drive can jump to.
> - [`FtlDrive`](./Cosmoteer.Ships.Parts.Ftl.FtlDriveRules.md): Lets the ship make FTL jumps, spending power and fuel from the storages it names.
> - [`Graphics`](./Cosmoteer.Ships.Parts.Graphics.PartGraphicsRules.md): The main look of a part, covering floor, walls, roof and doodads, each swapped for a more battered sprite as the part takes damage.
> - [`GridBuffProvider`](./Cosmoteer.Ships.Parts.Buffs.PartGridBuffProviderRules.md): Buffs every part within `GridDistance` cells, counted along the grid rather than as a straight-line distance.
> - [`HealthToggle`](./Cosmoteer.Ships.Parts.Logic.PartHealthToggleRules.md): On while the part's remaining health sits between `MinHealthFraction` and `MaxHealthFraction`.
> - [`IndicatorSprites`](./Cosmoteer.Ships.Parts.Graphics.PartIndicatorSpritesRules.md): Shows small status icons over the part, each appearing while the toggle it watches is in the state it wants.
> - [`InlineResourceConverter`](./Cosmoteer.Ships.Parts.Resources.InlineResourceConverterRules.md): Acts as a storage that converts from another storage on demand, holding a small reserve so nothing is wasted.
> - [`IonEnergyStorage`](./Cosmoteer.Ships.Parts.Resources.IonEnergyStorageRules.md): Collects ion beam energy, with each further beam adding less to the pool than the one before.
> - [`JunkToggle`](./Cosmoteer.Ships.Parts.Logic.JunkToggleRules.md): On while its ship is junk, the drifting wreck left behind after a ship dies.
> - [`LazyMultiValue`](./Cosmoteer.Ships.Parts.Logic.PartLazyMultiValueRules.md): Combines several values into one only when something asks for the result, so nothing is notified when the inputs change.
> - [`ModeCycle`](./Cosmoteer.Ships.Parts.Logic.PartModeCycleRules.md): Steps a mode number up or down inside `ModeRange` whenever its increment or decrement trigger fires.
> - [`ModeProxy`](./Cosmoteer.Ships.Parts.Logic.PartModeProxyRules.md): Stands in for a mode component in another part, reporting `ModeWhenNotConnected` when there is nothing to connect to.
> - [`ModeToggle`](./Cosmoteer.Ships.Parts.Logic.PartModeToggleRules.md): On while the mode component it watches sits on one of the modes listed in `OnModes`.
> - [`ModeTrigger`](./Cosmoteer.Ships.Parts.Logic.PartModeTriggerRules.md): Fires whenever the mode component it watches moves into one of `TriggerInModes`.
> - [`MultiColor`](./Cosmoteer.Ships.Parts.Graphics.PartMultiColorRules.md): Combines several color components into one, with separate combining modes for the RGB channels and for alpha.
> - [`MultiResourceStorage`](./Cosmoteer.Ships.Parts.Resources.MultiResourceStorageRules.md): Presents several storages as one, spreading resources between them by the chosen add and remove modes.
> - [`MultiToggle`](./Cosmoteer.Ships.Parts.Logic.PartMultiToggleRules.md): Combines several toggles into one that is on when all, any, exactly one or none of them are on.
> - [`MultiTrigger`](./Cosmoteer.Ships.Parts.Logic.PartMultiTriggerRules.md): Fires whenever any of the triggers it lists fires.
> - [`MultiValue`](./Cosmoteer.Ships.Parts.Logic.PartMultiValueRules.md): Combines several value components into one number by adding, multiplying or taking the smallest, largest or average.
> - [`NetworkBasicNode`](./Cosmoteer.Ships.Networks.PartNetworkBasicNodeRules.md): A plain junction in a part's network wiring that carries routes through and does nothing else.
> - [`NetworkNodeProxy`](./Cosmoteer.Ships.Networks.PartNetworkNodeProxyRules.md): Stands in for another network component on the same part, so routes can point at this id while the real component named by `ComponentID` does the work.
> - [`NetworkPort`](./Cosmoteer.Ships.Networks.PartNetworkPortRules.md): One edge port that connects to a matching port on the neighbouring part, sitting at `Location` and facing `Direction`.
> - [`NetworkResourceInput`](./Cosmoteer.Ships.Networks.PartNetworkResourceInputRules.md): A storage on the part that takes a resource in and hands it off to sinks elsewhere in the part network.
> - [`NetworkResourceOutput`](./Cosmoteer.Ships.Networks.PartNetworkResourceOutputRules.md): A storage on the part that fills itself from resource sources elsewhere in the part network.
> - [`NetworkResourceStore`](./Cosmoteer.Ships.Networks.PartNetworkResourceStoreRules.md): Opens an existing resource storage on the part to the network so other parts can draw from it or push into it, with optional reserved and maximum levels.
> - [`NetworkRouter`](./Cosmoteer.Ships.Networks.PartNetworkRouterRules.md): Wires the network components on a single part together, saying which of them can reach which.
> - [`NetworkToggle`](./Cosmoteer.Ships.Networks.PartNetworkToggleRules.md): Publishes a toggle from another component on this part to the network, so receivers elsewhere can read it.
> - [`NetworkToggleReceiver`](./Cosmoteer.Ships.Networks.PartNetworkToggleReceiverRules.md): Combines every matching toggle reachable through the part network into one on or off state for this part.
> - [`NetworkTrigger`](./Cosmoteer.Ships.Networks.PartNetworkTriggerRules.md): Publishes a trigger from another component on this part to the network, so receivers elsewhere fire with it.
> - [`NetworkTriggerReceiver`](./Cosmoteer.Ships.Networks.PartNetworkTriggerReceiverRules.md): Fires whenever any matching trigger reachable through the part network fires.
> - [`NetworkValue`](./Cosmoteer.Ships.Networks.PartNetworkValueRules.md): Publishes a number from another component on this part to the network, so receivers elsewhere can read it.
> - [`NetworkValueReceiver`](./Cosmoteer.Ships.Networks.PartNetworkValueReceiverRules.md): Combines every matching value reachable through the part network into one number for this part.
> - [`OpenCloseSprite`](./Cosmoteer.Ships.Parts.Graphics.PartOpenCloseSpriteRules.md): Shows an open or a closed sprite depending on its operational toggle, the way a door or hatch does.
> - [`Oscillator`](./Cosmoteer.Ships.Parts.Weapons.OscillatorRules.md): Rocks back and forth by `Angle` every `Interval` while operational, sweeping whatever is chained to it.
> - [`PartCrew`](./Cosmoteer.Ships.Parts.Crew.PartCrewRules.md): Sets how many crew must man the part before it works, how urgent that job is and where they stand.
> - [`PolledValue`](./Cosmoteer.Ships.Parts.Logic.PartPolledValueRules.md): Reads another component's value every tick and announces changes, for sources that never report changes themselves.
> - [`PolygonCollider`](./Cosmoteer.Ships.Parts.Colliders.PolygonColliderRules.md): Gives the part a hit shape built from listed corner points, for wedges and other non-rectangular parts.
> - [`ProgressBar`](./Cosmoteer.Ships.Parts.UI.PartProgressBarRules.md): Draws a bar under the part's health bar, colored by how full the tracked value is.
> - [`RailgunProjectile`](./Cosmoteer.Ships.Parts.Weapons.RailgunProjectileRules.md): Accelerates along the part from a start offset to an end offset and triggers on arrival, as a railgun stage does.
> - [`ResourceChange`](./Cosmoteer.Ships.Parts.Resources.ResourceChangeRules.md): Adds `Amount` to a storage, or takes it away, each time the trigger fires.
> - [`ResourceConsumer`](./Cosmoteer.Ships.Parts.Resources.ResourceConsumerRules.md): Marks the part as consuming a resource into the storage it names, which is what puts it on the crew's delivery list.
> - [`ResourceConsumingStorage`](./Cosmoteer.Ships.Parts.Resources.ResourceConsumingStorageRules.md): Holds a resource and destroys `TriggerThreshold` worth at a time, firing a trigger whenever it does.
> - [`ResourceConverter`](./Cosmoteer.Ships.Parts.Resources.ResourceConverterRules.md): Turns one resource into another every `Interval`, the way a reactor burns fuel into power.
> - [`ResourceSprites`](./Cosmoteer.Ships.Parts.Graphics.PartResourceSpritesRules.md): Picks a sprite according to how much a resource storage is holding, so a stack of ammo visibly grows and shrinks.
> - [`ResourceStorage`](./Cosmoteer.Ships.Parts.Resources.ResourceStorageRules.md): Holds up to `MaxResources` of a single resource for the part to use, as a battery or an ammo bin does.
> - [`ResourceStorageProxy`](./Cosmoteer.Ships.Parts.Resources.ResourceStorageProxyRules.md): Stands in for a resource storage in another part, able to scale the quantities it reports.
> - [`RoofOpacity`](./Cosmoteer.Ships.Parts.Graphics.PartRoofOpacityValueRules.md): Reports how opaque the ship's roof is being drawn as a value other components can read, remapped onto `OutputRange`.
> - [`SegmentedProgressBar`](./Cosmoteer.Ships.Parts.UI.PartSegmentedProgressBarRules.md): Draws that same bar split into `SegmentCount` blocks, the way loaded shots are counted off.
> - [`SelfBuffProvider`](./Cosmoteer.Ships.Parts.Buffs.PartSelfBuffProviderRules.md): Buffs only the part it sits on, which is how a part boosts itself.
> - [`Sensor`](./Cosmoteer.Ships.Parts.Sensors.SensorRules.md): Widens the ship's sight and radar radius while the part is operational.
> - [`ShieldArcsMimic`](./Cosmoteer.Ships.Parts.Graphics.PartShieldArcsMimicRules.md): Repeats the arc visuals of an `ArcShield` at this component's own spot, so one shield's effects can appear elsewhere.
> - [`ShipConstructionToggle`](./Cosmoteer.Ships.Parts.Logic.ShipConstructionToggleRules.md): On while the ship has building work queued, optionally ignoring plain repairs.
> - [`SmoothedValue`](./Cosmoteer.Ships.Parts.Logic.PartSmoothedValueRules.md): Follows another component's value gradually, moving no more than `MaxDelta` per second toward it.
> - [`Sprite`](./Cosmoteer.Ships.Parts.Graphics.PartSpriteRules.md): Draws a single sprite for the part, able to follow another component and to swap in damaged versions.
> - [`SpriteGrid`](./Cosmoteer.Ships.Parts.Graphics.PartSpriteGridRules.md): Repeats one sprite across a grid of cells.
> - [`StatProvider`](./Cosmoteer.Ships.Parts.PartStatProviderRules.md): Feeds a live number into one of the part's tooltip stats, so a shown stat tracks the part's real state.
> - [`StaticMode`](./Cosmoteer.Ships.Parts.Logic.PartStaticModeRules.md): A fixed mode number that other components can read.
> - [`StaticToggle`](./Cosmoteer.Ships.Parts.Logic.PartStaticToggleRules.md): A toggle stuck permanently on or off, handy as a constant input to other components.
> - [`StaticValue`](./Cosmoteer.Ships.Parts.Logic.PartStaticValueRules.md): A fixed number that other components can read, most often a tuning constant.
> - [`StatusToggle`](./Cosmoteer.Ships.Statuses.PartStatusToggleRules.md): Turns on while the named status on the part sits between `MinStatusValue` and `MaxStatusValue`, letting other components react to a burning or scorched part.
> - [`StatusValueRegulator`](./Cosmoteer.Ships.Statuses.StatusValueRegulatorRules.md): Pushes status values in a region around the part towards `TargetValue`, paying for the change out of a resource storage or banking it into one.
> - [`Stopwatch`](./Cosmoteer.Ships.Parts.Logic.PartStopwatchRules.md): Counts time upward while the part runs, stopping at `Max` and restartable from a trigger.
> - [`ThresholdToggle`](./Cosmoteer.Ships.Parts.Logic.PartThresholdToggleRules.md): On while a value from another component sits between `MinAmount` and `MaxAmount`.
> - [`ThresholdTrigger`](./Cosmoteer.Ships.Parts.Logic.PartThresholdTriggerRules.md): Fires when a value from another component moves into the band between `MinAmount` and `MaxAmount`.
> - [`Thruster`](./Cosmoteer.Ships.Parts.Thrusters.ThrusterRules.md): Pushes the ship with `Force` while burning fuel, its activation set by how the ship is being steered.
> - [`TileLineScoreValue`](./Cosmoteer.Ships.Parts.Logic.PartTileLineScoreValueRules.md): Scores the tiles along a straight line out from the part and stops where a blocking part or shield gets in the way.
> - [`TileScoreValue`](./Cosmoteer.Ships.Parts.Logic.PartTileScoreValueRules.md): Scores the parts filling a region of tiles around the part and provides the total as a value.
> - [`Timer`](./Cosmoteer.Ships.Parts.Logic.PartTimerRules.md): Fires when `Duration` runs out, able to restart itself for a steady repeating tick.
> - [`ToggleEffects`](./Cosmoteer.Ships.Parts.Effects.PartToggleEffectsRules.md): Plays one set of effects when a toggle turns on and another when it turns off.
> - [`ToggleEmitterSelector`](./Cosmoteer.Ships.Parts.Weapons.PartToggleEmitterSelectorRules.md): Hands the weapon one of two emitters depending on a toggle, which is how a part switches ammunition.
> - [`ToggleProxy`](./Cosmoteer.Ships.Parts.Logic.PartToggleProxyRules.md): Stands in for a toggle component in another part, reporting `IsOnWhenNotConnected` when there is nothing to connect to.
> - [`ToggleTrigger`](./Cosmoteer.Ships.Parts.Logic.PartToggleTriggerRules.md): Fires whenever the toggle it watches switches on, off, or either way.
> - [`ToggleValueSelector`](./Cosmoteer.Ships.Parts.Logic.PartToggleValueSelectorRules.md): Provides one of two values depending on whether a toggle is on.
> - [`ToggledBlendSprites`](./Cosmoteer.Ships.Parts.Graphics.PartToggledBlendSpritesRules.md): Picks a blending sprite from a set according to which of the listed toggles are on.
> - [`ToggledComponents`](./Cosmoteer.Ships.Parts.Logic.PartToggledComponentsRules.md): Adds or removes the components nested inside it depending on a toggle, which is how a part swaps whole behaviors.
> - [`TransformLerp`](./Cosmoteer.Ships.Parts.Logic.PartTransformLerpRules.md): Slides and turns between a start and an end pose as the value it watches moves across its range.
> - [`TransformMatch`](./Cosmoteer.Ships.Parts.Logic.PartTransformMatchRules.md): Chases another component's position and rotation at a limited speed, and can be sent back to rest by a toggle.
> - [`TriggerProxy`](./Cosmoteer.Ships.Parts.Logic.PartTriggerProxyRules.md): Stands in for a trigger component in another part, passing its firing along to this part.
> - [`TriggeredEffects`](./Cosmoteer.Ships.Parts.Effects.PartTriggeredEffectsRules.md): Plays effects every time the trigger it watches fires, such as a muzzle flash on each shot.
> - [`TriggeredPartSwap`](./Cosmoteer.Ships.Parts.Logic.TriggeredPartSwapRules.md): Replaces the part with a different part when triggered, carrying health and resources across if asked.
> - [`TriggeredResourceConverter`](./Cosmoteer.Ships.Parts.Resources.TriggeredResourceConverterRules.md): Turns one resource into another each time its trigger fires rather than on a repeating timer.
> - [`TriggeredToggle`](./Cosmoteer.Ships.Parts.Logic.PartTriggeredToggleRules.md): Switches on when one trigger fires and off when another does.
> - [`TurretWeapon`](./Cosmoteer.Ships.Parts.Weapons.TurretWeaponRules.md): A weapon on a turret that rotates at `RotateSpeed` to bear on its target before firing.
> - [`TypedResourceGrid`](./Cosmoteer.Ships.Parts.Resources.TypedResourceGridRules.md): Holds a grid of stacks of one resource, as a battery room or an ammo store does.
> - [`TypedResourceGridConsumer`](./Cosmoteer.Ships.Parts.Resources.TypedResourceGridConsumerRules.md): Puts a `TypedResourceGrid` on the crew's delivery list so they keep its cells stocked.
> - [`UIColor`](./Cosmoteer.Ships.Parts.UI.PartUIColorRules.md): Gives the player a color picker on the part and passes the chosen color to other components.
> - [`UITargeter`](./Cosmoteer.Ships.Parts.UI.PartUITargeterRules.md): Gives the player a target button for the weapons it names, so they can be aimed by hand.
> - [`UIToggle`](./Cosmoteer.Ships.Parts.UI.PartUIToggleRules.md): Gives the player a switch on the part and reports the chosen setting as a mode number.
> - [`UIToggleModeOverride`](./Cosmoteer.Ships.Parts.Logic.UIToggleModeOverrideRules.md): Forces a player-facing toggle into `TargetMode` on one trigger and hands control back on another.
> - [`UITrigger`](./Cosmoteer.Ships.Parts.UI.PartUITriggerRules.md): Gives the player a button on the part that fires a trigger when pressed.
> - [`ValueAccumulator`](./Cosmoteer.Ships.Parts.Logic.PartValueAccumulatorRules.md): Builds a value up while its toggle is on and lets it drain away again, the way heat gathers and cools.
> - [`ValueChangeTrigger`](./Cosmoteer.Ships.Parts.Logic.PartValueChangeTriggerRules.md): Fires when a watched value moves and provides the size of that change as its own value.
> - [`ValueColor`](./Cosmoteer.Ships.Parts.Graphics.PartValueColorRules.md): Builds a color from four value components, one per channel, so a color can follow live numbers.
> - [`ValueLerp`](./Cosmoteer.Ships.Parts.Logic.PartValueLerpRules.md): Remaps a value from an input range onto an output range.
> - [`ValueOperation`](./Cosmoteer.Ships.Parts.Logic.PartValueOperationRules.md): Divides, subtracts, raises to a power or takes the modulo of two values and provides the result.
> - [`ValueProxy`](./Cosmoteer.Ships.Parts.Logic.PartValueProxyRules.md): Stands in for a value component in another part, reporting `ValueWhenNotConnected` when there is nothing to connect to.
> - [`ValueSprites`](./Cosmoteer.Ships.Parts.Graphics.PartValueSpritesRules.md): Picks a sprite from a list according to a value read from another component.
> - [`ValueTween`](./Cosmoteer.Ships.Parts.Logic.PartValueTweenRules.md): Eases its value between `OffValue` and `OnValue` whenever a toggle flips, over the tween duration given for that direction.
> - [`WeaponTargetOverlay`](./Cosmoteer.Ships.Parts.Overlays.WeaponTargetOverlayRules.md): Draws a marker on the weapon's current target and a line running out to it.
> - [`WholeShipProvider`](./Cosmoteer.Ships.Parts.Buffs.WholeShipBuffProviderRules.md): Buffs every part on the ship at once.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. Write prose under each `## Field` heading below. The headings and the type-signature
> lines are regenerated by the scaffolder, so a hand-edit to them is overwritten. Add `[[links]]`
> and Markdown freely in the prose. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).

## OnlyWithRotation
`int` · optional

Restricts the component to one part rotation (0 to 3 quarter turns). At any other rotation the component is simply not created, which also applies to its blueprint and destroyed-part forms. Combine several rotation-locked components to give a part different behavior or graphics per orientation.

## OnlyWithFlip
`bool` · optional

Restricts the component to one horizontal-flip state of the part, so it only exists when the part's flip matches. The vanilla tri-steel factory declares a `FloorSprite` with `OnlyWithFlip = false` and a mirrored `FloorSpriteFlipped` with `OnlyWithFlip = true`.

## IncludeWhenUnderConstruction
`bool` · optional

Whether the component is also created while the part is an unfinished construction site. Off by default, though collider and death-effect components force it on in code. Vanilla `base_part_terran.rules` enables it, with [[Cosmoteer.Ships.Parts.PartComponentRules.IncludeWhenNotUnderConstruction]] set to false, for its construction scaffolding sprites.

## IncludeWhenNotUnderConstruction
`bool` · optional · default `true`

Whether the component is created on the finished part. Setting this to false while enabling [[Cosmoteer.Ships.Parts.PartComponentRules.IncludeWhenUnderConstruction]] makes a construction-site-only component, such as the vanilla scaffolding and construction progress sprites.

## BlueprintSortOrder
`int` · optional

Specifies the ordering of DrawBlueprintData@) relative to other components on the part. Declaration order is used to break ties.
