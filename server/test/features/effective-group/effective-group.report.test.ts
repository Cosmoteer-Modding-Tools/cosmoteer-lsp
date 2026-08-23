import { readFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { generateEffectiveGroupReport } from '../../../src/features/effective-group/effective-group.report';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { AddBaseIndex } from '../../../src/mod/add-base.index';
import { MemberInjectionIndex } from '../../../src/mod/member-injection.index';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { globalSettings } from '../../../src/settings';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace, workspaceFile, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const token = CancellationToken.None;

const parse = (source: string): AbstractNodeDocument => parser(lexer(source), 'file:///inline.rules').value;

/** The report for the offset of the first occurrence of `marker` in the source. */
const reportAt = async (source: string, marker: string): Promise<string> => {
    const offset = source.indexOf(marker);
    if (offset < 0) throw new Error(`marker ${marker} not in source`);
    return (await generateEffectiveGroupReport(parse(source), offset, token)) ?? '';
};

/** The report for the first occurrence of `marker` in an on-disk fixture, parsed under its own uri. */
const reportInFile = async (path: string, marker: string): Promise<string> => {
    const text = readFileSync(path, 'utf8');
    const offset = text.indexOf(marker);
    if (offset < 0) throw new Error(`marker ${marker} not in ${path}`);
    const document = parser(lexer(text), filePathToUri(path)).value;
    return (await generateEffectiveGroupReport(document, offset, token)) ?? '';
};

/** The member names the "Changed from the game's own files" table lists, in the order it lists them. */
const changedMembers = (report: string): string[] => {
    const section = report.split("## Changed from the game's own files")[1] ?? '';
    const table = section.split('\n## ')[0];
    return [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
};

/** The workshop mod deriving a part from the fixture game tree. */
const OM_RULES = workspaceFile('..', 'workshop', 'om', 'om.rules');

describe('effective group report', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('lists an inherited member with the file it comes from', async () => {
        const source = ['Base', '{', '\tA = 1', '}', 'Derived : &Base', '{', '\tB = 2', '}', ''].join('\n');
        const report = await reportAt(source, 'B = 2');
        expect(report).toContain('`A`');
        expect(report).toContain('`B`');
        expect(report).toContain('inherited from');
        expect(report).toContain('written here');
    });

    it('names what an override shadows rather than calling it dead', async () => {
        const source = ['Base', '{', '\tA = 1', '}', 'Derived : &Base', '{', '\tA = 9', '}', ''].join('\n');
        const report = await reportAt(source, 'A = 9');
        expect(report).toContain('shadows');
        // Nothing here may claim the base's line is removable: other files derive from it too.
        expect(report).not.toMatch(/dead|remove/i);
    });

    it('says outright that a report is incomplete when a base cannot be read', async () => {
        const source = ['Derived : &NoSuchBase', '{', '\tA = 1', '}', ''].join('\n');
        const report = await reportAt(source, 'A = 1');
        expect(report).toContain('incomplete');
        expect(report).toContain('`&NoSuchBase`');
        expect(report).toContain('resolves to nothing');
    });

    it('folds a real cross-file caret chain', async () => {
        const report = await reportInFile(workspaceFile('parts', 'derived_part.rules'), 'Mode = Any');
        expect(report).toContain('`Type`');
        expect(report).toContain('base_part.rules');
        expect(report).toContain('`Mode`');
    });

    it('names what a mod loads in place of the value the game writes', async () => {
        const report = await reportInFile(OM_RULES, 'Mode = Any');
        expect(report).toContain("Changed from the game's own files");
        expect(report).toContain('`Mode`');
        expect(report).toContain('`All`');
        expect(report).toContain('`Any`');
    });

    it('leaves a value the mod repeats word for word out of the changed table', async () => {
        const report = await reportInFile(OM_RULES, 'Mode = Any');
        // The mod writes `Type = MultiToggle` over the game's own `Type = MultiToggle`, so the game
        // loads there exactly what it loaded before and no value was changed.
        expect(changedMembers(report)).toEqual(['Mode']);
        expect(report).toMatch(/\| `Mode` \| `All` \| `Any` \|/);
        // The member is folded in and does shadow the game's own line, so the changed table is the
        // only thing leaving it out.
        expect(report).toMatch(/\| `Type` \| `MultiToggle` \| written here.*shadows \[base_part\.rules:11\]/);
    });

    it('leaves a member with no one-line spelling out of the changed table', async () => {
        const report = await reportInFile(OM_RULES, 'HeatTarget = OwnStorage');
        expect(report).toMatch(/\| `HeatTarget` \| `HeatStorageDistribution` \| `OwnStorage` \|/);
        // The mod also overrides `Components`, a group the game writes as a group too, and two
        // placeholders side by side would claim a comparison the report cannot show.
        expect(changedMembers(report)).toEqual(['HeatTarget']);
        // It is folded in and shadows the game's own group, so the changed table is the only thing
        // leaving it out.
        expect(report).toMatch(/\| `Components` \| \*group of 1\* \| written here.*shadows \[base_part\.rules:8\]/);
    });

    it("counts a folder whose name merely starts with `Data` as none of the game's own files", async () => {
        const report = await reportInFile(workspaceFile('..', 'DataOld', 'om.rules'), 'Mode = Any');
        // `DataOld` sits next to the game's `Data` folder rather than inside it, so what it writes
        // is a mod's value and belongs in the changed table.
        expect(report).toContain("Changed from the game's own files");
        expect(changedMembers(report)).toEqual(['Mode']);
    });

    it("says nothing about the game's files for a chain that never reaches them", async () => {
        const source = ['Base', '{', '\tA = 1', '}', 'Derived : &Base', '{', '\tA = 2', '}', ''].join('\n');
        const report = await reportAt(source, 'A = 2');
        expect(report).not.toContain('Changed from');
    });

    it('reports on the enclosing group when the caret sits in a list', async () => {
        const source = ['Owner', '{', '\tItems', '\t[', '\t\tA', '\t]', '\tOther = 1', '}', ''].join('\n');
        const report = await reportAt(source, 'A\n');
        // A list has no member names of its own, so the answer is about the group holding it.
        expect(report).toContain('`Items`');
        expect(report).toContain('`Other`');
    });

    it('answers for the document root when the caret is outside every group', async () => {
        const source = ['RootLeaf = 3', '', 'Group', '{', '\tX = 1', '}', ''].join('\n');
        const report = await reportAt(source, 'RootLeaf');
        expect(report).toContain('`RootLeaf`');
        expect(report).toContain('`Group`');
    });
});

describe('effective group report over a mod that patches the game tree', () => {
    const MOD_DIR = join(FIXTURES_DIR, 'action-resolution-mod');
    let gamePath = '';

    beforeAll(async () => {
        await initWorkspace();
        gamePath = globalSettings.cosmoteerPath;
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        invalidateModContext();
        AddBaseIndex.instance.reset();
        MemberInjectionIndex.instance.reset();
        await AddBaseIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, MOD_DIR], token);
        await MemberInjectionIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, MOD_DIR], token);
    });

    afterAll(() => {
        AddBaseIndex.instance.reset();
        MemberInjectionIndex.instance.reset();
        globalSettings.cosmoteerPath = gamePath;
        clearModRootCache();
        invalidateModContext();
    });

    it('names the mod action a member was merged in by', async () => {
        const report = await reportInFile(workspaceFile('parts', 'derived_part.rules'), '// Deep descendant');
        // The game merges what an `Add` action supplies into the target group as it loads, so the
        // member is neither written in this file nor inherited from a base of it.
        expect(report).toMatch(/\| `AddedComp` \| \*group of 2\* \| merged in by a mod action, \[mod\.rules:\d+\]/);
        // A member the file writes itself still says so, next to the merged ones.
        expect(report).toMatch(/\| `IsOperational` \| \*group of 1\* \| written here, \[derived_part\.rules:\d+\]/);
    });
});
