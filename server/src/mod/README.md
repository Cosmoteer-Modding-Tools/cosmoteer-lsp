# `mod/` — mod.rules support

A `mod.rules` (or `mod_*.rules`) file is a **mod manifest** (distinct from normal `.rules`
data files, and from `mod-*.rules` data files which are just a naming convention). It declares
mod metadata (`ID`, `Name`, `Version`, `Author`, …) and an `Actions` list that patches the
base game.

## Action verbs (from `Standard Mods/example_mod/mod.rules`)

| `Action = …` | Target field | Source field | Extra fields |
|--------------|--------------|--------------|--------------|
| `Add`        | `AddTo`      | `ToAdd`      | `Name`, `OnlyIfNotExisting`, `CreateIfNotExisting`, `IgnoreIfNotExisting` |
| `AddMany`    | `AddTo`      | `ManyToAdd`  | `CreateIfNotExisting`, `IgnoreIfotExisting` |
| `Overrides`  | `OverrideIn` | `Overrides`  | `CreateIfNotExisting`, `IgnoreIfNotExisting` |
| `Replace`    | `Replace`    | `With`       | `IgnoreIfNotExisting` |
| `Remove`     | `Remove`     | —            | `IgnoreIfNotExisting` |
| `RemoveMany` | `RemoveMany` | —            | `IgnoreIfNotExisting` |
| `AddBase`    | `AddBaseTo`  | `BaseToAdd`  | `IgnoreIfNotExisting` |

`VERB_SCHEMA` in `action.ts` is the single source of truth (drives parsing, validation and
completion).

## Resolution model: game-root vs mod-root, and the effective tree

- **TARGET** paths (`AddTo = "<./Data/...>"`, bare `<cosmoteer.rules>`, workshop
  `<./Data/../../../workshop/content/<appid>/<id>/...>`) resolve against the **game Data
  root**. `action-target-resolver.ts#normalizeTargetPath` rewrites them to the canonical
  `<./Data/...>` form so they take the existing game-tree branch of `FullNavigationStrategy`.
- **SOURCE** refs (`&<...>`) resolve **mod-relative** (their own file) — already handled by
  the navigation engine.
- **Effective tree (self-awareness)** — `mod-context.ts` resolves references against
  *vanilla + the mod's own additions*: the mod's root `cosmoteer.rules` globals and the names
  its `Add (Name)` / root `Overrides` actions inject. So a global the mod adds to
  `<cosmoteer.rules>` (e.g. `SW_SHADERS`) resolves both as a later action target and via
  super-paths `&/SW_SOUNDS/…` anywhere in the mod. The mod root is found by walking up from
  the open file (`mod-root.ts`).

## Files

- `action.ts` — `ACTION_VERBS`, `VERB_SCHEMA`, `TARGET_FIELDS`, and the node-capturing `ModAction`.
- `action-parser.ts` — `parseModActions(document)` reads the top-level `Actions` list.
- `action-target-resolver.ts` — `normalizeTargetPath` + `resolveActionTarget` (game root + workshop).
- `mod-root.ts` — `findModRoot(uri)` (walk up to the manifest).
- `mod-context.ts` — `ModContext` + `resolveWithModContext` (vanilla + mod additions).
- `mod-rules.registrar.ts` — stores per-manifest actions; populated in `server.ts`.

Validation lives in `features/diagnostics/validator.mod-action.ts` (run as a separate pass from
`validateTextDocument`); the generic value validator only skips mod-action *target* nodes and
falls back to the effective tree for everything else. Completion lives in
`features/completion/autocompletion.mod-rules.ts` (verbs, field names, and target paths).
