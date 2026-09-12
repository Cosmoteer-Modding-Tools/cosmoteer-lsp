# Changelog

## [Unreleased]

### Added

- A value that divides by zero is now reported. The game reads it as NaN, which a fractional field keeps as its value and a whole-number field refuses with an overflow while it loads, so the same expression is a silent wrong number in one field and a file the game will not load in another. Turn it off with `cosmoteerLSPRules.diagnostics.validateDivisionByZero`.

### Fixed

- Arithmetic is now computed the way the game computes it, in decimal. `10 / 3 * 3` reads 9.99999999999999 rather than 10, so `floor` of it reads 9 and a whole-number field fed such an expression is no longer shown as fine when the game refuses it.
- `round` now takes the two arguments the game's parser demands and rounds halves away from zero, so `round(-2.5, 0)` is -3.
- A math name the game has no function for is now reported rather than computed. `pow`, `atan2`, `cbrt`, `sign`, `sum`, `avg` and `lg` all look like they work and all stop the game loading the file. The part table's formula columns keep them, since a column is never read by the game.
- Math names are now matched exactly, as the game matches them, and a name that is only miscased is offered the spelling that works. `Sqrt(16)` and `PI` used to compute a number.
- A call whose arguments carry a comma is now reported unless it is quoted, because a comma ends a value. The same goes for a reference written bare in an expression, where only `(&path)` is substituted.
- An expression written in quotes is now evaluated, so the hover and the hint show its value. That is the form the game's own files use for every call with a comma in it.
- A percentage multiplied by a reference is no longer labelled a percentage, which read a recoil as 3000%.
- Signature help now reads only the line the cursor is on and ignores what a comment or an escaped quote says.
- A string left without its closing quote now ends at the end of its line, the way the game's own reader ends it, and is reported on the quote that opened it. Typing a quote in front of a word that was already there used to swallow the rest of the file.
- A value left half written no longer takes the member below it. A line ending in an operator, in a sign, or in a call that is still open used to absorb the next field, which then disappeared.
- A member written as `Name : Base` before its braces are typed is now kept, with the base it names, so completion and go to definition work while it is being written.
- Colouring now covers exactly what is written. A negative number no longer paints the bracket after it, a value written across several lines no longer paints past its own line, and `90d` and `1.5r` read as the numbers they are.
- The formatter no longer puts spaces around punctuation that belongs to a value, so `Key = a:b` and a written-out address keep their meaning.
- Required now means what the game's deserializer means by it, which brings 319 more fields into the check, and the scaffold offered by completion lists the same fields the check reports as missing.
- A component whose name happens to match an inheritance base somewhere else in the project is no longer skipped by the required-field check.
- A quick fix whose offsets no longer match the text is refused instead of applied to the wrong place, and a did-you-mean fix keeps the quotes of a quoted value.
- Completion inside an inheritance header now offers the bases rather than the field names, and it does so before the braces are typed. Reference paths walk the inheritance chain, `Action = ` offers the verbs, and a comment or a finished value offers nothing.
- A reference that hops through a base, an alias or a list element now finds what the mod itself adds, and an `Add` naming a member of a whole game file resolves through the file's own alias.
- A mod whose actions live in a fragment list not named `Actions` is now read as actions rather than as ordinary rules.
- A member an action creates is now known to the rest of the mod even when the action that creates it lives in an included fragment rather than in the manifest. A second action writing into that member used to be reported as a target the game does not have.
- A `.txt` file counts as rules content only when the project actually reaches it, through a `.rules` file or through another `.txt` that file reaches in turn. A folder of renamed leftovers that name only each other is no longer read as rules and no longer reports anything.
- Renaming a middle segment of a reference path now renames that segment rather than the one at the end.
- The colour picker no longer flattens a channel it did not change, a colour group written in mixed forms shows its real alpha, and colours written as hue and saturation, as a shader constant list, or as a name all get a swatch.
- Every shader the game ships now translates to GLSL that compiles, so the preview shows the shader rather than a stand-in. A colour constant written with arithmetic renders its own colour, a particle def written at file scope shows its ramp, and an include resolves the way the game resolves it.
- A colour written as a single word that names no colour the engine knows is now reported. Turn it off with `cosmoteerLSPRules.diagnostics.validateColorValues`.
- A manifest whose `CompatibleGameVersions` names no version the installed game accepts is now reported, with a fix that sets the current version, and migrating a workspace brings the manifest to that version first.
- A project that opens no folder no longer leaves the server silent for the rest of the session, and a failure during startup is written to the log instead of vanishing.

