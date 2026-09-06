/**
 * The payload shapes of the faction wizard: what the server reports after scanning saved ships and after
 * registering them, and what it reports after scanning for and creating a faction. Client-side mirror of
 * `server/src/features/ships/register-ship.types.ts` and of the new-faction command's results, typed only
 * as far as the wrapper reads them.
 */

export type ShipRole =
    | 'combat'
    | 'trade'
    | 'crew_transport'
    | 'defense'
    | 'trade_station'
    | 'military_station'
    | 'wreckage'
    | 'starter'
    | 'storage_pod';
export type ShipDifficulty = 1 | 2 | 3;

export interface ScannedShip {
    fsPath: string;
    name: string;
    insideMod: boolean;
    signals: {
        parts: number;
        weapons: number;
        thrusters: number;
        storage: number;
        crew: number;
        unknownParts: string[];
        unpricedParts: string[];
    };
    value: { parts: number; doors: number; crew: number; total: number; doorsUnpriced: boolean };
    valueTier: number;
    tierByRole: Record<ShipRole, number>;
    difficulty: ShipDifficulty;
    strength: { weaponShare: number; typicalWeaponShare: number; armorShare: number; typicalArmorShare: number; score: number };
    roles: ShipRole[];
    blocked?: 'unreadable' | 'idTaken';
}

export interface FactionChoice {
    id: string;
    name?: string;
    source: 'game' | 'mod';
    own: boolean;
}

export interface RegisterShipScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    factions: FactionChoice[];
    ships: ScannedShip[];
    balanceFallback: boolean;
    partsTruncated: boolean;
    failure?: string;
}

export interface ShipChoice {
    fsPath: string;
    role: ShipRole;
    tier: number;
    difficulty: ShipDifficulty;
}

export interface RegisteredShip {
    fsPath: string;
    name: string;
    role: ShipRole;
    tier: number;
    shipFile: string;
    registeredIn: string;
    tradeRouteIn?: string;
    stasisIcon?: string;
    starterDescriptionKey?: string;
    failure?: string;
}

export interface RegisterShipApplyResult {
    kind: 'apply';
    faction: string;
    ships: RegisteredShip[];
    manifest: string;
    manifestFailure?: string;
    manifests?: string[];
    createdFiles: string[];
    changedFiles: string[];
    failure?: string;
}

export interface NewFactionScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    takenIds: string[];
    suggestedPlayerIndex: number;
    failure?: string;
}

export interface NewFactionApplyResult {
    kind: 'apply';
    id: string;
    factionFile: string;
    galaxyFile: string;
    beaconFile: string;
    manifest: string;
    wiring: Record<string, string>;
    iconFile?: string;
    beaconShipFile?: string;
    loreFile?: string;
    loreKeys: string[];
    manifests?: string[];
    nameKey: string;
    localizationFiles: string[];
    placeholderAssets: string[];
    militaryPlayerIndex: number;
    civilianPlayerIndex: number;
    createdFiles: string[];
    changedFiles: string[];
    failure?: string;
}
