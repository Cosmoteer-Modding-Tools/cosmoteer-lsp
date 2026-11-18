# Halfling.Particles.IParticleDataUpdater

One step in a particle system's initializer or updater list, reading and writing named particle variables such as `location`, `scale` and `color`.

> A group in this slot picks its class with `Type = …`:
>
> - [`AddFrameOfReference`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleAddFrameOfReference.md): Adds the motion of whatever the effect is riding on into each particle's velocity, so a trail drifts along with its ship.
> - [`AlignToVelocity`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleAlignToVelocity.md): Turns each new particle to point the way it is travelling, so streaks and sparks lie along their own motion.
> - [`AlternatingConstVector2`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleAlternatingConstVector2.md): Hands out `Vector2A` and `Vector2B` in turn to successive particles, the way the chaingun ejects casings to alternating sides.
> - [`AssignIndex`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleAssignIndex.md): Writes each particle's index into a variable so later updaters can vary a value from one particle to the next.
> - [`Barrier`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleBarrier.md): Stops particles at a barrier plane the game moves at runtime, which is how a bullet trail is cut off at the point of impact.
> - [`ColorFromSource`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleColorFromSource.md): Tints each new particle with the color of whatever spawned the effect.
> - [`ColorRamp`](./Halfling.Particles.Updaters.ParticleColorRamp.md): Fades a particle's color along a list of colors as `LerpIn` runs from 0 to 1, usually driven by its remaining life.
> - [`ConstructVector2`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleConstructVector2.md): Packs two float variables into a single Vector2 variable.
> - [`CrewColor`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleCrewColor.md): Tints each new particle with the current crew member's color.
> - [`DirectionFromWorldSpace`](./Halfling.Scene2D.Particles.ParticleDirectionFromWorldSpace.md): Rotates a direction vector out of world space into the effect's own coordinates.
> - [`EndPointFromCustomShape`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleEndPointFromCustomShape.md): Places each new particle at the far end of the effect's shape, such as the point where a beam terminates.
> - [`FpsCompensator`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleFpsCompensator.md): Spreads a frame's worth of new particles back along their velocity so a stream does not clump into blobs at low frame rates.
> - [`GetHitNormal`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleGetHitNormal.md): Writes the surface normal of the impact into a variable, so sparks can spray back out off the surface that was hit.
> - [`InheritVelocity`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleInheritVelocity.md): Adds the world velocity of the effect's source into each particle's velocity, so a muzzle flash carries the ship's motion.
> - [`Lerp`](./Halfling.Particles.Updaters.ParticleLerp.md): Blends a particle variable from `FromValue` to `ToValue` as `LerpIn` runs from 0 to 1, usually driven by its remaining life.
> - [`Lifetime`](./Halfling.Particles.Updaters.ParticleLifetime.md): Counts every particle down over the same fixed `Lifetime` and deletes it at the end. Other updaters read that same countdown to fade size and color.
> - [`LocalBarrier`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleLocalBarrier.md): Stops particles at a barrier plane whose position and facing come from other particle variables, with no help from the simulation.
> - [`LocationAndValueFromCustomShape`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleLocationAndValueFromCustomShape.md): Places each new particle at a random point on the effect's shape and reads out the value the shape carries there.
> - [`LocationFromCustomShape`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleLocationFromCustomShape.md): Places each new particle at a random point on the effect's shape, such as somewhere along a beam or across a burning tile.
> - [`LocationFromPartRect`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleLocationFromPartRect.md): Places each new particle at a random point inside a part's rectangle, in ship coordinates so the particles ride along with the ship.
> - [`LocationFromSource`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleLocationFromSource.md): Places each new particle at the point the effect was spawned from.
> - [`LocationToWorldSpace`](./Halfling.Scene2D.Particles.ParticleLocationToWorldSpace.md): Converts a particle's location out of the effect's local coordinates into world coordinates, so it stops following the ship that spawned it.
> - [`OffsetByIndex`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleOffsetByIndex.md): Shifts a particle variable by `Offset` times the particle's index, to step a burst out in even increments.
> - [`Operator`](./Halfling.Particles.Updaters.ParticleOperator.md): Combines two particle variables with `Operator` and writes the result into a third.
> - [`OperatorConst`](./Halfling.Particles.Updaters.ParticleOperatorConst.md): Applies `Operator` between a particle variable and a constant `Value`, such as multiplying every particle's scale by a fixed amount.
> - [`ParticleLightNormal`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleLightNormal.md): Works out each particle's lighting normal from where it sits in the world, feeding a renderer that shades particles to match the scene.
> - [`ParticleNormalFromRotation`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleNormalFromRotation.md): Turns a rotation variable into a unit Vector2 pointing that way.
> - [`ParticleRotationFromNormal`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleRotationFromNormal.md): Turns a Vector2 direction into the rotation angle that points along it.
> - [`PerpendicularVector`](./Halfling.Particles.Updaters.ParticlePerpendicularVector.md): Writes the vector at right angles to an input vector, for spray thrown out sideways from a direction of travel.
> - [`RandomRotationByIndex`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleRandomRotationByIndex.md): Spreads rotations evenly around the circle by particle index rather than purely at random, so a burst of debris leaves no gaps.
> - [`RotateVectorRandom`](./Halfling.Particles.Updaters.ParticleRotateVectorRandom.md): Turns a vector by a random angle within `Rotation`, to scatter a direction that would otherwise be identical for every particle.
> - [`RotationToWorldSpace`](./Halfling.Scene2D.Particles.ParticleRotationToWorldSpace.md): Converts a particle's rotation out of the effect's local coordinates into world coordinates, so it no longer turns with the ship.
> - [`ScalarOperator`](./Halfling.Particles.Updaters.ParticleScalarOperator.md): Applies `Operator` between a single float variable and a wider one such as a Vector2 or a Color, hitting every component at once.
> - [`ScaleFromCamera`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleScaleFromCamera.md): Sizes each new particle by the current camera zoom, keeping an effect readable whether the view is close in or far out.
> - [`ScaleFromIntensity`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleScaleFromIntensity.md): Sizes each new particle by the effect's current intensity, so a stronger effect throws bigger particles.
> - [`ScaleToWorldSpace`](./Halfling.Scene2D.Particles.ParticleScaleToWorldSpace.md): Converts a particle's scale out of the effect's local coordinates into world scale.
> - [`SetBulletBarrierID`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleSetBulletBarrierID.md): Copies the firing bullet's barrier id onto each particle, pairing a trail with the barrier that will cut it off when the bullet lands.
> - [`SetRandom`](./Halfling.Particles.Updaters.ParticleSetRandom.md): Sets a particle variable to a random value between `FromValue` and `ToValue`, the usual way to vary size, rotation or tint across a burst.
> - [`SetRandomCircle`](./Halfling.Particles.Updaters.ParticleSetRandomCircle.md): Scatters new particles at random inside `Circle`, or around its rim when `Perimeter` is set.
> - [`SetRandomHsvColor`](./Halfling.Particles.Updaters.ParticleSetRandomHsvColor.md): Tints each new particle a random color drawn from hue, saturation, value and alpha ranges.
> - [`SetRandomVelocity`](./Halfling.Particles.Updaters.ParticleSetRandomVelocity.md): Launches each new particle at a random `Speed` in a random `Direction`.
> - [`SetRandomVelocityFromPoint`](./Halfling.Particles.Updaters.ParticleSetRandomVelocityFromPoint.md): Launches each new particle straight away from `AwayFromPoint` at a random `Speed`, for outward bursts and shockwaves.
> - [`SetValue`](./Halfling.Particles.Updaters.ParticleSetValue.md): Sets a particle variable to a fixed `Value`, the plainest way to give every particle the same starting size, tint or offset.
> - [`SetWorldSpaceLocation`](./Halfling.Scene2D.Particles.ParticleSetWorldSpaceLocation.md): Places each new particle at `LocalLocation` measured against the effect, and stores the world position that lands on.
> - [`SetWorldSpaceRotation`](./Halfling.Scene2D.Particles.ParticleSetWorldSpaceRotation.md): Sets each new particle's world rotation from `LocalRotation` measured against the effect's own facing.
> - [`SetWorldSpaceScale`](./Halfling.Scene2D.Particles.ParticleSetWorldSpaceScale.md): Sets each new particle's world scale from `LocalScale` measured against the effect's own scale.
> - [`SetWorldSpaceVelocity`](./Halfling.Scene2D.Particles.ParticleSetWorldSpaceVelocity.md): Sets each new particle's world velocity from `LocalVelocity` measured against the effect's own facing.
> - [`UvAnimation`](./Halfling.Particles.Updaters.ParticleUvAnimation.md): Plays a sprite sheet as a flipbook on each particle, stepping frames at `Framerate` as the particle ages.
> - [`UvFlip`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleUvFlip.md): Mirrors a particle's texture coordinates left to right or top to bottom, so one sprite frame can be reused flipped.
> - [`UvSprites`](./Halfling.Particles.Updaters.ParticleUvSprites.md): Picks one frame of a sprite sheet per particle from `SpriteIndexIn`, so a single burst can mix several shapes.
> - [`ValueCurve`](./Halfling.Particles.Updaters.ParticleValueCurve.md): Drives a particle variable along a curve of `Points` as `LerpIn` runs from 0 to 1, for fades that are not a straight line.
> - [`VariableLifetime`](./Halfling.Particles.Updaters.ParticleVariableLifetime.md): Counts each particle down over its own lifetime read from `LifetimeIn` and deletes it at the end, so particles in one burst can die at different times.
> - [`VelocityFromIntensity`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleVelocityFromIntensity.md): Launches each new particle at a speed scaled by the effect's current intensity.
> - [`VelocityToWorldSpace`](./Halfling.Scene2D.Particles.ParticleVelocityToWorldSpace.md): Converts a particle's velocity out of the effect's local coordinates into world coordinates.
> - [`WorldLocationFromPartCenter`](./Cosmoteer.Source.Simulation.MediaEffects.ParticleUpdaters.ParticleWorldLocationFromPartCenter.md): Sets a particle's initial location to the center of a part.
> - [`WorldLocationFromPartRect`](./Cosmoteer.Simulation.MediaEffects.ParticleUpdaters.ParticleWorldLocationFromPartRect.md): Places each new particle at a random point inside a part's rectangle, in world coordinates so the particles are left behind as the ship moves on.
> - [`WorldScaleFromPartSize`](./Cosmoteer.Source.Simulation.MediaEffects.ParticleUpdaters.ParticleWorldScaleFromPartSize.md): Sets a particle's initial scale to the size of a part.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. This class declares no fields of its own, so the summary is the whole page. The
> fields it is written with come from its base class. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).
