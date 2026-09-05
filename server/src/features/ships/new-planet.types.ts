/**
 * The shapes the new-planet command speaks in. Both clients ask the same two questions of the
 * server, what a planet could be built on here and what creating one did, so the shapes live apart
 * from the command that answers them.
 */

import { CancellationToken } from 'vscode-languageserver';
import { NewContentHost } from '../refactor/new-content/new-content.command';
import { WiringOutcome } from './mod-wiring';

/** Where in the career spawner each placement puts the planet. */
export type PlanetPlacement = 'inner' | 'outer' | 'innerMoon' | 'outerMoon' | 'none';

/** Why the command created nothing. */
export type NewPlanetFailure =
    | 'noModRoot'
    | 'notEditable'
    | 'noGameRoot'
    | 'invalidId'
    | 'idTaken'
    | 'pathTaken'
    | 'writeFailed'
    | 'noAuthorPrefix';

/** What the client sends. Without an `id` the command reports what could be created here. */
export interface NewPlanetArgs {
    /** A file or folder of the mod the planet is created in. */
    uri: string;
    /** The planet's word, which the doodad id and the file name are built from. Absent on the scan round. */
    id?: string;
    /** The planet's display name, declared under `Doodads/<Label>`. */
    name?: string;
    /** The id of the game's own planet doodad the new one is built on. Absent or unknown, the first offered stands in. */
    base?: string;
    /** Where the career sectors place it. Absent, it is offered to the inner planets. */
    placement?: PlanetPlacement;
    /** Its chance weight among the other planets of that list. */
    weight?: number;
    /** The size range it may be placed at, as `[min, max]`, replacing the base's. */
    scale?: [number, number];
    /** The size it is placed at by hand, replacing the base's. */
    defaultScale?: number;
}

/** One of the game's own planets a new one can be built on. */
export interface PlanetBase {
    /** The doodad id. */
    id: string;
    /** The style it is drawn in. */
    style: string;
    /** Its display name, when the language files declare one. */
    label?: string;
    /** Its palette icon, as an absolute path. */
    icon: string;
}

/** The server facilities the command needs: the content host, plus the language files for the base names. */
export interface NewPlanetHost extends NewContentHost {
    /**
     * The display name a localization key resolves to, for the base picker.
     *
     * @param key the key path.
     * @param cancellationToken cancels the lookup.
     * @returns the text, or undefined when no language file declares the key.
     */
    localizedName?(key: string, cancellationToken: CancellationToken): Promise<string | undefined>;
}

/** What could be created in this mod. */
export interface NewPlanetScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    /** The author segment of the mod's id, which every doodad id opens with. Empty when the manifest declares none. */
    authorPrefix: string;
    /** The doodad ids the game and the workspace mods already use, folded. */
    takenIds: string[];
    /** The game's own planets, in the order the registry lists them. */
    bases: PlanetBase[];
    /** The placements the install's spawner file can take. */
    placements: PlanetPlacement[];
    failure?: NewPlanetFailure;
}

/** What creating the planet did. */
export interface NewPlanetApplyResult {
    kind: 'apply';
    /** The doodad id. */
    id: string;
    /** The file the doodad is declared in, empty when nothing was written. */
    file: string;
    /** The manifest the actions went into, empty when none did. */
    manifest: string;
    /** How each wiring went: the doodad registry and the career spawner list. */
    wiring: Record<'doodads' | 'spawner', WiringOutcome>;
    /** The manifest names to choose between, only set when a wiring is `ambiguousManifest`. */
    manifests?: string[];
    /** The localization keys the texts are declared under. */
    localizationKeys: string[];
    /** The language files the keys were written into, empty when the mod ships none. */
    localizationFiles: string[];
    createdFiles: string[];
    changedFiles: string[];
    failure?: NewPlanetFailure;
}

export type NewPlanetResult = NewPlanetScanResult | NewPlanetApplyResult;
