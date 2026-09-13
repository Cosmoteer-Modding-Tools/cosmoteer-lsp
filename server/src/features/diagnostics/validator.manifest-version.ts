import { CancellationToken } from 'vscode-languageserver';
import { readdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
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
import { readManifest } from '../../mod/mod-dependencies';
import {
    clearGameVersionInfoCache,
    declaredCompatibleVersions,
    modVersionVerdict,
    readGameVersionInfo,
} from '../game-version';
import { lineEndingOf } from '../refactor/command-host';
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
    const literal = await gameVersionsInsertLiteral();
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
 * incompatible, and `Assets.ApplyPreLoadMods` then drops it out of the enabled set while the game
 * loads, so the author sees the mod switch itself off with nothing said about why.
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
    if (declared === undefined || declared.length === 0 || !member) return [];
    const info = await readGameVersionInfo(CosmoteerWorkspaceService.instance.dataRootPath).catch(() => undefined);
    if (!info || modVersionVerdict(declared, info) !== 'namesNone') return [];
    const rewrite = await compatibleVersionsRewrite(document);
    return [
        {
            message: l10n.t(
                "'CompatibleGameVersions' names no version this Cosmoteer build accepts, so the game turns the mod off while it loads. The installed version is {0}.",
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
    const versions = await gameVersionsInsertLiteral();
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
 * Every check a manifest gets on the versions it declares: that the game would select the file at
 * all, and that the versions it names are ones the installed build accepts.
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
    ...(await validateAcceptedVersions(document)),
];
