/**
 * The shapes the create-component command speaks in: what a client sends, the component kinds it may
 * choose between, the text the command answers with, and the facilities it is given. Kept apart from
 * the command so the code action and a test can name them without pulling the schema lookups in.
 */

import { Range, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

/** What the client sends: the reference that names nothing, and on the second round the kind it picked. */
export interface CreateComponentArgs {
    /** The file the reference is written in. */
    uri: string;
    /** The byte offset of the reference value in that file. */
    offset: number;
    /** The name the reference writes, which the declaration is keyed by. */
    name: string;
    /** The `Type` discriminator of the chosen kind. Absent means "report the kinds". */
    type?: string;
    /**
     * Whether the server writes the declaration itself, in the plain form. A client that can place a
     * tab stop leaves this off and writes the snippet the answer carries.
     */
    apply?: boolean;
}

/** Why nothing can be declared. */
export type CreateComponentFailure =
    /** The file cannot be read, or the offset no longer names anything. */
    | 'stale'
    /** The file declares no part or bullet whose components this would join. */
    | 'noOwner'
    /** The file belongs to the game's own install rather than to a mod. */
    | 'notEditable'
    /** The chosen kind is not one this owner declares components of. */
    | 'unknownType'
    /** A component of that name is already written in this file. */
    | 'alreadyDeclared';

/** One component kind the author may pick. */
export interface ComponentTypeChoice {
    /** The `Type` discriminator, which is what the declaration writes. */
    type: string;
    /** The class the discriminator selects, shown beside it. */
    detail: string;
}

/** The text to write and the span it replaces, which the client turns into an edit or a snippet. */
export interface CreateComponentInsert {
    /** The file to write into. */
    uri: string;
    /** The span the text replaces, empty for a pure insertion. */
    range: Range;
    /** The declaration, with a tab stop on every value the author has to fill in. */
    snippet: string;
    /** The same declaration with its tab stops resolved, for a client that cannot place one. */
    text: string;
}

/** What the command answers with, on either round. */
export type CreateComponentResult =
    | { choices: ComponentTypeChoice[] }
    | { insert: CreateComponentInsert; applied?: boolean }
    | { failure: CreateComponentFailure };

/** The facilities the command reads the editor's buffers through. */
export interface CreateComponentHost {
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** Hands the client the edit, for a client that asked the server to write the declaration. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
}
