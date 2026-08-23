import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { computeModReachability, reachabilityKey, relativeToMod } from '../../src/mod/mod-reachability';
import { generateModOverview } from '../../src/mod/mod-overview';
import { clearModRootCache } from '../../src/mod/mod-root';
import { FIXTURES_DIR } from '../helpers';

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'reachability-mod');

describe('computeModReachability', () => {
    let reachable: Set<string>;
    let unreachable: string[];
    let deadReferencers: Map<string, string[]>;

    beforeAll(async () => {
        const result = await computeModReachability(MOD_DIR, token);
        expect(result).toBeDefined();
        reachable = result!.reachable;
        unreachable = result!.unreachable.map((file) => relativeToMod(MOD_DIR, file)).sort();
        deadReferencers = result!.deadReferencers;
    });

    const has = (rel: string): boolean => reachable.has(reachabilityKey(join(MOD_DIR, rel)));

    it('reaches the manifest, action sources, their includes and inheritance bases', () => {
        expect(has('mod.rules')).toBe(true);
        // The Add action's ToAdd source.
        expect(has('wired/a.rules')).toBe(true);
        // Reached through a.rules's `&<b.rules>` include and `: <../shared/base.rules>/Base` inheritance.
        expect(has('wired/b.rules')).toBe(true);
        expect(has('shared/base.rules')).toBe(true);
    });

    it('reaches the strings folder but not the unreferenced root cosmoteer.rules', () => {
        expect(has('strings/en.rules')).toBe(true);
        // The game applies actions to its own Data/cosmoteer.rules and never opens the mod's copy,
        // so an unreferenced root cosmoteer.rules is honestly unreachable (`AddTo = <cosmoteer.rules>`
        // is a TARGET and must not pull it in).
        expect(has('cosmoteer.rules')).toBe(false);
    });

    it('seeds nested manifests, resolving their sources relative to the manifest directory', () => {
        // The game discovers manifests with SearchOption.AllDirectories and can pick a nested one
        // by game-version priority, so a merged sub-mod's manifest seeds too.
        expect(has('nested/mod_sub.rules')).toBe(true);
        // `ToAdd = &<extra.rules>` names the file next to the nested manifest, not at the mod root.
        expect(has('nested/extra.rules')).toBe(true);
    });

    it('reports the orphan as unreachable and never lets an action TARGET reach a same-named mod file', () => {
        // `OverrideIn = <vanillaname.rules>` names a vanilla location. The mod's own
        // `vanillaname.rules` must not become reachable through that target path.
        expect(unreachable).toEqual([
            'cosmoteer.rules',
            'disabled/proto.rules',
            'orphan/dead (Kopie).rules',
            'orphan/dead.rules',
            'vanillaname.rules',
        ]);
    });

    it('does not reach a file whose only references are commented out', () => {
        // a.rules names proto.rules twice, once behind `//` and once inside `/* */`. The game
        // never follows disabled includes, so the file must stay unreachable (this kept a whole
        // commented-out prototype folder of a real mod wrongly inside the validation scope).
        expect(has('disabled/proto.rules')).toBe(false);
    });

    it('does not mistake `//` inside a string for a comment', () => {
        // The ref after the url on the same line must survive the comment strip.
        expect(has('wired/c.rules')).toBe(true);
    });

    it('records which unreachable files are referenced only from other unreachable files', () => {
        // dead.rules includes dead (Kopie).rules, but is itself dead, so the chain stays dead.
        const chained = deadReferencers.get(reachabilityKey(join(MOD_DIR, 'orphan/dead (Kopie).rules')));
        expect(chained?.map((file) => relativeToMod(MOD_DIR, file))).toEqual(['orphan/dead.rules']);
        // dead.rules and vanillaname.rules are referenced by nothing at all.
        expect(deadReferencers.has(reachabilityKey(join(MOD_DIR, 'orphan/dead.rules')))).toBe(false);
        expect(deadReferencers.has(reachabilityKey(join(MOD_DIR, 'vanillaname.rules')))).toBe(false);
    });

    it('annotates a comment-disabled file with the reachable file holding the commented reference', () => {
        // The commented-out line in a.rules is exactly what a modder must revive, so it is the
        // annotation, even though a.rules itself is reachable.
        const referencers = deadReferencers.get(reachabilityKey(join(MOD_DIR, 'disabled/proto.rules')));
        expect(referencers?.map((file) => relativeToMod(MOD_DIR, file))).toEqual(['wired/a.rules']);
    });

    it('returns undefined for a folder without a manifest', async () => {
        expect(await computeModReachability(join(MOD_DIR, 'wired'), token)).toBeUndefined();
    });

    it('matches `actions` and `Stringsfolder` case-insensitively like the game', async () => {
        // Published mods write these lowercased; the game's node lookup ignores case.
        const lowerDir = join(FIXTURES_DIR, 'reachability-mod-lowercase');
        const result = await computeModReachability(lowerDir, token);
        expect(result).toBeDefined();
        expect(result!.reachable.has(reachabilityKey(join(lowerDir, 'wired/a.rules')))).toBe(true);
        expect(result!.reachable.has(reachabilityKey(join(lowerDir, 'strings/en.rules')))).toBe(true);
        expect(result!.unreachable.map((file) => relativeToMod(lowerDir, file))).toEqual(['orphan.rules']);
    });
});

