export const startsWithAmpersandAndLetter = (value: string) => /^&[A-Za-z_.]/.test(value);

/**
 * The authoritative ObjectText reference-path grammar, ported from
 * `Halfling.ObjectText.Validator.PATH_RE` in the game's `HalflingCore.dll` (see the
 * `inspect-cosmoteer-ot-format` skill). A target is: an optional leading `&`, an optional first
 * segment (identifier with `.`/`#`, or `^` `~` `.` `..` `:` `#`, or a `<file path>`), then any
 * number of `/`-separated segments (identifier, `^`, `..`, `:`, `#`), with whitespace allowed
 * around the separators.
 *
 * A name segment is `\.?\w[\w.]*` — a run of word characters and dots requiring at least one word
 * character, with at most a single leading dot. This is deliberately unambiguous: the earlier
 * `(\w|(?<=\w\.*)\.|\.(?=\w\.*))+` form let an interior `.` match two alternatives, so a long dotted
 * value that ultimately failed drove exponential backtracking (a ReDoS that froze the whole server,
 * since `isValidReference` runs on every edit).
 */
const PATH_RE =
    /^\s*&?\s*(#?\.?\w[\w.]*|\^|~|\.|\.\.|:|<(.*)>|#)?\s*(?:\/\s*(?:\.?\w[\w.]*|\^|\.\.|:|#)\s*)*\/?\s*$/;

// Mirrors .NET `Path.GetInvalidPathChars()` for the `<file path>` check: control chars (0x00-0x1F)
// plus the quote/pipe/angle characters that can never appear in a path. Spaces and hyphens are
// valid in paths and must not be rejected.
// eslint-disable-next-line no-control-regex
const INVALID_FILE_PATH_CHARS = /[\x00-\x1f"<>|]/;

export const isValidReference = (value: string): boolean => {
    const match = PATH_RE.exec(value);
    if (!match) return false;
    // When the target embeds a `<file path>`, that path must itself be a valid file path.
    if (value.includes('<')) {
        return !INVALID_FILE_PATH_CHARS.test(match[2] ?? '');
    }
    return true;
};

/**
 * The final identifier segment of an inheritance reference — the base group's name — or undefined
 * when the reference does not end in a plain name. `BASE_SPRITES` -> `BASE_SPRITES`, `^/0/Toggles` ->
 * `Toggles`, `&<…/base.rules>/Part` -> `Part`, `..` -> undefined. Used to recognize a group that
 * serves as an inheritance base (a template completed by its deriving groups).
 * @param reference the inheritance reference to extract the base name from
 * @returns the final plain-name segment, or undefined when the reference does not end in one
 */
export const inheritanceBaseLeafName = (reference: string): string | undefined => {
    const segment = reference.replace(/^[&^~]+/, '').split('/').pop() ?? '';
    return /^[A-Za-z_]\w*$/.test(segment) ? segment : undefined;
};
