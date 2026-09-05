import { commands, ExtensionContext, l10n, Position, Range, SnippetString, Uri, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';

/**
 * The code actions whose edit ends with the caret on a tab stop, which a workspace edit cannot do, so
 * the text is written here: the plain snippet insertion, and the component declaration whose kind the
 * author picks first.
 */

/**
 * The command the server's "create the component this names" quick fix carries. The server does not
 * claim it, so the editor runs this instead: which kind of component the author meant cannot be read
 * off the reference, and only they know it.
 */
export const CREATE_COMPONENT_LOCAL_COMMAND = 'cosmoteer.createComponentFromAction';

/** Mirror of the server's create-component arguments (see server features/refactor/create-component). */
interface CreateComponentArgs {
    uri: string;
    offset: number;
    name: string;
    type?: string;
}

/** Mirror of what the server answers with on either round. */
interface CreateComponentResult {
    choices?: Array<{ type: string; detail: string }>;
    insert?: {
        uri: string;
        range: { start: { line: number; character: number }; end: { line: number; character: number } };
        snippet: string;
    };
    failure?: string;
}

/**
 * What to say when no component can be declared.
 *
 * @param failure the reason the server gave, absent when it answered with nothing at all.
 * @returns the message to show.
 */
function createComponentFailureMessage(failure: string | undefined): string {
    switch (failure) {
        case 'noOwner':
            return l10n.t('This file declares no part or bullet to add a component to.');
        case 'notEditable':
            return l10n.t('Files in the game folder are read-only.');
        case 'alreadyDeclared':
            return l10n.t('A component of that name is already declared here.');
        case 'unknownType':
            return l10n.t('That kind of component cannot be declared here.');
        default:
            return l10n.t('The component could not be created.');
    }
}

/**
 * The command the server's snippet-bearing code actions carry. The server does not claim it, and it
 * cannot: a `WorkspaceEdit` has no way to carry a tab stop, so the text is written here, where the
 * editor can leave the caret where the author has to type next.
 */
export const INSERT_SNIPPET_LOCAL_COMMAND = 'cosmoteer.insertSnippetFromAction';

/** Mirror of the server's snippet arguments (see server features/refactor/snippet-action.ts). */
interface InsertSnippetArgs {
    uri: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    snippet: string;
}

/**
 * Write a snippet over a range of a file, leaving the caret on its first tab stop.
 *
 * @param insert the file, the range and the snippet to write.
 */
async function insertSnippetAt(insert: InsertSnippetArgs): Promise<void> {
    const document = await workspace.openTextDocument(Uri.parse(insert.uri));
    const editor = await window.showTextDocument(document);
    const range = new Range(
        new Position(insert.range.start.line, insert.range.start.character),
        new Position(insert.range.end.line, insert.range.end.character)
    );
    await editor.insertSnippet(new SnippetString(insert.snippet), range);
}

/**
 * Registers the two commands.
 *
 * @param context the extension context the disposables go into.
 * @param client the language client the component command runs through.
 */
export function registerSnippetActions(context: ExtensionContext, client: LanguageClient): void {
    context.subscriptions.push(
        // The command the server's "create the component this names" quick fix carries. The kind is
        // asked for here, and the server works out where the declaration goes and what it has to carry.
        commands.registerCommand(CREATE_COMPONENT_LOCAL_COMMAND, async (args?: CreateComponentArgs) => {
            if (!args?.uri || !args.name) return;
            const run = async (type?: string) =>
                (await client.sendRequest(ExecuteCommandRequest.type, {
                    command: 'cosmoteer.createComponent',
                    arguments: [{ ...args, type }],
                })) as CreateComponentResult | null;
            const offered = await run();
            if (!offered || offered.failure || !offered.choices?.length) {
                window.showWarningMessage(createComponentFailureMessage(offered?.failure));
                return;
            }
            const picked = await window.showQuickPick(
                offered.choices.map((choice) => ({ label: choice.type, detail: choice.detail })),
                {
                    title: l10n.t("Create the component '{0}'", args.name),
                    placeHolder: l10n.t('The kind of component to declare.'),
                    matchOnDetail: true,
                }
            );
            if (!picked) return;
            const written = await run(picked.label);
            if (!written?.insert) {
                window.showWarningMessage(createComponentFailureMessage(written?.failure));
                return;
            }
            await insertSnippetAt(written.insert);
        }),
        // The command the server's snippet-bearing code actions carry, which writes the text and leaves
        // the caret on the first tab stop. The edit cannot come through the code action itself: the
        // protocol's edits are plain text.
        commands.registerCommand(INSERT_SNIPPET_LOCAL_COMMAND, async (args?: InsertSnippetArgs) => {
            if (!args?.uri || typeof args.snippet !== 'string') return;
            await insertSnippetAt(args);
        })
    );
}
