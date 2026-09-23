/**
 * The shapes the register-part command speaks in: what a client sends, the ships it may choose
 * between, and what each round answers with. Read by the server that answers the command and by
 * every client that asks, so both sides share the one declaration rather than each keeping a copy
 * that nothing checks against the other.
 */

/** What the client sends: the part, and on the second round the ship it picked. */
export interface RegisterPartArgs {
    /** The file the part group lives in. */
    uri: string;
    /** The byte offset of the part group's name in that file. */
    offset: number;
    /** The {@link ShipCandidate.key} of the chosen ship. Absent means "report the candidates". */
    ship?: string;
}

/** Why a ship cannot take the part, whatever else is true of it. */
export type ShipBlocker = 'partsInherited' | 'noPartsList' | 'notEditable' | 'noModRoot' | 'unreadable';

/** Why a registration did nothing. */
export type RegisterPartFailure =
    | 'stale'
    | 'noShipClasses'
    | 'unknownShip'
    | 'alreadyRegistered'
    | 'partsInherited'
    | 'noPartsList'
    | 'noModRoot'
    | 'ambiguousManifest'
    | 'notEditable'
    | 'editRejected';

/** Something worth saying that did not stop the registration. */
export type RegisterPartWarning = 'noPartId';

/** One ship class the part could be registered in, and what registering would take. */
export interface ShipCandidate {
    /** The identity the client sends back to pick this ship. */
    key: string;
    /** The ship group's name in its own file. */
    groupName: string;
    /** The ship's written `ID`, absent when it declares none. */
    id?: string;
    /** The ship file's on-disk path. */
    fsPath: string;
    /** Whether the ship belongs to the workspace or to the game's own install. */
    target: 'workspace' | 'vanilla';
    /** Whether registering writes into the ship's own file or into the mod's manifest. */
    via: 'shipFile' | 'modAction';
    /** True when the part is already in that ship's parts, so registering would duplicate it. */
    alreadyRegistered: boolean;
    /** Why this ship cannot take the part, absent when it can. */
    blocked?: ShipBlocker;
}

/** The ship classes the part could be registered in. */
export interface RegisterPartScan {
    kind: 'scan';
    /** The part's own id, read locally or through its bases, absent when it declares none anywhere. */
    partId?: string;
    /** The part group's name, which is what a registration reference names. */
    partGroupName: string;
    /** The candidates in registry order, mod-added ships last. */
    candidates: ShipCandidate[];
    /** Never set here, the field that tells a report from a refusal. */
    failure?: undefined;
}

/** What a registration did. */
export interface RegisterPartApply {
    kind: 'apply';
    /** The ship file the part was registered in, empty when nothing was written. */
    shipFsPath: string;
    /** Whether the registration went into the ship's own file or into the mod's manifest. */
    via: 'shipFile' | 'modAction';
    /** Every file the edit changed, so the client can save and tidy them. */
    changedFiles: string[];
    /** The reference that was written, sigil included, empty when nothing was written. */
    reference: string;
    /** Something worth saying that did not stop the registration. */
    warning?: RegisterPartWarning;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
    /** Never set here, the field that tells a report from a refusal. */
    failure?: undefined;
}

/** The ship classes the part could be registered in, or nothing but the reason there are none. */
export type RegisterPartScanResult = RegisterPartScan | { kind: 'scan'; failure: RegisterPartFailure };

/** What a registration did, or nothing but the reason it did nothing. */
export type RegisterPartApplyResult =
    | RegisterPartApply
    | {
          kind: 'apply';
          failure: RegisterPartFailure;
          /** The manifest names to choose between, only set for `ambiguousManifest`. */
          manifests?: string[];
      };
