import { buildModSchema, ModSchemaSummary } from '../features/mod-schema/mod-schema';
import { watchDirectories, watchModAssemblies } from '../features/mod-schema/watch';
import { extendSchemaWithMods, modSchemaSignature } from '../document/schema/schema';
import { invalidateSchemaContextCache } from '../document/schema/schema-context';
import { invalidateComponentIdCache } from '../features/diagnostics/validator.schema-sibling';
import { invalidateEffectiveChainCache } from '../semantics/effective-group';
import { invalidateLooseDeclarationCache } from '../features/diagnostics/validator.schema-id-reference';
import { localModDirs, workshopContentDir } from '../workspace/workshop-dir';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { globalSettings } from '../settings';
import { hasPullDiagnosticsCapability } from './capabilities';
import { connection, documents } from './context';
import { diagnosticsCache, inlayHintCache } from './document-caches';
import { schedulePushValidation } from './push-diagnostics';
import { bumpWorkspaceScanEpoch } from './scan-epoch';
import { workspaceFolderPaths } from './workspace-folders';

/**
 * The folders a code mod's assemblies can live in: every open workspace folder, plus the installed
 * workshop tree, whose mods supply types the edited files legitimately name even when the user is
 * not editing those mods.
 *
 * @returns the search roots, empty when there is nothing to search.
 */
async function modAssemblyRoots(): Promise<string[]> {
    const roots = await workspaceFolderPaths();
    const workshop = workshopContentDir();
    if (workshop) roots.push(workshop);
    // Mods the user installed by hand live outside the workshop tree, and their types are named by
    // the files being edited just the same.
    roots.push(...localModDirs());
    return roots;
}

/**
 * Load the code-mod schema at startup, reusing the cached extraction whenever the assemblies on
 * disk are unchanged.
 *
 * @returns once the extension is merged, or immediately when there is nothing to search.
 */
export async function loadModSchema(): Promise<void> {
    // Off means: no assembly walk, no assembly read, nothing merged.
    if (!codeModsEnabled()) {
        extendSchemaWithMods(undefined);
        return;
    }
    const roots = await modAssemblyRoots();
    if (roots.length === 0) return;
    const summary = await buildModSchema(roots, CosmoteerWorkspaceService.instance.dataRootPath ?? '');
    armModAssemblyWatch(summary.assemblyPaths, roots);
}

/** Whether a code mod's assemblies are read into the schema at all (`codeMods.enabled`). */
export const codeModsEnabled = (): boolean => globalSettings.codeMods?.enabled ?? true;

/** Whether those assemblies are watched, so a mod change is picked up without the command. */
export const codeModAutoRefreshEnabled = (): boolean => codeModsEnabled() && (globalSettings.codeMods?.autoRefresh ?? true);

/** Closes the watch armed for the previous build, so re-arming never leaks handles. */
let closeModAssemblyWatch: (() => void) | undefined;
/**
 * Closes the watch on the code mods' assemblies, after the user turned the feature (or its
 * auto-refresh) off. Re-arming goes through the normal build, which needs the assembly list.
 */
export function disarmModAssemblyWatch(): void {
    closeModAssemblyWatch?.();
    closeModAssemblyWatch = undefined;
}

/** True while a watcher-driven refresh is running, so a burst mid-rebuild coalesces into one rerun. */
let modSchemaRefreshRunning = false;
/** True when a change arrived while a refresh was running and has to be answered afterwards. */
let modSchemaRefreshQueued = false;

/**
 * Watch the assemblies the current extraction came from, so a mod installed, updated or rebuilt
 * after startup is merged without the user running the command.
 *
 * The client watches the workspace folders (the `.dll`/`.xml` glob registered above), which is where
 * a mod being developed lives. The installed workshop tree is outside every workspace folder, so it
 * is watched here.
 *
 * @param assemblyPaths the assemblies the build discovered, from its summary.
 * @param roots the search roots, watched so an installed or uninstalled mod is noticed as well.
 */
