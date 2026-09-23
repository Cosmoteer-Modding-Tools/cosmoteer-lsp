import { WatchedDocumentIndex } from '../workspace/watched-document-index';
import { WorkspaceSymbolService } from '../features/navigation/workspace-symbol.service';
import { SchemaIdIndex } from '../features/completion/schema-id.index';
import { TemplateBaseIndex } from '../workspace/template-base.index';
import { LocalizationKeyIndex } from '../features/completion/localization-key.index';
import { ReverseIncludeIndex } from '../mod/reverse-include.index';
import { MentionIndex } from '../workspace/mention.index';
import { AddBaseIndex } from '../mod/add-base.index';
import { MemberInjectionIndex } from '../mod/member-injection.index';
import { ActionRootingIndex } from '../mod/action-rooting.index';
import { aliasRootIndex } from '../document/schema/alias-root';
import { invalidateShipLayers } from '../features/ships/ship-layer.index';
import { invalidatePartTableFor } from '../features/part-table/part-table.service';

/** The shared build walks `WatchedDocumentIndex.buildTogether` runs, see {@link PROJECT_INDEXES}. */
export type BuildGroup = 'project' | 'modAction';

/**
 * One project-wide index, described by the operations the shared sites may run on it. Every field
 * is optional, and an absent one is a statement about that index rather than an oversight: it
 * either has no such operation, or the shared site is the wrong place to run it. The entry says
 * which in a comment.
 */
export interface ProjectIndex {
    /** Drops everything the index holds, for the case where the resolved file set itself moved. */
    readonly reset?: () => void;
    /** Marks one file stale by uri, so the index re-reads it at its next query. */
    readonly markDirty?: (uri: string) => void;
    /** Drops a deleted file's contribution by uri. */
    readonly remove?: (uri: string) => void;
    /** The index's content revision, listed only where the content feeds scanned diagnostics. */
    readonly revision?: () => number;
    /** The shared walk this index is built on, when it shares one. */
    readonly buildGroup?: BuildGroup;
    /**
     * The index instance itself, for the shared walk. Read through a function so importing this
     * list never forces the index modules to have finished initializing first.
     */
    readonly watched?: () => WatchedDocumentIndex;
}

/**
 * Every index keyed to the project's file set, named once so the sites that reset, dirty, remove
 * from, build or revision-sum the family cannot drift apart.
 *
 * The declaration order is load-bearing for the build groups: {@link buildGroupMembers} keeps it,
 * and `buildTogether` feeds each document to its members in that order, which decides what each
 * member sees of the other's state during the shared walk. The reverse-include index leads the
 * project group for that reason. The remaining operations are per-index clears and dirty marks
 * that do not read each other, so their order carries nothing.
 */
