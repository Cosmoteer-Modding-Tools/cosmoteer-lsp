import { RegisterPartFailure } from '../register-part/register-part.types';

/**
 * The shapes the new-content command speaks in. Kept apart from the command itself so the template
 * emitters and the id derivation can name a content kind without pulling the command's file writing
 * in with it.
 */

/**
 * The kinds of content the command creates. Each one has a hand-written template, its own folder
 * convention and its own answer to the question of what makes the game load the file.
 *
 * `part`, `resource`, `logoShip` and `decalFolder` have a real registration route. `bullet` and
 * `mediaEffect` have none: the game reaches a shot through a part's `BulletEmitter` and a media
 * effect through a `MediaEffects` entry, so nothing registers them and the command says so rather
 * than inventing an action.
 *
 * `logoShip` is the odd one out in that it writes no template: the title screen flies in a saved
 * ship, so the command copies one the author picked and points the menu rules at the copy.
 *
 * `editorGroup`, `partStat` and `partToggle` are entries of the game's gui registries: a build
 * toolbar category, a tooltip stat line and a part toggle. Each is registered from the manifest
 * into a file the game root reaches only through nested references, so the target is spelled out
 * rather than derived, and each hands back a sentence saying how a part uses it, since registering
 * the entry is only half of what makes it show.
 *
 * `buff` is a member of the game's buff map, merged in from the manifest with an `Overrides` because
 * the registry is a group rather than a list, and it too hands back a usage sentence, since a buff no
 * part provides or receives does nothing. `codexPage` is a help page appended to the game's tutorial
 * pages, whose texts are localization keys like a part's name.
 */
export type ContentKind =
    | 'part'
    | 'resource'
    | 'bullet'
    | 'mediaEffect'
    | 'logoShip'
    | 'decalFolder'
    | 'editorGroup'
    | 'partStat'
    | 'partToggle'
    | 'buff'
    | 'codexPage';

/** Every content kind, in the order the client offers them. */
export const CONTENT_KINDS: readonly ContentKind[] = [
    'part',
    'resource',
    'bullet',
    'mediaEffect',
    'logoShip',
    'decalFolder',
    'editorGroup',
    'partStat',
    'partToggle',
    'buff',
    'codexPage',
];

/** How a created file is wired into the game. */
export type RegistrationRoute = 'ship' | 'manifest' | 'none';

/**
 * Why a registration was not written. The part route's reasons come from the shipped register-part
 * command, which does that work, and the two extra ones are the manifest route's own.
 */
export type RegistrationFailure = RegisterPartFailure | 'manifestUnusable' | 'noGameRoot' | 'noShipChosen';

/** Why the command created nothing at all. */
export type NewContentFailure =
    'noModRoot' | 'notEditable' | 'unknownKind' | 'invalidName' | 'pathTaken' | 'idTaken' | 'noSource' | 'writeFailed';

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
    /**
     * The on-disk path of the saved `.ship.png` a new logo ship is copied from. Only the logo ship
     * reads it, and it is refused without one, since there is no ship to invent in its place.
     */
    source?: string;
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
    /** The id written into the file, empty for a kind that declares none. */
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
     * kinds nothing registers. A logo ship is no rules file, so its reference is the manifest-relative
     * path the `Replace` action names instead.
     */
    reference: string;
    /** The plain sentence naming what has to point at the file, for a kind nothing registers. */
    pointedAtBy?: string;
    /**
     * The plain sentence saying how a part uses the created entry, for a kind whose registration
     * alone shows nothing: a toolbar category needs a part to name it, a stat line needs a part to
     * write a value under it, a toggle needs a part component to carry it, a buff needs a part to
     * provide and receive it and a codex page needs a show condition before the HUD offers it.
     */
    usage?: string;
    /** The assets the template points at that the author is expected to replace. */
    placeholderAssets: string[];
    /**
     * The manifest-relative path the title screen pointed at before, set when the mod already
     * replaced the title screen ship and that action was pointed at the new copy instead of a
     * second one being added. The file it names is left where it was.
     */
    previousLogo?: string;
    /** Why nothing was created, absent on success. */
    failure?: NewContentFailure;
}

/** Either round's answer. */
export type NewContentResult = NewContentScanResult | NewContentApplyResult;
