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

/** The result shape of the server's `cosmoteer/partTableEdit` request. */
export interface PartTableEditResult {
    status: 'ok' | 'refused' | 'notFound';
    edit?: ProtocolWorkspaceEdit;
    message?: string;
    note?: string;
}

/** A message the webview posts back. */
export interface PanelMessage {
    type: string;
    uri?: string;
    range?: unknown;
    columns?: string[];
    filter?: unknown;
    refresh?: boolean;
    columnsVersion?: string;
    quiet?: boolean;
    pendingFormula?: string;
    name?: string;
    view?: unknown;
    activeView?: string;
    id?: string;
    formula?: string;
    reference?: string;
    formulas?: Record<string, string>;
    rows?: string[];
    overrides?: unknown;
    edits?: PartTableEdit[];
    text?: string;
}
