import { CodeAction, CodeActionKind } from 'vscode-languageserver';
import * as l10n from '@vscode/l10n';
import { AbstractNodeDocument, isGroupNode } from '../../../core/ast/ast';
import { isModRules } from '../../../document/document-kind';
import { cloneShapeAt } from './clone-target';
import { CLONE_DECLARATION_ACTION_COMMAND } from './clone.command';

/**
 * The "clone this declaration under a new id" refactoring, offered whenever the caret sits in
 * something that declares an id: a part group, a whole-file root, or an element of a collection list.
 *
 * The gate is the other way round from the part registration's. The source is allowed to be the
 * game's own file, because copying a game part into a mod is the whole point of the feature and is
 * the way nearly every part mod starts. It is the destination that has to be a mod the user may edit,
 * and that is not known until the author has said where the copy goes, so the command decides it.
 *
 * Nothing here consults a project index. `onCodeAction` never awaits the fragment-rooting build, so a
 * refactoring offered from the lightbulb cannot assume one exists, and gating the offer on an index
 * would silently withhold it for as long as the build takes. Whether the declaration inherits its id,
 * whether its bases can be read and how much would be copied are all worked out by the command, which
 * can afford the reads and can say what it found.
 *
 * @param document the parsed document the caret is in.
 * @param offset the caret's byte offset.
 * @param uri the document's uri.
 * @returns the offered refactoring, or undefined when the caret is in no declaration.
 */
export const cloneDeclarationCodeAction = (
    document: AbstractNodeDocument,
    offset: number,
    uri: string
): CodeAction | undefined => {
    // A manifest declares actions, never content, and a group inside one is a fragment it points at.
    if (isModRules(uri)) return undefined;
    const found = cloneShapeAt(document, offset);
    if ('refusal' in found) return undefined;
    const shape = found.shape;
    // Something that writes no id and inherits nothing is not a declaration at all, only a fragment
    // the file's kind happens to be known for, such as a particle definition. A group that inherits
    // may well take its id from a base, and that is worth offering and then explaining, because the
    // author cannot see from the file that a copy of it would collide.
    const inherits = isGroupNode(shape.container) && (shape.container.inheritance?.length ?? 0) > 0;
    if (!shape.identity && !inherits) return undefined;
    // The identity slot is the steadiest anchor the file has, so an edit somewhere else in it does not
    // move what the offer refers to.
    const anchor = shape.identity?.node.position.start ?? offset;

    const title = l10n.t('Clone this under a new id...');
    return {
        title,
        kind: CodeActionKind.RefactorExtract,
        // The client's own command, carrying the declaration and nothing else, so the editor can ask
        // for the new id and show the copy before anything is written (see the command id's own note).
        command: {
            title,
            command: CLONE_DECLARATION_ACTION_COMMAND,
            arguments: [{ uri, offset: anchor }],
        },
    };
};
