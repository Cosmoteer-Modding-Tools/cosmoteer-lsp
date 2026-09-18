/**
 * The facilities the create-component command is given, kept apart from the command so a test can
 * stand in for them without pulling the schema lookups in. The shapes the command speaks to a client
 * in are shared with the clients, in shared/create-component.types.ts.
 */

import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

/** The facilities the command reads the editor's buffers through. */
export interface CreateComponentHost {
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** Hands the client the edit, for a client that asked the server to write the declaration. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
}
