# Halfling.Particles.IParticleRenderer

Decides how a particle system's particles get drawn, from plain textured quads to lightning bolts.

> A group in this slot picks its class with `Type = …`:
>
> - [`LightQuadRenderer`](./Cosmoteer.Simulation.MediaEffects.ParticleRenderers.LightParticleQuadRenderer.md): Draws the particles into the light buffer so they light up what is around them instead of only being drawn over it.
> - [`LightningRenderer`](./Cosmoteer.Simulation.MediaEffects.ParticleRenderers.ParticleLightningRenderer.md): Draws each particle as a jagged lightning bolt running from `SourceLocationIn` to `DestLocationIn`, with noise bending the segments.
> - [`LitQuadRenderer`](./Cosmoteer.Simulation.MediaEffects.ParticleRenderers.LitParticleQuadRenderer.md): Draws particles as quads shaded by the scene lighting, taking each particle's surface normal from `LightNormalIn`.
> - [`StandardQuadRenderer`](./Halfling.Particles.Renderers.StandardParticleQuadRenderer.md): Draws each particle as a plain textured quad, the usual choice for smoke, sparks and flame.
> - [`TwoColorQuadRenderer`](./Cosmoteer.Simulation.MediaEffects.ParticleRenderers.TwoColorParticleQuadRenderer.md): Draws particles as quads that carry a second color as well, for shaders that blend between two tints.

> Machine-generated skeleton. The line above is the class summary, one sentence saying what this
> class is. This class declares no fields of its own, so the summary is the whole page. The
> fields it is written with come from its base class. See [README](./README.md) to contribute.
>
> For guides, worked examples and the bigger picture, see the
> [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding).
