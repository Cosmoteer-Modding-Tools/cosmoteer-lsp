import { CodeAction, CodeActionKind } from 'vscode-languageserver';
import * as l10n from '@vscode/l10n';
import { AbstractNodeDocument } from '../../../core/ast/ast';
import { isModRules, isShaderDocument } from '../../../document/document-kind';
import { findModRoot } from '../../../mod/mod-root';
import { foldPathCase } from '../../../workspace/fs-cache';
import { uriToFsPath } from '../../navigation/workspace-files';
import { modRootsUnder } from '../register-part/ship-registry';
import { OVERRIDE_IN_MOD_ACTION_COMMAND } from './override-in-mod.command';
import { overrideMemberAt } from './override-member';

/**
 * The "override this in my mod" refactoring, offered whenever the caret sits on a value of the
 * game's own `Data` tree and the workspace holds a mod that could carry the override. The action
 * carries the command rather than an edit: which mod the override belongs in is a choice only the
 * author can make, and the edit lands in a file the caret is not in at all.
 *
 * Nothing here consults a project index. `onCodeAction` never awaits the fragment-rooting build, so a
 * refactoring offered from the lightbulb cannot assume one exists, and gating the offer on an index
 * would silently withhold it for as long as the build takes. The one directory walk it does make is
 * memoized for a moment, since a burst of code-action requests over the same workspace asks the same
 * question every time.
 */

/** How long a mod walk stands, in milliseconds, before the folders are read again. */
const MOD_WALK_TTL = 3000;

/** The last mod walk, so a burst of code-action requests costs one pass over the folders. */
let modWalk: { key: string; at: number; found: boolean } | undefined;

/**
 * Drop the memoized mod walk, so a test or a newly created manifest starts from a clean slate.
 */
export const clearOverrideInModCache = (): void => {
    modWalk = undefined;
};

/**
 * Whether any workspace folder holds a mod, which is what the override would be written into.
 *
 * @param folderPaths the workspace folders, as on-disk paths.
 * @returns true when at least one mod root was found.
 */
const hasWorkspaceMod = (folderPaths: readonly string[]): boolean => {
    const key = folderPaths.map((folder) => foldPathCase(folder)).join('|');
    const now = Date.now();
    if (modWalk && modWalk.key === key && now - modWalk.at < MOD_WALK_TTL) return modWalk.found;
    const found = folderPaths.some((folder) => modRootsUnder(folder).length > 0);
    modWalk = { key, at: now, found };
    return found;
};

/**
 * The offer to override the value under the caret from a mod.
 *
 * The value is only located and judged, never copied here, and the answer is thrown away: the
 * command redoes the whole analysis against a fresh read before it writes anything.
 *
 * @param document the parsed document the caret is in.
 * @param text that document's current source text.
 * @param offset the caret's byte offset.
 * @param uri the document's uri.
 * @param dataRoot the game's `Data` directory, absent when the game folder is unset.
 * @param folderPaths the workspace folders, as on-disk paths.
 * @returns the offered refactoring, or undefined when there is nothing to override.
 */
export const overrideInModCodeAction = (
    document: AbstractNodeDocument,
    text: string,
    offset: number,
    uri: string,
    dataRoot: string | undefined,
    folderPaths: readonly string[]
): CodeAction | undefined => {
    if (!dataRoot || isShaderDocument(uri) || isModRules(uri)) return undefined;
    const fsPath = uriToFsPath(uri).replace(/\\/g, '/');
    // Only the game's own files are overridden from a mod. A file of a mod is edited directly, which
    // includes a mod somebody unpacked into the game tree.
    const key = foldPathCase(fsPath);
    const root = foldPathCase(dataRoot.replace(/\\/g, '/').replace(/\/+$/, ''));
    if (!key.startsWith(`${root}/`)) return undefined;
    if (findModRoot(fsPath)) return undefined;
    // A language strings file cannot be modified by an action at all, which the game's own example
    // mod states outright. The full check reads the mod manifests, so the offer uses the folder
    // convention the game's own language files follow and the command makes the real one.
    if (/(^|\/)strings\//i.test(`${key}/`)) return undefined;

    // The folder walk comes before the member analysis, since the analysis stats every path the
    // member carries and there is nothing to offer without a mod to write into.
    if (!hasWorkspaceMod(folderPaths)) return undefined;
    const result = overrideMemberAt(document, text, offset, fsPath, dataRoot);
    if ('refusal' in result) return undefined;

    const title = l10n.t('Override "{0}" in a mod...', result.member.name);
    return {
        title,
        kind: CodeActionKind.RefactorExtract,
        // The client's own command, carrying the caret and nothing else, so the editor can ask which
        // mod before anything is written (see the command id's own note).
        command: {
            title,
            command: OVERRIDE_IN_MOD_ACTION_COMMAND,
            arguments: [{ uri, offset: result.member.span.start }],
        },
    };
};
