# Cosmoteer.Simulation.HitEffects.HitEffectRules

One thing a shot does where it lands, from damage and knockback to statuses, drains and spawned bullets. A modder writes one of its concrete types.

> A group in this slot picks its class with `Type = …`:
>
> - [`AreaCrewStun`](./Cosmoteer.Simulation.HitEffects.AreaCrewStunEffectRules.md): Knocks out every crew member within `Radius` of the impact for `Duration`, with the stun weakening toward the edge.
> - [`AreaDamage`](./Cosmoteer.Simulation.HitEffects.AreaDamageEffectRules.md): Damages every part within `Radius` of the impact at once, weakening toward the edge by `Falloff`.
> - [`AreaImpulse`](./Cosmoteer.Simulation.HitEffects.AreaImpulseEffectRules.md): Shoves nearby ships away from the impact point with a single physics kick.
> - [`AreaResourceDrain`](./Cosmoteer.Simulation.HitEffects.AreaResourceDrainEffectRules.md): Drains `ResourceType` out of every part within `Radius` of the impact, for effects that empty ammo or battery storage.
> - [`AreaShieldStatusApplication`](./Cosmoteer.Simulation.HitEffects.AreaShieldStatusApplicationEffectRules.md): Applies a status to the generators of any shields overlapping `Radius` of the impact, optionally scaled by how much of the shield is covered.
> - [`AreaStatusApplication`](./Cosmoteer.Simulation.HitEffects.AreaStatusApplicationEffectRules.md): Applies a status such as fire or heat to every part within `Radius` of the impact.
> - [`ChainLightning`](./Cosmoteer.Simulation.HitEffects.ChainLightningEffectRules.md): Arcs lightning from the impact to nearby targets and then hops on from target to target, running `HitEffects` at every strike.
> - [`CollectNugget`](./Cosmoteer.Simulation.HitEffects.CollectNuggetEffectRules.md): Pulls a floating resource nugget in toward the storage that is collecting it, the way the manipulator beam gathers salvage.
> - [`Damage`](./Cosmoteer.Simulation.HitEffects.DamageEffectRules.md): Damages the single part the shot hit, optionally spending a shared damage pool carried by the bullet.
> - [`ExplosiveDamage`](./Cosmoteer.Simulation.HitEffects.ExplosiveDamageEffectRules.md): Spends a pool of `TotalDamage` outward from the blast center so the nearest parts soak it up first and anything sheltered behind them survives.
> - [`ExplosiveResourceDrain`](./Cosmoteer.Simulation.HitEffects.ExplosiveResourceDrainEffectRules.md): Spends a pool of `TotalDrain` outward from the blast center, draining `ResourceType` from the nearest parts first.
> - [`Feedback`](./Cosmoteer.Simulation.HitEffects.FeedbackEffectRules.md): Turns the contained effects back on the part that fired the shot, for recoil, self damage or a weapon that heats itself up.
> - [`GridStatusApplication`](./Cosmoteer.Simulation.HitEffects.GridStatusApplicationEffectRules.md): Spreads a status tile by tile across the ship's grid from the hit tile, paying a cost per tile and stopping at walls or at `MaxCost`.
> - [`Impulse`](./Cosmoteer.Simulation.HitEffects.ImpulseEffectRules.md): Kicks the hit ship with a single physics impulse, knocking it back or spinning it.
> - [`KillCrew`](./Cosmoteer.Simulation.HitEffects.KillCrewEffect.md): Kills crew standing on the hit part, with `KillChance` rolled per crew member.
> - [`MoveCrew`](./Cosmoteer.Simulation.HitEffects.MoveCrewEffectRules.md): Pulls a crew member floating in space in toward the airlock collecting them, the way the manipulator beam recovers crew.
> - [`OverrideBulletDistance`](./Cosmoteer.Simulation.HitEffects.OverrideBulletDistanceEffectRules.md): Rewrites how far the shot still has to travel, so a hit can cut a bullet short or let it carry on further.
> - [`OverrideBulletLifetime`](./Cosmoteer.Simulation.HitEffects.OverrideBulletLifetimeEffectRules.md): Rewrites how much time the shot has left before it expires, so a hit can end a bullet early or extend it.
> - [`Random`](./Cosmoteer.Simulation.HitEffects.RandomHitEffectRules.md): Picks one of several hit effect sets at random every time the shot lands, weighted by each option's `RandomWeight`.
> - [`Repeating`](./Cosmoteer.Simulation.HitEffects.RepeatingEffectRules.md): Fires the same hit effects again every `Interval` seconds for `Count` repetitions, for burning and other lingering damage.
> - [`ResourceDrain`](./Cosmoteer.Simulation.HitEffects.ResourceDrainEffectRules.md): Drains `Amount` of `ResourceType` from the single part the shot hit.
> - [`SpawnBullets`](./Cosmoteer.Simulation.HitEffects.SpawnBulletsEffectRules.md): Spawns fresh bullets at the impact, for shrapnel, cluster warheads and submunitions.
> - [`StatusApplication`](./Cosmoteer.Simulation.HitEffects.StatusApplicationEffectRules.md): Applies a status such as fire or heat to the single part the shot hit.
> - [`TargetFilter`](./Cosmoteer.Simulation.HitEffects.TargetFilterRules.md): Runs the contained hit effects only when the shot's target passes `Filter`, so a weapon can behave differently against friendlies or asteroids.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. This class declares no fields of its own, so the summary is the whole page. The
> fields it is written with come from its base class. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).
