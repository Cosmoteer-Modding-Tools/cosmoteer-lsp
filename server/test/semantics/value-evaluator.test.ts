import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Range } from 'vscode-languageserver';
import { evaluateNumericValue } from '../../src/semantics/value-evaluator';
import { InlayHintService } from '../../src/features/inlay/inlay-hint.service';
import { AbstractNodeDocument, isAssignmentNode } from '../../src/core/ast/ast';
import { parseFixture, walkAst } from '../helpers';
import { initWorkspace } from '../workspace-helper';

const token = CancellationToken.None;

/** The right-hand side of the `name = …` assignment. */
const rhsOf = (doc: AbstractNodeDocument, name: string) => {
    for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === name) return node.right;
    throw new Error(`assignment ${name} not found`);
};

describe('value-evaluator', () => {
    let doc: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        doc = parseFixture('math.rules', 'file:///math.rules');
    });

    it('evaluates pure arithmetic with correct precedence', async () => {
        expect(await evaluateNumericValue(rhsOf(doc, 'Simple'), token)).toBe(12);
        expect(await evaluateNumericValue(rhsOf(doc, 'Precedence'), token)).toBe(14); // 2 + (3*4)
    });

    it('evaluates function calls', async () => {
        expect(await evaluateNumericValue(rhsOf(doc, 'WithFunc'), token)).toBe(4); // sqrt(16)
    });

    it('resolves references and combines with functions: (&A)/(&B) + ceil(17/2) = 14', async () => {
        expect(await evaluateNumericValue(rhsOf(doc, 'Result'), token)).toBe(14); // 10/2 + ceil(8.5)=9
    });

    it('resolves nested functions over indexed-path refs: (ceil((&R/0/1)/5)/(&R/0/1)) = 0.2', async () => {
        // FractionalCostToRepair: &Resources/0/1 = 50 -> ceil(50/5)=10 -> 10/50 = 0.2
        expect(await evaluateNumericValue(rhsOf(doc, 'FractionalCostToRepair'), token)).toBe(0.2);
    });

    it('evaluates the boolean & like mXparser: nonzero operands are true, result is 1 or 0', async () => {
        expect(await evaluateNumericValue(rhsOf(doc, 'BoolAnd'), token)).toBe(1); // (&A=10) & (&B=2)
        expect(await evaluateNumericValue(rhsOf(doc, 'BoolAndZero'), token)).toBe(0); // (0) & (&A=10)
    });

    it('converts the game number suffixes: degrees to radians, radians pass through', async () => {
        expect(await evaluateNumericValue(rhsOf(doc, 'Degrees'), token)).toBeCloseTo(Math.PI / 2, 10); // 90d
        expect(await evaluateNumericValue(rhsOf(doc, 'Radians'), token)).toBe(2.5); // 2.5r
        expect(await evaluateNumericValue(rhsOf(doc, 'DegreesMath'), token)).toBeCloseTo(Math.PI / 2, 10); // 180d / 2
    });

    it('returns null for non-numeric values', async () => {
        expect(await evaluateNumericValue(rhsOf(doc, 'Text'), token)).toBeNull();
    });
});

describe('InlayHintService', () => {
    let doc: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        doc = parseFixture('math.rules', 'file:///math.rules');
    });

    it('emits a `= N` hint only for computable math/function assignments', async () => {
        const hints = await InlayHintService.instance.getInlayHints(doc, Range.create(0, 0, 100, 0), token);
        const labels = hints.map((h) => h.label).sort();

        expect(labels).toContain('= 12'); // Simple
        expect(labels).toContain('= 4'); // WithFunc
        expect(labels).toContain('= 14'); // Result
        expect(labels).toContain('= 0.2'); // FractionalCostToRepair (nested ceil over indexed refs)
        // No hints for plain numbers or strings.
        expect(hints.some((h) => h.label === '= 5')).toBe(false); // Plain = 5 (not an expression)
        expect(hints.every((h) => typeof h.label === 'string' && h.label.startsWith('='))).toBe(true);
    });

    it('annotates each math segment inside a list literal', async () => {
        // ArrayMath = [10 * 2, &A + 5, 30] -> hints for `10*2`=20 and `&A+5`=15, none for bare 30.
        const hints = await InlayHintService.instance.getInlayHints(doc, Range.create(0, 0, 100, 0), token);
        const onListLine = hints.filter((h) => h.position.line === 13).map((h) => h.label);
        expect(onListLine).toContain('= 20'); // 10 * 2
        expect(onListLine).toContain('= 15'); // &A (=10) + 5  — relative ref resolved out of the list
        expect(onListLine).not.toContain('= 30'); // bare value, not computed
    });

    it('respects the requested line range', async () => {
        const hints = await InlayHintService.instance.getInlayHints(doc, Range.create(0, 0, 2, 0), token);
        // Lines 0-2 hold Calc/{/A — no expression assignments there.
        expect(hints.length).toBe(0);
    });
});
