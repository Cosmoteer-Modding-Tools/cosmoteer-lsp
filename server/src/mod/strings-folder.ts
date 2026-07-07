import { existsSync } from 'fs';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, isValueNode } from '../core/ast/ast';
import { namedMembersOf, parseFilePath } from '../utils/ast.utils';
import { cachedReaddir } from '../workspace/fs-cache';
import { globalSettings } from '../settings';
import { findModRoot } from './mod-root';
import { isManifestBasename } from '../document/document-kind';
import { ParserResultRegistrar } from '../registrar/parser-result-registrar';
import { CosmoteerWorkspaceData, CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';

/**
 * Language string files (`en.rules`, …) live under the folder named by the `StringsFolder`
 * setting and cannot be modified by actions — mods provide their own per-language files there
 * instead. This module resolves the absolute string folders in play (the base game's, declared
 * in the game-root `cosmoteer.rules`, plus the editing mod's own manifests) so the validator can
 * reject any action target that resolves to a file inside one.
 *
 * See https://cosmoteer.wiki.gg/wiki/Modding/Actions ("a small number of .rules files that can't
 * be modified using actions").
 */
const STRINGS_FOLDER_FIELD = 'StringsFolder';

/** Normalize an fs path or `file://` URI to a comparable lowercase, forward-slash, no-trailing-slash form. */
export const normalizeFsPath = (path: string): string => {
    let p = path.trim();
    if (p.startsWith('file://')) p = decodeURIComponent(p.slice('file://'.length));
    return p
        .replace(/\\/g, '/')
        .replace(/^\/+([a-zA-Z]:)/, '$1') // `/C:/…` (Windows file URI) -> `C:/…`
        .replace(/\/+$/, '')
        .toLowerCase();
};

/** Whether `filePath` lives inside `folder` (or is the folder itself). */
export const isUnderFolder = (filePath: string, folder: string): boolean => {
    const dir = normalizeFsPath(folder);
    if (!dir) return false;
    const file = normalizeFsPath(filePath);
    return file === dir || file.startsWith(dir + '/');
};

/** The `StringsFolder` paths declared at the top level of a parsed manifest, resolved against `baseDir`. */
const foldersFromDoc = (doc: AbstractNodeDocument, baseDir: string): string[] => {
    const folders: string[] = [];
    for (const [name, value] of namedMembersOf(doc)) {
        // Case-insensitive: the game keys node children with InvariantCultureIgnoreCase.
        if (name.toLowerCase() === STRINGS_FOLDER_FIELD.toLowerCase() && isValueNode(value)) {
            const relative = String(value.valueType.value).trim();
            if (relative) folders.push(join(baseDir, relative));
        }
    }
    return folders;
};

/** The `StringsFolder` paths declared at the top level of one manifest, resolved against `baseDir`. */
const stringsFoldersIn = async (
    manifestPath: string,
    baseDir: string,
    cancellationToken: CancellationToken
): Promise<string[]> => {
    const doc =
        ParserResultRegistrar.instance.getResultByPath(manifestPath) ??
        (await parseFilePath(manifestPath, cancellationToken).catch(() => null));
    if (!doc) return [];
    return foldersFromDoc(doc, baseDir);
};

/**
 * The absolute string folders that apply when validating the manifest at `documentUri`:
 * the base game's (from the game-root `cosmoteer.rules`) and the editing mod's own (from every
 * manifest in its mod root). `documentUri` may be undefined (then only the base game's apply).
 */
export const resolveStringsFolders = async (
    documentUri: string | undefined,
    cancellationToken: CancellationToken
): Promise<string[]> => {
    const folders: string[] = [];

    const dataRoot = globalSettings.cosmoteerPath;
    if (dataRoot) {
        // Prefer the workspace's already-parsed game `cosmoteer.rules` — re-parsing the large vanilla
        // manifest from disk on every keystroke-triggered validation is the cost this avoids. Fall
        // back to a disk read only when the workspace hasn't cached it.
        const cached = await CosmoteerWorkspaceService.instance.getCosmoteerRules().catch(() => undefined);
        const cachedDoc = (cached?.content as CosmoteerWorkspaceData | undefined)?.parsedDocument;
        if (cachedDoc) {
            folders.push(...foldersFromDoc(cachedDoc, dataRoot));
        } else {
            const gameRoot = join(dataRoot, 'cosmoteer.rules');
            if (existsSync(gameRoot)) folders.push(...(await stringsFoldersIn(gameRoot, dataRoot, cancellationToken)));
        }
    }

    const modRoot = documentUri ? findModRoot(documentUri) : null;
    if (modRoot) {
        const entries = await cachedReaddir(modRoot).catch(() => []);
        for (const entry of entries) {
            if (!isManifestBasename(entry.name)) continue;
            folders.push(...(await stringsFoldersIn(join(modRoot, entry.name), modRoot, cancellationToken)));
        }
    }

    return folders;
};

// Memo of "is this document under a StringsFolder", keyed by cosmoteer path + uri. The answer is
// effectively static for a file, so caching avoids re-walking the mod root + re-reading the manifest
// for every asset/math node validated in a large localization file. Keyed on the game path so a
// config change gives a fresh answer.
const stringsFileMemo = new Map<string, Promise<boolean>>();

/**
 * Whether the document at `documentUri` is itself a language-strings file (lives under a
 * `StringsFolder`). Such files hold localization TEXT, not code, so value validators (asset paths,
 * math operand types) must not treat their values as assets/expressions — the game reads them as
 * raw strings.
 */
export const isStringsFile = (
    documentUri: string | undefined,
    cancellationToken: CancellationToken
): Promise<boolean> => {
    if (!documentUri) return Promise.resolve(false);
    const key = `${globalSettings.cosmoteerPath ?? ''}::${documentUri}`;
    let cached = stringsFileMemo.get(key);
    if (!cached) {
        // The base game's language files (`Data/strings/en.rules`, …) are engine-default — vanilla
        // `cosmoteer.rules` declares NO `StringsFolder` — so a declared-folder check alone misses
        // them. A `strings/` path segment is the reliable convention for the base game and most mods;
        // a mod's differently-named folder is still caught by the declared `StringsFolder` below.
        if (/(^|\/)strings\//i.test(normalizeFsPath(documentUri) + '/')) {
            cached = Promise.resolve(true);
        } else {
            cached = resolveStringsFolders(documentUri, cancellationToken)
                .then((folders) => folders.some((folder) => isUnderFolder(documentUri, folder)))
                .catch(() => false);
        }
        stringsFileMemo.set(key, cached);
    }
    return cached;
};
