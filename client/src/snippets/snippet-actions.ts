import { commands, ExtensionContext, l10n, Position, Range, SnippetString, Uri, window, workspace } from 'vscode';
import { ExecuteCommandRequest, LanguageClient } from 'vscode-languageclient/node';
import {
    CreateComponentArgs,
    CreateComponentFailure,
    CreateComponentResult,
} from '../../../shared/create-component.types';
import { InsertSnippetArgs } from '../../../shared/snippet-action.types';

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

/**
 * The command the server's snippet-bearing code actions carry. The server does not claim it, and it
 * cannot: a `WorkspaceEdit` has no way to carry a tab stop, so the text is written here, where the
 * editor can leave the caret where the author has to type next.
 */
export const INSERT_SNIPPET_LOCAL_COMMAND = 'cosmoteer.insertSnippetFromAction';

/**
 * What to say when no component can be declared, one message per reason the server reports.
 *
 * @param failure the reason the server gave.
 * @returns the message to show.
 */
function createComponentFailureMessage(failure: CreateComponentFailure): string {
    switch (failure) {
        case 'stale':
            return l10n.t('The reference has moved since the offer was made, so nothing was declared.');
        case 'noOwner':
            return l10n.t('This file declares no part or bullet to add a component to.');
        case 'notEditable':
            return l10n.t('Files in the game folder are read-only.');
        case 'alreadyDeclared':
            return l10n.t('A component of that name is already declared here.');
        case 'unknownType':
            return l10n.t('That kind of component cannot be declared here.');
    }
}

/**
 * What to say about a round the server answered with nothing usable, which is either a named reason
 * or no answer at all.
 *
 * @param result what the server answered with, null when it answered with nothing.
 * @returns the message to show.
 */
function createComponentProblemMessage(result: CreateComponentResult | null): string {
    if (result && 'failure' in result) return createComponentFailureMessage(result.failure);
    return l10n.t('The component could not be created.');
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
            if (!offered || !('choices' in offered) || offered.choices.length === 0) {
                window.showWarningMessage(createComponentProblemMessage(offered));
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
            if (!written || !('insert' in written)) {
                window.showWarningMessage(createComponentProblemMessage(written));
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