## 1.0.1 - 2026-09-07

### Fixed

- An asset path is now checked the way the game reads it, against the folder of the file it is written in only. A group inheriting a base from another folder no longer had that folder tried as well, which reported a path the game cannot load in one session and not in the next.
- A missing asset that sits in a sub-folder of the file's own folder is now found, and the fix writes that path.
- Path completion now works inside a list of assets such as `RandomSounds = [""]`, and in a group that gets its class only through a base in another file, such as `CrewEnterEffects : /BASE_SOUNDS/AudioInterior`. Before, nothing was offered there until a slash was typed.
- Everything written inside such a group is now understood as well: a nested group such as `DynamicVolume { … }`, the elements of an enum list, the `Type =` of a group in a list, and a cross-file id such as `SpecificFaction = …`. Field and value completion, hover, go to definition, rename and the checks were all silent there before.
- `Flammable = false` on a part without a `TypeCategories` list of its own is now migrated too. The fix writes `TypeCategories : ^/0/TypeCategories [non_flammable]`, extending the list the part inherits the way the game's own files do, when a base of the part declares that list. Before, such a part was only listed for review, which is what most parts written against an older game are, since they inherit the list from the game's base part.
- The station generation command created the station icon with the wrong path, which could lead to a crash.
- The arrows of the resource flow and the firing chain were drawn as filled shapes rather than lines, so an arrow that bowed back to an earlier box covered the drawing as a solid sail and two arrows side by side read as one thick one. They are lines again.
- The words of an arrow, the amount, the resource and how often it moves, or the member that fires, are now written on the arrow itself rather than kept for its tooltip, so a heat line is told from a battery line without hovering each one.
- Every resource has its own arrow colour in the resource flow, and every chain its own in the firing chain, named after the trigger it starts from, with a swatch per colour in the legend. Before, every arrow was the one green the boxes that move resources also had, and a part with twenty crossing arrows read as one tangle.

## 1.0.0 - 2026-09-06

### Added

