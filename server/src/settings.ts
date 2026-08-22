// Must match the `cosmoteerLSPRules.maxNumberOfProblems` default in package.json and the JetBrains
// default in CosmoteerSettings.kt. A client that does not answer `workspace/configuration` falls back
// to this number, so a lower value here silently truncates the Problems panel with no explanation.
export const MAX_NUMBER_OF_PROBLEMS = 100;

// The settings contributed by the extension (see package.json `cosmoteerLSPRules.*`).
export interface CosmoteerSettings {
    maxNumberOfProblems: number;
    cosmoteerPath: string;
    trace: {
        server: 'off' | 'messages' | 'verbose';
    };
    ignorePaths: string[];
    diagnostics: {
        // When true (the default), validate every `.rules` file the scope below covers, not just the
        // files open in the editor, so the Problems panel describes the mod rather than the tabs.
        // The scan is cached on disk per file, so only the first open of a project pays for it.
        // Turn it off on a low-memory machine: the pass holds every scanned file's AST while it runs.
        validateWholeWorkspace: boolean;
        // Which files the whole-workspace pass covers. 'modRulesReachable' (the default) restricts
        // it to the files the game can actually load: the closure of the mod.rules action sources,
        // their includes and inheritance, plus the strings folder, so backups, templates and other
        // dead content stop flooding the Problems panel. 'allFiles' validates every `.rules` under
        // the workspace folders instead. A workspace with no manifest to scope by is unrestricted
        // either way, and files open in the editor always validate either way.
        workspaceValidationScope: 'allFiles' | 'modRulesReachable';
        // When true (the default), flag a component `ID<…>` reference (e.g. `OperationalToggle =
        // IsOperational`) whose id names no component anywhere in the part, its inherited bases, or
        // its include-valued components blocks. Only runs once the game `Data` tree is indexed
        // (inherited vanilla bases must resolve). Runtime-injected engine components and fields with
        // non-sibling semantics are excluded.
        validateComponentReferences: boolean;
        // When true (the default), flag a cross-file `ID<…>` reference (a GUI toggle/color/targeter/
        // trigger id) whose id names no declaration of that kind anywhere in the project. Only runs
        // once the game `Data` tree is indexed, since a reference to a vanilla-declared id would
        // otherwise be a false positive.
        validateCrossFileReferences: boolean;
        // When true (the default), flag a group that is missing a schema-required field, checking the
        // inheritance chain so a field supplied by a base does not count as missing. The schema's
        // required flag is derived from real C# signals and cross-file templates are absorbed by a
        // project-wide index. Can be turned off to skip the one-time project index build it performs.
        validateRequiredFields: boolean;
        // When true (the default), flag an inline `_`-prefixed shader constant a material sets that the
        // referenced `.shader` declares no uniform for (a typo such as `_hotColr`), and one whose value
        // is the wrong shape for its type. Only fires when the shader resolves on disk (otherwise the
        // names cannot be judged). The handful of dead constant keys the game itself ships are skipped.
        validateShaderConstants: boolean;
        // When true (the default), run lightweight diagnostics on `.shader` files themselves: an
        // `#include` whose target does not exist, a `_`-prefixed uniform read that no file in the
        // include chain declares, and a call to a function that is neither an HLSL intrinsic nor
        // defined in scope. It is a lexical check (not an HLSL compiler) built to stay false-positive-
        // free: the undeclared-symbol checks only run when the whole include chain is readable, so a
        // shader whose base include lives in an unconfigured game path is left unchecked.
        validateShaderCode: boolean;
        // When true (the default), flag a localization key (`NameKey = "Parts/Foo"`, a C# `KeyString`)
        // whose path is declared in no language strings file in the project. Only literal key paths are
        // checked (reference-valued keys `&<…>/NameKey` are validated as references), and matching is
        // case-insensitive (the game resolves keys case-folded). Only runs once the game `Data` tree is
        // indexed, since a mod's reference to a vanilla key would otherwise false-positive.
        validateLocalizationKeys: boolean;
        // When true (the default), hint at a `,`/`;` separator that a line break already makes
        // redundant (ObjectText ends every entry at an unsuppressed newline, so separators are only
        // needed between entries on the same line). Hint severity keeps it out of the Problems
        // panel. Vanilla itself ships hundreds of such separators.
        validateRedundantSeparators: boolean;
        // When true (the default), warn about a block comment the game leaves open: its ObjectText
        // scanner closes a comment only when the run of `*` before the closing `/` is odd, so a
        // banner such as `/**** X ****/` runs on to the next `*/` and swallows everything in
        // between. Warning severity, since the file silently loses content when the mod loads.
        validateUnclosedComments: boolean;
        // When true (the default), hint at a field the game provably ignores: its group resolves to
        // a schema class that does not declare the name, and no reference in the file reads it (so
        // the constant idiom `X = foo.png` + `&X` stays untouched). Comes with a remove quick fix.
        // Hint severity keeps it out of the Problems panel.
        validateIgnoredFields: boolean;
        // When true (the default), fade a field that restates the game's own default, so deleting it
        // is a no-op. Only judged inside groups with no inheritance list: a base can set a non-default
        // value that an explicitly-written default deliberately overrides. Required fields, fields the
        // game never reads, and fields any reference in the file reads are left alone. Hint severity
        // keeps it out of the Problems panel.
        validateDefaultValues: boolean;
        // When true (the default), fade a SCREAMING_CASE constant that nothing reads, including a
        // chain of constants that only read each other and never reach a field. Only judged when no
        // other file in the project spells the name, so a constant read from another file (or by a
        // mod that ships a `.dll`) is left alone. Hint severity keeps it out of the Problems panel.
        validateUnusedConstants: boolean;
        // When true (the default), hint at a group whose fields several other files of the same mod
        // write word for word, which could live in one shared base file all of them inherit, the way
        // the game's own data and the larger mods are written. Carries the "extract shared base"
        // refactoring, so turning it off removes both the hint and the offer. Only fields that mean
        // the same thing from a base file are counted, and only the files of the mod being edited are
        // ever rewritten. Hint severity keeps it out of the Problems panel.
        validateDuplicateFields: boolean;
        // When true (the default), fade a field whose value the group already inherits, so writing it
        // leaves the game exactly where deleting it would. Carries a remove quick fix. Only judged
        // when the whole inheritance chain could be read and neither copy carries a reference that
        // means something different from where it is written. Hint severity keeps it out of the
        // Problems panel.
        validateRedundantOverrides: boolean;
        // When true (the default), check a `mod.rules` manifest against the metadata the game reads
        // from it: a missing or malformed `ID`/`Name`, which stops the mod loading at all, a field
        // name that is a near miss of a real one, and a declared `StringsFolder`, `Logo` or
        // ship-library folder that is not on disk. Field names are matched ignoring case, the way
        // the game binds them. A name the game does not know but that is nothing like a real field
        // is left alone, since mods keep their own keys in the manifest for loaders that ship a
        // `.dll`.
        validateModManifest: boolean;
        // When true (the default), fade a part-grid value the part own size puts out of the game
        // reach: a door location that is not a cell beside the part, a blocked-travel cell or a
        // per-cell map key outside it. A PhysicalRect that leaves the part is an error instead,
        // since the game throws while reading such a part. Only values written on a part that
        // declares its own ID are judged, and Size is read through the inheritance chain.
        validatePartGeometry: boolean;
        // When true (the default), flag an id two files of one mod both register for the same game
        // collection, which the game resolves by keeping one entry and dropping the rest. Only a
        // declaration the mod actually wires in through a manifest action or a game-root alias
        // counts, so an inheritance template carrying a leftover ID is left alone, as is a mod that
        // ships alternative manifests. Built-in ships and techs are out of scope, since a name that
        // could mean either collection cannot decide a collision.
        validateDuplicateIds: boolean;
        // When true (the default), report an id this project only resolves because an installed mod
        // declares it, while the manifest does not list that mod under Dependencies. The rescue is
        // silent, so the file reads as correct on the author's machine and names nothing for
        // everybody else. One finding per file and per mod, and never a full dependency audit: an id
        // both mods declare resolves in the project and never reaches the installed-mod consult.
        validateUndeclaredDependencies: boolean;
        // When true (the default), report a buff modifier, buff clamp or buff toggle naming a buff
        // its own part never receives. The game registers a part with a buff manager once per entry
        // of its ReceivableBuffs and never otherwise, so a buff outside that set has no value on the
        // part at any point, and supplying it from the same part does not help. The set is folded
        // through the whole inheritance chain, and nothing is judged when any hop of that chain
        // cannot be read.
        validateUnreceivableBuffs: boolean;
        // When true (the default), report a path-shaped field whose file or folder is not on disk.
        // Covers the values the asset check cannot reach, because it recognises a path by its
        // extension and these carry one the game alone knows: a music track, a markov name file,
        // and the folder fields a ship library or a texture set is read from. The path is resolved
        // the way the game resolves it, against the folder of the file it is written in.
        validatePaths: boolean;
        // When true (the default), hint at a damage level whose art is stretched differently from
        // the other levels of its own sprite list. The game draws every level into the quad its
        // Size names, so a level whose pixel aspect over quad aspect differs from its siblings
        // squashes or rotates the moment the part takes that damage. Only levels whose file and
        // size can both be read are compared, and the first readable level sets the stretch the
        // rest are judged against. Hint severity keeps it out of the Problems panel.
        validateSpriteGeometry: boolean;
        // When true (the default), report a sprite naming a render layer the ship that draws it does
        // not declare. The game indexes the ship's own `RenderLayers` map when it first draws the
        // part and throws when the id is not in it, so a typo and a layer borrowed from another ship
        // class both crash rather than draw nothing. Layers a mod adds to a ship count as that ship's.
        validateRenderLayers: boolean;
    };
    codeMods: {
        // When true (the default), a mod that ships a `.dll` has its own serializable types, fields
        // and `Type=` discriminators read out of the assembly and merged into the schema, so its
        // components validate, complete and hover like built-in ones. Turning it off skips the
        // discovery walk entirely and leaves the shipped schema alone, at the price of every type
        // such a mod adds being reported as an unknown discriminator.
        enabled: boolean;
        // When true (the default), the assemblies the merge came from are watched, so a mod
        // installed, updated or rebuilt while the editor is open is picked up on its own. Turning it
        // off keeps the startup merge but makes `Cosmoteer: Rebuild Schema from Code Mod Assemblies`
        // the only way to pick up a change. Costs nothing while idle. Each change re-walks the mod
        // folders.
        autoRefresh: boolean;
    };
    inlayHints: {
        // When true (the default), a reference whose target is a group in the game's
        // ModifiableValue shape (`Arc { BaseValue = 160d }`) is annotated with that member:
        // `Arc = &~/…/ArcShield/Arc` renders ` /BaseValue = 160d`. The BaseValue is what the
        // reference effectively supplies at runtime, and it is otherwise invisible without
        // following the reference by hand.
        showBaseValue: boolean;
    };
    hover: {
        // When true (the default), a hover over a computed value lists every reference the
        // evaluation replaced with a number, the number it stood for, and the file and line that
        // number was read from. The computed number is otherwise the only thing on screen, so
        // checking where it came from means following every reference by hand.
        showSubstitutions: boolean;
        // When true (the default), a hover over a modifiable value lists the modifiers folded onto
        // its base number, what drives each one, the clamp it puts on the result, and which part
        // supplies the buff. The file shows one base number, and the component supplying the buff
        // usually lives in another part entirely, so neither was answerable without reading the
        // whole project by hand.
        showModifiers: boolean;
    };
    // When true, a refactoring may also read and rewrite files inside the Cosmoteer game `Data`
    // install: renames reach into it, and the shared-base extraction treats it as a project of its
    // own, which it cannot do otherwise because the game tree carries no mod manifest. Off by default
    // to protect the read-only vanilla files. Only a developer working on the game data itself should
    // turn it on. Installed workshop mods belong to somebody else and stay off limits either way.
    allowEditingVanillaFiles: boolean;
    decompiler: {
        // When true, a schema hover ends with an "Open <Class> in decompiler" link that opens the
        // owning C# class in the user's .NET decompiler (ILSpy or dotPeek). Off by default: it is
        // a power-user feature that needs a decompiler installed, and the link is noise for
        // everyone else.
        showInHover: boolean;
        // Explicit path to the decompiler executable. Empty (the default) means auto-detect:
        // the PATH plus the usual ILSpy / dotPeek install locations per OS are searched.
        executablePath: string;
        // Which command-line style to launch with. 'auto' infers ILSpy or dotPeek from the
        // executable's file name and is right for both standard installs.
        tool: 'auto' | 'ilspy' | 'dotpeek';
    };
    formatting: {
        // Master switch for document formatting (Format Document on `.rules` and `.shader` files).
        // On by default. Turning it off makes the server return no formatting edits.
        enabled: boolean;
        // When true, the document is auto-formatted right before every save (LSP willSaveWaitUntil),
        // independent of the editor's own `editor.formatOnSave`. Off by default so saving never
        // rewrites a file the user did not ask to reformat. On-save formatting indents with tabs,
        // the vanilla `.rules` convention, since the save event carries no editor indent options.
        formatOnSave: boolean;
    };
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
export const defaultSettings: CosmoteerSettings = {
    maxNumberOfProblems: MAX_NUMBER_OF_PROBLEMS,
    cosmoteerPath: '',
    trace: {
        server: 'off',
    },
    ignorePaths: [],
    diagnostics: {
        validateWholeWorkspace: true,
        workspaceValidationScope: 'modRulesReachable',
        validateComponentReferences: true,
        validateCrossFileReferences: true,
        validateRequiredFields: true,
        validateShaderConstants: true,
        validateShaderCode: true,
        validateLocalizationKeys: true,
        validateRedundantSeparators: true,
        validateUnclosedComments: true,
        validateIgnoredFields: true,
        validateDefaultValues: true,
        validateUnusedConstants: true,
        validateDuplicateFields: true,
        validateRedundantOverrides: true,
        validateModManifest: true,
        validatePartGeometry: true,
        validateDuplicateIds: true,
        validateUndeclaredDependencies: true,
        validateUnreceivableBuffs: true,
        validatePaths: true,
        validateSpriteGeometry: true,
        validateRenderLayers: true,
    },
    codeMods: {
        enabled: true,
        autoRefresh: true,
    },
    inlayHints: {
        showBaseValue: true,
    },
    hover: {
        showSubstitutions: true,
        showModifiers: true,
    },
    allowEditingVanillaFiles: false,
    decompiler: {
        showInHover: false,
        executablePath: '',
        tool: 'auto',
    },
    formatting: {
        enabled: true,
        formatOnSave: false,
    },
};

export let globalSettings: CosmoteerSettings = defaultSettings;

/**
 * Replace the current global settings. Must be used instead of reassigning the
 * imported `globalSettings` binding directly, since other modules read it live.
 *
 * @param settings the new settings to publish as the global configuration.
 */
export const setGlobalSettings = (settings: unknown): void => {
    globalSettings = mergeSettings(settings);
};

/**
 * Fill a client's configuration answer up with the defaults it left out.
 *
 * A client sends only the keys it knows about, so a setting the client has never heard of arrives
 * as `undefined` and would read as "off" everywhere the server tests it for truth. Every key the
 * answer does carry wins, including an explicit `false`.
 *
 * @param settings the client's answer, or undefined/null when the client answered nothing.
 * @returns a complete settings object.
 */
export const mergeSettings = (settings: unknown): CosmoteerSettings =>
    mergeInto(defaultSettings, settings) as CosmoteerSettings;

/**
 * Merge one configuration level, recursing into nested groups and replacing anything else.
 *
 * @param fallback the default value for this level.
 * @param provided the value the client sent for this level, if any.
 * @returns the merged value.
 */
const mergeInto = (fallback: unknown, provided: unknown): unknown => {
    if (provided === undefined || provided === null) return fallback;
    if (!isPlainGroup(fallback) || !isPlainGroup(provided)) return provided;
    const merged: { [key: string]: unknown } = { ...fallback };
    for (const key of Object.keys(provided)) {
        merged[key] = mergeInto(fallback[key], provided[key]);
    }
    return merged;
};

/**
 * Tell a nested settings group apart from a leaf value, so arrays and scalars are replaced whole.
 *
 * @param value the value to judge.
 * @returns true when the value is a plain object that carries further settings.
 */
const isPlainGroup = (value: unknown): value is { [key: string]: unknown } =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