describe('computeModReachability with a virtual-inheritance Actions list', () => {
    // A manifest that builds `Actions` by concatenating other files' action lists via
    // `Actions: &<launcher.rules>/Actions, …` (the pvp-parts idiom). Those referenced files live
    // only in the list's inheritance, not its body, so they must be seeded from there.
    const REF_DIR = join(FIXTURES_DIR, 'reachability-mod-actionsref');
    let reachable: Set<string>;
    let unreachable: string[];

    beforeAll(async () => {
        const result = await computeModReachability(REF_DIR, token);
        expect(result).toBeDefined();
        reachable = result!.reachable;
        unreachable = result!.unreachable.map((file) => relativeToMod(REF_DIR, file)).sort();
    });

    const has = (rel: string): boolean => reachable.has(reachabilityKey(join(REF_DIR, rel)));

    it('reaches every action file the manifest concatenates via inheritance', () => {
        expect(has('mod.rules')).toBe(true);
        expect(has('launcher.rules')).toBe(true);
        expect(has('register.rules')).toBe(true);
    });

    it('cascades through a reached action file to the parts its actions add', () => {
        // launcher.rules's AddMany source `&<parts/foo.rules>/Part` expands once the file is reached.
        expect(has('parts/foo.rules')).toBe(true);
    });

    it('does not reach an action file referenced only behind a comment', () => {
        // `//&<disabled.rules>/Actions` is stripped at lex time and never becomes an inheritance ref.
        expect(unreachable).toEqual(['disabled.rules']);
    });
});

describe('generateModOverview', () => {
    let markdown: string;

    beforeAll(async () => {
        clearModRootCache();
        const uri = pathToFileURL(join(MOD_DIR, 'mod.rules')).href;
        markdown = (await generateModOverview(uri, [MOD_DIR], token))!;
        expect(markdown).toBeDefined();
    });

    it('renders the manifest header fields', () => {
        expect(markdown).toContain('# Mod overview — Reachability Fixture');
        expect(markdown).toContain('**ID**: Test.ReachMod');
        expect(markdown).toContain('**StringsFolder**: strings');
    });

    it('lists each action with verb, name, target and source', () => {
        expect(markdown).toContain('**Add** **WIRED** `<cosmoteer.rules>` ← `&<wired/a.rules>`');
        expect(markdown).toContain('**Overrides** `<vanillaname.rules>`');
    });

    it('marks a create-flagged action as not existence-checked and a dead target as broken', () => {
        // Action 1 carries CreateIfNotExisting, so existence is not a fact to report.
        expect(markdown).toMatch(/1\. · \*\*Add\*\*/);
        // Action 2 targets a vanilla file that does not exist anywhere.
        expect(markdown).toMatch(/2\. ✗ \*\*Overrides\*\*/);
        expect(markdown).toContain('1 action(s) have a target that resolves to nothing');
    });

    it('reports the reachability summary and the unreachable files', () => {
        expect(markdown).toContain('## File reachability');
        expect(markdown).toContain('### Unreachable files (5)');
        expect(markdown).toContain('orphan/dead.rules');
        expect(markdown).toContain('vanillaname.rules');
    });

    it('explains the root cosmoteer.rules convention instead of implying it was forgotten', () => {
        expect(markdown).toContain('never loads the mod\'s copy');
    });

    it('annotates dead chains with their unreachable referencer', () => {
        expect(markdown).toContain('3 of these are referenced by nothing at all. 2 are referenced only from');
        // The chained file points back at its dead referencer, linked like every other file.
        expect(markdown).toMatch(/\[orphan\/dead \(Kopie\)\.rules\]\([^)]+\) ← \[orphan\/dead\.rules\]\(/);
        // A comment-disabled file points at the reachable file holding the commented reference.
        expect(markdown).toMatch(/\[disabled\/proto\.rules\]\([^)]+\) ← \[wired\/a\.rules\]\(/);
        // Files referenced by nothing carry no arrow.
        expect(markdown).not.toMatch(/\[vanillaname\.rules\]\([^)]+\) ←/);
    });

    it('links files via vscode://file (the preview rejects file: links) with parentheses encoded', () => {
        // markdown-it's validateLink blocks the `file:` scheme, which left the raw `[…](…)` text
        // visible in the preview, and an unencoded `)` in a name would close the destination early.
        expect(markdown).not.toContain('](file:');
        expect(markdown).toContain('](vscode://file/');
        expect(markdown).toContain('[orphan/dead (Kopie).rules](');
        expect(markdown).toContain('dead%20%28Kopie%29.rules)');
    });
});