export const PROJECT_INDEXES: readonly ProjectIndex[] = [
    {
        reset: () => ReverseIncludeIndex.instance.reset(),
        markDirty: (uri) => ReverseIncludeIndex.instance.markDirty(uri),
        remove: (uri) => ReverseIncludeIndex.instance.remove(uri),
        revision: () => ReverseIncludeIndex.instance.revision,
        buildGroup: 'project',
        watched: () => ReverseIncludeIndex.instance,
    },
    {
        reset: () => SchemaIdIndex.instance.reset(),
        markDirty: (uri) => SchemaIdIndex.instance.markDirty(uri),
        remove: (uri) => SchemaIdIndex.instance.remove(uri),
        revision: () => SchemaIdIndex.instance.revision,
        buildGroup: 'project',
        watched: () => SchemaIdIndex.instance,
    },
    {
        reset: () => TemplateBaseIndex.instance.reset(),
        markDirty: (uri) => TemplateBaseIndex.instance.markDirty(uri),
        remove: (uri) => TemplateBaseIndex.instance.remove(uri),
        revision: () => TemplateBaseIndex.instance.revision,
        buildGroup: 'project',
        watched: () => TemplateBaseIndex.instance,
    },
    {
        reset: () => LocalizationKeyIndex.instance.reset(),
        markDirty: (uri) => LocalizationKeyIndex.instance.markDirty(uri),
        remove: (uri) => LocalizationKeyIndex.instance.remove(uri),
        revision: () => LocalizationKeyIndex.instance.revision,
        buildGroup: 'project',
        watched: () => LocalizationKeyIndex.instance,
    },
    {
        // No revision. The symbol table answers navigation, and nothing a scanned file's
        // diagnostics are computed from reads it, so summing it would stale the scan-result cache
        // on every edit for nothing.
        reset: () => WorkspaceSymbolService.instance.reset(),
        markDirty: (uri) => WorkspaceSymbolService.instance.markDirty(uri),
        remove: (uri) => WorkspaceSymbolService.instance.remove(uri),
    },
    {
        // No revision, like the member-injection index below: the two feed the reference
        // resolver's extensions, and what that changes for a scanned file arrives through the
        // rooting revisions that are summed.
        reset: () => AddBaseIndex.instance.reset(),
        markDirty: (uri) => AddBaseIndex.instance.markDirty(uri),
        remove: (uri) => AddBaseIndex.instance.remove(uri),
        buildGroup: 'modAction',
        watched: () => AddBaseIndex.instance,
    },
    {
        reset: () => MemberInjectionIndex.instance.reset(),
        markDirty: (uri) => MemberInjectionIndex.instance.markDirty(uri),
        remove: (uri) => MemberInjectionIndex.instance.remove(uri),
        buildGroup: 'modAction',
        watched: () => MemberInjectionIndex.instance,
    },
    {
        // Deliberately in no build group. It resolves its targets through the two indexes above,
        // so sharing their walk would let it answer from a half-built extension state. See the
        // note in fragment-rooting.ts for what that breaks and how to measure it.
        reset: () => ActionRootingIndex.instance.reset(),
        markDirty: (uri) => ActionRootingIndex.instance.markDirty(uri),
        remove: (uri) => ActionRootingIndex.instance.remove(uri),
        revision: () => ActionRootingIndex.instance.revision,
    },
    {
        // No markDirty and no remove, both on purpose. The mention index reads disk alone (open
        // buffers are never consulted) and keys its dirty set by on-disk path rather than by uri,
        // so marking it from the per-file uri path would file the entry under a key no sync
        // matches and would re-read a file whose disk text never moved. The disk-change paths mark
        // it themselves with the path, which is also how a deletion reaches it: the next sync
        // finds the file gone and drops it, so there is nothing for a remove to do.
        reset: () => MentionIndex.instance.reset(),
        revision: () => MentionIndex.instance.revision,
    },
    {
        // Reset only. The index is built from the ship files and the manifests on disk, so an
        // unsaved edit cannot move it, and dropping it per keystroke re-walked the game tree for
        // every edit under `ships/`. The disk-change paths drop it through
        // `invalidateShipLayersFor`, which also decides whether the changed file could move it.
        reset: () => invalidateShipLayers(),
    },
    {
        // Revision only. The alias walk is rebuilt from `cosmoteer.rules` changes through
        // `aliasRootIndex.invalidate()`, which the paths that see such a change call themselves.
        revision: () => aliasRootIndex.revision,
    },
    {
        // Dirty marks and removals, which are the same call. The part table is a derived view
        // rather than an index the server builds up front, so there is nothing to reset or to
        // revision-sum, and a deleted file is a changed one: marking the parts written in it stale
        // is what makes the next build read them again, find nothing where the file stood, and
        // drop their rows. Without it a part deleted on disk keeps its row, its values and the
        // link to the file that is gone.
        markDirty: (uri) => invalidatePartTableFor(uri),
        remove: (uri) => invalidatePartTableFor(uri),
    },
];

/**
 * The members of one shared build walk, in the order {@link PROJECT_INDEXES} declares them.
 *
 * @param group the walk to collect.
 * @returns the indexes that share it.
 */
export const buildGroupMembers = (group: BuildGroup): WatchedDocumentIndex[] =>
    PROJECT_INDEXES.flatMap((index) => (index.buildGroup === group && index.watched ? [index.watched()] : []));
