import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Position } from 'vscode-languageserver';
import { readFileSync } from 'fs';
import { HoverService } from '../../../src/features/hover/hover.service';
import { AbstractNodeDocument, isAssignmentNode } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { parseFixture, walkAst } from '../../helpers';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;

/** Position over the key (left identifier) of the `name = …` assignment. */
const keyPosition = (doc: AbstractNodeDocument, name: string): Position => {
    for (const node of walkAst(doc)) {
        if (isAssignmentNode(node) && node.left.name === name) {
            const p = node.left.position;
            return Position.create(p.line, p.characterStart + 1);
        }
    }
    throw new Error(`assignment ${name} not found`);
};

const hoverText = async (doc: AbstractNodeDocument, name: string): Promise<string> => {
    const hover = await HoverService.instance.getHover(doc, keyPosition(doc, name), token);
    if (!hover) return '';
    const contents = hover.contents as { value: string };
    return contents.value;
};

/** Hover over a key of an inline source, parsed under a throwaway uri. */
const inlineHover = (source: string, name: string): Promise<string> =>
    hoverText(parser(lexer(source), 'file:///inline.rules').value, name);

// A computed hover shows one number, and reading where it came from used to mean following every
// reference by hand. The trace under it names each one, what it stood for, and where that lives.
describe('hover substitution trace', () => {
    let math: AbstractNodeDocument;
    let repairCost: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        math = parseFixture('math.rules', 'file:///math.rules');
        repairCost = parseFixture('repaircost.rules', 'file:///repaircost.rules');
    });

    afterEach(() => {
        globalSettings.hover.showSubstitutions = true;
    });

    it('puts the substituted references under the computed value', async () => {
        const text = await hoverText(math, 'Result');
        expect(text).toContain('**= 14**');
        expect(text).toContain('- `&A` = 10 on line 3');
        expect(text).toContain('- `&B` = 2 on line 4');
        expect(text.indexOf('**= 14**')).toBeLessThan(text.indexOf('- `&A`'));
    });

    it('indents a nested substitution', async () => {
        const text = await hoverText(repairCost, 'FractionalCostToRepair');
        expect(text).toContain('- `&Resources/0/1` = 200 on line 10\n  - `&~/COST` = 100 on line 1');
        expect(text).toContain('  - `&~/MULTIPLIKATOR` = 2 on line 3');
    });

    it('names the other file for a cross-file substitution', async () => {
        const path = workspaceFile('a.rules');
        const doc = parser(lexer(readFileSync(path, 'utf8')), path).value;
        const text = await hoverText(doc, 'ToC');
        expect(text).toContain('= 300 in c.rules:3');
    });

    it('shows the substituted number, not the written suffix', async () => {
        // The game hands mXparser the converted number, so a `300%` source substitutes as 3. The
        // unit belongs to the final slot and is already on the computed-value line above.
        expect(await inlineHover('F = 300%\nX = (&F) * 2\n', 'X')).toContain('`&F` = 3 on line 1');
    });

    it('adds nothing when the value has no references', async () => {
        const text = await hoverText(math, 'Simple');
        expect(text).toContain('= 12');
        expect(text).not.toContain('- `&');
    });

    it('is silent when the setting is off', async () => {
        globalSettings.hover.showSubstitutions = false;
        const text = await hoverText(math, 'Result');
        expect(text).toContain('= 14');
        expect(text).not.toContain('- `&A`');
    });

    it('leaves a non-numeric hover untouched', async () => {
        expect(await hoverText(math, 'Text')).toBe('');
    });
});
