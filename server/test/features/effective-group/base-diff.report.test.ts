import { readFileSync } from 'fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { generateBaseDiffReport } from '../../../src/features/effective-group/base-diff.report';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;

/** The workshop mod deriving a part from the fixture game tree. */
const OM_RULES = workspaceFile('..', 'workshop', 'om', 'om.rules');

/** The report for the first occurrence of `marker` in an on-disk fixture, parsed under its own uri. */
const reportInFile = async (path: string, marker: string): Promise<string> => {
    const text = readFileSync(path, 'utf8');
    const offset = text.indexOf(marker);
    if (offset < 0) throw new Error(`marker ${marker} not in ${path}`);
    const document = parser(lexer(text), filePathToUri(path)).value;
    return (await generateBaseDiffReport(document, offset, token)) ?? '';
};

/** The member names the comparison table lists, in the order it lists them. */
const members = (report: string): string[] =>
    [...report.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);

describe('what a group changes from the game', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('puts the value the game writes beside the value loaded here', async () => {
        const report = await reportInFile(OM_RULES, 'Mode = Any');
        expect(report).toMatch(/\| `Mode` \| `All` \| `Any` \| changed \|/);
    });

    it('leaves a member the group repeats word for word out of the table', async () => {
        // The mod writes `Type = MultiToggle` over the game's own `Type = MultiToggle`, so the game
        // loads exactly what it loaded before.
        expect(members(await reportInFile(OM_RULES, 'Mode = Any'))).toEqual(['Mode']);
    });

    it('names the base it compared against', async () => {
        const report = await reportInFile(OM_RULES, 'Mode = Any');
        expect(report).toContain('base_part.rules:');
    });

    it('compares a member whose value is a whole group', async () => {
        // At the part level the mod rewrites `HeatTarget` and carries a `Components` group of its
        // own, and neither is a value with a one-line spelling on both sides.
        const report = await reportInFile(OM_RULES, 'HeatTarget = OwnStorage');
        expect(report).toMatch(/\| `HeatTarget` \| `HeatStorageDistribution` \| `OwnStorage` \| changed \|/);
        expect(members(report)).toContain('Components');
    });

    it('answers nothing for a group the game ships itself', async () => {
        const text = readFileSync(workspaceFile('parts', 'base_part.rules'), 'utf8');
        const document = parser(lexer(text), filePathToUri(workspaceFile('parts', 'base_part.rules'))).value;
        expect(await generateBaseDiffReport(document, text.indexOf('Mode = All'), token)).toBeNull();
    });

    it('answers nothing for a group deriving from nothing the game ships', async () => {
        const source = ['Base', '{', '\tA = 1', '}', 'Derived : &Base', '{', '\tA = 9', '}', ''].join('\n');
        const document = parser(lexer(source), 'file:///inline.rules').value;
        expect(await generateBaseDiffReport(document, source.indexOf('A = 9'), token)).toBeNull();
    });
});
