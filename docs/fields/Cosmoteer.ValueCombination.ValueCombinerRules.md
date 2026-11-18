# Cosmoteer.ValueCombination.ValueCombinerRules

How a freshly applied status value merges with the value the target already carries. A modder writes one of its concrete types, or just a combine mode name.

> A group in this slot picks its class with `Type = …`:
>
> - [`NormalizedAdd`](./Cosmoteer.ValueCombination.NormalizedAddCombinerRules.md): Adds a new status value onto the existing one with diminishing returns, so stacking fire onto an already burning tile adds less each time.
> - [`SimpleValueCombinerRules`](./Cosmoteer.ValueCombination.SimpleValueCombinerRules.md): Merges the old and new status values with one arithmetic `Mode`, either `Max`, `Min`, `Add` or `Multiply`. It can also be written as just the mode name on its own.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. This class declares no fields of its own, so the summary is the whole page. The
> fields it is written with come from its base class. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).
