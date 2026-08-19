import { describe, expect, it } from 'vitest';
import { AbstractNode, isAssignmentNode } from '../../src/core/ast/ast';
import { parseText } from '../../src/utils/ast.utils';
import { formatWithUnit, sourceUnitOf } from '../../src/semantics/value-units';

/** The right-hand side of the first `key = value` in the source, as the evaluator would see it. */
const rightOf = (source: string): AbstractNode[] => {
    const document = parseText(source, 'file:///t.rules');
    const assignment = document.elements.find(isAssignmentNode);
    if (!assignment?.right) throw new Error('no assignment in test source');
    return [assignment.right];
};

describe('sourceUnitOf', () => {
    it('reads the angle suffixes', () => {
        expect(sourceUnitOf(rightOf('A = 90d'))).toBe('angle');
        expect(sourceUnitOf(rightOf('A = 2.5r'))).toBe('angle');
    });

    it('reads the percent suffix, spaced or not', () => {
        expect(sourceUnitOf(rightOf('A = 50%'))).toBe('percent');
        expect(sourceUnitOf(rightOf('A = 12.5 %'))).toBe('percent');
    });

    it('leaves a plain number and a quoted literal unlabelled', () => {
        expect(sourceUnitOf(rightOf('A = 5'))).toBeUndefined();
        expect(sourceUnitOf(rightOf('A = "50%"'))).toBeUndefined();
    });

    it('carries the unit through plain arithmetic', () => {
        expect(sourceUnitOf(rightOf('A = 180d / 2'))).toBe('angle');
        expect(sourceUnitOf(rightOf('A = 50% * 4'))).toBe('percent');
    });

    it('refuses when two units disagree', () => {
        expect(sourceUnitOf(rightOf('A = 90d + 50%'))).toBeUndefined();
    });

    it('refuses inside a function call, which may change the unit', () => {
        // `deg(90d)` answers degrees, not the radians its operand carried.
        expect(sourceUnitOf(rightOf('A = deg(90d)'))).toBeUndefined();
    });

    it('refuses across an operator that does not preserve the unit', () => {
        expect(sourceUnitOf(rightOf('A = 90d ^ 2'))).toBeUndefined();
    });
});

describe('formatWithUnit', () => {
    it('renders an angle as the stored radians and the degrees they are', () => {
        expect(formatWithUnit(-0.04363323129985824, 'angle')).toBe('-0.043633 rad (-2.5°)');
        expect(formatWithUnit(2.792526803190927, 'angle')).toBe('2.792527 rad (160°)');
        expect(formatWithUnit(2.5, 'angle')).toBe('2.5 rad (143.239449°)');
    });

    it('renders a fraction with its percent', () => {
        expect(formatWithUnit(2, 'percent')).toBe('2 (200%)');
        expect(formatWithUnit(0.5, 'percent')).toBe('0.5 (50%)');
    });

    it('renders a duration in seconds', () => {
        expect(formatWithUnit(1.5, 'seconds')).toBe('1.5 s');
    });

    it('leaves an unknown unit exactly as the evaluator formatted it', () => {
        expect(formatWithUnit(14, undefined)).toBe('14');
    });
});