const REVIVAL_DIR = join(FIXTURES_DIR, 'revival-chain-mod');

describe('revival chains', () => {
    let markdown: string;
    let deadEdges: Map<string, string[]>;

    beforeAll(async () => {
        clearModRootCache();
        const result = await computeModReachability(REVIVAL_DIR, token);
        expect(result).toBeDefined();
        deadEdges = result!.deadEdges;
        markdown = (await generateModOverview(pathToFileURL(join(REVIVAL_DIR, 'mod.rules')).href, [REVIVAL_DIR], token))!;
    });

    it('keeps only the references a dead file really makes', () => {
        const commented = deadEdges.get(reachabilityKey(join(REVIVAL_DIR, 'dead', 'commented.rules')));
        expect(commented).toBeUndefined();
        const head = deadEdges.get(reachabilityKey(join(REVIVAL_DIR, 'dead', 'head.rules')));
        expect(head).toHaveLength(1);
    });

    it('counts the whole chain behind the file that heads it', () => {
        expect(markdown).toContain('#### Revival chains');
        expect(markdown).toMatch(/\[dead\/head\.rules\]\([^)]+\) · brings 2 files back with it/);
    });

    it('lists the chain that brings the most files back first', () => {
        // Wiring in a head brings every file behind it, so the row worth reading first is the one
        // that revives the most.
        const rows = markdown.split('\n').filter((line) => line.includes('back with it'));
        expect(rows[0]).toContain('zz_big/bighead.rules');
        expect(rows[0]).toContain('brings 3 files back with it');
        expect(rows[1]).toContain('dead/head.rules');
        expect(rows[2]).toContain('dead3/head.rules');
    });

    it('points at the commented-out line that disabled the chain', () => {
        expect(markdown).toMatch(/\[dead\/head\.rules\]\([^)]+\) · brings 2 files back with it ← \[wired\/live\.rules\]\(/);
    });

    it('leaves out a file whose only onward reference is commented out', () => {
        // It is still listed among the unreachable files, it just heads no chain.
        expect(markdown).toContain('dead/commented.rules');
        expect(markdown).not.toMatch(/\[dead\/commented\.rules\]\([^)]+\) · brings/);
    });

    it('collapses chains of the same name and size into one row', () => {
        // A mod that generates a family of parts from one template leaves one identical chain per
        // folder, and listing each of them reads as many findings where there is one.
        expect(markdown).toMatch(/brings 2 files back with it .* and 1 more of this name/);
        expect(markdown.match(/brings 2 files back with it/g)).toHaveLength(1);
    });

    it('keeps a same-named head of a different size in its own row', () => {
        // dead3/head.rules carries one file where the two chains above carry two, and folding it
        // into their row would hide a chain of a different size behind their count.
        expect(markdown).toMatch(/\[dead3\/head\.rules\]\([^)]+\) · brings one file back with it/);
        expect(markdown).not.toMatch(/brings one file back with it[^\n]*more of this name/);
    });

    it('offers neither half of a dead cycle as a chain head', () => {
        expect(markdown).not.toMatch(/\[dead\/cycle_[ab]\.rules\]\([^)]+\) · brings/);
    });
});
