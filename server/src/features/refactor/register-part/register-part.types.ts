/**
 * The shapes the register-part command speaks in: what a client sends, the ships it may choose
 * between, what each round answers with, and the facilities the command is given. Kept apart from the
 * command so the new-content and ship commands, which reuse its host and its failures, do not pull its
 * file writing in with them.
 */

import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { FileWithPath } from '../../../workspace/cosmoteer-workspace.service';

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
export interface RegisterPartScanResult {
    kind: 'scan';
    /** The part's own id, read locally or through its bases, absent when it declares none anywhere. */
    partId?: string;
    /** The part group's name, which is what a registration reference names. */
    partGroupName: string;
    /** The candidates in registry order, mod-added ships last. */
    candidates: ShipCandidate[];
    /** Why the candidates could not be worked out, absent on success. */
    failure?: RegisterPartFailure;
}

/** What a registration did, or why it did nothing. */
export interface RegisterPartApplyResult {
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
    /** Why nothing was written, absent on success. */
    failure?: RegisterPartFailure;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
}

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface RegisterPartHost {
    /** The workspace folders whose mods may declare ships, as on-disk paths. */
    folderPaths(): Promise<string[]>;
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** The game's own root `cosmoteer.rules`, which holds the ship registry. */
    gameRoot(): Promise<FileWithPath | undefined>;
    /** The game's `Data` directory, which decides whether a ship is the install's or the mod's. */
    dataRoot(): string | undefined;
    /** Hands the client the edit. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Announces the files the command wrote, so the indexes pick them up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}
