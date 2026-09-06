/**
 * The shapes the new-nebula command speaks in. Both clients ask the same two questions of the
 * server, what a nebula could be built on here and what creating one did, so the shapes live apart
 * from the command that answers them.
 */

import { WiringOutcome } from './mod-wiring';

/** A colour as red, green and blue, each a whole channel of 0 to 255. */
export type NebulaColor = [number, number, number];

/** The three colours a nebula look is made of. */
export type NebulaColors = [NebulaColor, NebulaColor, NebulaColor];

/** Why the command created nothing. */
export type NewNebulaFailure = 'noModRoot' | 'notEditable' | 'noGameRoot' | 'invalidId' | 'idTaken' | 'pathTaken' | 'writeFailed';

/** What the client sends. Without an `id` the command reports what could be created here. */
export interface NewNebulaArgs {
    /** A file or folder of the mod the nebula is created in. */
    uri: string;
    /** The nebula's id, as spawners and doodads name it. Absent on the scan round. */
    id?: string;
    /** The nebula's display name, opening the tooltip declared under `Nebulas/<Id>`. */
    name?: string;
    /** The id of the game's own nebula the new one is built on. Absent or unknown, the first offered stands in. */
    base?: string;
    /** The three colours of the look, as `[r, g, b]` each. Absent or malformed, the base's own stand in. */
    colors?: NebulaColors;
    /** How far the nebula reaches, in world units. */
    radius?: number;
    /** How many are placed per system, as `[min, max]`. */
    count?: [number, number];
    /** How far from the system's centre they are placed, as `[min, max]`. */
    distance?: [number, number];
    /** The chance a system gets any, as a whole percentage. */
    spawnChance?: number;
    /** Whether the starting system is kept clear of it, which the game's own storms are. */
    avoidStartingSector?: boolean;
}

/** One of the game's own nebulas a new one can be built on. */
export interface NebulaBase {
    id: string;
    /** The colours its low-detail material declares. */
    colors: NebulaColors;
}

/** What could be created in this mod. */
export interface NewNebulaScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    /** The nebula ids the game and the workspace mods already use, folded. */
    takenIds: string[];
    /** The game's own nebulas, in the order the registry lists them. */
    bases: NebulaBase[];
    failure?: NewNebulaFailure;
}

/** What creating the nebula did. */
export interface NewNebulaApplyResult {
    kind: 'apply';
    id: string;
    /** The file the nebula type is declared in, empty when nothing was written. */
    nebulaFile: string;
    /** The file the career spawner entry is declared in. */
    spawnerFile: string;
    /** The file the creative palette doodad is declared in. */
    doodadFile: string;
    /** The manifest the actions went into, empty when none did. */
    manifest: string;
    /** How each wiring went: the registry, the career spawner, the palette doodad. */
    wiring: Record<'registry' | 'spawner' | 'doodad', WiringOutcome>;
    /** The manifest names to choose between, only set when a wiring is `ambiguousManifest`. */
    manifests?: string[];
    /** The localization keys the texts are declared under. */
    localizationKeys: string[];
    /** The language files the keys were written into, empty when the mod ships none. */
    localizationFiles: string[];
    createdFiles: string[];
    changedFiles: string[];
    failure?: NewNebulaFailure;
}

export type NewNebulaResult = NewNebulaScanResult | NewNebulaApplyResult;
