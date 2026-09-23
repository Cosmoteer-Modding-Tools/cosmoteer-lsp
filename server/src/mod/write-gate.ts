import * as l10n from '@vscode/l10n';
import { globalSettings } from '../settings';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { foldPathCase } from '../workspace/fs-cache';
import { workshopContentDir } from '../workspace/workshop-dir';
import { uriToFsPath } from '../workspace/workspace-files';
import { findModRoot } from './mod-root';

/**
 * The one gate that says whether a file may be written.
 *
 * Every command that produces an edit asks here before it answers, so the trees that are not the
 * author's work are refused in one place instead of once per feature. Two trees are not theirs: the
 * game's own `Data` install, which Steam owns and re-verifies, and somebody else's installed
 * workshop mod, which a re-subscribe overwrites. A file anywhere else is the author's to edit,
 * whether or not a manifest has been written yet, since a mod being started carries no `mod.rules`
 * and a loose folder of fragments is still the author's folder.
 *
 * The game tree has one switch, `rename.allowEditingVanillaFiles`, for a developer working on the
 * game data itself. The workshop tree has none, because it is somebody else's package either way.
 */

/** Why a path may not be written. */
export type WriteRefusalReason = 'gameInstall' | 'installedMod';

/** A refused write, with the sentence the user is shown. */
export interface WriteRefusal {
    /** Which tree refused it. */
    readonly reason: WriteRefusalReason;
    /** The file that was refused, as the caller spelled it. */
    readonly fsPath: string;
    /** The root of the refusing tree, for a report that names the trees rather than the files. */
    readonly root: string;
    /** The localized sentence for a toast or a warning. */
    readonly message: string;
}

/** A path in compare form: forward slashes, case folded the way the filesystem folds it. */
const compareForm = (path: string): string => foldPathCase(path.replace(/\\/g, '/'));

/**
 * Whether a path sits inside a folder, both already in compare form.
 *
 * @param key the path to test.
 * @param folder the folder it may sit in.
 * @returns true when the path is the folder itself or anything under it.
 */
const isUnder = (key: string, folder: string): boolean => {
    const dir = folder.replace(/\/+$/, '');
    return key === dir || key.startsWith(`${dir}/`);
};

/** The file name of a path or uri, for a message a person reads. */
const fileNameOf = (fsPath: string): string => {
    const path = fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
    return path.slice(path.lastIndexOf('/') + 1);
};

/**
 * Whether a file may be written, and why not when it may not.
 *
 * @param fsPath the file's on-disk path.
 * @returns the refusal, or undefined when the write may go ahead.
 */
export const writeRefusalFor = (fsPath: string): WriteRefusal | undefined => {
    const key = compareForm(fsPath);
    const workshop = workshopContentDir();
    if (workshop && isUnder(key, compareForm(workshop))) {
        return {
            reason: 'installedMod',
            fsPath,
            root: workshop,
            message: l10n.t(
                "Cosmoteer: this is the game's own data or somebody else's installed mod, which is not yours to add to."
            ),
        };
    }
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (dataRoot && isUnder(key, compareForm(dataRoot)) && !globalSettings.allowEditingVanillaFiles) {
        return {
            reason: 'gameInstall',
            fsPath,
            root: dataRoot,
            message: l10n.t("{0} is one of the game's own files, which a mod cannot edit.", fileNameOf(fsPath)),
        };
    }
    return undefined;
};

/**
 * The entries of a change set that may be written, with the refusals for the rest.
 *
 * A command that swept a wider tree than it may write answers with the part it may write rather
 * than with nothing: a stray match in the game install must not cost the author the repair of their
 * own files.
 *
 * @param changes the change set, keyed by document uri.
 * @returns the entries that may be written, and one refusal per entry that may not.
 */
export const writableChanges = <T>(
    changes: Record<string, T>
): { kept: Record<string, T>; refused: WriteRefusal[] } => {
    const kept: Record<string, T> = {};
    const refused: WriteRefusal[] = [];
    for (const [uri, value] of Object.entries(changes)) {
        const refusal = writeRefusalFor(uriToFsPath(uri));
        if (refusal) refused.push(refusal);
        else kept[uri] = value;
    }
    return { kept, refused };
};

/**
 * Whether a file is one the refactorings may ever touch, and which tree it is compared within.
 *
 * Normally that is a mod the user is editing, found by its manifest, and never the game's own `Data`
 * tree or somebody else's installed workshop mod: the duplication in the game's files is real and
 * large, and offering to rewrite them would edit an install the user does not own.
 *
 * The game tree is doubly invisible, because it carries no manifest either, so a developer working on
 * the game data itself is served by `allowEditingVanillaFiles`, the one switch every refactoring
 * reads. With it on, the data root stands in for the missing manifest and becomes the tree those
 * files are compared within and the directory a generated base file is placed relative to.
 *
 * This asks more than {@link writeRefusalFor} does, because it also wants a project root, so a
 * folder carrying no manifest is refused here and written to there.
 *
 * @param fsPath the file's on-disk path.
 * @returns the root of the tree the file is compared within, or undefined when it must be left alone.
 */
export const editableModRootOf = (fsPath: string): string | undefined => {
    if (writeRefusalFor(fsPath)) return undefined;
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath?.replace(/\\/g, '/');
    // A mod somebody unpacked into the game tree is still its own project, so a manifest inside
    // the data root keeps winning over the data root itself.
    if (dataRoot && isUnder(compareForm(fsPath), compareForm(dataRoot))) return findModRoot(fsPath) ?? dataRoot;
    return findModRoot(fsPath) ?? undefined;
};
