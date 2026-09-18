// The localization every webview page looks its user-visible text up in. The host writes the
// translated strings into the page ahead of the page's own script, keyed by the English source, and
// a host that writes none leaves the page falling back to the key, which is that source.
//
// One copy for all four pages: each page is bundled on its own, so the copy in a page's bundle is
// the only one that page carries.

/** The translated text the host wrote into the page, keyed by its English source. */
const STRINGS = (typeof window !== 'undefined' && window.cosmoteerStrings) || {};

/**
 * Looks a user-visible string up by its English source and fills in its numbered placeholders.
 *
 * @param message the English source, which is also the bundle key.
 * @param args the values for the `{0}`-style placeholders, in order.
 * @returns the localized text with its placeholders filled in.
 */
export function t(message, ...args) {
    const template = STRINGS[message] || message;
    if (!args.length) return template;
    return template.replace(/\{(\d+)\}/g, (match, index) => (args[index] === undefined ? match : String(args[index])));
}
