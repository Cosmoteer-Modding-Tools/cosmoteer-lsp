import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Position } from 'vscode-languageserver';
import { HoverService } from '../../../src/features/hover/hover.service';
import { AbstractNodeDocument, isAssignmentNode } from '../../../src/core/ast/ast';
import { parseFixture, walkAst } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

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

describe('HoverService', () => {
    let doc: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        doc = parseFixture('math.rules', 'file:///math.rules');
    });

    it('shows the computed result of a math expression', async () => {
        expect(await hoverText(doc, 'Result')).toContain('= 14');
    });

    it('shows the computed result of nested functions over indexed refs', async () => {
        expect(await hoverText(doc, 'FractionalCostToRepair')).toContain('= 0.2');
    });

    it('shows a reference target value and its resolved number', async () => {
        const text = await hoverText(doc, 'RefToA');
        expect(text).toContain('= 10'); // &A resolves to 10
        expect(text).toContain('→'); // and points at the target
    });

    it('returns nothing for a plain string value', async () => {
        expect(await hoverText(doc, 'Text')).toBe('');
    });
});
