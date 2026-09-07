import { describe, expect, it } from 'vitest';
import { chainSeries, legendFor } from '../../../src/features/diagram/diagram-series';
import { DiagramEdge } from '../../../src/features/diagram/diagram.types';

const flow = (from: string, to: string, series?: string): DiagramEdge => ({ from, to, kind: 'flow', series });

describe('chain series', () => {
    it('gives everything one start reaches the name of that start', () => {
        const edges = chainSeries([flow('turret', 'gun'), flow('gun', 'hit'), flow('hit', 'sound')], (id) => id);
        expect(edges.map((edge) => edge.series)).toEqual(['turret', 'turret', 'turret']);
    });

    it('keeps two chains apart where they never meet', () => {
        const edges = chainSeries([flow('turret', 'gun'), flow('scorched', 'smoke')], (id) => id);
        expect(edges.map((edge) => edge.series)).toEqual(['turret', 'scorched']);
    });

    it('lets the first start keep an arrow two starts reach', () => {
        // A colour that changed partway along would read as a chain that ends there.
        const edges = chainSeries([flow('a', 'shared'), flow('b', 'shared'), flow('shared', 'end')], (id) => id);
        expect(edges.map((edge) => edge.series)).toEqual(['a', 'b', 'a']);
    });

    it('starts a ring nothing points into from its first written box', () => {
        const edges = chainSeries([flow('x', 'y'), flow('y', 'x')], (id) => id);
        expect(edges.map((edge) => edge.series)).toEqual(['x', 'x']);
    });

    it('names a series the way the caller says', () => {
        const edges = chainSeries([flow('c:turret', 'c:gun')], (id) => id.replace('c:', '').toUpperCase());
        expect(edges[0].series).toBe('TURRET');
    });
});

describe('legend for a diagram with series', () => {
    const legend = [
        { kind: 'component' as const, label: 'box' },
        { kind: 'flow' as const, label: 'plain arrow' },
    ];

    it('drops the plain arrow entry when every flow arrow has a series', () => {
        expect(legendFor(legend, [flow('a', 'b', 'heat')]).map((entry) => entry.kind)).toEqual(['component']);
    });

    it('keeps it while one arrow is still drawn plain', () => {
        expect(legendFor(legend, [flow('a', 'b', 'heat'), flow('b', 'c')]).map((entry) => entry.kind)).toEqual([
            'component',
            'flow',
        ]);
    });
});
