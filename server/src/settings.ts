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
        // When true, flag a component `ID<…>` reference (e.g. `OperationalToggle = IsOperational`)
        // whose id names no component anywhere in the part or its inherited bases. Off by default:
        // some components are injected by the engine at runtime (never declared in `.rules`, e.g.
        // `ConstructionTracker`) and some files are fragments merged into a parent part, so a
        // single-file check cannot be fully false-positive-free.
        validateComponentReferences: boolean;
        // When true, flag a cross-file `ID<…>` reference (e.g. `ResourceType = battery`, a buff in
        // `ReceivableBuffs`, a status key in `StatusResistances`) whose id names no declaration of
        // that kind anywhere in the project. Off by default, because it depends on the whole project
        // and game tree being indexed, so a reference to something the index has not seen would be a
        // false positive.
        validateCrossFileReferences: boolean;
        // When true (the default), flag a group that is missing a schema-required field, checking the
        // inheritance chain so a field supplied by a base does not count as missing. Validated to zero
        // false positives across vanilla and 42 real workshop mods (7820 files); the schema's required
        // flag is derived from real C# signals and cross-file templates are absorbed by a project-wide
        // index. Can be turned off to skip the one-time project index build it performs.
        validateRequiredFields: boolean;
        // When true, flag an inline `_`-prefixed shader constant a material sets that the referenced
        // `.shader` declares no uniform for (a typo such as `_hotColr`), and one whose value is the wrong
        // shape for its type. Off by default: the type check is false-positive-free, but the game itself
        // ships a handful of dead constant keys its shaders do not read (e.g. a nebula's `_color4`, an
        // ion beam's `_sizePulseFactor`), which are technically-correct warnings on vanilla data, so the
        // check is opt-in. Only fires when the shader resolves on disk (otherwise the names cannot be
        // judged).
        validateShaderConstants: boolean;
        // When true, run lightweight diagnostics on `.shader` files themselves: an `#include` whose
        // target does not exist, a `_`-prefixed uniform read that no file in the include chain declares,
        // and a call to a function that is neither an HLSL intrinsic nor defined in scope. Off by
        // default: it is a lexical check (not an HLSL compiler), and the undeclared-symbol checks only
        // run when the whole include chain is readable, so a shader whose base include lives in an
        // unconfigured game path is left unchecked rather than flagged wrongly.
        validateShaderCode: boolean;
        // When true, flag a localization key (`NameKey = "Parts/Foo"`, a C# `KeyString`) whose path is
        // declared in no language strings file in the project. Only literal key paths are checked
        // (reference-valued keys `&<…>/NameKey` are validated as references), and matching is
        // case-insensitive (the game resolves keys case-folded). Off by default like the other
        // cross-file existence checks: coverage needs the base game strings indexed (a configured
        // `cosmoteerPath`), so without it a reference to a vanilla key would false-positive. An FP scan
        // over vanilla (0 findings on 874 keys) and 42 workshop mods found only genuine missing-string
        // bugs, so it is safe to enable once the game path is set.
        validateLocalizationKeys: boolean;
    };
    rename: {
        // When true, a rename may also edit files inside the Cosmoteer game `Data` install. Off by
        // default to protect the read-only vanilla files — only a developer working on the game data
        // itself should turn this on.
        allowEditingVanillaFiles: boolean;
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
        validateComponentReferences: false,
        validateCrossFileReferences: false,
        validateRequiredFields: true,
        validateShaderConstants: false,
        validateShaderCode: false,
        validateLocalizationKeys: false,
    },
    rename: {
        allowEditingVanillaFiles: false,
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
