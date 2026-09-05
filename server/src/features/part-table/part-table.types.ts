/**
 * The payload shapes of the part table: the rows the server reads out of the project, the columns
 * it discovered while reading them, and the formula requests the view sends back. The webview draws
 * whatever it is given and computes nothing about the game, so every judgement about what a value is
 * and where it came from is made here.
 */

import { WorkspaceEdit } from 'vscode-languageserver';

/** The unit an evaluated number carries, mirroring what the value-unit module decides. */
export type PartTableUnit = 'angle' | 'percent' | 'seconds' | 'credits';

/** One read value of one part, with the place the winning declaration is written. */
export interface PartTableCell {
    /** The value as one line of text, already rendered with its unit where one is known. */
    readonly text: string;
    /** The number the game computes, null when the value is not numeric. */
    readonly value: number | null;
    /** The unit the number carries, absent when neither the schema nor the spelling decides one. */
    readonly unit?: PartTableUnit;
    /** The file the winning declaration is written in. */
    readonly uri: string;
    /** The line of that declaration. */
    readonly line: number;
    /** The column of that declaration. */
    readonly character: number;
    /** True when the value came from a base rather than from the part's own group. */
    readonly inherited: boolean;
}

/** One part of the table. */
export interface PartTableRow {
    /** The row's identity, stable across a rebuild, used by the view to address a row. */
    readonly key: string;
    /** The part's declared `ID`, falling back to the group name when it declares none. */
    readonly id: string;
    /** The group's name inside its file. */
    readonly name: string;
    /** The file's base name, for a column the reader can scan. */
    readonly file: string;
    /** The part group's own file. */
    readonly uri: string;
    /** The line the part group starts on. */
    readonly line: number;
    /** The column the part group starts at. */
    readonly character: number;
    /** Where the part comes from: the game's own data, or a mod under the workspace. */
    readonly origin: 'game' | 'mod';
    /** The mod folder's name, or the game's name for a part the game ships. */
    readonly source: string;
    /** The part's `TypeCategories`, one filter axis of the view. */
    readonly categories: readonly string[];
    /** The `Type` of every component the part carries, the other filter axis. */
    readonly components: readonly string[];
    /** The build menu group the part sits in, `WeaponsEnergy` or `Defenses`, empty when it names none. */
    readonly editorGroup: string;
    /** Every build menu group the part sits in, for a part the menu lists under several. */
    readonly editorGroups: readonly string[];
    /** The ship classes whose `Parts` list registers the part, `Terran`, empty for one no ship reaches. */
    readonly ships: readonly string[];
    /** The read values, keyed by column path. */
    readonly cells: Readonly<Record<string, PartTableCell>>;
}

/**
 * One column the walk discovered, offered to the column picker. The header the view shows and the
 * group the picker sorts by are both read off the path there, since tens of thousands of columns
 * cross the wire and every field of them is paid for on each.
 */
export interface PartTableColumn {
    /** The member path from the part group, `Components/ArcShield/Radius/BaseValue`. */
    readonly path: string;
    /** How many rows carry a value, which the picker shows beside the column. */
    readonly rows: number;
    /**
     * True for a column the table works out rather than reads, such as the cost in credits. Its path
     * starts with `@`, and a formula names it the way it names any other column.
     */
    readonly derived?: true;
    /** What a derived column is, for the picker and the header. */
    readonly description?: string;
}

/** Which parts the table is narrowed to. An axis with no values narrows nothing. */
export interface PartTableFilter {
    /** The `TypeCategories` tags a part has to carry one of. */
    readonly categories?: readonly string[];
    /** The component types a part has to carry one of. */
    readonly components?: readonly string[];
    /** The mods a part may come from. */
    readonly sources?: readonly string[];
    /** The build menu groups a part has to sit in one of. */
    readonly editorGroups?: readonly string[];
}

/** The whole table, as one request answers it. */
export interface PartTableData {
    /** The rows the filter leaves. */
    readonly rows: readonly PartTableRow[];
    /**
     * The columns those rows carry, which is what the picker offers. Absent when the request named
     * the version the view already holds and that version is still current, so a rebuild for other
     * columns or after an edit does not carry the whole picker again.
     */
    readonly columns?: readonly PartTableColumn[];
    /** Names the column set, so the view can say it already holds it. */
    readonly columnsVersion: string;
    /** How many parts the scope holds before the filter, so the view can say what it is showing. */
    readonly total: number;
    /** Every `TypeCategories` tag any part of the scope carries, sorted, for the filter bar. */
    readonly categories: readonly string[];
    /** Every component type any part of the scope carries, sorted, for the filter bar. */
    readonly componentTypes: readonly string[];
    /** Every mod name any part of the scope comes from, sorted, for the filter bar. */
    readonly sources: readonly string[];
    /** Every build menu group any part of the scope sits in, sorted, for grouping the rows. */
    readonly editorGroups: readonly string[];
    /** Every ship class any part of the scope is registered by, sorted. */
    readonly ships: readonly string[];
    /** The name of the mod the table reads beside the game, empty when it reads the game alone. */
    readonly mod: string;
    /** The columns the view opens with, chosen by coverage when the reader has picked none yet. */
    readonly suggested: readonly string[];
    /** True when a cap stopped the walk, so the view can say the table is not the whole project. */
    readonly truncated: boolean;
    /** Why the table is empty, when it is, so the view can say something better than "no parts". */
    readonly emptyReason?: 'noGamePath' | 'noParts';
}

