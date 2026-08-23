import { SharedBaseHost } from '../features/refactor/shared-base/shared-base.command';
import { clearSharedBaseScanCache } from '../features/refactor/shared-base/mod-scan';
import { RegisterPartHost } from '../features/refactor/register-part/register-part.command';
import { CloneHost } from '../features/refactor/clone-declaration/clone.command';
import { NewContentHost } from '../features/refactor/new-content/new-content.command';
import { WorkspaceSymbolService } from '../features/navigation/workspace-symbol.service';
import { SchemaIdIndex } from '../features/completion/schema-id.index';
import { TemplateBaseIndex } from '../features/diagnostics/template-base.index';
import { LocalizationKeyIndex } from '../features/completion/localization-key.index';
import { ReverseIncludeIndex } from '../features/navigation/reverse-include.index';
import { MentionIndex } from '../features/navigation/mention.index';
import { AddBaseIndex } from '../mod/add-base.index';
import { MemberInjectionIndex } from '../mod/member-injection.index';
import { ActionRootingIndex } from '../mod/action-rooting.index';
import { invalidateModContext } from '../mod/mod-context';
import { invalidateSchemaContextCache } from '../document/schema/schema-context';
import { basenameOf, isManifestBasename } from '../document/document-kind';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { invalidateFsPath } from '../workspace/fs-cache';
import { filePathToUri } from '../features/navigation/navigation-strategy';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { connection, documents } from './context';
import { diagnosticsCache, inlayHintCache } from './document-caches';
import { bumpWorkspaceScanEpoch } from './scan-epoch';
import { bumpValidationScopeEpoch } from './validation-scope';
import { getWorkspaceFoldersCached, searchFolderUris } from './workspace-folders';


/**
 * The server facilities the shared-base extraction runs against: the workspace folders it sweeps,
 * the open buffers whose unsaved text wins over disk, the client's edit channel, and the index
 * refresh a written file needs before it is validated again.
 *
 * @param progress the sweep's progress reporter, absent when a plan is being applied.
 * @returns the host for {@link extractSharedBase}.
 */
export function sharedBaseHost(
    progress: { report(percentage: number, message?: string): void } | undefined,
    inScope: ((fsPath: string) => boolean) | undefined
): SharedBaseHost {
    return {
        inScope,
        folderPaths: async () => ((await getWorkspaceFoldersCached()) ?? []).map((folder) => uriToFsPath(folder.uri)),
        openDocuments: () => documents.all(),
        applyEdit: async (changes) => (await connection.workspace.applyEdit({ changes })).applied,
        report: (percentage, message) => progress?.report(percentage, message),
        filesChanged: (paths) => {
            // The watcher reports the new file eventually. Doing it here as well keeps the base file
            // from being validated as unreachable, and its consumers as inheriting nothing, in the
            // window before that arrives.
            for (const path of paths) {
                invalidateFsPath(path);
                MentionIndex.instance.markDirty(path);
                const uri = filePathToUri(path);
                WorkspaceSymbolService.instance.markDirty(uri);
                SchemaIdIndex.instance.markDirty(uri);
                TemplateBaseIndex.instance.markDirty(uri);
                LocalizationKeyIndex.instance.markDirty(uri);
                ReverseIncludeIndex.instance.markDirty(uri);
                AddBaseIndex.instance.markDirty(uri);
                MemberInjectionIndex.instance.markDirty(uri);
                ActionRootingIndex.instance.markDirty(uri);
            }
            invalidateSchemaContextCache();
            // A brand-new base file is outside the manifest's reachability closure until it is redone.
            bumpValidationScopeEpoch();
            diagnosticsCache.clear();
            inlayHintCache.clear();
            bumpWorkspaceScanEpoch();
            clearSharedBaseScanCache();
        },
    };
}

/**
 * The server facilities the part registration runs against. Everything but the game registry is the
 * shared-base host's own, so the index refresh a written file needs stays defined in one place. It is
 * also the host the override generator runs against, whose needs are a subset of these.
 *
 * @returns the host for {@link registerPartInShip}.
 */
export function registerPartHost(): RegisterPartHost {
    const shared = sharedBaseHost(undefined, undefined);
    return {
        folderPaths: shared.folderPaths,
        openDocuments: shared.openDocuments,
        applyEdit: shared.applyEdit,
        gameRoot: () => CosmoteerWorkspaceService.instance.getCosmoteerRules(),
        dataRoot: () => CosmoteerWorkspaceService.instance.dataRootPath,
        filesChanged: (paths) => {
            shared.filesChanged(paths);
            // A written manifest changes the mod's reachability closure and its ModContext, which is
            // memoized per mod root and otherwise only dropped when a manifest is created or deleted,
            // so the freshly registered part would keep being reported as unreachable.
            if (paths.some((path) => isManifestBasename(basenameOf(path)))) invalidateModContext();
        },
    };
}

/**
 * The server facilities the clone runs against. The write and index-refresh half is the shared-base
 * host's own, so the set of indexes a written file dirties stays defined in one place, and the rest is
 * the three project lookups the copy needs: which ids are taken, which localization keys are taken,
 * and what the source's keys already say in each language.
 *
 * @returns the host for {@link cloneDeclaration}.
 */
export function cloneHost(): CloneHost {
    const shared = sharedBaseHost(undefined, undefined);
    return {
        folderPaths: shared.folderPaths,
        openDocuments: shared.openDocuments,
        applyEdit: shared.applyEdit,
        dataRoot: () => CosmoteerWorkspaceService.instance.dataRootPath,
        declaredIds: async (cls, cancellationToken) =>
            await SchemaIdIndex.instance.primaryIdsForClass(cls, await searchFolderUris(), cancellationToken),
        declaredKeys: async (cancellationToken) =>
            await LocalizationKeyIndex.instance.allKeysLower(await searchFolderUris(), cancellationToken),
        localizationTexts: async (key, cancellationToken) =>
            await LocalizationKeyIndex.instance.textsForKey(key, await searchFolderUris(), cancellationToken),
        filesChanged: (paths) => {
            shared.filesChanged(paths);
            // A copy written into a mod changes that mod's reachability closure and its ModContext,
            // which is memoized per mod root, so the new folder would keep reading as content the mod
            // never loads.
            if (paths.some((path) => isManifestBasename(basenameOf(path)))) invalidateModContext();
        },
    };
}

/**
 * The server facilities the new-content command runs against. The part registration's host is its
 * own, since creating a file needs exactly what registering one does, plus the project's id index so
 * an id that would collide with the game's own content is refused before anything is written.
 *
 * @returns the host for {@link newContent}.
 */
export function newContentHost(): NewContentHost {
    const shared = registerPartHost();
    return {
        ...shared,
        existingIds: async (cls, cancellationToken) =>
            await SchemaIdIndex.instance.idsForClass(
                cls,
                ((await getWorkspaceFoldersCached()) ?? []).map((folder) => uriToFsPath(folder.uri)),
                cancellationToken
            ),
    };
}
