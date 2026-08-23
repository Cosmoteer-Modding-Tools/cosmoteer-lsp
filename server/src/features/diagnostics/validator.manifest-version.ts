import { CancellationToken } from 'vscode-languageserver';
import { readdir } from 'fs/promises';
import { dirname, join } from 'path';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isGroupNode, isListNode } from '../../core/ast/ast';
import { basenameOf, isManifestBasename } from '../../document/document-kind';
import { findModRoot } from '../../mod/mod-root';
import { readManifest } from '../../mod/mod-dependencies';
import {
    clearGameVersionInfoCache,
    declaredCompatibleVersions,
    readGameVersionInfo,
} from '../post-update/game-version';
import { collectRulesFiles, uriToFsPath } from '../navigation/workspace-files';
import { foldPathCase } from '../../workspace/fs-cache';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * The written form of a version list, in the quoted spelling the game's own manifests use.
 *
 * @param versions the versions to write.
 * @returns the list literal, ready to be inserted into a manifest.
 */
const versionsLiteral = (versions: readonly string[]): string => `[${versions.map((one) => `"${one}"`).join(', ')}]`;

/**
 * The `CompatibleGameVersions` the installed game's own Standard Mods manifests declare, which the
 * developers keep at the current game version (`["0.30.4c"]`). Harvested once per session.
 *
 * The manifests are read through the parser rather than by matching the raw text, because the format
 * lets a list run over several lines and a text match confined to one line would miss it.
 *
 * This is the manifest source on its own, which stays separate because
 * {@link readGameVersionInfo} falls back to it when the game assembly cannot be read. Anything that
 * wants the best answer the install can give should call {@link gameVersionsInsertLiteral}.
 *
 * @returns the literal, or undefined when no install is configured or no shipped manifest declares
 *          the field.
 */
let cachedVersionsLiteral: Promise<string | undefined> | undefined;
export const currentGameVersionsLiteral = (): Promise<string | undefined> => {
    cachedVersionsLiteral ??= (async () => {
        const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
        if (!dataRoot) return undefined;
        const standardMods = join(dirname(dataRoot), 'Standard Mods');
        const entries = await readdir(standardMods, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const manifest = await readManifest(join(standardMods, entry.name, 'mod.rules'));
            const declared = manifest ? declaredCompatibleVersions(manifest) : undefined;
            if (declared && declared.length > 0) return versionsLiteral(declared);
        }
        return undefined;
    })();
    return cachedVersionsLiteral;
};

/**
 * The version list the quick fix inserts, taken from the best source the install offers.
 *
 * The installed build states its own version in its assembly, as the constant
 * `Cosmoteer.Versions.GameVersion`, so that is the version a manifest should name and it is read
 * first. The shipped Standard Mods manifests remain the fallback for an install whose assembly
 * cannot be read, since the developers keep them at the current version.
 *
 * @returns the literal to insert, or undefined when neither source could be read, in which case the
 *          diagnostic carries no fix.
 */
export const gameVersionsInsertLiteral = async (): Promise<string | undefined> => {
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    const info = await readGameVersionInfo(dataRoot).catch(() => undefined);
    if (info?.source === 'assembly' && info.installed) return versionsLiteral([info.installed]);
    return currentGameVersionsLiteral().catch(() => undefined);
};

/** Drop the harvested version facts (call when the configured game install changes). */
export const clearGameVersionsCache = (): void => {
    cachedVersionsLiteral = undefined;
    clearGameVersionInfoCache();
};

/** The written name of a top-level member, whatever container form it takes. */
const topLevelMemberName = (node: AbstractNode): string | undefined =>
    isAssignmentNode(node) ? node.left.name : isGroupNode(node) || isListNode(node) ? node.identifier?.name : undefined;

/**
 * Validate a version-split manifest's selectability: a `mod_*.rules` without a top-level
 * `CompatibleGameVersions` gets no selection priority at all in the game's `GetModInfoPath`
 * (0.30.0d and later), so when the mod has any other manifest file the
 * game silently never selects it. `UseThisFileIfNoVersionMatch` does not rescue it either: the
 * game only consults that flag on files that do carry `CompatibleGameVersions`. A mod whose only
 * manifest is the file is used unconditionally and stays silent, as does the plain `mod.rules`
 * (which falls back to priority 0 without the field).
 *
 * Sibling manifests are searched in the nearest ancestor manifest directory's whole subtree (the
 * mod folder for the common layouts: manifests side by side in the mod root, or version manifests
 * in sub-folders below a root `mod.rules`), matching the game's recursive manifest scan.
 *
 * @param document the parsed manifest document.
 * @param cancellationToken cancels the sibling-manifest directory walk.
 * @returns the diagnostic with an add-the-field quick fix, or empty when the file is selectable.
 */
export const validateManifestVersion = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const basename = basenameOf(document.uri);
    if (!isManifestBasename(basename) || basename.toLowerCase() === 'mod.rules') return [];
    for (const element of document.elements) {
        if (topLevelMemberName(element)?.toLowerCase() === 'compatiblegameversions') return [];
    }
    const anchor = document.elements.find((element) => topLevelMemberName(element) !== undefined);
    if (!anchor) return [];
    const ownPath = uriToFsPath(document.uri);
    const ownDir = dirname(ownPath).replace(/\\/g, '/');
    // The walk starts at the parent, so the nearest manifest directory strictly above this one wins
    // (a root `mod.rules` above version sub-folders), while the file's own directory would always
    // self-match. Without any manifest ancestor the own directory's subtree is searched alone,
    // which can miss a sibling sub-folder's manifest but never flags a selectable file.
    const searchRoot = findModRoot(dirname(ownDir)) ?? ownDir;
    let hasSibling = false;
    for await (const file of collectRulesFiles(searchRoot)) {
        if (cancellationToken.isCancellationRequested) return [];
        if (!isManifestBasename(basenameOf(file))) continue;
        if (foldPathCase(file) === foldPathCase(ownPath)) continue;
        hasSibling = true;
        break;
    }
    if (!hasSibling) return [];
    const versions = await gameVersionsInsertLiteral();
    return [
        {
            message: l10n.t(
                "This manifest has no 'CompatibleGameVersions'. The mod has other manifest files, so the game (0.30.0 and later) never selects this one."
            ),
            node: anchor,
            severity: 'warning',
            data: versions
                ? {
                      rewrite: {
                          title: l10n.t('Add CompatibleGameVersions for the current game version'),
                          edits: [{ start: 0, end: 0, newText: `CompatibleGameVersions = ${versions}\n` }],
                      },
                  }
                : undefined,
        },
    ];
};