/** What the view asks the table for. */
export interface PartTableParams {
    /** The document the command was invoked from, which decides the mod the table is scoped to. */
    readonly textDocument?: { readonly uri: string };
    /** The column paths to compute, absent on the first build so the ranking chooses them. */
    readonly columns?: readonly string[];
    /** Which parts to narrow to, absent for all of them. */
    readonly filter?: PartTableFilter;
    /** Read the parts from disk again rather than answering from the walk of the last build. */
    readonly refresh?: boolean;
    /** The columns version the view holds, so the answer can leave the columns out while it stands. */
    readonly columnsVersion?: string;
}

/** How far a walk has come, sent while the first build of a large mod reads its parts. */
export interface PartTableProgress {
    /** How many parts have been read. */
    readonly done: number;
    /** How many parts the walk reads in all. */
    readonly total: number;
}

/**
 * A value the reader typed over a cell without writing it to the file yet, keyed by row key and
 * then by column path. The number is what the formulas compute with, null for a value that does
 * not read as a number.
 */
export type PartTableOverrides = Readonly<Record<string, Readonly<Record<string, number | null>>>>;

/** What the view asks a formula column for. */
export interface PartTableFormulaParams {
    /** The expression, written over column paths in square brackets. */
    readonly formula: string;
    /** The row the `ref(…)` function reads, by row key, absent when the view compares nothing. */
    readonly reference?: string;
    /**
     * The other formula columns of the view, by the name the reader gave them, so a formula can
     * name one of them the way it names a column.
     */
    readonly formulas?: Readonly<Record<string, string>>;
    /**
     * The rows on screen, by key, which is what the column aggregates run over. Absent for every
     * row of the last build.
     */
    readonly rows?: readonly string[];
    /** The values the reader typed over cells, which the formula computes with instead of the file's. */
    readonly overrides?: PartTableOverrides;
}

/** One formula column, computed over the table the last build produced. */
export interface PartTableFormulaResult {
    /** The computed number per row key, null where the formula could not produce one. */
    readonly values: Readonly<Record<string, number | null>>;
    /** The message to show instead of the column when the formula does not parse. */
    readonly error?: string;
}

/** What the view asks when a typed-over value is to be written into the file. */
export interface PartTableEditParams {
    /** The row the cell belongs to, by row key. */
    readonly row: string;
    /** The column path of the cell. */
    readonly column: string;
    /** The value as the reader wrote it, a number with or without one of the game's suffixes. */
    readonly text: string;
}

/** The answer to a cell edit: the edit to apply, or why none can be. */
export interface PartTableEditResult {
    /**
     * `ok` carries an edit. `refused` names a value that cannot be written from the table, such as
     * one of the game's own. `notFound` means the table has to be built again first.
     */
    readonly status: 'ok' | 'refused' | 'notFound';
    /** The edit to apply, present when the status is `ok`. */
    readonly edit?: WorkspaceEdit;
    /** What to tell the reader, present when the status is not `ok`. */
    readonly message?: string;
    /** What happened to the value, for a note: it was written over, or added to the part as an override. */
    readonly note?: string;
}

/**
 * The figures a whole ship is judged by, per part. A saved ship names its parts by id and nothing
 * else, so what a ship costs, how hard it hits and how many crew it houses are all sums over these.
 */
export interface PartStats {
    /** The part's own id, as written. */
    readonly id: string;
    /** The other ids the part answers to, which an older blueprint may still name it by. */
    readonly otherIds: readonly string[];
    /** The part's type categories, as written. */
    readonly categories: readonly string[];
    /** The part's price in credits, null when a resource it takes has no known price. */
    readonly cost: number | null;
    /** The part's damage per second, null when it fires nothing. */
    readonly dps: number | null;
    /** The part's health, null when it declares none. */
    readonly maxHealth: number | null;
    /** How many crew the part houses, summed over its crew-source components. */
    readonly crewCapacity: number;
    /** How many cells the part covers, null when its size is unreadable. */
    readonly tiles: number | null;
    /** The part's footprint in cells, width then height, null when its size is unreadable. */
    readonly size: readonly [number, number] | null;
    /** The file the part is written in. */
    readonly fsPath: string;
}

/** Every part of a scope, keyed by every id it answers to, folded to lower case. */
export interface PartStatsIndex {
    readonly byId: ReadonlyMap<string, PartStats>;
    /** True when the walk stopped at its cap, so a part may be missing rather than unknown. */
    readonly truncated: boolean;
}

/** What the edit builder needs from the request layer: the editor's buffers and the game's root. */
export interface PartTableEditHooks {
    /** The editor's own text for a uri, so an unsaved file is written from what the reader sees. */
    readonly openText: (uri: string) => string | undefined;
    /** The game's data root, which no edit may land in. */
    readonly dataRootPath: string | undefined;
}
