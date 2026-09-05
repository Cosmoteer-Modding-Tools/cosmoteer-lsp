/**
 * The shapes the new-tech command speaks in. Both clients ask the same two questions of the server,
 * which parts and techs a new tech could be made of here and what creating one did, so the shapes
 * live apart from the command that answers them.
 */

import { CancellationToken } from 'vscode-languageserver';
import { NewContentHost } from '../refactor/new-content/new-content.command';
import { WiringOutcome } from './mod-wiring';

/** Which group field a part declares, which the tech mirrors. */
export type PartGroupField = 'EditorGroup' | 'EditorGroups' | 'none';

/** Why the command created nothing. */
export type NewTechFailure =
    | 'noModRoot'
    | 'notEditable'
    | 'noGameRoot'
    | 'noParts'
    | 'unknownPart'
    | 'invalidId'
    | 'idTaken'
    | 'pathTaken'
    | 'writeFailed';

/** What the client sends. Without a `part` the command reports what a tech could be made of. */
export interface NewTechArgs {
    /** A file or folder of the mod the tech is created in. */
    uri: string;
    /** The id of the part the tech unlocks, one of the scan's `parts`. Absent on the scan round. */
    part?: string;
    /** What the tech costs at a station, a whole number above zero. */
    cost?: number;
    /** The techs that have to be bought first, by id. */
    prerequisites?: string[];
    /** The tech's id, defaulting to the part's, which is the game's own convention. */
    id?: string;
}

/** One part of the mod a tech could unlock. */
export interface NewTechPart {
    id: string;
    /** The part's display name, absent when its key could not be read. */
    name?: string;
    fsPath: string;
    /** Which group field the part declares, which decides what the tech writes. */
    groupField: PartGroupField;
}

/** One tech a new one could build on. */
export interface NewTechEntry {
    id: string;
    /** The tech's display name, absent when its key could not be read. */
    name?: string;
}

/** What could be created in this mod. */
export interface NewTechScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    /** The parts the mod's own files declare, in file order. */
    parts: NewTechPart[];
    /** The game's techs and the mod's own, for the prerequisite picker. */
    techs: NewTechEntry[];
    /** Every tech id in use, folded. */
    takenIds: string[];
    failure?: NewTechFailure;
}

/** What creating the tech did. */
export interface NewTechApplyResult {
    kind: 'apply';
    id: string;
    /** The file the tech is declared in, empty when nothing was written. */
    file: string;
    /** The manifest the action went into, empty when none did. */
    manifest: string;
    /** How the wiring went: the game's tech list. */
    wiring: Record<'techs', WiringOutcome>;
    /** The manifest names to choose between, only set when the wiring is `ambiguousManifest`. */
    manifests?: string[];
    createdFiles: string[];
    changedFiles: string[];
    failure?: NewTechFailure;
}

export type NewTechResult = NewTechScanResult | NewTechApplyResult;

/** The server-side facilities the command needs: the new-content host plus the language files. */
export interface NewTechHost extends NewContentHost {
    /**
     * The text a localization key resolves to, for the names the pickers show.
     *
     * @param key the key path as a file writes it.
     * @param cancellationToken cancels the lookup.
     * @returns the text, or undefined when no language file declares the key.
     */
    localizedName?(key: string, cancellationToken: CancellationToken): Promise<string | undefined>;
}