- Parts can now be compared side by side in a new tool window. Every part of the game and of the mod being edited gets a row and any field they carry a column, resolved to the number the game computes rather than the text the file writes. Narrowing to a category, a component kind or one mod narrows the columns with it. Columns are dragged into order, sized by their edge and frozen at the left, a formula column computes over the other columns, and picking a part to compare against shades every number against it, blue below that part and red above it, with a key beside the picker saying so, since the colour says where a number stands and not whether that is better. The whole setup can be saved under a name and is there again the next time the window is opened.
- The part table works out the cost in credits, the tiles a part covers and its damage per second, opens on the figures a part is balanced by, lists every ship class and its build menu groups in a tree at the left, groups its rows by ship class and build menu group, category or mod, and keeps the average, the least and the most of every column in a footer.
- The part table follows the editor: an edit to a part, saved or not, reaches the table on its own. A cell can be double-clicked to try a value, the formulas follow it while the files stay as they were, and writing the changes puts each typed value into its file: over the part's own value, as an override on the part for one it inherits, and in the manifest for one the mod overrides there. A reference or an expression is replaced whole, and the note says what the number took the place of. Reading a large mod says which part it is on.
- Formula columns of the part table gained `coalesce`, `has`, wildcards in paths, aggregates over the parts on screen and references to other formulas by name.
- What a mod changes in the files the game ships can now be asked for from the Tools menu. It puts the value the game writes beside the value the mod loads there, one row per member, and counts the members it writes the game's own value for.
- What one group changes from the game can now be asked for on its own, comparing it against the nearest base of it the game ships and listing only what the game loads differently.
- Saved ships can now be put into a faction from the Tools menu or the project view. Pick `.ship.png` files or a folder of them, pick the faction, and every ship is copied in and registered with the tier the game's own arithmetic gives it, a difficulty read against the game's own ships of that tier, and a role read off its parts: unarmed ships with cargo become trade ships with a trade route, crew-heavy ones crew transports, thrusterless ones stations. Each suggestion can be changed before anything is written. Two more roles cover the rest of the game's own tree: a wreck for the debris fields, and a starter ship the career mode offers when a new game begins, with its description key declared in the language files. A station gets its stasis icon drawn beside it, the white silhouette the map shows while it is out of sight, the way the game's own icon generator draws it.
- An `Overrides` whose body puts a whole group in the target's place is now reported, since the game does not merge the body into its target and every member the body leaves out is gone when the mod loads. The fix targets the deepest group the body descends into and writes only the members beside it.
- A manifest action that appends a whole list as one entry is now reported, with a fix that rewrites a one-element `ManyToAdd [ &<file>/Member ]` to `ManyToAdd = &<file>/Member`. The game reads each element of `ManyToAdd [ ]` and the value of `ToAdd` as one entry, so a reference to a list of entries lands as a single entry it cannot read.
- A faction can now be created from one dialog. `New Faction` asks the id, the name and the border colour, then writes the faction with free player indexes, its share of the galaxy and the tier ranges of its systems, an FTL beacon that marks them on the map, and its name in every language file, each wired in from the manifest. The dialog also takes a PNG for the icon and a saved ship for the beacon, both copied into the faction's folder, and writes a lore page for the codex with its texts as keys to fill. Left empty, the icon and the beacon ship are the game's own until you replace them.
- A nebula can now be created from one dialog. `New Nebula` takes a look from one of the game's own nebulas, inherited whole with its shaders, its effects on ships and its sounds, replaces its three colours with yours, and asks where it spawns: radius, how many per sector, how far from the centre, and whether the starting sector stays clear. It writes the nebula, its spawner entry for the career sectors, its doodad for creative mode and its tooltip and HUD keys, each wired in from the manifest.
- A galaxy size can now be created from one dialog. `New Galaxy Size` takes a name and a number of systems, clones the game's standard generator with that count, and offers the size when a new career or creative game begins, with its name and tip in the language files.
- An asteroid type can now be created from one dialog. `New Asteroid Type` takes a resource, one of the game's deposit looks, a rarity and the sizes, and writes the deposit tiles, the asteroid recipes, the spawner entries, the hard conversions and the manifest actions, with the names declared in every language file.
- A planet can now be created from one dialog. `New Planet` builds on one of the game's own planets, inherited whole with its style and orbits, names it, optionally gives it a size of its own, and asks where career sectors place it. It writes the doodad and its name key and wires both the registry and the sector spawner from the manifest.
- A resource can now be put into the career trade from one dialog. `Resource in Trade` picks a resource, sets how common it is on the game's own scale and whether stations stock it or buy it, and writes the two manifest actions that put it on every trade ship and in every station.
- Everything the wizards create now sits in one Cosmoteer submenu of the New menu, in the project view's right-click menu and under File, one line per kind, with the selected folder as the mod to write into.
- Build Toolbar Category, Part Stat Line and Part Toggle join the Cosmoteer submenu of New. Each is registered from `mod.rules` with its language keys, and the notification says how a part uses it.
- A tech can now be created from one dialog. `New Tech` takes one of your parts, a cost and the prerequisites, writes the tech with the part's own name, description, icon and group read by reference, and adds it to the game's tech tree.
- Buff and Codex Page join the Cosmoteer submenu of New. A buff is merged into the game's buff map from `mod.rules` and a name already in use is refused, and a codex page is appended to the tutorial pages with its language keys.
- `New Content File` gained two kinds: the title screen ship, a saved ship of yours copied in and set as the one the menu flies in, and a roof decal folder, whose PNGs the paint tool offers under a group of their own. The ship action gained storage pods, the loot the game drops beside wrecks.
- Two drawn views share a new tool window: the resource wiring of a part, and what a part fires in what order. The resource view says on each box what that component does and on each arrow how much of which resource moves along it and how often, and boxes link to the declarations they stand for.
- What a saved ship places can now be read out of a `.ship.png`, with a count per part and whether the project declares it. The action asks which ship to read when nothing selected is one.
- Moving or renaming a `.rules` file now rewrites the references that name it, and the references the moved file itself writes.
- A reference naming its own file can now be written as the `~` form it is, and the members of a group can be written in the order the schema declares them, both from the intention menu.
- A media-effect bucket now says on hover which registry list holds it and what it therefore draws between.
- A prohibit shorthand on a part whose `Prohibits` list is empty is now reported, since the shorthands add one keep-out rect per category the list names.
- An action written into a manifest's `Actions` list without its own `{ }` braces is now reported. The game cannot read such a manifest and drops the mod with a load error.
- The text markup a language file's strings carry is now completed as it is typed: every tag the game draws, then its attributes and the values they take, with the project's localization keys inside a `<string id=…>` and the images it registers inside an `<img name=…>`.
- A colour written in a language file's markup now carries a swatch, and picking a colour rewrites the tag in the form it was written in.
- Text markup is now judged tag by tag rather than only for its shape. A tag the game draws nothing for, an attribute it throws without, a value it cannot parse and an image name nothing registers all make the game draw the whole string with its tags as plain text.

