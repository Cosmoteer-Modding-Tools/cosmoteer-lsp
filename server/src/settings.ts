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
        // When true, validate every `.rules` file in the open workspace folder(s), not just the
        // files open in the editor. Off by default: parsing the whole project keeps every file's
        // AST in memory and costs CPU up front, which low-memory machines may not want.
        validateWholeWorkspace: boolean;
        // Which files the whole-workspace pass covers. 'allFiles' (the default) validates every
        // `.rules` under the workspace folders. 'modRulesReachable' restricts the pass to the files
        // the game can actually load — the closure of the mod.rules action sources, their includes
        // and inheritance, and the strings folder — so backups, templates and other dead content
        // stop flooding the Problems panel. Files open in the editor always validate either way.
        workspaceValidationScope: 'allFiles' | 'modRulesReachable';
        // When true (the default), flag a component `ID<…>` reference (e.g. `OperationalToggle =
        // IsOperational`) whose id names no component anywhere in the part, its inherited bases, or
        // its include-valued components blocks. Only runs once the game `Data` tree is indexed
        // (inherited vanilla bases must resolve); runtime-injected engine components and fields with
        // non-sibling semantics are excluded, which took the vanilla scan to zero false positives.
        validateComponentReferences: boolean;
        // When true (the default), flag a cross-file `ID<…>` reference (a GUI toggle/color/targeter/
        // trigger id) whose id names no declaration of that kind anywhere in the project. Only runs
        // once the game `Data` tree is indexed, since a reference to a vanilla-declared id would
        // otherwise be a false positive.
        validateCrossFileReferences: boolean;
        // When true (the default), flag a group that is missing a schema-required field, checking the
        // inheritance chain so a field supplied by a base does not count as missing. Validated to zero
        // false positives across vanilla and 42 real workshop mods (7820 files); the schema's required
        // flag is derived from real C# signals and cross-file templates are absorbed by a project-wide
        // index. Can be turned off to skip the one-time project index build it performs.
        validateRequiredFields: boolean;
        // When true (the default), flag an inline `_`-prefixed shader constant a material sets that the
        // referenced `.shader` declares no uniform for (a typo such as `_hotColr`), and one whose value
        // is the wrong shape for its type. Only fires when the shader resolves on disk (otherwise the
        // names cannot be judged); the handful of dead constant keys the game itself ships are skipped.
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
        // panel; vanilla itself ships hundreds of such separators.
        validateRedundantSeparators: boolean;
        // When true (the default), hint at a field the game provably ignores: its group resolves to
        // a schema class that does not declare the name, and no reference in the file reads it (so
        // the constant idiom `X = foo.png` + `&X` stays untouched). Comes with a remove quick fix.
        // Hint severity keeps it out of the Problems panel.
        validateIgnoredFields: boolean;
    };
    inlayHints: {
        // When true (the default), a reference whose target is a group in the game's
        // ModifiableValue shape (`Arc { BaseValue = 160d }`) is annotated with that member:
        // `Arc = &~/…/ArcShield/Arc` renders ` /BaseValue = 160d`. The BaseValue is what the
        // reference effectively supplies at runtime, and it is otherwise invisible without
        // following the reference by hand.
        showBaseValue: boolean;
    };
    rename: {
        // When true, a rename may also edit files inside the Cosmoteer game `Data` install. Off by
        // default to protect the read-only vanilla files — only a developer working on the game data
        // itself should turn this on.
        allowEditingVanillaFiles: boolean;
    };
    formatting: {
        // Master switch for document formatting (Format Document on `.rules` and `.shader` files).
        // On by default; turning it off makes the server return no formatting edits.
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
        validateWholeWorkspace: false,
        workspaceValidationScope: 'allFiles',
        validateComponentReferences: true,
        validateCrossFileReferences: true,
        validateRequiredFields: true,
        validateShaderConstants: true,
        validateShaderCode: true,
        validateLocalizationKeys: true,
        validateRedundantSeparators: true,
        validateIgnoredFields: true,
    },
    inlayHints: {
        showBaseValue: true,
    },
    rename: {
        allowEditingVanillaFiles: false,
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
