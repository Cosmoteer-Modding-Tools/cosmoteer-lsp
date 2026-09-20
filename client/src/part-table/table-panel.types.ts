/**
 * The payload shapes the part table panel exchanges with the server and with its webview: the results of
 * the table, formula and edit requests, the edits the page asks for, and the messages it posts back.
 */

import { WorkspaceEdit as ProtocolWorkspaceEdit } from 'vscode-languageclient/node';

/**
 * The payload shape of the server's `cosmoteer/partTable` request, client-side mirror of
 * `server/src/features/part-table/part-table.types.ts`. Only the members the panel itself touches
 * are typed, the webview consumes the rest as it comes.
 */
export interface PartTableData {
    rows: Array<{ key: string }>;
    /** Absent when the page already holds the version the request named, the page keeps its own. */
    columns?: Array<{ path: string }>;
    columnsVersion: string;
    emptyReason?: 'noGamePath' | 'noParts';
}

/** The result shape of the server's `cosmoteer/partTableFormula` request. */
export interface PartTableFormulaResult {
    values: Record<string, number | null>;
    error?: string;
}

/** One typed-over value the page asks to have written into its file. */
export interface PartTableEdit {
    row: string;
    column: string;
    text: string;
}

/** The result shape of the server's `cosmoteer/partTableWorkbook` request. */
export interface PartTableWorkbookResult {
    /** The name the save dialog opens on. */
    fileName: string;
    /** The file's bytes, base64 encoded. */
    base64: string;
}

/** The result shape of the server's `cosmoteer/partTableEdit` request. */
export interface PartTableEditResult {
    status: 'ok' | 'refused' | 'notFound';
    edit?: ProtocolWorkspaceEdit;
    message?: string;
    note?: string;
}

/**
 * A message the webview posts back, as one case per kind rather than as one shape carrying every
 * field any kind might use.
 *
 * It was the latter: a single interface with twenty-one optional properties, which typed `saveView`
 * and `exportExcel` identically and left the handler to guard each field by hand. A union makes the
 * switch narrow, so a case can only read the fields its own kind actually carries, and a kind added
 * on the page without a case here stops compiling.
 */
export type PanelMessage =
    /** The page has loaded and is ready for its first payload. */
    | { type: 'ready' }
    /** A click on a cell, asking the editor to open where the value is written. */
    | { type: 'openLocation'; uri?: string; range?: unknown }
    /** The column set changed, or the reader asked for a rebuild. */
    | {
          type: 'columns' | 'refresh';
          columns?: string[];
          filter?: unknown;
          refresh?: boolean;
          columnsVersion?: string;
          quiet?: boolean;
          pendingFormula?: string;
      }
    /** The page wants the saved views listed. */
    | { type: 'listViews' }
    /** The page's own state, kept so reopening the table shows what was left behind. */
    | { type: 'saveState'; view?: unknown; activeView?: string }
    | { type: 'saveView'; name?: string; view?: unknown }
    | { type: 'deleteView'; name?: string }
    /** A what-if formula to evaluate against the rows the page is showing. */
    | {
          type: 'formula';
          id?: string;
          formula?: string;
          reference?: string;
          formulas?: Record<string, string>;
          rows?: string[];
          overrides?: unknown;
      }
    /** Edits the reader made in a cell, to write back into the files the values came from. */
    | { type: 'applyEdits'; edits?: PartTableEdit[] }
    /** What the page is showing, sent when it asks for the workbook. */
    | { type: 'exportExcel'; model?: unknown };
