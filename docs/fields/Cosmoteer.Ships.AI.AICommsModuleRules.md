# Cosmoteer.Ships.AI.AICommsModuleRules

Decides what an AI ship offers the player over comms. Write one of the concrete modules, which cover trade, missions, part techs, crew for hire and surrender talk.

> A group in this slot picks its class with `Type = …`:
>
> - [`CrewProvider`](./Cosmoteer.Ships.AI.CommsModules.AICrewProviderModuleRules.md): Lets the player hire crew off this AI ship, setting how many are for sale and what each one costs.
> - [`Dialogue`](./Cosmoteer.Ships.AI.CommsModules.AIDialogueModuleRules.md): Lets the AI ship hail others and haggle over surrender, setting how readily it offers, demands or accepts one and what the payout is.
> - [`MissionProvider`](./Cosmoteer.Ships.AI.CommsModules.AIMissionProviderModuleRules.md): Lets the AI ship hand out missions to the player.
> - [`TechProvider`](./Cosmoteer.Ships.AI.CommsModules.AITechProviderModuleRules.md): Lets the AI ship sell part techs to the player.
> - [`Trade`](./Cosmoteer.Ships.AI.CommsModules.AITradeModuleRules.md): Lets the AI ship trade with others, and says whether it also refills oxygen or helps with construction.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. This class declares no fields of its own, so the summary is the whole page. The
> fields it is written with come from its base class. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).
