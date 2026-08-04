import { CancellationToken } from 'vscode-languageserver';
import { readFile, readdir } from 'fs/promises';
import { dirname, join } from 'path';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isGroupNode, isListNode } from '../../core/ast/ast';
import { basenameOf, isManifestBasename } from '../../document/document-kind';
import { findModRoot } from '../../mod/mod-root';
import { collectRulesFiles, uriToFsPath } from '../navigation/workspace-files';
import { foldPathCase } from '../../workspace/fs-cache';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * The `CompatibleGameVersions = […]` literal of the installed game's own Standard Mods manifests,
 * which the devs keep at the current game version (`["0.30.4c"]`). Harvested once per session and
 * used as the quick fix's insert content, so the fix always names the version of the installed
 * game instead of a hardcoded string that rots. Undefined when no install is configured or the
 * manifests are unreadable, in which case the diagnostic carries no fix.
 */
let cachedVersionsLiteral: Promise<string | undefined> | undefined;
const currentGameVersionsLiteral = (): Promise<string | undefined> => {
    cachedVersionsLiteral ??= (async () => {
        const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
        if (!dataRoot) return undefined;
        const standardMods = join(dirname(dataRoot), 'Standard Mods');
        const entries = await readdir(standardMods, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const text = await readFile(join(standardMods, entry.name, 'mod.rules'), 'utf8').catch(() => undefined);
            const literal = text?.match(/CompatibleGameVersions\s*=\s*(\[[^\]\n]*\])/i)?.[1];
            if (literal) return literal;
        }
        return undefined;
    })();
    return cachedVersionsLiteral;
};

/** Drop the harvested version literal (call when the configured game install changes). */
export const clearGameVersionsCache = (): void => {
    cachedVersionsLiteral = undefined;
};

/** The written name of a top-level member, whatever container form it takes. */
const topLevelMemberName = (node: AbstractNode): string | undefined =>
    isAssignmentNode(node) ? node.left.name : isGroupNode(node) || isListNode(node) ? node.identifier?.name : undefined;

/**
 * Validate a version-split manifest's selectability: a `mod_*.rules` without a top-level
 * `CompatibleGameVersions` gets no selection priority at all in the game's `GetModInfoPath`
 * (verified in Cosmoteer.dll, 0.30.0d and later), so when the mod has any other manifest file the
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
    const versions = await currentGameVersionsLiteral();
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