### Fixed

- A file a manifest action wires in whole, such as a lore page appended to the codex, now hovers, completes and validates at its top level. Its nested groups were typed from the action's target, but a plain field at the top of the file was not.
- Setting a second title screen ship now points the mod's existing `Replace` at the new file rather than adding a second action for the same value. The notification names the file the menu showed before.
- A faction's defense platforms now carry the faction's name as their id prefix, the way the game's own files do, rather than the id with its first letter raised.
- A localization key added to a nested group no longer lands between the group's indentation and its closing brace.
- A mod is no longer reported as depending on itself when the same mod is also installed from the workshop. Two folders writing one manifest id are one mod.
- A resource flow number written as arithmetic is now read, so a capacity, an interval, a quantity or an amount computed from another field reaches the drawing.
- An `Overrides` action whose source names a group inside a file now merges that group's members. It used to merge nothing, so every member such an action supplies was missing from hover, navigation and the reports.
- Renaming a declaration now rewrites a reference written on its own as a list element, such as a media effect naming a particle right after a `{ … }` element. Find-all-references and the highlight answer for such an element too, and a rename can be started from one.
- Two members of one group whose names differ only in case are now reported as the duplicate they are, since the game matches a member name without regard to case. The message also says what really happens: the whole file fails to load.

## 0.9.0 - 2026-08-28

### Added

