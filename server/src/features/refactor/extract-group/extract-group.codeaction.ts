import * as l10n from '@vscode/l10n';
import { CodeAction, CodeActionKind } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../core/ast/ast';
import { isModRules } from '../../../document/document-kind';
import { ROOT_GROUP_CLASSES } from '../../../document/schema/schema-context';
import { findModRoot } from '../../../mod/mod-root';
import { globalSettings } from '../../../settings';
import { memberSpanOf } from '../shared-base/member-record';
import { EXTRACT_GROUP_ACTION_COMMAND, locateGroup } from './extract-group.command';
import { ExtractGroupArgs } from './extract-group.types';

/**
 * The "move this block into a file of its own" refactoring, offered on a named group inside a file
 * the user may edit. The action carries the command rather than an edit: the file's name is a choice
 * only the author can make, and the block often cannot move at all, which is only known once its
 * references have been read.
 *
 * Nothing here consults a project index, like every other lightbulb offer: the shape in front of the
 * caret is all the offer needs, and whether the move is safe is the command's answer to give.
 *
 * @param document the parsed document the caret is in.
 * @param offset the caret's byte offset.
 * @param uri the document's uri.
 * @returns the offered refactoring, or undefined when the caret sits in no movable group.
 */
export const extractGroupCodeAction = (
    document: AbstractNodeDocument,
    offset: number,
    uri: string
): CodeAction | undefined => {
    // A manifest's groups are actions the game reads in place, not content a file can stand in for.
    if (isModRules(uri)) return undefined;
    if (!findModRoot(uri) && !globalSettings.allowEditingVanillaFiles) return undefined;
    const group = locateGroup(document, offset);
    if (!group?.identifier) return undefined;
    // A group deriving from somewhere else carries members no copy of its body holds.
    if (group.inheritance?.length) return undefined;
    // The group a file is really about stays where it is, or the file is left empty or unrooted.
    if (group.identifier && ROOT_GROUP_CLASSES[group.identifier.name]) return undefined;
    const topLevel = document.elements.filter((element) => memberSpanOf(element) !== undefined);
    if (topLevel.length === 1 && topLevel[0] === group) return undefined;
    if (group.elements.length === 0) return undefined;

    const title = l10n.t("Move '{0}' into its own file...", group.identifier.name);
    const args: ExtractGroupArgs = { uri, offset: group.identifier.position.start };
    return {
        title,
        kind: CodeActionKind.RefactorExtract,
        command: { title, command: EXTRACT_GROUP_ACTION_COMMAND, arguments: [args] },
    };
};
