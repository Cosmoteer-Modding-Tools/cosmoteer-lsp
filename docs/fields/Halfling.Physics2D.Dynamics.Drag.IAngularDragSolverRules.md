# Halfling.Physics2D.Dynamics.Drag.IAngularDragSolverRules

Stores data for and creates IAngularDragSolver instances.

> A group in this slot picks its class with `Type = …`:
>
> - [`Exponential`](./Halfling.Physics2D.Dynamics.Drag.ExponentialAngularDragSolver%2BExponentialAngularDragSolverRules.md): Angular drag of the form `-Coefficient * speed^Exponent`, so a fast spin is slowed far harder than a slow one.
> - [`Viscous`](./Halfling.Physics2D.Dynamics.Drag.ViscousAngularDragSolver%2BViscousAngularDragSolverRules.md): Angular drag proportional to spin speed, `-Coefficient * speed`.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. This class declares no fields of its own, so the summary is the whole page. The
> fields it is written with come from its base class. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).
