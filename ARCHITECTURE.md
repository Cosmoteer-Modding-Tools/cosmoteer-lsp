# Architecture

How the server is layered, what each layer may import, and how that is kept true.

## Layers

`server/src`, lowest first. A layer may import from the layers below it and from its own siblings.
An import that points upward is a defect, whether or not it compiles.

| Layer        | Holds                                                           | May import              |
| ------------ | --------------------------------------------------------------- | ----------------------- |
| `core/`      | lexer, parser, AST. The grammar, and nothing that knows a game. | nothing in `server/src` |
| `utils/`     | dependency-free helpers                                         | nothing in `server/src` |
| `document/`  | schema model, document kinds, the parsed-document registry      | `core`, `utils`         |
| `workspace/` | the file system, caches, persisted index state                  | + `document`            |
| `semantics/` | inheritance, references, value evaluation                       | + `workspace`           |
| `mod/`       | manifests, actions, the mod indexes                             | + `semantics`           |
| `features/`  | one folder per editor feature                                   | + `mod`                 |
| `lsp/`       | protocol handlers and wiring                                    | + `features`            |
| `cli/`       | the lint command                                                | everything below        |

`server.ts`, `settings.ts` and `capabilities.ts` sit at the root of `server/src`, outside the table.
Each is settled once at startup and read from every layer, so giving any of them a layer would make
the readers below it reach upward for a value that is already fixed by the time they run. Nothing
else belongs there.

`core/` is the layer that matters most. It is what a consumer outside the language server can use
on its own, so it is the one boundary enforced as a hard ESLint error
(`no-restricted-imports` in `eslint.config.mjs`). It is clean today and has to stay clean.

The other boundaries are convention rather than enforced. They are clean today: no import in
`server/src` points upward through the table, as a runtime import or as an `import type`.

## Inverting a dependency

Where a lower layer genuinely needs behaviour that lives above it, the lower layer declares the port
and the upper layer registers the implementation at startup. `document/reference-resolver.ts` does
this already and is the pattern to copy. Reaching upward with an import instead is what produces
import cycles.

## The extension client

`client/src/extension.ts` is a registry, not a place to wire features. `activate` builds the
language client and then calls one `register<Feature>(context, client)` per feature; anything a
feature needs registered (commands, CodeLens providers, content providers, notification handlers)
belongs in that feature's own module.

Each feature folder holds its registrar as `<folder>.ts`, or as `<folder>.registrar.ts` where
`<folder>.ts` is already the feature's implementation. Message types for a webview panel live in the
panel's `.types.ts` sibling, as a discriminated union on `type` rather than one shape with every
field optional, so a handler's branches narrow.

## The webview pages

Each page is a folder of ES modules under `media/src`, and `esbuild.mjs` bundles one page per entry
into `media/dist`. The bundle is a single IIFE on purpose: the JetBrains plugin inlines exactly one
script into the page it shows (`JcefPageHost.pageHtml`), so a tree of separately served modules
would leave Rider with a blank panel. The panels under `client/src` load the same file through
`asWebviewUri`, and `media/dist` is a build output rather than a checked-in file.

The modules under `media/src` are part of the lint, format and type-check runs. They talk to the
extension only through the host bridge declared in `media/webview.d.ts`, and `media/src/shared`
holds what all four pages share, which today is the localization lookup.

No module may touch `document` or `window` while it is being evaluated. The element handles live in
each page's `dom.js` as bindings an `initDom()` fills in, and the entry starts the page only where a
host bridge exists, because the unit tests load the built page under Node to read the pure helpers
it exports. Those helpers reach Node through the build's `globalName` and a footer rather than
through a `module.exports` written in the page: esbuild reads a file that names `module` as
CommonJS and gives it a `module` of its own, so the assignment would never arrive. The tests get the
bundle from `server/test/media-bundle.ts`, which builds it on demand when it is missing or older
than its sources.
