/**
 * The shapes the new-asteroid-type command speaks in. Both clients ask the same two questions of the
 * server, what an asteroid type could be built from here and what creating one did, so the shapes
 * live apart from the command that answers them.
 */

import { CancellationToken } from 'vscode-languageserver';
import { NewContentHost } from '../refactor/new-content/new-content.command';
import { ASTEROID_SIZES, RARITIES } from './new-asteroid-type.command';

export type AsteroidSize = (typeof ASTEROID_SIZES)[number];
export type AsteroidRarity = (typeof RARITIES)[number];

/** How one wiring of the type went. */
export type AsteroidWiringOutcome =
    'written' | 'alreadyThere' | 'noTarget' | 'editRejected' | 'skipped' | 'manifestUnusable' | 'ambiguousManifest';

/** Why the command created nothing. */
export type NewAsteroidTypeFailure =
    | 'noModRoot'
    | 'notEditable'
    | 'noGameRoot'
    | 'noAuthorPrefix'
    | 'invalidId'
    | 'idTaken'
    | 'pathTaken'
    | 'writeFailed';

/** What the client sends. Without an `id` the command reports what could be created here. */
export interface NewAsteroidTypeArgs {
    /** A file or folder of the mod the type is created in. */
    uri: string;
    /** The type's id, one bare word every doodad and part id is built around. Absent on the scan round. */
    id?: string;
    /** The type's display name, written into the texts and the editor group. */
    name?: string;
    /** The resource the deposits yield, by its id. */
    resource?: string;
    /** The game's own deposit whose textures are borrowed, by its folder key. */
    look?: string;
    /** Which rarity list the type spawns from. */
    rarity?: AsteroidRarity;
    /** Which sizes get a recipe. */
    sizes?: AsteroidSize[];
    /** The factor every size's spawn weight is multiplied by. */
    weight?: number;
    /** Whether hard tiles and their conversions are written. */
    hard?: boolean;
    /** A literal deposit density, replacing the resource's own. */
    density?: number;
}

/** A resource the deposits can yield. */
export interface AsteroidResource {
    id: string;
    /** The resource's name in the language files, absent when none could be read. */
    name?: string;
}

/** One of the game's own deposits whose textures can be borrowed. */
export interface AsteroidLook {
    id: string;
    label: string;
}

/** What could be created in this mod. */
export interface NewAsteroidTypeScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    resources: AsteroidResource[];
    looks: AsteroidLook[];
    /** The type ids whose doodads or deposits already exist under this mod's author prefix, folded. */
    takenIds: string[];
    /** The author prefix every id is built with, empty when the manifest declares no dotted id. */
    authorPrefix: string;
    failure?: NewAsteroidTypeFailure;
}

/** What creating the type did. */
export interface NewAsteroidTypeApplyResult {
    kind: 'apply';
    id: string;
    /** The folder the type's files were written under, empty when nothing was written. */
    folder: string;
    /** Every file written, the deposit tiles first and the types file last. */
    files: string[];
    /** The manifest the actions went into, empty when none did. */
    manifest: string;
    /** How each wiring went: the deposits, the conversions, the recipes and the spawner entries. */
    wiring: Record<'parts' | 'conversions' | 'doodads' | 'types', AsteroidWiringOutcome>;
    /** The manifest names to choose between, only set when a wiring is `ambiguousManifest`. */
    manifests?: string[];
    /** The localization keys the texts are declared under. */
    localizationKeys: string[];
    /** The language files the keys were written into, empty when the mod ships none. */
    localizationFiles: string[];
    createdFiles: string[];
    changedFiles: string[];
    failure?: NewAsteroidTypeFailure;
}

export type NewAsteroidTypeResult = NewAsteroidTypeScanResult | NewAsteroidTypeApplyResult;

/** The server-side facilities the command needs, the new-content host plus the language files for the resource names. */
export interface NewAsteroidTypeHost extends NewContentHost {
    /**
     * The text a localization key resolves to, for naming a resource the way the game does.
     *
     * @param key the key as a resource's `NameKey` writes it.
     * @param cancellationToken cancels the lookup.
     * @returns the text, or undefined when no language file declares the key.
     */
    localizedName?(key: string, cancellationToken: CancellationToken): Promise<string | undefined>;
}
