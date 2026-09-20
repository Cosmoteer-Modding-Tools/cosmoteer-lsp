/**
 * The shapes the run-in-game command speaks in: what a client sends, what the command did, and every
 * reason it refused to do it. Read by the server that starts the game and by every client that asks,
 * so both sides share the one declaration and a reason added here is a compile error in the client
 * that has no sentence for it yet.
 */

/** Why the command did nothing. Each one is reported to the user as its own sentence. */
export type RunGameRefusal =
    | 'unsupported-platform'
    | 'no-install'
    | 'no-executable'
    | 'no-mod'
    | 'no-user-data'
    | 'no-settings-file'
    | 'game-running'
    | 'duplicate-mod-enabled'
    | 'link-name-taken'
    | 'link-failed'
    | 'settings-unparseable'
    | 'settings-no-game-settings'
    | 'settings-no-enabled-mods'
    | 'settings-not-equivalent'
    | 'settings-bad-entry'
    | 'settings-write-failed';

/** Arguments the clients pass. */
export interface RunGameArgs {
    /** The document the command was invoked from, used to find the mod. */
    readonly uri?: string;
    /** The user data folder to use, when the client has already asked which one. */
    readonly userDataFolder?: string;
}

/** What the command did, or the single reason it refused to do it. */
export type RunGameResult =
    | {
          readonly kind: 'started';
          /** The mod folder as the game sees it, which is the link when one was made. */
          readonly modFolder: string;
          /** Whether a link had to be created, so the client can say where it went. */
          readonly linked: boolean;
          /** Whether the settings file had to be changed, or the mod was already enabled. */
          readonly enabled: boolean;
          /** Where the settings file was backed up, when it was written. */
          readonly backup?: string;
          /**
           * False when the mod's manifest names no game version this build accepts, the installed
           * one or one of the older ones it still takes. The game turns such a mod straight back
           * off while loading, so it never appears and nothing says why.
           */
          readonly compatible: boolean;
      }
    | { readonly kind: 'choose-user-data'; readonly candidates: readonly string[] }
    | { readonly kind: 'refused'; readonly reason: RunGameRefusal; readonly detail?: string };