- A number the game also reads as a group can now be rewritten into that form in one step. "Make this modifiable" writes the value the file already had as its `BaseValue` and an empty `Modifiers` list beside it, and the offer runs the other way on a group that carries nothing but its base value.
- A component a part wires before declaring it can now be declared from the lightbulb. The kind is picked in a dialog, and the declaration is written where the part keeps its components, with every field the game throws without scaffolded.
- An inline block can now be moved into a file of its own. The file name is asked for in a dialog, the block is written there, and a reference to it takes its place, with every path it carries re-expressed against the new folder.
- Every class the schema knows now says what it is in one sentence, on the class page in the schema search and on the hover over a `Type =` value.
- A component wired into a slot that reads another kind of component is now reported, which the game answers with a crash while the part is built. The part's own components of the right kind are offered as the fix.
- A bucket declared twice in the media-effect registry, and a bucket list longer than the band the game reads out of it, are now reported, and a registry with no `default_bullet` bucket is warned about.
- A part category, part feature or ship tag written once in the project that is one typing slip from a name several files write is now hinted at, with the established name offered as a fix.
- The language files of a mod are now compared against each other: a language behind the ones beside it, with a fix that writes the missing keys in with the English sentence to translate, and a translation whose placeholder slots differ from the English text.
- A field a sibling switches off is now faded out with a remove fix, such as a converter quantity written beside the list form rather than beside the storage shorthand.
- A manifest action aiming at a node an installed mod already replaces, removes or writes is now reported, with the mod named and which of the two the game applies last.
- The field-name popup now offers the fields the game's own files write most before the ones it never writes.
- Who reaches a declaration can now be asked for, listing the files that reference it, include it, inherit from it and the manifest actions that name it as a target.
- A file of a mod now says on its first line whether the mod loads it at all. The checkbox for it is under Editing in the settings page.
- A whole mod can now be created from the Tools menu. Cosmoteer: New Mod asks where it goes, what it is called and who wrote it, then writes the manifest and the language file.
- The mod overview now names the mods on this machine that write what this mod writes, saying what each of them does to the shared node and which of the two the game applies last.
- The mod overview now opens with a health table: action targets, how much of the mod the game loads, ids registered twice, part grid values out of reach, language files behind the one they follow, dead fields, repeated field sets and overrides that change nothing.
- An indicator sprite component whose `HidesIndicators` names its own indicator, or an index its list does not have, is now reported. Both stop the game loading, and both come from adding an indicator at the head of the list without shifting the numbers underneath.
- A buff provider chaining from a buff its own part cannot receive is now reported. The game checks this while reading the part and throws outright, so the game does not start at all.
- A language file string whose markup the game cannot read is now reported, with the tag, the attribute or the bare `&` that broke it named. The game answers such a string by drawing its tags as plain text and logging nothing.
- A part component chain that leads back to itself is now reported. Nothing guards the chain at either end, so a closed one takes the process down the moment the part is created.
- A bullet whose components the game cannot build is now reported: a second physics component, none at all, and a hit or a targetable written above the physics component.
- An enum value the field's type allows and the class reading it refuses is now reported, and the value popup stops offering such a member whether or not the report is on.
- A range written the wrong way round is now reported where its consumer rolls or compares rather than interpolates.
- A blend sprite situation code the game cannot expand is now reported, both a character outside `0`, `1` and `*` and a code whose length its slot does not allow.
- A field the game reads and then acts on wrongly is now reported, such as an `ExcludeID` the engine adds to the list of parts a criteria matches rather than the one it excludes.
- A part naming itself as the part it leaves behind when destroyed is now reported. Working out what it costs and what it drops both walk that chain with no guard against a loop.
- A door presence toggle whose cell lies inside its own part is now reported, with the rest of the part grid checks.
- A bullet component wired into a slot that reads another kind of component is now reported, the way a part's components already were.
- A value the part grid editor edits that is written as a reference is now followed to its declaration and changed there, instead of a literal being pasted over the reference. A rect, a point, a cell, a component location, a polygon vertex and a radius all write through, and the editor says where the write landed and how many other places read it.

### Changed

- The mod overview now reads the checks the editor has already run instead of walking the mod again, so the report opens without a pause on a large mod.

### Fixed

- A range written with the wrong number of list elements is now reported as an error saying the game refuses to load the file, instead of a cosmetic warning claiming the game never reads the extra element.
- A reference whose chain leads back to itself now says so, instead of reporting the same thing a misspelled name reports.
- A part whose `Size` is written as a reference is now drawn at that size instead of as a single cell, and the same goes for a component location, a port cell, a tile line start and a graphics slot offset.
- The part grid editor now re-renders when a file it reads changes, not only when the part's own file does.

## 0.8.0 - 2026-08-23

### Added

- A hover now says where the declaration under the cursor stands in its group's chain. A member names the value it replaces and the file and line that one is written in, and a group's own name says how many of its fields its bases supply. The checkbox for it is under Editing in the settings page.
- A reference can now be replaced with the value it stands for. "Inline the value" appears on a reference resolving to a single written value, and the value is copied the way its own file spells it.
- The effective-group report now lists what a mod loads in place of the game's own value, with the game's value beside it.
- The mod overview now names which unreachable file brings the most others back with it, and names the file whose commented-out line disabled the chain where one did.
- A reference that does not work out to a number now shows what it points at, both as an inlay hint and on hover. The checkbox for the inline half is under Editing in the settings page.
- The mod overview now lists the mod's own parts that no tech in the project unlocks.
- A particle channel a file computes that nothing in the effect reads is now faded out, which is what a misspelled channel name leaves behind.
- A manifest's `Replace` and `Remove` actions are now read the way the game reads them, so a member a mod replaces or removes shows what the game really loads.
- Render layers are now offered and checked per ship class. Only the layers the part's own ship declares are suggested, and a layer no ship declares, or one belonging to another ship class, is reported with the ship named. Turn it off with `cosmoteerLSPRules.diagnostics.validateRenderLayers`.
- Quotes, braces, brackets and `<` now close themselves as you type, and `//` and `/* */` comments toggle with the editor's own comment shortcut.

