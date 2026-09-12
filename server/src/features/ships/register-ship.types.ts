import { ShipDifficulty, ShipRole, ShipSignals, ShipStrength, ShipValue } from './ship-assessment.types';

/**
 * The shapes the register-ship command speaks in. Both clients ask the same two questions of the
 * server, what these blueprints are and what registering them did, so the shapes live apart from the
 * command that answers them.
 */

/** Why the command could not answer at all. */
export type RegisterShipFailure = 'noModRoot' | 'notEditable' | 'noGameRoot' | 'noBlueprints' | 'unknownFaction';

/** Why one blueprint could not be registered, which never stops the others. */
export type ShipRegistrationFailure =
    'unreadable' | 'alreadyRegistered' | 'idTaken' | 'copyFailed' | 'writeFailed' | 'editRejected' | 'unknownRole';

/** Why the manifest could not be written, which leaves the ship files in place but unwired. */
export type ManifestFailure = 'ambiguousManifest' | 'manifestUnusable' | 'noGameRoot' | 'editRejected';

/** What the client sends. Without `ships` the command reports what the blueprints are. */
export interface RegisterShipArgs {
    /** A file or folder of the mod the ships are registered in, usually the active editor's document. */
    uri: string;
    /** The blueprints to read: `.ship.png` files, or folders whose `.ship.png` files are read. */
    blueprints: string[];
    /** The faction the ships join, for the apply round. */
    faction?: string;
    /** What to register each blueprint as, for the apply round. A blueprint left out is skipped. */
    ships?: ShipChoice[];
}

/** What the client decided for one blueprint. */
export interface ShipChoice {
    /** The blueprint's on-disk path, as the scan reported it. */
    fsPath: string;
    role: ShipRole;
    tier: number;
    difficulty: ShipDifficulty;
}

/** One faction the ships could join. */
export interface FactionChoice {
    id: string;
    /** The faction's display name, when a language file of the project declares it. */
    name?: string;
    /** Whether the game's own files declare it or a workspace mod adds it. */
    source: 'game' | 'mod';
    /** True when the faction belongs to the mod being written to, so its ships sit with its files. */
    own: boolean;
}

/** One blueprint, judged. */
export interface ScannedShip {
    fsPath: string;
    name: string;
    /** Whether the blueprint already sits inside the mod, so it is referenced in place rather than copied. */
    insideMod: boolean;
    signals: ShipSignals;
    value: ShipValue;
    /** The tier the game rates the ship's value at. */
    valueTier: number;
    /** The tier each role would be registered at, keyed by role. */
    tierByRole: Record<ShipRole, number>;
    difficulty: ShipDifficulty;
    strength: ShipStrength;
    /** The roles that fit the ship, the best fit first. */
    roles: ShipRole[];
    /**
     * Why the ship cannot be registered, absent when it can: the file carries no ship, or a built-in
     * ship already has its name, which the game refuses as a duplicate.
     */
    blocked?: 'unreadable' | 'idTaken';
}

/** What the blueprints are and where they could go. */
export interface RegisterShipScanResult {
    kind: 'scan';
    /** The mod the ships would be registered in, empty when there is none. */
    modRoot: string;
    /** The mod's manifest id, empty when it declares none. */
    modId: string;
    /** The factions the ships could join, the mod's own first. */
    factions: FactionChoice[];
    ships: ScannedShip[];
    /** True when the figures are the shipped vanilla ones because the game path is unset. */
    balanceFallback: boolean;
    /** True when the part walk stopped at its cap, so an unknown part may be a missing one. */
    partsTruncated: boolean;
    /** Why nothing could be reported, absent on success. */
    failure?: RegisterShipFailure;
}

/** What registering one blueprint did. */
export interface RegisteredShip {
    fsPath: string;
    name: string;
    role: ShipRole;
    tier: number;
    /** The file the ship now sits at, the same as `fsPath` when it was referenced in place. */
    shipFile: string;
    /** The role file the entry was written into, empty when none was. */
    registeredIn: string;
    /** The trade-route file the entry was written into, only for a civilian ship. */
    tradeRouteIn?: string;
    /** The stasis icon drawn beside a station, the picture the map shows while it is out of sight. */
    stasisIcon?: string;
    /** The localization key a starter ship's description is read under, declared with a placeholder. */
    starterDescriptionKey?: string;
    /** Why the ship was not registered, absent on success. */
    failure?: ShipRegistrationFailure;
}

/** What the apply round did. */
export interface RegisterShipApplyResult {
    kind: 'apply';
    faction: string;
    ships: RegisteredShip[];
    /** The manifest the actions were written into, empty when none was. */
    manifest: string;
    /** Why the manifest was not written, absent when it was or when it already carried the actions. */
    manifestFailure?: ManifestFailure;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
    /** Every file the command created. */
    createdFiles: string[];
    /** The language files a starter ship's description key was declared in. */
    localizationFiles?: string[];
    /** Every file the command changed, created ones included. */
    changedFiles: string[];
    /** Why nothing was registered, absent on success. */
    failure?: RegisterShipFailure;
}

/** Either round's answer. */
export type RegisterShipResult = RegisterShipScanResult | RegisterShipApplyResult;
