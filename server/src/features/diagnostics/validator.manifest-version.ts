import { CancellationToken } from 'vscode-languageserver';
import { readFile } from 'fs/promises';
import { dirname } from 'path';
import {
    AbstractNode,
    AbstractNodeDocument,
    IdentifierNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { basenameOf, isManifestBasename } from '../../document/document-kind';
import { findModRoot } from '../../mod/mod-root';
import { readManifest } from '../mod-report/mod-dependencies';
import {
    declaredCompatibleVersions,
    gameVersionsInsertLiteral,
    modVersionVerdict,
    readGameVersionInfo,
} from '../game-version';
import { lineEndingOf } from '../refactor/command-host';
import { uriToFsPath } from '../../workspace/workspace-files';
import { collectRulesFiles } from '../../workspace/rules-file-walk';
import { foldPathCase } from '../../workspace/fs-cache';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/** The written name of a top-level member, whatever container form it takes. */
const topLevelMemberName = (node: AbstractNode): string | undefined =>
    isAssignmentNode(node) ? node.left.name : isGroupNode(node) || isListNode(node) ? node.identifier?.name : undefined;

/** Where a manifest writes its `CompatibleGameVersions`: the name to report on, and what it spans. */
interface VersionsMember {
    /** The written field name, which is what a diagnostic underlines. */
    readonly name: IdentifierNode;
    /** The offset just past the written list, so a rewrite can replace name and list together. */
    readonly end: number;
}

/**
 * The manifest's `CompatibleGameVersions` member, in either the `X = [ … ]` or the `X [ … ]`
 * spelling.
 *
 * @param document the parsed manifest.
 * @returns the member, or undefined when the manifest writes none.
 */
const versionsMember = (document: AbstractNodeDocument): VersionsMember | undefined => {
    for (const element of document.elements) {
        if (topLevelMemberName(element)?.toLowerCase() !== 'compatiblegameversions') continue;
        if (isAssignmentNode(element)) {
            return element.right ? { name: element.left, end: element.right.position.end } : undefined;
        }
        if (isListNode(element) && element.identifier) {
            return { name: element.identifier, end: element.position.end };
        }
    }
    return undefined;
};

/**
 * The edit that makes a manifest name the version the installed build is, replacing the whole
 * written member so the list says exactly one version.
 *
 * @param document the parsed manifest.
 * @returns the byte-offset edit, or undefined when the manifest writes no list or the installed
 *          version could not be read.
 */
export const compatibleVersionsRewrite = async (
    document: AbstractNodeDocument
): Promise<{ start: number; end: number; newText: string } | undefined> => {
    const member = versionsMember(document);
    if (!member) return undefined;
    const literal = await gameVersionsInsertLiteral(CosmoteerWorkspaceService.instance.dataRootPath);
    if (!literal) return undefined;
    return { start: member.name.position.start, end: member.end, newText: `CompatibleGameVersions = ${literal}` };
};

/**
 * Whether the manifest already names the version the installed build is, which is what the
 * migration brings every manifest to.
 *
 * @param document the parsed manifest.
 * @returns true when the declared list names the installed version, and true as well when there is
 *          no install to compare against, so an unreadable install rewrites nothing.
 */
export const namesInstalledGameVersion = async (document: AbstractNodeDocument): Promise<boolean> => {
    const declared = declaredCompatibleVersions(document);
    if (declared === undefined) return true;
    const info = await readGameVersionInfo(CosmoteerWorkspaceService.instance.dataRootPath).catch(() => undefined);
    if (!info || !info.installed) return true;
    return declared.includes(info.installed);
};

/**
 * Validate a manifest's declared versions against what the installed build accepts.
 *
 * `ModInfo.IsCompatibleWithGameVersion` answers true when the list names the installed version or
 * one of the older ones the build still accepts. A list that names neither leaves the mod
 * incompatible, which the game acts on in two places. `ModsDialog` asks the player to confirm
 * every time they enable the mod, with no further condition. `Assets.ApplyPreLoadMods` drops the
 * mod out of the enabled set while the game loads, but only when the `AutoDisableMods` setting is
 * on and the version last launched is one this build no longer accepts, and it then says so
 * through the `Mods/AutoDisabled` dialog.
 *
 * The verdict needs the accepted set out of the game assembly, so an install that is not configured
 * or cannot be read reports nothing rather than guessing.
 *
 * @param document the parsed manifest document.
 * @returns the diagnostic with the rewrite-to-the-current-version fix, or empty when the build
 *          accepts the mod.
 */
const validateAcceptedVersions = async (document: AbstractNodeDocument): Promise<ValidationError[]> => {
    const declared = declaredCompatibleVersions(document);
    const member = versionsMember(document);
    // An empty list names no version the build accepts, which is the verdict this message already
    // states, so it is judged like any other list rather than waved through.
    if (declared === undefined || !member) return [];
    const info = await readGameVersionInfo(CosmoteerWorkspaceService.instance.dataRootPath).catch(() => undefined);
    if (!info || modVersionVerdict(declared, info) !== 'namesNone') return [];
    const rewrite = await compatibleVersionsRewrite(document);
    return [
        {
            message: l10n.t(
                "'CompatibleGameVersions' names no version this Cosmoteer build accepts. The game warns the player before it lets them enable the mod, and it can turn the mod off by itself after a game update. The installed version is {0}.",
                info.installed
            ),
            node: member.name,
            severity: 'warning',
            data: rewrite
                ? {
                      rewrite: {
                          title: l10n.t('Set CompatibleGameVersions to the current game version'),
                          edits: [rewrite],
                      },
                  }
                : undefined,
        },
    ];
};

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
const validateSelectability = async (
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
    const versions = await gameVersionsInsertLiteral(CosmoteerWorkspaceService.instance.dataRootPath);
    // The inserted line has to end the way the file's other lines do, or the fix leaves a lone `\n`
    // in a CRLF manifest and every tool downstream reports the file as mixed.
    const lineEnding = lineEndingOf(await readFile(ownPath, { encoding: 'utf-8' }).catch(() => ''));
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
                          edits: [{ start: 0, end: 0, newText: `CompatibleGameVersions = ${versions}${lineEnding}` }],
                      },
                  }
                : undefined,
        },
    ];
};

