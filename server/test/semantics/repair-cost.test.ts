import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Range } from 'vscode-languageserver';
import { evaluateNumericValue } from '../../src/semantics/value-evaluator';
import { InlayHintService } from '../../src/features/inlay/inlay-hint.service';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode } from '../../src/core/ast/ast';
import { parseFixture, valueOf, walkAst } from '../helpers';
import { initWorkspace } from '../workspace-helper';

const token = CancellationToken.None;

/**
 * The value of a named assignment anywhere in a document.
 *
 * @param doc the parsed document to search.
 * @param name the assignment's field name.
 * @returns the assignment's value node.
 */
const rhsOf = (doc: AbstractNodeDocument, name: string): AbstractNode => {
    for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === name) return valueOf(node);
    throw new Error(`assignment ${name} not found`);
};

/**
 * Regression coverage for a real part file: a cost computed inside the `Resources` list and a
 * `FractionalCostToRepair` that dereferences that same list element twice in one expression.
 */
describe('repair-cost real-world shape', () => {
    let doc: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        doc = parseFixture('repaircost.rules', 'file:///repaircost.rules');
    });

    it('resolves a reference assignment to its target number (COST = &BASE_COST)', async () => {
        expect(await evaluateNumericValue(rhsOf(doc, 'COST'), token)).toBe(100);
    });

    it('computes math living inside the Resources list (ceil((&COST)*(&MULT)) = 200)', async () => {
        expect(await evaluateNumericValue(rhsOf(doc, 'MaxHealth'), token)).toBe(200);
    });

    it('dereferences the same list element twice in one expression (diamond, not a cycle)', async () => {
        // &Resources/0/1 -> ceil(100*2)=200, used twice: ceil(200/5)/200 = 40/200 = 0.2.
        // Reusing one node on two branches must not be mistaken for a reference cycle.
        expect(await evaluateNumericValue(rhsOf(doc, 'FractionalCostToRepair'), token)).toBe(0.2);
    });

    it('shows inlay hints for the reference assignment, list math and the repair fraction', async () => {
        const hints = await InlayHintService.instance.getInlayHints(doc, Range.create(0, 0, 100, 0), token);
        const labelOnLine = (line: number) => hints.filter((h) => h.position.line === line).map((h) => h.label);
        expect(labelOnLine(1)).toContain('= 100'); // COST = &BASE_COST (reference assignment)
        expect(labelOnLine(9)).toContain('= 200'); // ceil(...) inside the Resources list
        expect(labelOnLine(13)).toContain('= 0.2'); // FractionalCostToRepair
    });
});