function armModAssemblyWatch(assemblyPaths: readonly string[], roots: readonly string[]): void {
    closeModAssemblyWatch?.();
    closeModAssemblyWatch = undefined;
    if (!codeModAutoRefreshEnabled()) return;
    closeModAssemblyWatch = watchModAssemblies(watchDirectories(assemblyPaths, roots), () => {
        void refreshModSchema();
    });
}

/**
 * Re-extract after a watched assembly or doc file changed, and re-run everything that depends on the
 * schema. Unlike the command this trusts the cache: the stamps of the changed file no longer match,
 * so the affected build misses it anyway, while an event that changed nothing relevant stays a cheap
 * cache hit.
 *
 * @returns once the new extraction is merged and the clients have been asked to re-pull.
 */
export async function refreshModSchema(): Promise<void> {
    if (!codeModAutoRefreshEnabled()) return;
    if (modSchemaRefreshRunning) {
        modSchemaRefreshQueued = true;
        return;
    }
    modSchemaRefreshRunning = true;
    try {
        const roots = await modAssemblyRoots();
        if (roots.length === 0) return;
        const before = modSchemaSignature();
        const summary = await buildModSchema(roots, CosmoteerWorkspaceService.instance.dataRootPath ?? '');
        armModAssemblyWatch(summary.assemblyPaths, roots);
        // A watcher fires for plenty that does not change the schema surface (a mod's `.deps.json`
        // rewritten beside its assembly, a touch that moved no bytes). Only tell the clients to
        // throw away their results when the merged surface actually moved.
        if (modSchemaSignature() === before) return;
        applyModSchemaChange();
        connection.console.info(
            `Code mod schema updated from disk: ${summary.types} types, ${summary.discriminators} discriminators, ` +
                `${summary.documented} documented fields from ${summary.assemblies} assemblies.`
        );
    } catch (e) {
        if (globalSettings.trace.server === 'messages') console.error(e);
    } finally {
        modSchemaRefreshRunning = false;
        if (modSchemaRefreshQueued) {
            modSchemaRefreshQueued = false;
            void refreshModSchema();
        }
    }
}

/**
 * Drop everything computed against the previous schema. The schema decides what every validator,
 * completion and hover answers, and the version-keyed caches would keep serving results computed
 * against the old one, since no document version moved.
 */
export function applyModSchemaChange(): void {
    diagnosticsCache.clear();
    inlayHintCache.clear();
    invalidateSchemaContextCache();
    invalidateComponentIdCache();
    invalidateEffectiveChainCache();
    invalidateLooseDeclarationCache();
    bumpWorkspaceScanEpoch();
    if (hasPullDiagnosticsCapability) connection.languages.diagnostics.refresh();
    else for (const document of documents.all()) schedulePushValidation(document);
}

/**
 * Re-extract every code mod's schema surface and re-run the diagnostics that depend on it. Unlike
 * the startup load this ignores the cache, so a mod the user just rebuilt is picked up even when
 * its assembly kept its timestamp.
 *
 * @returns the summary for the invoking client to display, or null without workspace folders.
 */
export async function rebuildModSchema(): Promise<ModSchemaSummary | null> {
    // The command respects the switch: rebuilding into a schema the user asked to keep mod-free
    // would quietly re-enable the feature they turned off.
    if (!codeModsEnabled()) {
        return { assemblies: 0, types: 0, discriminators: 0, fromCache: false, unreadable: [], documented: 0, assemblyPaths: [], disabled: true };
    }
    const roots = await modAssemblyRoots();
    if (roots.length === 0) return null;
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('Building code mod schema', 0, '', false);
    try {
        const summary = await buildModSchema(
            roots,
            CosmoteerWorkspaceService.instance.dataRootPath ?? '',
            { force: true }
        );
        armModAssemblyWatch(summary.assemblyPaths, roots);
        applyModSchemaChange();
        return summary;
    } finally {
        progress.done();
    }
}
