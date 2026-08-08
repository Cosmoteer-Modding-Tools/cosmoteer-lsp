export const MAX_NUMBER_OF_PROBLEMS = 10;

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
        // the only way to pick up a change. Costs nothing while idle; each change re-walks the mod
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
    },
    codeMods: {
        enabled: true,
        autoRefresh: true,
    },
    inlayHints: {
        showBaseValue: true,
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
export const setGlobalSettings = (settings: CosmoteerSettings): void => {
    globalSettings = settings;
};
