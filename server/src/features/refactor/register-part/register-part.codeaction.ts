import { CodeAction, CodeActionKind } from 'vscode-languageserver';
import * as l10n from '@vscode/l10n';
import { AbstractNodeDocument } from '../../../core/ast/ast';
import { isModRules } from '../../../document/document-kind';
import { findModRoot } from '../../../mod/mod-root';
import { globalSettings } from '../../../settings';
import { locatePartGroup } from '../../part-editor/part-grid-data.service';
import { REGISTER_PART_IN_SHIP_ACTION_COMMAND } from './register-part.command';

/**
 * The "register this part in a ship class" refactoring, offered whenever the cursor sits in a part
 * group of a file the user may edit. The action carries the command rather than an edit: which ship
 * class the part belongs in is a choice only the author can make, and the edit may land in a file the
 * cursor is not in at all.
 *
 * Nothing here consults a project index. `onCodeAction` never awaits the fragment-rooting build, so a
 * refactoring offered from the lightbulb cannot assume one exists, and gating the offer on an index
 * would silently withhold it for as long as the build takes. A top-level group named `Part` anchors
 * its class by name alone, which is all the offer needs; enumerating the ship classes is the
 * command's job, where the indexes are built.
 *
 * @param document the parsed document the cursor is in.
 * @param offset the cursor's byte offset.
 * @param uri the document's uri.
 * @returns the offered refactoring, or undefined when the cursor is in no editable part group.
 */
export const registerPartInShipCodeAction = (
    document: AbstractNodeDocument,
    offset: number,
    uri: string
): CodeAction | undefined => {
    // A manifest declares actions, never a part, and a `Part` group in one would be a fragment the
    // manifest points at rather than something to register.
    if (isModRules(uri)) return undefined;
    const part = locatePartGroup(document, offset);
    if (!part?.identifier) return undefined;
    // The part lookup falls back to the file's first part group when the offset encloses nothing, so
    // the cursor is tested against the group itself. The container-position invariant leaves an
    // unclosed group's end at zero, which reads as open-ended rather than as an empty span.
    const end = part.position.end > part.position.start ? part.position.end : Number.MAX_SAFE_INTEGER;
    if (offset < part.identifier.position.start || offset >= end) return undefined;
    // The game's own files are read-only unless the one switch every refactoring reads says otherwise.
    if (!findModRoot(uri) && !globalSettings.allowEditingVanillaFiles) return undefined;

    const title = l10n.t('Register this part in a ship class...');
    return {
        title,
        kind: CodeActionKind.RefactorExtract,
        // The client's own command, carrying the part and nothing else, so the editor can ask which
        // ship class before anything is written (see the command id's own note).
        command: {
            title,
            command: REGISTER_PART_IN_SHIP_ACTION_COMMAND,
            arguments: [{ uri, offset: part.identifier.position.start }],
        },
    };
};
