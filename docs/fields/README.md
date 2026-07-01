# Field documentation

This folder holds the human-written descriptions the Cosmoteer `.rules` language server shows when you
hover a field or pick it from autocompletion. Anyone can improve them — you do **not** need to own the
game, install the toolchain, or write any code. If you know what a field does, you can document it.

There is one Markdown file per schema type (e.g. `Cosmoteer.Ships.Parts.PartRules.md`), and one
`## Heading` per field inside it. Right now ~19% of fields are documented (seeded automatically from the
game's own developer notes and the community [modding wiki](https://cosmoteer.wiki.gg/wiki/Modding)); the
other ~81% are marked `<!-- TODO: needs documentation -->` and waiting for you.

> **Scope:** these docs describe *individual fields* — what to type and what it does. They are not a
> replacement for the [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding), which is the
> place for tutorials, guides and worked examples. Each scaffolded file links back to the wiki. If a
> field is documented on the wiki (e.g. under [Data fields](https://cosmoteer.wiki.gg/wiki/Modding/Data_fields)
> or [Projectile](https://cosmoteer.wiki.gg/wiki/Modding/Projectile)), a short field-level summary here
> is welcome — quote or paraphrase it, and let the wiki carry the deeper explanation.

## How to document a field

1. Find the field. Either browse the files here (they're named after the C# type), or in the editor
   hover the field and the hover tells you which type it belongs to.
2. Open that type's `.md` file and find the field's `## <FieldName>` heading.
3. Replace the `<!-- TODO: needs documentation -->` line with a plain-English description. Example:

   ```markdown
   ## MaxHealth
   `float` · optional · default `100`

   The hit points the part has before it is destroyed. Scales with the part's size.
   ```

4. Open a pull request. That's it.

### Rules of thumb

- **Only edit the prose** — the blank line *below* the `` `type` · optional · … `` signature line. Leave
  the `#` H1, the `## Field` headings, and the signature line alone: they are regenerated from the
  schema and any hand-edits are overwritten.
- Markdown works in the prose (lists, `code`, links). Link a related field or type with
  `[[Type.Field]]`-style references if you like — they render as text and help future editors.
- Don't invent behaviour. If you're unsure, say what you know and leave the rest, or open a PR marked
  *needs review* — a partial, honest description beats a confident wrong one.

### How to write the description

The goal is a sentence a modder reads on hover and immediately knows what to type. Aim for what the
field **does** and, where it matters, its **units, range, and interactions** with other fields. One or
two sentences is plenty.

Conventions, so every field reads the same way:

- **Start with the subject, in the present tense.** A noun phrase (`The hit points a part has before…`)
  or a plain verb (`Multiplies the crew's move speed within this part.`). Not `This field sets…` or
  `Used to…`.
- **Don't restate the type.** The signature line above already shows `` `float` · optional · default `100` ``.
  Write what the number *means*, not that it is a number.
- **Give units and range when they aren't obvious** — seconds, degrees, tiles, a `0..1` fraction, a
  multiplier vs an absolute value. This is the single most useful thing you can add.
- **Name related fields** rather than describing them again: "Ignored unless [[Cosmoteer.Ships.Parts.PartRules.Flammable]] is true."
- **Keep it plain.** No SHOUTING for emphasis, and no run-on sentences stitched together with `;` or ` - `
  — split into two sentences instead. (This matches the code-comment style used across the repo.)

Good vs. not:

| Field | ✅ Good | ❌ Avoid |
| --- | --- | --- |
| `MaxHealth` | `The hit points the part has before it is destroyed. Scales with part size.` | `This is an integer field that sets the max health value of the part.` |
| `FiringArc` | `Half-angle, in degrees, the turret can rotate to either side of its forward direction. 180 = full circle.` | `The firing arc.` |
| `ReloadTime` | `Seconds between shots. Reduced by reload buffs.` | `Sets how fast it reloads (higher is slower).` |

If the game's own note was seeded in for a field, treat it as a starting point — it's often terse or
written for engine developers. Rephrasing it for modders, or adding the units and range, is a welcome
improvement, not a duplicate.

### Fixing outdated docs

When Cosmoteer changes and a field is removed, the scaffolder moves its old prose into a
**Removed fields** section at the bottom of the file (marked `<!-- OUTDATED … -->`) instead of deleting
it. If the field is genuinely gone, delete that section. If it was renamed, move the prose up under the
new field's heading.

## Maintainer workflow (needs the toolchain)

The editable source of truth is the `.md` files here. Two generated artifacts flow from them:

| Command | What it does | When to run |
| --- | --- | --- |
| `npm run docs:compile` | `*.md` → `server/src/document/schema/field-docs.json` (the file the server ships and imports). | After **any** prose edit, and in CI. |
| `npm run docs:lint` | Checks every heading maps to a real field, every file to a real type, reports coverage, and fails if `field-docs.json` is stale. | In CI, and before committing. |
| `npm run docs:scaffold` | Regenerates the skeletons from the schema, pre-filling new fields from the XML seed and preserving all prose. | After a schema regen (Cosmoteer update). |

### After a Cosmoteer update

1. Regenerate the schema **and** the XML prose seed with schemagen (needs the game DLLs):
   `cd tools/schemagen && dotnet run -c Release`. This rewrites `cosmoteer.schema.json` and the
   gitignored `field-docs.seed.json` (see [tools/schemagen/README.md](../../tools/schemagen/README.md)).
2. `npm run docs:scaffold` — adds `.md` headings for new fields (pre-filled from the seed where the game
   documents them), moves dropped fields to *Removed fields*, and leaves existing prose untouched.
3. `npm run docs:compile` then `npm run docs:lint`.
4. Review the diff and commit the `.md` changes and `field-docs.json` together.

## How it reaches the editor

`field-docs.json` is merged onto the extracted schema at load by `applyFieldDocs`
(`server/src/document/schema/field-docs.ts`), which attaches each description to its field. From there
`fieldSignatureMarkdown` renders it below the type signature in both hover and completion — a
description written on a base-class field shows on every type that inherits it.

Because the docs are keyed by field name (and alias), they survive schema regens: a field keeps its
description as long as its name doesn't change.
