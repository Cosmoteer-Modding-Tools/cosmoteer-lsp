import { CodeAction, CodeActionKind, Diagnostic, Range, TextEdit } from 'vscode-languageserver';
import { hasSnippetCodeActionCapability } from '../../lsp/capabilities';

/**
 * The client's own command for writing a snippet into the editor. The server deliberately leaves it
 * out of its `executeCommandProvider`: a tab stop only exists inside an editor, and a `WorkspaceEdit`
 * has no way to carry one, so the client is the only place this can run.
 */
export const INSERT_SNIPPET_ACTION_COMMAND = 'cosmoteer.insertSnippetFromAction';

/** The arguments {@link INSERT_SNIPPET_ACTION_COMMAND} takes, as one object. */
export interface InsertSnippetArgs {
    /** The file the snippet is written into. */
    uri: string;
    /** The span the snippet replaces, empty for a pure insertion. */
    range: Range;
    /** The snippet body, in the tab-stop syntax both clients read. */
    snippet: string;
}

/**
 * The plain text a snippet body stands for, so a client that cannot place a tab stop still gets the
 * edit. A choice writes its first option, a placeholder writes its default, a bare stop writes
 * nothing, and an escaped `$` or `}` becomes the character it stands for.
 *
 * @param snippet the snippet body.
 * @returns the same text with every tab stop resolved to what it would start out as.
 */
export const plainTextOf = (snippet: string): string => {
    let text = '';
    for (let index = 0; index < snippet.length; index++) {
        const character = snippet[index];
        if (character === '\\' && index + 1 < snippet.length) {
            text += snippet[++index];
            continue;
        }
        if (character !== '$') {
            text += character;
            continue;
        }
        const bare = /^\$(\d+)/.exec(snippet.slice(index));
        if (bare) {
            index += bare[0].length - 1;
            continue;
        }
        const braced = /^\$\{(\d+)(?:([:|])([\s\S]*?)\|?)?\}/.exec(snippet.slice(index));
        if (!braced) {
            text += character;
            continue;
        }
        index += braced[0].length - 1;
        if (braced[2] === ':') text += plainTextOf(braced[3] ?? '');
        else if (braced[2] === '|') text += (braced[3] ?? '').split(',')[0] ?? '';
    }
    return text;
};

/**
 * A code action that writes a snippet where the client can place tab stops, and the same text
 * without them where it cannot. The two forms are never both sent: a client applies a code action's
 * edit and then runs its command, so carrying the edit and the command together would write the
 * text twice.
 *
 * @param action the title, kind, target file and diagnostics the offer carries.
 * @param range the span the snippet replaces, empty for a pure insertion.
 * @param snippet the snippet body, in the tab-stop syntax both clients read.
 * @returns the offer, in whichever form this client can apply.
 */
export const snippetCodeAction = (
    action: { title: string; kind: CodeActionKind; uri: string; diagnostics?: Diagnostic[]; isPreferred?: boolean },
    range: Range,
    snippet: string
): CodeAction => {
    const { title, kind, uri, diagnostics, isPreferred } = action;
    if (!hasSnippetCodeActionCapability) {
        const edit: TextEdit = { range, newText: plainTextOf(snippet) };
        return { title, kind, diagnostics, isPreferred, edit: { changes: { [uri]: [edit] } } };
    }
    const args: InsertSnippetArgs = { uri, range, snippet };
    return {
        title,
        kind,
        diagnostics,
        isPreferred,
        command: { title, command: INSERT_SNIPPET_ACTION_COMMAND, arguments: [args] },
    };
};
