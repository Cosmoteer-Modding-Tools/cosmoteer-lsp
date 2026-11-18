# Cosmoteer.Ships.AI.AIStasisModuleRules

Drives a ship cheaply while it sits outside live simulation range. Write one of the concrete modules, which patrol, follow a fleet leader, search wanted areas or leave the sector.

> A group in this slot picks its class with `Type = …`:
>
> - [`AreaPatrol`](./Cosmoteer.Ships.AI.StasisModules.AIStasisAreaPatrolModuleRules.md): Keeps a stasis ship circling its spawn location or the world origin at the given radius and speed.
> - [`DeleteSelf`](./Cosmoteer.Ships.AI.StasisModules.AIStasisDeleteSelfModuleRules.md): Deletes the stasis spawner as soon as it is created, so the ship never appears.
> - [`ExitSector`](./Cosmoteer.Ships.AI.StasisModules.AIStasisExitSectorModuleRules.md): Sends a ship out of the sector while it is still in stasis, travelling at the given stasis speed.
> - [`FollowFleetLeader`](./Cosmoteer.Ships.AI.StasisModules.AIStasisFollowFleetLeaderModuleRules.md): Keeps a stasis ship trailing its fleet leader at the given stasis speed.
> - [`MissionProvider`](./Cosmoteer.Ships.AI.StasisModules.AIStasisMissionProviderModuleRules.md): Holds the missions a stasis ship carries, so they exist before the ship is ever fully simulated.
> - [`WantedSearch`](./Cosmoteer.Ships.AI.StasisModules.AIStasisWantedSearchModuleRules.md): Sends a stasis ship prowling through nearby wanted areas.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. This class declares no fields of its own, so the summary is the whole page. The
> fields it is written with come from its base class. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).
