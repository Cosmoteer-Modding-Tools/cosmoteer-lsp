# Class and field documentation

This folder holds the human-written descriptions the Cosmoteer `.rules` language server shows when you
hover a field or a `Type=`, pick a field from autocompletion, or open a class page in the schema search.
Anyone can improve them. You do **not** need to install the toolchain or write any code. If you know what
a field does, you can document it.

There is one Markdown file per schema class (e.g. `Cosmoteer.Ships.Parts.PartRules.md`). Each file opens
with the **class summary**, one sentence saying what the class is, and then carries one `## Heading` per
field. Every field in the schema has a description, so most field contributions improve an existing one
rather than fill a blank: sharpening a terse sentence, adding the units or range, or naming the field a
value interacts with. A field added by a game update arrives marked
`<!-- TODO: needs documentation -->` and waits for you, and a class with no summary yet is marked
`<!-- TODO: needs a class summary -->`.

## How to write a class summary

The class summary is the first thing anyone reads about a class, and it sits above the "extends" line and
the field list on the class page. It answers "what is a `BulletEmitter`?" for someone who just met the
word. One sentence.

- Say what the thing does in the running game and what you use it for. `Fires bullets at whatever the
  turret it sits in is aimed at.`
- Never restate the class name back at the reader. `Stores rules for a bullet emitter component.` says
  nothing, and a fair number of the game's own notes read exactly like that.
- Don't repeat what the page already prints. It already shows the `Type = …` spelling, the base class and
  every field, so the summary should not.
- If a class is internal and nobody writes it in a `.rules` file, say that in one clause instead of
  inventing a purpose.

```markdown
# Cosmoteer.Ships.Parts.Weapons.BulletEmitterRules

Fires bullets from the part, one per barrel position, at the target its weapon is aimed at.

> Machine-generated skeleton. …
```

> **Scope:** these docs describe *one class or one field at a time*, what to type and what it does. They are not a
> replacement for the [Cosmoteer modding wiki](https://cosmoteer.wiki.gg/wiki/Modding), which is the
> place for tutorials, guides and worked examples. Each scaffolded file links back to the wiki. If a
> field is documented on the wiki (e.g. under [Data fields](https://cosmoteer.wiki.gg/wiki/Modding/Data_fields)
> or [Projectile](https://cosmoteer.wiki.gg/wiki/Modding/Projectile)), a short field-level summary here
> is welcome. Quote or paraphrase it, and let the wiki carry the deeper explanation.

## How to document a field

1. Find the field. Either browse the files here (they're named after the C# type), or in the editor
   hover the field and the hover tells you which type it belongs to.
2. Open that type's `.md` file and find the field's `## <FieldName>` heading.
3. Edit the prose under the signature line, or replace a `<!-- TODO: needs documentation -->` line with a
   plain-English description. Example:

   ```markdown
   ## MaxHealth
   `float` · optional · default `100`

   The hit points the part has before it is destroyed. Scales with the part's size.
   ```

4. Open a pull request. That's it.

### Rules of thumb

- **Only edit the prose**, the class summary between the H1 and the blockquote, and the lines *below*
  each `` `type` · optional · … `` signature line. Leave the `#` H1, the blockquote preamble, the
  `## Field` headings and the signature lines alone: they are regenerated from the schema and any
  hand-edits are overwritten.
- Markdown works in the prose (lists, `code`, links). Link a related field or type with
  `[[Type.Field]]`-style references if you like, they render as text and help future editors.
- Don't invent behaviour. If you're unsure, say what you know and leave the rest, or open a PR marked
  *needs review*, a partial, honest description beats a confident wrong one.

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
- **Give units and range when they aren't obvious** like seconds, degrees, tiles, a `0..1` fraction, a
  multiplier vs an absolute value. This is the single most useful thing you can add.
- **Name related fields** rather than describing them again: "Ignored unless
  [[Cosmoteer.Ships.Parts.Weapons.WeaponRules.CanBeGivenExplicitTarget]] is true."
- **Keep it plain.** No uppercase words for emphasis, and no run-on sentences stitched together with
  `;`, ` - ` or an em-dash. Split into two sentences instead. (This matches the code-comment style used
  across the repo.)

Good vs. not:

| Field | ✅ Good | ❌ Avoid |
| --- | --- | --- |
| `MaxHealth` | `The hit points the part has before it is destroyed. Scales with part size.` | `This is an integer field that sets the max health value of the part.` |
| `FiringArc` | `Half-angle, in degrees, the turret can rotate to either side of its forward direction. 180 = full circle.` | `The firing arc.` |
| `ReloadTime` | `Seconds between shots. Reduced by reload buffs.` | `Sets how fast it reloads (higher is slower).` |

If the game's own note was seeded in for a field, treat it as a starting point. It is often terse or
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
| `npm run docs:lint` | Checks every heading maps to a real field, every file to a real class, reports class and field coverage, and fails if `field-docs.json` is stale. | In CI, and before committing. |
| `npm run docs:scaffold` | Regenerates the skeletons from the schema, pre-filling new classes and fields from the XML seed and preserving all prose. | After a schema regen (Cosmoteer update). |

### After a Cosmoteer update

1. Regenerate the schema **and** the XML prose seed with schemagen (needs the game DLLs):
   `cd tools/schemagen && dotnet run -c Release`. This rewrites `cosmoteer.schema.json` and the
   gitignored `field-docs.seed.json` (see [tools/schemagen/README.md](../../tools/schemagen/README.md)).
2. `npm run docs:scaffold`, which adds `.md` files for new classes and headings for new fields (pre-filled
   from the seed where the game documents them), moves dropped fields to *Removed fields*, and leaves
   existing prose untouched.
3. `npm run docs:compile` then `npm run docs:lint`.
4. Review the diff and commit the `.md` changes and `field-docs.json` together.

## How it reaches the editor

`field-docs.json` is merged onto the extracted schema at load by `applyFieldDocs`
(`server/src/document/schema/field-docs.ts`), which attaches each field description to its field and each
class summary to its class. From there `fieldSignatureMarkdown` renders a field description below the
type signature in both hover and completion, the schema search opens a class page with the class summary
above the extends line, and a `Type =` hover shows it under the class it resolved. A description written
on a base-class field shows on every type that inherits it. A class summary does not inherit: a class
with no summary of its own says nothing rather than borrowing its base's sentence.

Because the docs are keyed by class FullName and field name (and alias), they survive schema regens: a
field keeps its description as long as its name doesn't change. The class summary sits under a reserved
`T:` key in the same entry, which no field name can collide with.
