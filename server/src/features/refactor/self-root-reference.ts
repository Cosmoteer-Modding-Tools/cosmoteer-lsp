import * as l10n from '@vscode/l10n';
import { CancellationToken, CodeAction, CodeActionKind, Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNode, AbstractNodeDocument, isValueNode } from '../../core/ast/ast';
import { findNodeAtPosition, getStartOfAstNode } from '../../utils/ast.utils';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { normalizeUri } from '../navigation/reference-location';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';

/**
 * Writing a reference that names something in its own file as the self-rooted reference it is.
 *
 * `&<cannon_med.rules>/OVERCLOCK/BURST` written inside `cannon_med.rules` names the file it is
 * already in. `~` is the root of that same document, so `&~/OVERCLOCK/BURST` says the same thing
 * without repeating the file name, and keeps saying it after the file is renamed.
 *
 * The offer is narrow on purpose. The other two conversions the same machinery could do are not
 * safe to offer: a game-root path can only address the game's own tree, and rewriting a mod-internal
 * reference into one produces `./Data/../../../workshop/<id>/…`, which hard-codes where the mod
 * happens to be installed. That is the shape the workshop-escape hint exists to warn about.
 */

const navigation = new FullNavigationStrategy();

/** The reference forms this rewrites: a file reference with a path inside it. */
const FILE_ROOTED = /^&?<([^<>\r\n"]+)>(\/.+)$/;

/**
 * Offers to rewrite a reference that names its own file as a `~`-rooted one.
 *
 * @param parserResult the parsed document.
 * @param textDocument the open document, for the range of the edit.
 * @param position the caret.
 * @param uri the document's uri.
 * @param token cancels the resolution of the reference.
 * @returns the code action, or undefined when the reference names another file or does not resolve.
 */
export const selfRootReferenceCodeAction = async (
    parserResult: AbstractNodeDocument,
    textDocument: TextDocument,
    position: Position,
    uri: string,
    token: CancellationToken
): Promise<CodeAction | undefined> => {
    const node = findNodeAtPosition(parserResult, position);
    if (!node || !isValueNode(node) || node.valueType.type !== 'Reference') return undefined;
    const text = String(node.valueType.value);
    const match = FILE_ROOTED.exec(text);
    if (!match) return undefined;

    const target = await navigation.navigate(text, node, uri, token).catch(() => null);
    if (!target || isFile(target as FileWithPath)) return undefined;
    // The rewrite is only the same reference when the target lives in this very document: `~` is the
    // root of the document the reference is written in, and nothing else.
    if (normalizeUri(getStartOfAstNode(target as AbstractNode).uri) !== normalizeUri(uri)) return undefined;

    const rewritten = `${text.startsWith('&') ? '&' : ''}~${match[2]}`;
    return {
        title: l10n.t('Write this as {0}', rewritten),
        kind: CodeActionKind.RefactorRewrite,
        edit: {
            changes: {
                [uri]: [
                    {
                        range: {
                            start: textDocument.positionAt(node.position.start),
                            end: textDocument.positionAt(node.position.end),
                        },
                        newText: rewritten,
                    },
                ],
            },
        },
    };
};
