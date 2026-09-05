/**
 * The payload shapes the part grid editor panel exchanges with the server and with its webview: the
 * results of the grid and edit requests, and the mutation message the page posts.
 */

import { WorkspaceEdit as LspWorkspaceEdit } from 'vscode-languageclient';

/**
 * The payload shape returned by the server's `cosmoteer/partGridData` request (client-side mirror
 * of `server/src/features/part-editor/part-grid.types.ts`, only the members the panel touches are
 * typed, the webview consumes the rest as-is).
 */
export interface PartGridData {
    partName: string;
    dataVersion: number;
    anchor: { line: number; character: number };
    sprites: Array<{ id: string; uri: string | null }>;
    /** The other files the payload was read from, watched for changes alongside the part's own. */
    dependsOn?: string[];
}

/** The result shape of the server's `cosmoteer/partGridEdit` request. */
export interface PartGridEditResult {
    status: 'ok' | 'stale' | 'notFound' | 'error';
    message?: string;
    edit?: LspWorkspaceEdit;
    /** Where a write that followed a reference landed, for the page's status line. */
    note?: string;
}

/** A mutation message posted by the webview (forwarded to the server verbatim). */
export interface EditMessage {
    type: 'edit';
    mutation: unknown;
    dataVersion: number;
}
