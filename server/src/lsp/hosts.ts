import { CancellationToken } from 'vscode-languageserver';
import { SharedBaseHost } from '../features/refactor/shared-base/shared-base.types';
import { clearSharedBaseScanCache } from '../features/refactor/shared-base/mod-scan';
import { RegisterPartHost } from '../features/refactor/register-part/register-part.types';
import { CloneHost } from '../features/refactor/clone-declaration/clone.types';
import { ExtractGroupHost } from '../features/refactor/extract-group/extract-group.types';
import { CreateComponentHost } from '../features/refactor/create-component/create-component.types';
import { NewContentHost } from '../features/refactor/new-content/new-content.command';
import { RegisterShipHost } from '../features/ships/register-ship.command';
import { NewFactionHost } from '../features/ships/new-faction.types';
import { NewTechHost } from '../features/ships/new-tech.types';
import { partStatsIndex } from '../features/part-table/part-table.service';
import { ensureParserResult } from './open-documents';
import { shipLayerContext } from './ship-layers';
import { normalizeUri } from '../features/navigation/reference-location';
import { SchemaIdIndex } from '../features/completion/schema-id.index';
import { isEnglish, LocalizationKeyIndex } from '../features/completion/localization-key.index';
import { MentionIndex } from '../features/navigation/mention.index';
import { invalidateModContext } from '../mod/mod-context';
import { invalidateSchemaContextCache } from '../document/schema/schema-context';
import { basenameOf, isManifestBasename } from '../document/document-kind';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { invalidateFsPath } from '../workspace/fs-cache';
import { filePathToUri } from '../features/navigation/navigation-strategy';
import { connection, documents } from './context';
import { diagnosticsCache, inlayHintCache } from './document-caches';
import { markProjectIndexesDirty } from './open-documents';
import { invalidateShipLayersFor } from './ship-layers';
import { bumpWorkspaceScanEpoch } from './scan-epoch';
import { bumpValidationScopeEpoch } from './validation-scope';
import { searchFolderUris, workspaceFolderPaths } from './workspace-folders';


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
        folderPaths: workspaceFolderPaths,
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
                markProjectIndexesDirty(filePathToUri(path));
                invalidateShipLayersFor(filePathToUri(path));
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
 * The server facilities the "create the component this names" fix runs against: the open buffers it
 * reads the part from, and the client's edit channel for a client that asked the server to write the
 * declaration rather than placing it as a snippet itself.
 *
 * @returns the host for {@link createComponent}.
 */
export function createComponentHost(): CreateComponentHost {
    const shared = sharedBaseHost(undefined, undefined);
    return { openDocuments: shared.openDocuments, applyEdit: shared.applyEdit };
}

/**
 * The server facilities the "move this block into its own file" refactoring runs against: the open
 * buffers it reads the block from, the client's edit channel for the reference that replaces it, and
 * the index refresh the written file needs before anything is validated against it.
 *
 * @returns the host for {@link extractGroupToFile}.
 */
export function extractGroupHost(): ExtractGroupHost {
    const shared = sharedBaseHost(undefined, undefined);
    return {
        openDocuments: shared.openDocuments,
        applyEdit: shared.applyEdit,
        filesChanged: shared.filesChanged,
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
            await SchemaIdIndex.instance.idsForClass(cls, await workspaceFolderPaths(), cancellationToken),
    };
}

/**
 * The server facilities the register-ship command runs against: the part registration's host, the
 * part walk the table already keeps, the project's built-in ship ids for the collision check, and
 * the language files for the faction names.
 *
 * @returns the host for {@link registerShip}.
 */
export function registerShipHost(): RegisterShipHost {
    const shared = registerPartHost();
    return {
        ...shared,
        layerContext: shipLayerContext,
        partStats: (context, modRoot, cancellationToken) =>
            partStatsIndex(
                {
                    context,
                    modRoot,
                    // The editor's own parse of a part being edited, so an unsaved change to a part's
                    // cost reaches the ship's value.
                    openDocument: (fsPath) => {
                        const wanted = normalizeUri(fsPath);
                        const open = documents.all().find((document) => normalizeUri(document.uri) === wanted);
                        return open ? ensureParserResult(open.uri) : undefined;
                    },
                },
                cancellationToken
            ),
        existingIds: async (cls, cancellationToken) =>
            await SchemaIdIndex.instance.idsForClass(cls, await workspaceFolderPaths(), cancellationToken),
        localizedName,
    };
}

/**
 * The text a localization key shows, English first and any language when there is no English.
 *
 * @param key the key path.
 * @param cancellationToken cancels the lookup.
 * @returns the text, or undefined when no language file declares the key.
 */
const localizedName = async (key: string, cancellationToken: CancellationToken): Promise<string | undefined> => {
    const texts = await LocalizationKeyIndex.instance.textsForKey(key, await searchFolderUris(), cancellationToken);
    return texts.find((text) => isEnglish(text.language))?.text ?? texts[0]?.text;
};

/**
 * The server facilities the new-tech command runs against: the new-content host plus the language
 * files, for the part and tech names the pickers show.
 *
 * @returns the host for {@link newTech}.
 */
export function newTechHost(): NewTechHost {
    return { ...newContentHost(), localizedName };
}

/**
 * The server facilities the new-faction command runs against: the new-content host, which writes
 * files and language keys, plus the game root for the registries the faction is wired into.
 *
 * @returns the host for {@link newFaction}.
 */
export function newFactionHost(): NewFactionHost {
    return { ...newContentHost(), layerContext: shipLayerContext };
}
