/**
 * The version the build was cut from, injected by the bundler. Declared rather than imported,
 * because the package manifests sit outside the compiled source root and importing one would take
 * the whole manifest into the bundle. Left undefined by a watch build, which has no fixed version.
 */
declare const __CLI_VERSION__: string | undefined;

/** The tool name, which appears in every report and is what a reader searches for. */
export const TOOL_NAME = 'Cosmoteer Rules Lint';

/** Where a reader goes to find out what the tool is and what a rule means. */
export const TOOL_INFORMATION_URI = 'https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp';

/**
 * The version this build reports.
 *
 * @returns the injected version, or 'unknown' for a build that carries none.
 */
export const toolVersion = (): string =>
    typeof __CLI_VERSION__ === 'string' && __CLI_VERSION__ ? __CLI_VERSION__ : 'unknown';
