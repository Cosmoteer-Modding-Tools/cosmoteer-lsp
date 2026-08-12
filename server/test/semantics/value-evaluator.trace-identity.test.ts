import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { AbstractNode, AssignmentNode, isAssignmentNode } from '../../src/core/ast/ast';
import { evaluateNumericValue, evaluateNumericValueTraced } from '../../src/semantics/value-evaluator';
import { parseFixture, valueOf, walkAst } from '../helpers';
import { initWorkspace } from '../workspace-helper';
import { ORACLE } from './mx-oracle';

const token = CancellationToken.None;

/** The numeric fixtures, covering references, list indexes, suffixes, functions and every operator. */
const NUMERIC_FIXTURES = ['math.rules', 'repaircost.rules', 'operators.rules', 'mxfuncs.rules'];

/**
 * The value of `X = <source>`, the assignment each oracle expression is parsed as.
 *
 * @param source the expression to parse as X's value.
 * @returns the assignment's value node.
 */
const rhsOf = (source: string): AbstractNode => {
    const doc = parser(lexer(`X = ${source}\n`), 'file:///mx.rules').value;
    const assignment = doc.elements.find((node) => isAssignmentNode(node)) as AssignmentNode;
    expect(assignment, `no assignment parsed from: ${source}`).toBeDefined();
    return valueOf(assignment);
};

// The trace is a side channel on the one evaluator, so the traced and untraced entry points are the
// same arithmetic producing the same number. This suite is the tripwire against a future fork: were
// the traced path ever duplicated, every mXparser fix would have to be made twice.
describe('the traced entry point returns the untraced number', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    for (const [source, expected] of ORACLE) {
        it(`${source} = ${expected}`, async () => {
            const right = rhsOf(source);
            const untraced = await evaluateNumericValue(right, token);
            const traced = await evaluateNumericValueTraced(right, token);
            // toBe is Object.is, so a NaN or -0 divergence fails here too.
            expect(traced.value).toBe(untraced);
            expect(traced.value).toBe(expected);
        });
    }

    for (const fixture of NUMERIC_FIXTURES) {
        it(`agrees on every assignment of ${fixture}`, async () => {
            const doc = parseFixture(fixture, `file:///${fixture}`);
            let checked = 0;
            for (const node of walkAst(doc)) {
                if (!isAssignmentNode(node) || !node.right) continue;
                const untraced = await evaluateNumericValue(node.right, token);
                const traced = await evaluateNumericValueTraced(node.right, token);
                expect(traced.value, `${fixture}: ${node.left.name}`).toBe(untraced);
                checked++;
            }
            expect(checked).toBeGreaterThan(0);
        });
    }

    it('does not leak a trace between calls', async () => {
        const doc = parseFixture('math.rules', 'file:///math.rules');
        let right: AbstractNode | undefined;
        for (const node of walkAst(doc)) {
            if (isAssignmentNode(node) && node.left.name === 'Result') right = valueOf(node);
        }
        expect(right, 'assignment Result not found').toBeDefined();
        const first = await evaluateNumericValueTraced(right!, token);
        const second = await evaluateNumericValueTraced(right!, token);
        // The sink is built per call, so a second evaluation neither appends to nor dedupes against
        // the first one's entries.
        expect(second).toEqual(first);
        expect(second.substitutions).toHaveLength(2);
    });
});
