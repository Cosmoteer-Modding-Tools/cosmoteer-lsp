# Cosmoteer.Bullets.BulletComponentRules

One piece of a projectile's behaviour, such as its collider, its homing, its hits or its sprite. A modder writes one of the concrete component types under a bullet's `Components` group.

> A group in this slot picks its class with `Type = …`:
>
> - [`Acceleration`](./Cosmoteer.Bullets.Physics.BulletAccelerationRules.md): Speeds the bullet up or slows it down over time, along its facing, its velocity or the line to its target.
> - [`AnimatedSprite`](./Cosmoteer.Bullets.Graphics.BulletAnimatedSpriteRules.md): Draws a looping frame animation on the bullet, with its own offset, spin, render bucket and fade timing.
> - [`BoxPhysics`](./Cosmoteer.Bullets.Physics.BulletBoxPhysicsRules.md): Gives the bullet a rectangular collider of the given `Size`, suited to long shapes like missiles.
> - [`CirclePhysics`](./Cosmoteer.Bullets.Physics.BulletCirclePhysicsRules.md): Gives the bullet a round collider of the given `Radius`, the usual choice for shells, bolts and mines.
> - [`DamagePool`](./Cosmoteer.Bullets.Hits.BulletDamagePoolRules.md): Gives the bullet a budget of damage that hit effects draw from until it runs out, so a penetrating shot weakens as it goes.
> - [`DeathByDamagePool`](./Cosmoteer.Bullets.Death.BulletDeathByDamagePoolRules.md): Kills the bullet as soon as the `DamagePool` component it names has spent all of its damage.
> - [`DeathByDistanceTraveled`](./Cosmoteer.Bullets.Death.BulletDeathByDistanceTraveledRules.md): Kills the bullet once it has flown `Distance`, falling back to the bullet's own `Range` when no distance is given.
> - [`DeathByEnemyProximity`](./Cosmoteer.Bullets.Death.BulletDeathByEnemyProximityRules.md): Detonates the bullet when an enemy ship or bullet stays within `Range` long enough to pass `AccumulateThreshold`, which is how proximity mines work.
> - [`DeathByLifetime`](./Cosmoteer.Bullets.Death.BulletDeathByLifetimeRules.md): Kills the bullet after `Lifetime` seconds, defaulting to the time it needs to fly the bullet's own `Range`.
> - [`DeathByPredictedTargetDistance`](./Cosmoteer.Bullets.Death.BulletDeathByPredictedTargetDistanceRules.md): Kills the bullet at the distance where it predicts it will meet its target, offset randomly by `RandomOffset` for an airburst spread.
> - [`DeathBySpeed`](./Cosmoteer.Bullets.Death.BulletDeathBySpeedRules.md): Kills the bullet once its speed drops below `MinSpeed` or rises above `MaxSpeed`, which is how a mine settles and arms.
> - [`DeathByTargetProximity`](./Cosmoteer.Bullets.Death.BulletDeathByTargetProximityRules.md): Kills the bullet once it comes within `Proximity` of its target, without needing to collide with it.
> - [`MediaEffects`](./Cosmoteer.Bullets.Graphics.BulletMediaEffectsRules.md): Plays particles, sounds and other media on the bullet for as long as it lives, such as a missile's thruster plume.
> - [`PenetratingHit`](./Cosmoteer.Bullets.Hits.BulletPenetratingHitRules.md): Lets the bullet punch into a ship and keep going, with separate effects for the first hit, each part passed through and the exit.
> - [`ProximityAcceleration`](./Cosmoteer.Bullets.Physics.BulletProximityAccelerationRules.md): Pulls the bullet towards nearby ships and bullets, or pushes it away when `Acceleration` is negative, which is how mines spread out.
> - [`SameShipRetarget`](./Cosmoteer.Bullets.Targeting.BulletSameShipRetargetRules.md): Sends the bullet after another part of the same ship when the part it was aimed at is destroyed.
> - [`SimpleHit`](./Cosmoteer.Bullets.Hits.BulletSimpleHitRules.md): Stops the bullet at the first thing it touches and applies the matching effects for a shield, a part, another bullet or crew.
> - [`Sprite`](./Cosmoteer.Bullets.Graphics.BulletSpriteRules.md): Draws a still image on the bullet, with its own offset, spin, render bucket and optional normals for lighting.
> - [`TargetHoming`](./Cosmoteer.Bullets.Physics.BulletTargetHomingRules.md): Turns the bullet towards its target at `TurnVelocity` and steers it around obstacles, which is what makes a missile home.
> - [`TargetSearch`](./Cosmoteer.Bullets.Targeting.BulletTargetSearchRules.md): Lets a bullet with no target look for one within `Range`, trying ships, parts, bullets and crew in the order listed.
> - [`Targetable`](./Cosmoteer.Bullets.Targeting.BulletTargetableRules.md): Gives the bullet health so point defense can shoot it down, and a `TargetCategory` label that other bullets filter on.
> - [`VolumeHit`](./Cosmoteer.Bullets.Hits.BulletVolumeHitRules.md): Turns the bullet into a volume that damages other bullets passing through it and drains beams, the way the flak field does. It only works on a bullet with `CirclePhysics`.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. This class declares no fields of its own, so the summary is the whole page. The
> fields it is written with come from its base class. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).
