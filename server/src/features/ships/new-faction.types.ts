/**
 * The shapes the new-faction command speaks in. Both clients ask the same two questions of the
 * server, which ids and player indexes a faction could take here and what creating one did, so the
 * shapes live apart from the command that answers them.
 */

import { NewContentHost } from '../refactor/new-content/new-content.command';
import { WiringOutcome } from './mod-wiring';
import { ShipLayerContext } from './ship-layer.index';

/** Why the command created nothing. */
export type NewFactionFailure = 'noModRoot' | 'notEditable' | 'noGameRoot' | 'invalidId' | 'idTaken' | 'pathTaken' | 'writeFailed';

/** What the client sends. Without an `id` the command reports what could be created here. */
export interface NewFactionArgs {
    /** A file or folder of the mod the faction is created in. */
    uri: string;
    /** The faction's id, as ships and sectors name it. Absent on the scan round. */
    id?: string;
    /** The faction's display name, declared under `Factions/<Id>` in every language file. */
    name?: string;
    /** The border colour the map draws the faction's territory in, as `[r, g, b]`. */
    color?: [number, number, number];
    /** A PNG to copy in as the faction's icon. Absent, the game's own stands in. */
    icon?: string;
    /** A saved ship to copy in as the FTL beacon. Absent, the game's own stands in. */
    beaconShip?: string;
    /** Whether to write a lore page for the codex, with its texts as keys to fill. */
    lore?: boolean;
}

/** What could be created in this mod. */
export interface NewFactionScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    /** The faction ids the game and the workspace mods already use, folded. */
    takenIds: string[];
    /** The player indexes the known factions use. */
    takenPlayerIndexes: number[];
    /** The military index a new faction would get, the civilian one being the next number. */
    suggestedPlayerIndex: number;
    failure?: NewFactionFailure;
}

export type { WiringOutcome } from './mod-wiring';

/** What creating the faction did. */
export interface NewFactionApplyResult {
    kind: 'apply';
    id: string;
    /** The file the faction is declared in, empty when nothing was written. */
    factionFile: string;
    /** The file the territory, tiers and beacon type are declared in. */
    galaxyFile: string;
    /** The file the FTL beacon doodad is declared in. */
    beaconFile: string;
    /** The manifest the actions went into, empty when none did. */
    manifest: string;
    /** How each wiring went: the registry, the territory, the tiers, the beacon doodad, the beacon spawner, the lore page. */
    wiring: Record<'registry' | 'territory' | 'tiers' | 'beacon' | 'beaconSpawner' | 'lore', WiringOutcome>;
    /** The icon file written into the faction's folder, absent when the game's own stands in. */
    iconFile?: string;
    /** The beacon ship written into the faction's folder, absent when the game's own stands in. */
    beaconShipFile?: string;
    /** The lore page written, absent when none was asked for. */
    loreFile?: string;
    /** The localization keys the lore page reads its texts from, for the author to fill. */
    loreKeys: string[];
    /** The manifest names to choose between, only set when a wiring is `ambiguousManifest`. */
    manifests?: string[];
    /** The localization key the name is declared under. */
    nameKey: string;
    /** The language files the key was written into, empty when the mod ships none. */
    localizationFiles: string[];
    /** The game files the faction points at for now, for the author to replace. */
    placeholderAssets: string[];
    /** The player indexes the faction got. */
    militaryPlayerIndex: number;
    civilianPlayerIndex: number;
    createdFiles: string[];
    changedFiles: string[];
    failure?: NewFactionFailure;
}

export type NewFactionResult = NewFactionScanResult | NewFactionApplyResult;

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface NewFactionHost extends NewContentHost {
    /** The game root and the workspace folders, which the faction registry is read from. */
    layerContext(): Promise<ShipLayerContext>;
}
