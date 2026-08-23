import { RegisterPartFailure } from '../register-part/register-part.command';

/**
 * The shapes the new-content command speaks in. Kept apart from the command itself so the template
 * emitters and the id derivation can name a content kind without pulling the command's file writing
 * in with it.
 */

/**
 * The kinds of content the command creates. Each one has a hand-written template, its own folder
 * convention and its own answer to the question of what makes the game load the file.
 *
 * `part` and `resource` have a real registration route. `bullet` and `mediaEffect` have none: the
 * game reaches a shot through a part's `BulletEmitter` and a media effect through a `MediaEffects`
 * entry, so nothing registers them and the command says so rather than inventing an action.
 */
export type ContentKind = 'part' | 'resource' | 'bullet' | 'mediaEffect';

/** Every content kind, in the order the client offers them. */
export const CONTENT_KINDS: readonly ContentKind[] = ['part', 'resource', 'bullet', 'mediaEffect'];

/** How a created file is wired into the game. */
export type RegistrationRoute = 'ship' | 'manifest' | 'none';

/**
 * Why a registration was not written. The part route's reasons come from the shipped register-part
 * command, which does that work, and the two extra ones are the manifest route's own.
 */
export type RegistrationFailure = RegisterPartFailure | 'manifestUnusable' | 'noGameRoot' | 'noShipChosen';

/** Why the command created nothing at all. */
export type NewContentFailure =
    | 'noModRoot'
    | 'notEditable'
    | 'unknownKind'
    | 'invalidName'
    | 'pathTaken'
    | 'idTaken'
    | 'writeFailed';

/** What the client sends. Without a `name` the command reports what could be created here. */
export interface NewContentArgs {
    /** A file of the mod the content is created in, usually the active editor's document. */
    uri: string;
    /** The kind to create. Absent on the scan round, which reports all of them. */
    kind?: ContentKind;
    /** The author's name for the new content, which the file name and the id are derived from. */
    name?: string;
    /** The {@link NewContentShip.key} of the ship a new part is registered in. */
    ship?: string;
    /** Set to create the file without registering it, for an author who wires it up by hand. */
    skipRegistration?: boolean;
}

/** One ship class a new part could be registered in. */
export interface NewContentShip {
    /** The identity the client sends back to pick this ship. */
    key: string;
    /** The ship group's name in its own file. */
    groupName: string;
    /** The ship's written `ID`, absent when it declares none locally. */
    id?: string;
    /** The ship file's on-disk path. */
    fsPath: string;
    /** Whether the ship belongs to the workspace or to the game's own install. */
    target: 'workspace' | 'vanilla';
    /** Whether registering writes into the ship's own file or into the mod's manifest. */
    via: 'shipFile' | 'modAction';
    /** Why this ship cannot take a part, absent when it can. */
    blocked?: 'partsInherited' | 'noPartsList' | 'notEditable' | 'unreadable';
}

/** What one content kind would do in this mod. */
export interface ContentKindInfo {
    kind: ContentKind;
    /** The folder the file goes in, relative to the mod root, forward slashes. */
    folder: string;
    /** How the file is wired into the game. */
    registration: RegistrationRoute;
    /**
     * The plain sentence naming what has to point at the file, only set for a kind nothing
     * registers. It is shown instead of a success claim, because a file nothing reaches is a file
     * the game never loads.
     */
    pointedAtBy?: string;
    /** Why the registration route cannot be taken in this mod, absent when it can. */
    blocked?: RegistrationFailure;
}

/** What can be created in this mod, and where it would be wired in. */
export interface NewContentScanResult {
    kind: 'scan';
    /** The mod the file would be created in, empty when there is none. */
    modRoot: string;
    /** The mod's manifest id, empty when it declares none. */
    modId: string;
    /** The author segment new ids carry, empty when the manifest declares no dotted id. */
    idPrefix: string;
    /** One entry per content kind. */
    kinds: ContentKindInfo[];
    /** The ship classes a new part could be registered in, in registry order. */
    ships: NewContentShip[];
    /** Why nothing could be reported, absent on success. */
    failure?: NewContentFailure;
}

/** What creating the file did. */
export interface NewContentApplyResult {
    kind: 'apply';
    /** The created file's on-disk path, empty when nothing was written. */
    created: string;
    /** The kind that was created. */
    contentKind: ContentKind;
    /** The id written into the file, empty for a media effect, which declares none. */
    id: string;
    /** How the file was wired in. */
    route: RegistrationRoute;
    /** The file the registration was written into, empty when none was. */
    registeredIn: string;
    /** Why the registration did not happen, absent when it did or when the kind has no route. */
    registrationFailure?: RegistrationFailure;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
    /** Every file other than the created one that the command changed. */
    changedFiles: string[];
    /** The localization keys the template writes, whether or not they could be created. */
    localizationKeys: string[];
    /** The language files the keys were written into, empty when the mod ships none. */
    localizationFiles: string[];
    /**
     * The reference that reaches the created file, sigil included, written from the directory of
     * the file the command was invoked on. Set for every kind, and the only way in for the two
     * kinds nothing registers.
     */
    reference: string;
    /** The plain sentence naming what has to point at the file, for a kind nothing registers. */
    pointedAtBy?: string;
    /** The assets the template points at that the author is expected to replace. */
    placeholderAssets: string[];
    /** Why nothing was created, absent on success. */
    failure?: NewContentFailure;
}

/** Either round's answer. */
export type NewContentResult = NewContentScanResult | NewContentApplyResult;