### Changed

- Problems now appear about twice as fast after you stop typing.
- Checking a whole mod is faster. A pass reads each folder once instead of once per reference into it, and which ships a part may be drawn on is worked out once for the project instead of once per part file.
- The language server is started with more room for short-lived data, so the collections a whole-mod check used to trigger are rarer and no longer stall it for up to half a second at a time. It also settles back to less memory once the check is done.
- Semantic highlighting from the language server is on by default and is painted by the plugin itself, so the colors stay on the text while you type instead of dropping out whenever a request is still running.

### Fixed

- A file written in the same instant the editor read the folder it sits in is no longer missed until something else changes there.
- A value is now suggested while its quotes are still open. `Layer = "roo` used to answer with the group's field names rather than the ship render layers, and the accepted suggestion now writes the missing closing quote.
- `Layer` written on an `IndicatorSprites` component is marked as having no effect, which is what the game does with it.
- Turning semantic highlighting on or off now reaches the files you already have open, instead of only the next file you open.
- The part grid editor now shows the whole part. Its sprites are placed from a `Location` written as arithmetic, the components a part gathers from other files through its `Components` bases are drawn with the ones it declares itself, and a single field reaching far outside the part, such as a wide `BuffArea`, no longer frames the canvas around itself and shrinks the part into a corner.
- Zooming into a large part in the grid editor no longer leaves the canvas blank.
- A part rect written from references or math is now drawn in the part grid editor. It draws dashed and refuses the corner drag, since replacing the expression with four numbers is not what the drag looks like it does.
- The part grid editor now opens with the whole part in view instead of scrolled into its top-left corner, and a fit button returns to that view. A wide part is no longer squashed to the panel width.
- The rect of the layer being edited is now washed with its color, so a rect spanning the whole part is visible against the sprites.
- A layer whose checkbox is off can no longer be edited in the part grid editor.

## 0.7.0 - 2026-08-19

### Added

- Seven shapes the game refuses to load are now reported instead of parsing as if they were fine, among them free text where a member name belongs, a number naming a member, a nameless `{` or `[` block outside a list, an inheritance with no body and a `/*` that no `*/` ever ends. Each of these makes the game drop the whole file at load time, so a mod could be shipped broken while the editor showed nothing.
- A block comment the game does not close is now a warning, with a fix that makes it close. The game closes a block comment only when the run of `*` before the closing `/` is odd, so a banner like `/****** Section ******/` silently swallows everything up to the next `*/` when the mod loads.
- A member written on a line whose value already runs to the line end is now a warning saying the value before it swallows it. The game accepts that shape and folds the member into the value, so it loses the member rather than failing to load.
- A group whose fields several other files of the mod write word for word is now marked, with a fix that creates the shared base file for you: a new `base_*.rules` beside them holding the repeated fields, with every one of them rewritten to inherit it and its own copies deleted, the way the game's own data and the larger mods are built. When those files are the only things inheriting their base, the fields go into that base file instead of into a new one in front of it. `Tools | Cosmoteer: Extract Shared Base Files` searches the whole project and lists every extraction worth making, largest first.
- The whole rewrite is shown before any of it happens, in the IDE's own diff viewer, one entry per changed file with the file as it is now beside the text the extraction would leave in it. Close the viewer and you are asked whether to go ahead.
- Applying an extraction no longer leaves the files it rewrote unsaved. Only a file you already have open goes through the editor, so the change lands in its undo history; every other file is written straight to disk, and the open ones are saved afterwards.
- "Allow refactorings to edit vanilla files" is one switch covering rename and the shared-base extraction, replacing the rename-only one. With it on, the game's `Data` folder becomes visible to the extraction as a project of its own, which it cannot be otherwise because it carries no mod manifest. Installed workshop mods stay off limits either way.
- A field written with exactly the value its group already inherits is now faded, with a fix that removes it. The inheritance chain is followed into the game's own `Data`, so a value copied line for line from a vanilla base is found, and a path is compared as the file it names rather than as the text it is spelled with.

