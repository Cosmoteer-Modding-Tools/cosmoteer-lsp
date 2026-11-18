# Cosmoteer.Ships.Networks.PartNetworkRouterRules/IRouteGenerator

Supplies the hops inside a router. Write `Simple` for one-way hops, `Bidirectional` for pairs, or `Omni` to link every listed component to every other.

> A group in this slot picks its class with `Type = …`:
>
> - [`Bidirectional`](./Cosmoteer.Ships.Networks.PartNetworkRouterRules%2BBidirectionalRouteGenerator.md): Declares routes as `A B Cost` triples and builds the hop in both directions from each one.
> - [`Omni`](./Cosmoteer.Ships.Networks.PartNetworkRouterRules%2BOmniRouteGenerator.md): Links every component in `ComponentIDs` to every other one, in both directions, at the same cost.
> - [`Simple`](./Cosmoteer.Ships.Networks.PartNetworkRouterRules%2BSimpleRouteGenerator.md): Lists the router's hops one at a time, each with its own start, end and cost.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. This class declares no fields of its own, so the summary is the whole page. The
> fields it is written with come from its base class. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).
