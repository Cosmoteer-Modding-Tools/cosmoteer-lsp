import { WorkspaceFolder } from 'vscode-languageserver/node';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { hasWorkspaceFolderCapability } from './capabilities';
import { connection } from './context';

/** The cached `workspace/workspaceFolders` answer, `undefined` until (re)fetched. */
let workspaceFoldersCache: WorkspaceFolder[] | null | undefined;

/**
 * The client's workspace folders, fetched once and cached. Nearly every feature request needs the
 * folder list (through {@link searchFolderUris}), and asking the client each time made every
 * completion, hover, and validation pay a client round-trip. Never asks a client that did not
 * advertise the capability, since the request would go unanswered on such a client and pend the
 * feature forever. The cache is invalidated when the folder set changes.
 *
 * @returns the workspace folders, or null when the client has none (or doesn't support them).
 */
export async function getWorkspaceFoldersCached(): Promise<WorkspaceFolder[] | null> {
    if (!hasWorkspaceFolderCapability) return null;
    if (workspaceFoldersCache !== undefined) return workspaceFoldersCache;
    workspaceFoldersCache = (await connection.workspace.getWorkspaceFolders()) ?? null;
    return workspaceFoldersCache;
}

/** Forgets the cached folder list, so the next read asks the client again. */
export function invalidateWorkspaceFoldersCache(): void {
    workspaceFoldersCache = undefined;
}

// The cross-file existence validators (ids, localization keys) judge a reference against everything
// the game can see at load time, most of which is the vanilla install. Until the game `Data` root is
// initialized, that coverage is missing and an unknown-id verdict could be wrong, so those passes
// hold off rather than false-positive (they are on by default and activate once the path resolves).
export const gameIndexAvailable = (): boolean => !!CosmoteerWorkspaceService.instance.dataRootPath;

// Folders the cross-file index searches: the open workspace (the mod) plus the Cosmoteer
// game `Data` tree. Vanilla symbols (e.g. `Part` in `base_part.rules`) and most references
// to them live in the game install, outside the open mod folder. Without this, find-all-
// references on a vanilla symbol finds only its declaration.
export async function searchFolderUris(): Promise<string[]> {
    const folders = await getWorkspaceFoldersCached();
    const uris = (folders ?? []).map((folder) => folder.uri);
    // Use the actually-initialized Data root (reliable), not globalSettings.cosmoteerPath
    // (which a config-change event can transiently blank). This is where the vanilla files
    // and the references between them live. The referencing files need not be open.
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (dataRoot) uris.push(dataRoot);
    return uris;
}

/** The same folders as {@link searchFolderUris}, as on-disk paths, for a path shown to the user. */
export async function searchFolderPaths(): Promise<string[]> {
    return (await searchFolderUris()).map(uriToFsPath);
}
