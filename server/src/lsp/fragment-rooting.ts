import { CancellationToken } from 'vscode-languageserver/node';
import { WatchedDocumentIndex } from '../features/navigation/watched-document-index';
import { ReverseIncludeIndex } from '../features/navigation/reverse-include.index';
import { SchemaIdIndex } from '../features/completion/schema-id.index';
import { TemplateBaseIndex } from '../features/diagnostics/template-base.index';
import { LocalizationKeyIndex } from '../features/completion/localization-key.index';
import { AddBaseIndex } from '../mod/add-base.index';
import { MemberInjectionIndex } from '../mod/member-injection.index';
import { ActionRootingIndex } from '../mod/action-rooting.index';
import { aliasRootIndex } from '../document/schema/alias-root';
import { ensureAliasRootIndex } from '../features/navigation/alias-root-builder';
import { invalidateSchemaContextCache } from '../document/schema/schema-context';
import { clearNavigationMemo } from '../features/navigation/full.navigation-strategy';
import { invalidateEffectiveChainCache } from '../semantics/effective-group';
import { modFolderPaths } from '../features/navigation/workspace-files';
import { perfCount } from '../utils/perf-counters';
import { searchFolderUris } from './workspace-folders';

/** Resolves {@link workspaceInitialized} once `onInitialized` settled the game-tree scan. */
let resolveWorkspaceInitialized: () => void;
/**
 * Settles once `onInitialized` finished initializing the Cosmoteer workspace (successfully or
 * not). A `didOpen` validation of an already-open file can arrive while that scan is still
 * running, and building the project indexes at that moment would bake in a folder set without the
 * game `Data` root. Every index would then silently lack the vanilla tree for the whole session.
 * {@link ensureFragmentRooting} awaits this before any index build.
 */
const workspaceInitialized = new Promise<void>((resolve) => {
    resolveWorkspaceInitialized = resolve;
});

/**
 * Whether the game tree scan has settled, as a plain flag beside {@link workspaceInitialized}. A
 * request that has to answer between keystrokes cannot await the promise, so occurrence highlighting
 * reads the flag and leaves the cross-file part of its answer out until the scan is done.
 */
export let workspaceReady = false;

/** Settles {@link workspaceInitialized} and flips {@link workspaceReady}, once the game-tree scan
 *  is done (successfully or not). Called from `onInitialized` and nowhere else. */
export function markWorkspaceReady(): void {
    resolveWorkspaceInitialized();
    workspaceReady = true;
}

/**
 * Times one startup index build into a `startup.*` counter. Unlike the scan's `timedPass`, these
 * always record: startup happens once per session, so the counters cost nothing and are the only
 * attribution of where a cold start goes (see server/test/perf/startup-bench.mjs).
 *
 * @param counter the counter to add the elapsed milliseconds to.
 * @param run the build to time.
 * @returns whatever `run` returns.
 */
export const timedStartupPhase = async <T>(counter: string, run: () => Promise<T> | T): Promise<T> => {
    const started = Date.now();
    try {
        return await run();
    } finally {
        perfCount(counter, Date.now() - started);
    }
};

/**
 * Makes both fragment-rooting indexes current before any synchronous schema resolution runs. A
 * standalone fragment file is rooted either forward, through `cosmoteer.rules`'s own aliases, or in
 * reverse, through the field that `&<includes>` it, so every schema feature awaits this so a fragment's
 * fields, references, and shader material resolve. The first call also builds the other project-wide
 * indexes over the same document walk, so completion and validation don't each pay a separate
 * whole-project parse later.
 *
 * @param cancellationToken cancels the reconcile of changed documents.
 * @returns once the indexes are built and the fragment-rooting ones are reconciled.
 */
