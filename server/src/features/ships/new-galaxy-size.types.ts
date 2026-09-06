/**
 * The shapes the new-galaxy-size command speaks in. Both clients ask the same two questions of the
 * server, which size names are free here and what creating one did, so the shapes live apart from
 * the command that answers them.
 */

import { WiringOutcome } from './mod-wiring';

/** Why the command created nothing. */
export type NewGalaxySizeFailure = 'noModRoot' | 'notEditable' | 'noGameRoot' | 'invalidId' | 'idTaken' | 'pathTaken' | 'writeFailed';

/** What the client sends. Without an `id` the command reports what could be created here. */
export interface NewGalaxySizeArgs {
    /** A file or folder of the mod the size is created in. */
    uri: string;
    /** The size's id, which names its folder and its localization keys. Absent on the scan round. */
    id?: string;
    /** The size's display name, declared under `MapSizes/<Id>` in every language file. */
    name?: string;
    /** How many solar systems the galaxy gets, a whole number of 1 to 2000. */
    systems?: number;
}

/** What could be created in this mod. */
export interface NewGalaxySizeScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    /** The size names the game and this mod already use, folded. */
    takenIds: string[];
    /** How many systems the game's standard galaxy has, for the client to offer a figure against. */
    standardSystems: number;
    failure?: NewGalaxySizeFailure;
}

/** What creating the size did. */
export interface NewGalaxySizeApplyResult {
    kind: 'apply';
    id: string;
    /** The file the generator and the size are declared in, empty when nothing was written. */
    file: string;
    /** The manifest the actions went into, empty when none did. */
    manifest: string;
    /** How each wiring went: the career mode's list, the creative mode's list. */
    wiring: Record<'career' | 'creative', WiringOutcome>;
    /** The manifest names to choose between, only set when a wiring is `ambiguousManifest`. */
    manifests?: string[];
    /** The localization keys the name and the tip are declared under. */
    localizationKeys: string[];
    /** The language files the keys were written into, empty when the mod ships none. */
    localizationFiles: string[];
    createdFiles: string[];
    changedFiles: string[];
    failure?: NewGalaxySizeFailure;
}

export type NewGalaxySizeResult = NewGalaxySizeScanResult | NewGalaxySizeApplyResult;
