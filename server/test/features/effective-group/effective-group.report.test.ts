import { readFileSync } from 'fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { generateEffectiveGroupReport } from '../../../src/features/effective-group/effective-group.report';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;

const parse = (source: string): AbstractNodeDocument => parser(lexer(source), 'file:///inline.rules').value;

/** The report for the offset of the first occurrence of `marker` in the source. */
const reportAt = async (source: string, marker: string): Promise<string> => {
    const offset = source.indexOf(marker);
    if (offset < 0) throw new Error(`marker ${marker} not in source`);
    return (await generateEffectiveGroupReport(parse(source), offset, token)) ?? '';
};

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
        const path = workspaceFile('parts', 'derived_part.rules');
        const text = readFileSync(path, 'utf8');
        const document = parser(lexer(text), filePathToUri(path)).value;
        const report = (await generateEffectiveGroupReport(document, text.indexOf('Mode = Any'), token)) ?? '';
        expect(report).toContain('`Type`');
        expect(report).toContain('base_part.rules');
        expect(report).toContain('`Mode`');
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
