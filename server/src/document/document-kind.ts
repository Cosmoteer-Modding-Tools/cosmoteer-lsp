/**
 * The kind of a Cosmoteer rules document.
 *
 * `rules` is a normal `.rules` data file (game groups, parts, effects, …).
 * `mod-rules` is the special `mod.rules` manifest at a mod's root. It declares
 * mod metadata (ID/Name/Version/…) and an `Actions` list (Add/AddMany/Overrides/
 * Replace) that patches base-game rules. Its references and assignments follow
 * different rules, so several features branch on this kind.
 *
 * This is the single place that distinguishes the two. Features should depend on
 * {@link getDocumentKind} / {@link isModRules} rather than re-deriving it from the
 * URI, so the classification can be refined in one spot later.
 */
type DocumentKind = 'rules' | 'mod-rules';

/**
 * Classify by basename. A manifest is `mod.rules` or any `mod_*.rules` (Cosmoteer
 * also loads `mod_*.rules` variants, optionally in sub-folders). The hyphenated
 * `mod-*.rules` files (e.g. `mod-colors.rules`) are ordinary data files, not manifests.
 */
const MOD_MANIFEST_BASENAME = /^(mod\.rules|mod_.*\.rules)$/i;

/** The last path segment of a `file://` URI or OS path (slash or backslash separated). */
export const basenameOf = (uri: string): string => {
    const path = uri.split(/[?#]/, 1)[0].replace(/\\/g, '/');
    return path.substring(path.lastIndexOf('/') + 1);
};

/** True if a bare filename is a mod manifest (`mod.rules` / `mod_*.rules`). The single
 *  source of truth for manifest naming, reused by mod-root / mod-context scans. */
export const isManifestBasename = (basename: string): boolean => MOD_MANIFEST_BASENAME.test(basename);

/**
 * True if a filename holds rules content the project walks should index. The game's loader ignores
 * the extension, and mods declare whole parts in `.txt` files, so those count alongside `.rules`.
 * The single source of truth for the walk filters (project documents, stat sweeps, file trees,
 * reachability), so the set can be widened in one spot.
 */
export const isRulesFileName = (basename: string): boolean => {
    if (isDocumentationFileName(basename)) return false;
    const lower = basename.toLowerCase();
    return lower.endsWith('.rules') || lower.endsWith('.txt');
};

/** A file whose name says it is prose for the reader, whatever extension it carries. */
const DOCUMENTATION_BASENAME = /^(readme|changelog)(\.[^.]*)?$/i;

/**
 * True if a filename is a mod's readme or changelog. Modders write those next to the rules and
 * sometimes give them the `.rules` extension so the folder stays uniform, which makes prose arrive
 * at the parser and fills the panel with errors about a file nothing loads. The game never loads
 * them either: a strings folder only accepts a file whose first two lines are `__Name`/`__DebugOnly`
 * (`Cosmoteer.Localization.Strings`), and every other loader reaches a file by an explicit path.
 *
 * @param basename the bare filename.
 * @returns true for `readme`/`changelog` in any casing, with or without an extension.
 */
export const isDocumentationFileName = (basename: string): boolean => DOCUMENTATION_BASENAME.test(basename);

/**
 * True if a segment of a `<…>` reference path ends its file part (`foo.rules>`, `bar.txt>`). The
 * game resolves the path through the case-insensitive Windows FS and its loader ignores the
 * extension, so any casing and both extensions must match. The single source of truth for the
 * path splitters that locate the file part of a reference.
 */
export const isRulesPathSegment = (segment: string): boolean => /\.(rules|txt)>$/i.test(segment);
/**
 * Get the kind of a Cosmoteer rules document based on its URI.
 * @param uri The URI of the document.
 * @returns The document kind (`rules` or `mod-rules`).
 */
export const getDocumentKind = (uri: string): DocumentKind =>
    isManifestBasename(basenameOf(uri)) ? 'mod-rules' : 'rules';

/**
 * Check if a document is a mod manifest (`mod.rules` or `mod_*.rules`), based on its URI.
 * @param uri   The URI of the document.
 * @returns  True if the document is a mod manifest, false otherwise.
 */
export const isModRules = (uri: string): boolean => getDocumentKind(uri) === 'mod-rules';

/**
 * Check if a document is a Cosmoteer `.shader` file (HLSL), based on its URI. Shader files take a
 * different language-server path than `.rules` (a lexical HLSL scanner, not the OT parser), so
 * features such as semantic tokens branch on this.
 * @param uri The URI of the document.
 * @returns True if the document is a `.shader` file.
 */
export const isShaderDocument = (uri: string): boolean => basenameOf(uri).toLowerCase().endsWith('.shader');