### Changed

- The dead-field hint now also reads a field written as a bare list, the shape the game's own files use for effect collections. A `MediaEffects [ … ]` block that ended up on the component instead of on its hit or death slot is faded out with a remove quick fix instead of loading silently and doing nothing.

### Fixed

- Values are read the way the game reads them in five shapes that used to shift list positions or invent members: computed values inside a list count as one element each, a list element starting with a minus and continuing with arithmetic stays one element, a stray `)` and an unescaped `"` stay part of their value, and a value written on the line below its `=` belongs to the field above it.

## 0.6.0 - 2026-08-04

### Added

- Code mods are understood. A mod that ships a `.dll` declaring its own serializable types has those types, fields, enums and discriminators merged into the schema, so a modded component completes, hovers and validates like a built-in one. Assemblies in the open workspace, in your own `Mods` folder and in installed workshop mods all count, and the schema follows them as they are installed, updated or rebuilt.
- A code mod's own `///` documentation shows on hover when the mod is built with `<GenerateDocumentationFile>true</GenerateDocumentationFile>`, hover on a modded class links the mod's Steam Workshop page, and `Open in decompiler` opens the class from that mod's own assembly.
- Code mod support is configurable under Settings | Tools | Cosmoteer Rules | Code mods, and `Rebuild Schema from Code Mod Assemblies` in the Tools menu forces a rebuild.
- Whole-mod validation is on by default, scoped to what the game actually loads. Backups and templates stay out, and results are cached on disk, so only the first open of a project pays for the scan.
- Field documentation now covers every field in the schema, with units, ranges and the fields a value interacts with.
- Twelve more fields the game accepts and then ignores carry the dead-field hint, and a file that is one object gets the hint on its top-level fields too.
- The three music track collections the game crashes without now count as required.
- `Migrate Mod to Current Game Version` in the Tools menu upgrades every rules file of the workspace in one undoable edit and reports what it did, grouped by game version. An optional second mode also strips fields the game never reads.
- Deprecation hints now span the whole recorded changelog history, including `Flammable` and its `non_flammable` category replacement, deleted and renamed fields, and the manifest's `ModifiesMultiplayer` flag.
- A version-split manifest (`mod_*.rules`) without `CompatibleGameVersions` warns that the game never selects it, with a quick fix that inserts the installed game's version.

## 0.5.0 - 2026-07-18

### Added

- Field-name completion now works while typing a partial name, not only from an empty line.
- Deeper schema intelligence: fragment files that reach the game through mod actions, convenience-global aliases, and same-file or cross-file inheritance now know their class, so completion, hover and validation work inside them. Typed `Components` maps, font, cursor, sound and shader groups, and map entry-list forms are modeled.
- `mod.rules` action targets drive intelligence into the files they add: `Add`/`AddMany`/`AddBase`/`Overrides` fragments type from their target, inline action values complete and validate in the manifest, and `<./…>` targets resolve against the install root.
- Hover and completion on group-typed, list and asset fields now show a generated example (the `Type=` discriminator, required fields, and positional `Color`/`Vector2` forms), and color swatches appear on the positional list form the game saves.
- Interactive part grid editor, available as a JetBrains tool window with a gutter marker on `Part` lines: clicking the grid authors per-cell fields (doors, walls, crew destinations, colliders, ports and more) and writes each change straight to the `.rules` file.
- Field documentation for the most-modded gameplay and GUI classes, shown in hover and completion.
- Fields the game declares but never reads get a hint with a remove quick fix.
- `BaseValue` references show their value as an inlay hint (toggleable via `inlayHints.showBaseValue`), and `Modifiers` entries complete, hover and validate.
- Cross-file id intelligence now covers part ids, component ids, resource ids, damage types, triggers, effect buckets, bullet categories, ship ids and more, with completion, go-to-definition, find-usages, rename and validation. Ids declared by dependency mods and manifests count.
- Reference-path completion completes the segment at the cursor and matches member names case-insensitively, and references into other workshop mods recommend the game-root path form with a quick fix.
- Virtual-inheritance `:` paths resolve to the derived versions they select.
- Shader preview overhaul: real per-vertex math for ship, crew and part shaders, engine screen targets, WebGL2 rendering, preprocessor completion and hover, and sliders that fit each constant's range.
- Full mXparser operator support in `.rules` math, and computed-value inlay hints for the `d`/`r` number suffixes.
- Rules content written in `.txt` files is now indexed like `.rules`.