/**
 * Validate that a mod declares compatible versions at all. `ModInfo.IsCompatibleWithGameVersion`
 * opens with `if (CompatibleGameVersions == null) return false`, so a manifest that writes no list
 * is exactly as incompatible as one naming versions the build dropped, and it meets the same two
 * consequences {@link validateAcceptedVersions} describes.
 *
 * A mod whose manifests are version variants is not judged here. Its other manifest declares the
 * field, which is what the game selects on, so the whole mod is answered by that file and its own
 * findings. A `mod_*.rules` beside another manifest is not judged either, since
 * {@link validateSelectability} already reports the same missing field on it.
 *
 * @param document the parsed manifest document.
 * @param cancellationToken cancels the sibling-manifest directory walk.
 * @returns the diagnostic with an add-the-field quick fix, or empty when some manifest of the mod
 *          declares the versions.
 */
const validateVersionsDeclared = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const basename = basenameOf(document.uri);
    if (!isManifestBasename(basename)) return [];
    // The member walk catches the half-written `CompatibleGameVersions =` too, which carries no
    // list for {@link versionsMember} to answer with and is still the author writing the field.
    if (versionsMember(document)) return [];
    for (const element of document.elements) {
        if (topLevelMemberName(element)?.toLowerCase() === 'compatiblegameversions') return [];
    }
    const anchor = document.elements.find((element) => topLevelMemberName(element) !== undefined);
    if (!anchor) return [];
    const ownPath = uriToFsPath(document.uri);
    const ownDir = dirname(ownPath).replace(/\\/g, '/');
    const searchRoot = findModRoot(dirname(ownDir)) ?? ownDir;
    let hasSibling = false;
    for await (const file of collectRulesFiles(searchRoot)) {
        if (cancellationToken.isCancellationRequested) return [];
        if (!isManifestBasename(basenameOf(file))) continue;
        if (foldPathCase(file) === foldPathCase(ownPath)) continue;
        hasSibling = true;
        const sibling = await readManifest(file).catch(() => undefined);
        if (sibling && declaredCompatibleVersions(sibling) !== undefined) return [];
    }
    if (hasSibling && basename.toLowerCase() !== 'mod.rules') return [];
    const versions = await gameVersionsInsertLiteral(CosmoteerWorkspaceService.instance.dataRootPath);
    const lineEnding = lineEndingOf(await readFile(ownPath, { encoding: 'utf-8' }).catch(() => ''));
    return [
        {
            message: l10n.t(
                "This manifest declares no 'CompatibleGameVersions', which the game reads as incompatible with every version. The game warns the player before it lets them enable the mod, and it can turn the mod off by itself after a game update."
            ),
            node: anchor,
            severity: 'warning',
            data: versions
                ? {
                      rewrite: {
                          title: l10n.t('Add CompatibleGameVersions for the current game version'),
                          edits: [{ start: 0, end: 0, newText: `CompatibleGameVersions = ${versions}${lineEnding}` }],
                      },
                  }
                : undefined,
        },
    ];
};

/**
 * Every check a manifest gets on the versions it declares: that the game would select the file at
 * all, that it declares the versions in the first place, and that the versions it names are ones
 * the installed build accepts.
 *
 * @param document the parsed manifest document.
 * @param cancellationToken cancels the sibling-manifest directory walk.
 * @returns the findings, empty when the manifest is selectable and the build accepts it.
 */
export const validateManifestVersion = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => [
    ...(await validateSelectability(document, cancellationToken)),
    ...(await validateVersionsDeclared(document, cancellationToken)),
    ...(await validateAcceptedVersions(document)),
];
