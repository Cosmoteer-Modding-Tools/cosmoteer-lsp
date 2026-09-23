import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode } from '../../src/core/ast/ast';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import { evaluateNumericValue } from '../../src/semantics/value-evaluator';
import { sourceUnitOf, unitForValue } from '../../src/features/value-units';
import { walkAst } from '../helpers';
import { initWorkspace } from '../workspace-helper';

const token = CancellationToken.None;

/** Parses an inline source under a throwaway uri, so no schema types any of its fields. */
const parse = (source: string): AbstractNodeDocument => parser(lexer(source), 'file:///inline.rules').value;

/** The right-hand side of the named assignment. */
const rhsOf = (doc: AbstractNodeDocument, name: string): AbstractNode => {
    for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === name && node.right) return node.right;
    throw new Error(`assignment ${name} not found`);
};

// `deg` and `rad` are mXparser's angle-unit conversions, read off the shipped
// MathParser.org-mXparser.dll rather than off its documentation.
describe('deg and rad', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('reads a degree-suffixed angle back as the degrees it was written in', async () => {
        const doc = parse(['FiringArc = 200d', 'Arc = deg(&FiringArc)', ''].join('\n'));
        expect(await evaluateNumericValue(rhsOf(doc, 'Arc'), token)).toBe(200);
    });

    it('turns degrees into the radians the game stores', async () => {
        const doc = parse(['Turn = rad(200)', ''].join('\n'));
        expect(await evaluateNumericValue(rhsOf(doc, 'Turn'), token)).toBeCloseTo(3.490658503988659, 12);
    });

    it('folds a deg call wrapped around another function', async () => {
        const doc = parse(['Spread = deg(asin(0.5))', ''].join('\n'));
        expect(await evaluateNumericValue(rhsOf(doc, 'Spread'), token)).toBe(30);
    });

    it('leaves a recognized function the registry does not implement unevaluated', async () => {
        // The negative control for the entries above: `sinc` is a valid mXparser name with no
        // implementation here, so it must stay null rather than pick one up by accident.
        const doc = parse(['Sinc = sinc(1)', ''].join('\n'));
        expect(await evaluateNumericValue(rhsOf(doc, 'Sinc'), token)).toBeNull();
    });

    it('renders a deg result without a unit, since the call decides none and the slot types none', async () => {
        // A deg result is already degrees. Reading a unit off the call, or off an angle-typed slot,
        // would convert it a second time and show 200 radians where the game has 200 degrees.
        const doc = parse(['FiringArc = 200d', 'Arc = deg(&FiringArc)', ''].join('\n'));
        const call = rhsOf(doc, 'Arc');
        expect(sourceUnitOf([call])).toBeUndefined();
        expect(await unitForValue([call], token)).toBeUndefined();
    });
});
