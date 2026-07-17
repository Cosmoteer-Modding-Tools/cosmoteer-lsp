import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, GroupNode, isGroupNode, isListNode, isValueNode, ListNode } from '../../src/core/ast/ast';
import { parseFilePath } from '../../src/utils/ast.utils';
import { invalidateSchemaContextCache, memberTypeIn, resolveGroupClass } from '../../src/document/schema/schema-context';
import { ActionRootingIndex } from '../../src/mod/action-rooting.index';
import { parseModActions } from '../../src/mod/action-parser';
import { clearModRootCache } from '../../src/mod/mod-root';
import { invalidateModContext } from '../../src/mod/mod-context';
import { globalSettings } from '../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../workspace-helper';
import { FIXTURES_DIR } from '../helpers';

// End-to-end mod-action rooting over an on-disk fixture mod: files (and inline values) wired into
// the game tree only through mod.rules actions must type from the action's target slot. The mod
// (test/fixtures/action-rooting-mod/mod.rules) patches `parts/stats_part.rules` (a typed
// list<PartStatsCategory> slot) and `resources/testiron.rules` (a whole-file ResourceRules root),
// so every rooted fragment and inline value below has a schema ground truth to check against.
const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'action-rooting-mod');
const STATS_CATEGORY = 'Cosmoteer.Ships.Parts.PartStatsCategory';

const modFile = (name: string): string => join(MOD_DIR, name);

/** The named top-level group/list of a parsed document. */
const topLevel = (document: AbstractNodeDocument, name: string): GroupNode | ListNode | undefined =>
    document.elements.find(
        (element): element is GroupNode | ListNode =>
            (isGroupNode(element) || isListNode(element)) && element.identifier?.name === name
    );

beforeAll(async () => {
    await initWorkspace();
    globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    clearModRootCache();
    invalidateModContext();
    ActionRootingIndex.instance.reset();
    await ActionRootingIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, MOD_DIR], token);
    // The build recorded fresh roots, so the per-node schema memos must start a new epoch, exactly
    // as the server does after ensureFragmentRooting.
    invalidateSchemaContextCache();
});

afterAll(() => {
    ActionRootingIndex.instance.reset();
    invalidateSchemaContextCache();
});

describe('AddMany fragment rooting', () => {
    it('roots a whole `ManyToAdd = &<fragment>/Member` list as the target list type', async () => {
        const doc = await parseFilePath(modFile('extra_stats.rules'));
        const memberType = memberTypeIn(doc, 'ExtraStats');
        expect(memberType?.kind).toBe('list');
        const list = topLevel(doc, 'ExtraStats') as ListNode;
        const group = list.elements.find(isGroupNode)!;
        expect(resolveGroupClass(group)).toBe(STATS_CATEGORY);
        expect(memberTypeIn(group, 'NameKey')?.kind).toBe('string');
    });

    it('roots a fragment referenced as a single AddMany list element as the element class', async () => {
        const doc = await parseFilePath(modFile('one_stat.rules'));
        const group = topLevel(doc, 'OneStat') as GroupNode;
        expect(resolveGroupClass(group)).toBe(STATS_CATEGORY);
    });
});

describe('inline action values type inside the manifest', () => {
    it('types an inline `ToAdd { … }` group as the target list element class', async () => {
        const manifest = await parseFilePath(modFile('mod.rules'));
        const add = parseModActions(manifest).find((action) => action.type === 'Add')!;
        const toAdd = add.sources[0] as GroupNode;
        expect(isGroupNode(toAdd)).toBe(true);
        expect(resolveGroupClass(toAdd)).toBe(STATS_CATEGORY);
        expect(memberTypeIn(toAdd, 'NameKey')?.kind).toBe('string');
    });

    it('types an inline `ManyToAdd [ … ]` element group as the element class', async () => {
        const manifest = await parseFilePath(modFile('mod.rules'));
        const addMany = parseModActions(manifest).find(
            (action) => action.type === 'AddMany' && isListNode(action.sources[0])
        )!;
        const list = addMany.sources[0] as ListNode;
        const inline = list.elements.find(isGroupNode)!;
        expect(resolveGroupClass(inline)).toBe(STATS_CATEGORY);
    });
});

describe('AddBase and Overrides fragment rooting', () => {
    it('roots an AddBase fragment as the target group class (inheritance preserves type)', async () => {
        const doc = await parseFilePath(modFile('part_base.rules'));
        const root = ActionRootingIndex.instance.rootType(doc.uri);
        expect(root).toEqual({ kind: 'group', ref: 'Cosmoteer.Ships.Parts.PartRules', name: 'PartRules' });
        // The rooted file's own top-level members type through PartRules.
        expect(memberTypeIn(doc, 'Density')).toBeDefined();
    });

    it('roots a whole-file Overrides fragment as the target file root class', async () => {
        const doc = await parseFilePath(modFile('testiron_override.rules'));
        const root = ActionRootingIndex.instance.rootType(doc.uri);
        expect(root).toEqual({ kind: 'group', ref: 'Cosmoteer.Resources.ResourceRules', name: 'ResourceRules' });
        expect(memberTypeIn(doc, 'SellPrice')?.kind).toBe('int');
    });
});

describe('safe skips leave the fragment unrooted', () => {
    it('skips an index-based target', async () => {
        const doc = await parseFilePath(modFile('skip_index.rules'));
        expect(ActionRootingIndex.instance.rootType(doc.uri)).toBeUndefined();
        expect(memberTypeIn(doc, 'Skipped')).toBeUndefined();
        const group = topLevel(doc, 'Skipped') as GroupNode;
        expect(resolveGroupClass(group)).toBeUndefined();
    });

    it('skips a missing target', async () => {
        const doc = await parseFilePath(modFile('skip_missing.rules'));
        expect(ActionRootingIndex.instance.rootType(doc.uri)).toBeUndefined();
        expect(ActionRootingIndex.instance.memberType(doc.uri, 'Skipped')).toBeUndefined();
        expect(memberTypeIn(doc, 'Skipped')).toBeUndefined();
    });
});

describe('reconcile keeps records in step with the manifest', () => {
    it('drops a removed source contribution on removeSource', async () => {
        const doc = await parseFilePath(modFile('extra_stats.rules'));
        expect(ActionRootingIndex.instance.memberType(doc.uri, 'ExtraStats')).toBeDefined();
        ActionRootingIndex.instance.remove(modFile('mod.rules'));
        expect(ActionRootingIndex.instance.memberType(doc.uri, 'ExtraStats')).toBeUndefined();
        // Re-ingest for the tests that follow.
        ActionRootingIndex.instance.markDirty(modFile('mod.rules'));
        await ActionRootingIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, MOD_DIR], token);
        invalidateSchemaContextCache();
        expect(ActionRootingIndex.instance.memberType(doc.uri, 'ExtraStats')).toBeDefined();
    });
});

describe('the manifest itself parses the action vocabulary', () => {
    it('parses every fixture action to a known verb', async () => {
        const manifest = await parseFilePath(modFile('mod.rules'));
        const actions = parseModActions(manifest);
        expect(actions.length).toBe(7);
        expect(actions.every((action) => action.type !== 'Unknown')).toBe(true);
        expect(actions.filter((action) => isValueNode(action.sources[0])).length).toBeGreaterThan(0);
    });
});