export async function ensureFragmentRooting(cancellationToken: CancellationToken): Promise<void> {
    // Never build before `onInitialized` settled the game-tree scan: a validation of an
    // already-open file arrives earlier, and building then would permanently omit the game
    // `Data` root from every project index (they are one-time builds).
    await workspaceInitialized;
    // Only the rooting sources feed the schema-context memos: the forward alias walk, the
    // reverse-include index, and the mod-action rooting index. Snapshot their revisions so the
    // epoch below is only bumped when one of them actually moved. The whole-workspace scan calls
    // this once per file, and bumping unconditionally invalidated every memo on shared base nodes
    // several thousand times per scan.
    const rootingRevisionBefore =
        aliasRootIndex.revision + ReverseIncludeIndex.instance.revision + ActionRootingIndex.instance.revision;
    // The action indexes feed the resolver's `^/N`/injected-member extensions. When an edit to a
    // manifest or action fragment changes what they hold, references that resolved through them are
    // stale in the navigation memo (they never read the edited file, so the per-file memo drop misses
    // them). Snapshot their revisions and clear the memo below if a reconcile moved either.
    const actionRevisionBefore = AddBaseIndex.instance.revision + MemberInjectionIndex.instance.revision;
    await timedStartupPhase('startup.aliasRootMs', () => ensureAliasRootIndex(cancellationToken)).catch(
        () => undefined
    );
    const folders = await searchFolderUris();
    await timedStartupPhase('startup.buildTogetherMs', () =>
        WatchedDocumentIndex.buildTogether(
            [
                ReverseIncludeIndex.instance,
                SchemaIdIndex.instance,
                TemplateBaseIndex.instance,
                LocalizationKeyIndex.instance,
            ],
            folders,
            'Indexing project'
        )
    ).catch(() => undefined);
    await timedStartupPhase('startup.reverseIncludeMs', () =>
        ReverseIncludeIndex.instance.ensureBuilt(folders, cancellationToken)
    ).catch(() => undefined);
    // The AddBase index feeds the resolver's `^/N`-into-added-base extension, the Overrides index the
    // nested-Overrides member extension (both mod folders only, since the game Data tree carries no
    // mod actions). They share one walk of the mod tree instead of parsing all of it once each, which
    // is most of what a warm start used to spend.
    //
    // Sharing does move what each sees of the other: both resolve their action targets through the
    // reference resolver, which reads both extension sources, so during the shared walk each sees the
    // other populated only up to the current file rather than empty (AddBase, which used to run first)
    // or complete (Overrides, which used to run second). Only the Overrides direction can lose:
    // a target path stepping through `^/N` into a base that an AddBase in a later-walked file appends.
    // No such target is known to exist. Splitting the walk again is the fix if one ever shows up.
    //
    // ActionRootingIndex is deliberately not in this group, though it walks the same folders and
    // folding it in is tempting (it is the single biggest remaining startup phase). It resolves its
    // targets against a half-built AddBase/Overrides extension when it shares the walk, and the
    // damage is silent: a bogus `&/INDICATORS/DefinitelyNotReal` stops being flagged, because its
    // alias fallback answers from state the walk had not finished. A whole-mod scan is blind to this
    // class of damage and reports no difference. Only the end-to-end mod-driver's negative control
    // catches it, so measure with the mod-driver, not the scan, before touching this ordering again.
    //
    // They stay out of the cacheable group above on purpose: their state holds live AST nodes, which
    // no saved state can rehydrate, and a cacheId-less member in that group would disable the project
    // cache for all four. The ensureBuilt calls that follow find the build already done and only
    // reconcile dirty files, mirroring the reverse-include pattern above.
    await timedStartupPhase('startup.modActionWalkMs', () =>
        WatchedDocumentIndex.buildTogether(
            [AddBaseIndex.instance, MemberInjectionIndex.instance],
            modFolderPaths(folders),
            'Indexing mod actions'
        )
    ).catch(() => undefined);
    await timedStartupPhase('startup.addBaseMs', () =>
        AddBaseIndex.instance.ensureBuilt(folders, cancellationToken)
    ).catch(() => undefined);
    await timedStartupPhase('startup.memberInjectionMs', () =>
        MemberInjectionIndex.instance.ensureBuilt(folders, cancellationToken)
    ).catch(() => undefined);
    // The action-rooting index types action-wired fragments and inline action values from their
    // target slots. Built after the rooting indexes above, since the target slot types resolve
    // through them (mod folders only), and on its own walk. See the note above for what breaks
    // when it joins the shared one.
    await timedStartupPhase('startup.actionRootingMs', () =>
        ActionRootingIndex.instance.ensureBuilt(folders, cancellationToken)
    ).catch(() => undefined);
    // The action-rooting build re-roots fragments whose own includes then contribute new
    // reverse-include records (it marks those fragments dirty). Reconcile them here, repeating
    // while the reconcile still uncovers deeper chains, so the rooting revisions settle within
    // this call. Left to the next call, the late revision move would invalidate the scan-result
    // cache one pass after it was seeded and force a needless whole-workspace re-validation.
    for (let round = 0; round < 4; round++) {
        const reverseRevisionBefore = ReverseIncludeIndex.instance.revision;
        await ReverseIncludeIndex.instance.ensureBuilt(folders, cancellationToken).catch(() => undefined);
        if (ReverseIncludeIndex.instance.revision === reverseRevisionBefore) break;
    }
    // The builds above may have (re)rooted fragments, which changes what the per-node schema
    // resolution memos would answer, so start a fresh memo epoch for the features that follow.
    if (
        aliasRootIndex.revision + ReverseIncludeIndex.instance.revision + ActionRootingIndex.instance.revision !==
        rootingRevisionBefore
    ) {
        invalidateSchemaContextCache();
    }
    // A reconcile that changed an action index (a manifest/fragment edit added or removed an
    // AddBase/Overrides/Add) invalidates every `^/N`/injected-member resolution the memo cached.
    if (AddBaseIndex.instance.revision + MemberInjectionIndex.instance.revision !== actionRevisionBefore) {
        clearNavigationMemo();
        // The flatten memo is keyed on an epoch bumped when a file changes, which is before these
        // indexes have caught up, so a fold taken in that window holds the old injected members.
        invalidateEffectiveChainCache();
    }
}