### Changed

- Whole-workspace validation is much faster on mods that reference ids from other installed mods, and the repeated "Indexing mentions" popups are gone.

### Fixed

- A large class of id false positives is resolved: ids a mod creates from its manifest, built-in ship ids, effect-bucket names, bullet categories, planet styles and component references are now recognized or checked correctly.
- Syntax highlighting no longer misreads bare identifiers, dotted string ids, asset paths, percentages or quoted references.
- Parser and completion fixes: an in-progress empty field no longer desyncs the parser, empty completion answers reopen as you type, and completion behind a closing `}` offers the right scope.
- Shader preview fixes: HLSL `%`, `isinf`, integer casts and `#if defined(…)` now translate, fixing the crew preview falling back to a plain quad.

## 0.4.1 - 2026-07-07

### Added

- Validation of values the game silently never reads: bare valueless fields, unknown members inside a group-typed field's list form, extra list elements and value shapes the field cannot read.
- Positional list values (`BaseSize = [7.2, 7.2]`) now get validation, hover and completion, including nested entry lists.
- Bare `&…` reference list elements are validated like any other reference.
- A warning when a list element name and its body share a line without a separator, with a quick fix.
- The server logs startup and validation timings, useful when a start feels slow.

### Changed

- Much faster starts. Project indexes and whole-workspace validation results are persisted, so reopening an unchanged mod restores everything in about a second.
- Faster editing through incremental document sync, diagnostic deltas and lazily resolved completion documentation.
- Whole-workspace scans reuse per-file results and skip unchanged files.
- The bundled language server ships as a native ES module bundle.

### Fixed

- Automatic Cosmoteer detection finds installations in secondary Steam library folders and works on Linux and macOS, including Flatpak and Snap installs.
- A wrong or unreadable detected path shows a warning instead of a stuck progress notification.
- Completions inside `[ … ]` no longer offer the outer group's field names, and field-name completion no longer re-offers fields already written in their bare form.
- Effect lists on group-typed fields (`HitEffects [ … ]`) now carry full schema intelligence.
- A crash in the document outline caused by a `[` and a parser problem when continuing a math expression.
- Whole-workspace validation no longer leaks problems from out-of-scope files, and reference false positives from the game-data loading phase no longer stick until the next edit.
- Go-to-definition on the inheritance reference of an empty group did nothing.

## 0.4.0 - 2026-07-04

### Added

- Full feature parity with the VS Code extension via LSP4IJ: pull diagnostics with all opt-in validators, completion with snippets, hover, navigation, find usages, rename, formatting, quick fixes, signature help, inlay hints, color swatches, document links, workspace symbols and semantic-token highlighting for `.rules` and `.shader` files.
- Live WebGL shader preview in a tool window, opened from a gutter icon on `Shader = …` lines, the editor context menu, or the Tools menu.
- Mod overview report for `mod.rules` manifests (gutter icon and context menu).
- Settings page under Settings | Tools | Cosmoteer Rules mirroring every `cosmoteerLSPRules.*` option. Changes apply to running servers without a restart.
- Localized server messages following the IDE language (English and German).
- File icons for `.rules` and `.shader` files, via registered TextMate-backed file types. The registration also stops the IDE from advertising other marketplace plugins for these extensions.
- Setting to enable LSP semantic-token highlighting on top of the TextMate colors (off by default: the overlay repaints asynchronously after every edit, which looks like flickering).
- Node.js is no longer a hard prerequisite: when no runtime is configured or on PATH, the plugin offers to download a private copy of the official Node.js LTS build (checksum-verified, about 30 MB, only the `node` executable is kept) and starts the server with it.

### Changed

- Rebuilt on LSP4IJ instead of the Ultimate-only native LSP API: the plugin now runs on Rider, IntelliJ IDEA Community and every other JetBrains IDE (2024.2+), and no longer needs the JavaScript plugin or a configured Node interpreter, only Node.js on PATH or in the settings.
