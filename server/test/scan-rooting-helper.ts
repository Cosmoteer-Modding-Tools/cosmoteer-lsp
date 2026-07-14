import { CancellationToken } from 'vscode-languageserver';
import { invalidateSchemaContextCache } from '../src/document/schema/schema-context';
import { ReverseIncludeIndex } from '../src/features/navigation/reverse-include.index';
import { ActionRootingIndex } from '../src/mod/action-rooting.index';

/**
 * Brings mod-action rooting online for a scan harness, mirroring the production sequence in
 * server.ts `ensureFragmentRooting`: build the {@link ActionRootingIndex} after the reverse-include
 * index, re-pump the reverse-include index while the action build keeps dirty-marking chained
 * fragments, then start a fresh schema-context memo epoch so the new roots take effect. The
 * production routine lives inside server.ts's connection wiring (it awaits `workspaceInitialized`
 * and the server's own folder list), so it cannot be imported without standing up a server. The
 * post-reverse-include part of its sequence is mirrored here once and shared by the scan harnesses.
 *
 * Call after the harness built its reverse-include index over the same folders. Starts from a
 * clean index, so a per-mod harness loop stays isolated from the previous mod's action roots.
 *
 * @param folders the scan's project folders (the game Data tree plus the mod folders).
 * @param token cancels the index reconciles.
 * @returns once the action-rooting index is built and the rooting has converged.
 */
export const buildActionRootingForScan = async (folders: string[], token: CancellationToken): Promise<void> => {
    ActionRootingIndex.instance.reset();
    // The action-rooting index types action-wired fragments and inline action values from their
    // target slots, resolved through the alias and reverse-include indexes built before this call.
    await ActionRootingIndex.instance.ensureBuilt(folders, token).catch(() => undefined);
    // The action-rooting build re-roots fragments whose own includes then contribute new
    // reverse-include records (it marks those fragments dirty). Reconcile them, repeating while the
    // reconcile still uncovers deeper chains, exactly like the production convergence loop.
    for (let round = 0; round < 4; round++) {
        const reverseRevisionBefore = ReverseIncludeIndex.instance.revision;
        await ReverseIncludeIndex.instance.ensureBuilt(folders, token).catch(() => undefined);
        if (ReverseIncludeIndex.instance.revision === reverseRevisionBefore) break;
    }
    // The builds above (re)rooted fragments, which changes what the per-node schema resolution
    // memos would answer, so start a fresh memo epoch for the validation that follows.
    invalidateSchemaContextCache();
};

/**
 * Drops the scan's action-rooting state so it cannot leak into a later test sharing this worker,
 * the counterpart of the reverse-include and alias resets the harnesses already do.
 */
export const resetActionRootingForScan = (): void => {
    ActionRootingIndex.instance.reset();
    invalidateSchemaContextCache();
};
