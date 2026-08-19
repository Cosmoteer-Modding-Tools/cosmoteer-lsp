import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { readFileSync } from 'fs';
import { evaluateNumericValueTraced, Substitution } from '../../src/semantics/value-evaluator';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode } from '../../src/core/ast/ast';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { parseFixture, valueOf, walkAst } from '../helpers';
import { initWorkspace, workspaceFile } from '../workspace-helper';

const token = CancellationToken.None;

/**
 * The right-hand side of the `name = …` assignment, which every fixture here writes with a value.
 *
 * @param doc the parsed document to search.
 * @param name the assignment's field name.
 * @returns the assignment's value node.
 */
const rhsOf = (doc: AbstractNodeDocument, name: string): AbstractNode => {
    for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === name) return valueOf(node);
    throw new Error(`assignment ${name} not found`);
};

/** The parts of a substitution a test asserts on, dropping the uri (which is per-fixture). */
const shape = (entry: Substitution) => ({
    path: entry.path,
    value: entry.value,
    line: entry.line,
    depth: entry.depth,
});

/**
 * Trace an inline source's named assignment.
 *
 * @param source the whole document source.
 * @param name the assignment to evaluate.
 * @returns the traced value.
 */
const traceInline = (source: string, name: string) => {
    const doc = parser(lexer(source), 'file:///trace.rules').value;
    return evaluateNumericValueTraced(rhsOf(doc, name), token);
};

describe('substitution trace', () => {
    let math: AbstractNodeDocument;
    let repairCost: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        math = parseFixture('math.rules', 'file:///math.rules');
        repairCost = parseFixture('repaircost.rules', 'file:///repaircost.rules');
    });

    it('records each reference an expression substitutes, in source order', async () => {
        // Result = (&A) / (&B) + ceil(17 / 2), with A on file line 3 and B on file line 4.
        const traced = await evaluateNumericValueTraced(rhsOf(math, 'Result'), token);
        expect(traced.value).toBe(14);
        expect(traced.substitutions.map(shape)).toEqual([
            { path: '&A', value: 10, line: 2, depth: 0 },
            { path: '&B', value: 2, line: 3, depth: 0 },
        ]);
        expect(traced.omitted).toBe(0);
    });

    it('lists a reference an expression uses twice only once', async () => {
        // FractionalCostToRepair = (ceil((&Resources/0/1) / 5) / (&Resources/0/1)).
        const traced = await evaluateNumericValueTraced(rhsOf(math, 'FractionalCostToRepair'), token);
        expect(traced.value).toBe(0.2);
        expect(traced.substitutions.map(shape)).toEqual([{ path: '&Resources/0/1', value: 50, line: 11, depth: 0 }]);
        // A duplicate hides nothing that is not on screen already, so it is not reported as omitted.
        expect(traced.omitted).toBe(0);
    });

    it('nests a reference whose target is itself computed', async () => {
        const traced = await traceInline('BASE = 10\nMID = (&BASE) * 2\nX = (&MID) + 1\n', 'X');
        expect(traced.value).toBe(21);
        // Pre-order: the outer reference is reserved before its target is descended into, so it
        // stays ahead of what the descent finds even though the descent finishes first.
        expect(traced.substitutions.map(shape)).toEqual([
            { path: '&MID', value: 20, line: 1, depth: 0 },
            { path: '&BASE', value: 10, line: 0, depth: 1 },
        ]);
    });

    it('nests through a real fixture chain', async () => {
        // Part/FractionalCostToRepair reads Resources/0/1, whose own value is
        // ceil((&~/COST) * (&~/MULTIPLIKATOR)), so both operands come back one level down.
        const traced = await evaluateNumericValueTraced(rhsOf(repairCost, 'FractionalCostToRepair'), token);
        expect(traced.value).toBe(0.2);
        expect(traced.substitutions.map(shape)).toEqual([
            { path: '&Resources/0/1', value: 200, line: 9, depth: 0 },
            { path: '&~/COST', value: 100, line: 0, depth: 1 },
            { path: '&~/MULTIPLIKATOR', value: 2, line: 2, depth: 1 },
        ]);
    });

    it('reports where the number really lives when the target is a plain alias', async () => {
        // COST = &BASE_COST is dereferenced by the navigation itself, so `&~/COST` lands directly on
        // the 100 written on the first line rather than on the alias in between.
        const traced = await evaluateNumericValueTraced(rhsOf(repairCost, 'MaxHealth'), token);
        expect(traced.value).toBe(200);
        expect(traced.substitutions.map(shape)).toEqual([
            { path: '&~/COST', value: 100, line: 0, depth: 0 },
            { path: '&~/MULTIPLIKATOR', value: 2, line: 2, depth: 0 },
        ]);
    });

    it('names the file the value really comes from across files', async () => {
        // a.rules ToC = &<./Data/b.rules>/B/ToC, and b.rules ToC hops on to c.rules Leaf = 300.
        const path = workspaceFile('a.rules');
        const doc = parser(lexer(readFileSync(path, 'utf8')), path).value;
        const traced = await evaluateNumericValueTraced(rhsOf(doc, 'ToC'), token);
        expect(traced.value).toBe(300);
        expect(traced.substitutions).toHaveLength(1);
        expect(shape(traced.substitutions[0])).toEqual({
            path: '&<./Data/b.rules>/B/ToC',
            value: 300,
            line: 2,
            depth: 0,
        });
        expect(traced.substitutions[0].uri.replace(/\\/g, '/').endsWith('/c.rules')).toBe(true);
    });

    it('reports the base file when the value is inherited', async () => {
        const source = 'BaseArc\n{\n\tBaseValue = 90\n}\nArc : BaseArc\n{\n}\nRef = (&Arc/BaseValue) * 2\n';
        const traced = await traceInline(source, 'Ref');
        expect(traced.value).toBe(180);
        // Line 2 is the base's BaseValue, not the deriving group.
        expect(traced.substitutions.map(shape)).toEqual([{ path: '&Arc/BaseValue', value: 90, line: 2, depth: 0 }]);
    });

    it('records nothing when the expression does not evaluate', async () => {
        expect(await evaluateNumericValueTraced(rhsOf(math, 'Text'), token)).toEqual({
            value: null,
            substitutions: [],
            omitted: 0,
        });
    });

    it('stops recording past the depth cap', async () => {
        const source = 'L4 = 7\nL3 = (&L4) + 0\nL2 = (&L3) + 0\nL1 = (&L2) + 0\nX = (&L1) + 0\n';
        const traced = await traceInline(source, 'X');
        // The number is still the real one, only the recording stops.
        expect(traced.value).toBe(7);
        expect(traced.substitutions.map((entry) => entry.depth)).toEqual([0, 1, 2]);
        expect(traced.omitted).toBeGreaterThan(0);
    });

    it('stops recording past the entry cap', async () => {
        const declarations = Array.from({ length: 15 }, (_, index) => `N${index} = ${index + 1}`).join('\n');
        const sum = Array.from({ length: 15 }, (_, index) => `(&N${index})`).join(' + ');
        const traced = await traceInline(`${declarations}\nS = ${sum}\n`, 'S');
        expect(traced.value).toBe(120);
        expect(traced.substitutions).toHaveLength(12);
        expect(traced.omitted).toBe(3);
    });
});
