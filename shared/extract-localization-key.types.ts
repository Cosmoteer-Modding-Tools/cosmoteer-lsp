/**
 * The shapes the localization-key extraction speaks in: what a client sends once the author has named
 * the key, and what the extraction did. Read by the server that writes the key and by every client
 * that asks for one, so both sides share the one declaration.
 */

/** What the client sends once the author has named the key. */
export interface ExtractLocalizationKeyArgs {
    /** The file the extracted literal lives in. */
    uri: string;
    /** The literal's start offset in that file, opening quote included. */
    offset: number;
    /** The literal exactly as written, quotes included, which is also the text the strings files get. */
    literal: string;
    /** The key path to declare. The code action proposes one, the author may rewrite it. */
    key: string;
}

/** Why an extraction did nothing. */
export type ExtractLocalizationKeyFailure = 'stale' | 'noStringsFiles' | 'editRejected';

/** What the extraction did, or why it did nothing. */
export interface ExtractLocalizationKeyResult {
    /** The key the value now points at. */
    key: string;
    /** The strings files the key was written into (absolute paths), for the client's tidy-up. */
    changedFiles: string[];
    /** Set when nothing was changed. */
    failure?: ExtractLocalizationKeyFailure;
}
