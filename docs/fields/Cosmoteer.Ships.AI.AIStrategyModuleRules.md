# Cosmoteer.Ships.AI.AIStrategyModuleRules

Sets what a live AI ship is trying to do. Write one of the concrete modules, which attack, flee, patrol, hold position, self repair or leave the sector.

> A group in this slot picks its class with `Type = …`:
>
> - [`AggroEnemies`](./Cosmoteer.Ships.AI.StrategyModules.AIAggroEnemiesModuleRules.md): Makes the ship pick a nearby enemy and attack, weighing candidates by firepower, distance and whether an ally is already on them.
> - [`AreaPatrol`](./Cosmoteer.Ships.AI.StrategyModules.AIAreaPatrolModuleRules.md): Makes the ship patrol a circle around its spawn location or the world origin.
> - [`DeleteSelf`](./Cosmoteer.Ships.AI.StrategyModules.AIDeleteSelfModuleRules.md): Deletes the ship the moment its AI first runs.
> - [`ExitSector`](./Cosmoteer.Ships.AI.StrategyModules.AIExitSectorModuleRules.md): Sends the ship to an FTL gate to leave the sector as soon as it can.
> - [`FleeFromEnemies`](./Cosmoteer.Ships.AI.StrategyModules.AIFleeFromEnemiesModuleRules.md): Makes the ship run once enemies come within `FleeStartRange`, optionally recalling its crew and jumping away after a delay.
> - [`FollowFleetLeader`](./Cosmoteer.Ships.AI.StrategyModules.AIFollowFleetLeaderModuleRules.md): Makes the ship stay with the fleet leader named in its AI parameters.
> - [`HaltForComms`](./Cosmoteer.Modes.Career.TradeRoutes.AIHaltForCommsModuleRules.md): Stores rules for AI "halt for comms" modules.
> - [`HoldPosition`](./Cosmoteer.Ships.AI.StrategyModules.AIHoldPositionModuleRules.md): Keeps the ship parked where it spawned, optionally holding its spawn rotation too.
> - [`SelfRepair`](./Cosmoteer.Ships.AI.StrategyModules.AISelfRepairModuleRules.md): Makes a damaged ship stop and repair or rebuild itself before carrying on.
> - [`TradeShip`](./Cosmoteer.Modes.Career.TradeRoutes.AITradeShipModuleRules.md): Stores rules for AI trade ship modules.
> - [`WantedSearch`](./Cosmoteer.Ships.AI.StrategyModules.AIWantedSearchModuleRules.md): Sends the ship searching through nearby wanted areas.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. This class declares no fields of its own, so the summary is the whole page. The
> fields it is written with come from its base class. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).
