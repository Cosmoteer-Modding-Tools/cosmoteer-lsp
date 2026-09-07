import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { join, resolve } from 'path';

// The diagram page's pure layout, imported straight from the shipped media script (its
// module.exports guard activates outside a webview). A cycle in the graph is a thing these diagrams
// are asked to draw rather than a reason to refuse one, so the layering has to terminate on one.
const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const page = require(join(REPO_ROOT, 'media', 'diagram-view.js')) as {
    assignLayers(nodes: Array<{ id: string }>, edges: Array<{ from: string; to: string }>): Map<string, number>;
    orderLayers(
        nodes: Array<{ id: string }>,
        edges: Array<{ from: string; to: string }>,
        layer: Map<string, number>
    ): Map<string, number>;
    layoutDiagram(
        nodes: Array<{ id: string }>,
        edges: Array<{ from: string; to: string }>,
        metrics: { width: number; height: number; gapX: number; gapY: number }
    ): { boxes: Map<string, { x: number; y: number }>; width: number; height: number };
    edgePath(from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number; width: number; height: number }): string;
    edgeMidpoint(
        from: { x: number; y: number; width: number; height: number },
        to: { x: number; y: number; width: number; height: number }
    ): { x: number; y: number };
};

const METRICS = { width: 100, height: 40, gapX: 50, gapY: 10 };

describe('diagram layout', () => {
    it('puts a node after everything that points at it', () => {
        const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const edges = [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
        ];
        const layers = page.assignLayers(nodes, edges);
        expect(layers.get('a')).toBe(0);
        expect(layers.get('b')).toBe(1);
        expect(layers.get('c')).toBe(2);
    });

    // A factory's crew box both delivers and receives, which rings the graph. The ring must not
    // march the boxes off to the right pass after pass.
    it('keeps a ring of nodes as wide as its longest chain, not as wide as the pass bound', () => {
        const nodes = [{ id: 'crew' }, { id: 'consumer' }, { id: 'store' }, { id: 'converter' }, { id: 'out' }, { id: 'lone' }];
        const edges = [
            { from: 'crew', to: 'consumer' },
            { from: 'consumer', to: 'store' },
            { from: 'store', to: 'converter' },
            { from: 'converter', to: 'out' },
            { from: 'out', to: 'crew' },
        ];
        const layers = page.assignLayers(nodes, edges);
        expect(layers.get('crew')).toBe(0);
        expect(layers.get('consumer')).toBe(1);
        expect(layers.get('store')).toBe(2);
        expect(layers.get('converter')).toBe(3);
        expect(layers.get('out')).toBe(4);
        expect(layers.get('lone')).toBe(0);
        const laid = page.layoutDiagram(nodes, edges, METRICS);
        expect(laid.width).toBe(5 * METRICS.width + 4 * METRICS.gapX);
    });

    it('takes the longest path, not the first one found', () => {
        // `a` reaches `c` directly and through `b`, and the box has to sit past both.
        const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const edges = [
            { from: 'a', to: 'c' },
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
        ];
        expect(page.assignLayers(nodes, edges).get('c')).toBe(2);
    });

    it('terminates on a graph that leads back to itself', () => {
        const nodes = [{ id: 'a' }, { id: 'b' }];
        const edges = [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
        ];
        const layers = page.assignLayers(nodes, edges);
        expect(layers.size).toBe(2);
        expect([...layers.values()].every((value) => Number.isFinite(value))).toBe(true);
    });

    it('gives every node a box and measures the whole drawing', () => {
        const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const edges = [{ from: 'a', to: 'b' }];
        const laid = page.layoutDiagram(nodes, edges, METRICS);
        expect(laid.boxes.size).toBe(3);
        expect(laid.width).toBe(METRICS.width + METRICS.gapX + METRICS.width);
        expect(laid.height).toBeGreaterThanOrEqual(METRICS.height);
    });

    it('draws an arrow forwards between the two edges it joins', () => {
        const from = { x: 0, y: 0, width: 100, height: 40 };
        const to = { x: 150, y: 0, width: 100, height: 40 };
        expect(page.edgePath(from, to)).toMatch(/^M 100 20 C /);
    });

    it('bows a backwards arrow out rather than through the boxes', () => {
        const from = { x: 150, y: 0, width: 100, height: 40 };
        const to = { x: 0, y: 0, width: 100, height: 40 };
        const path = page.edgePath(from, to);
        // Both control points sit below the row, which is what keeps a cycle readable.
        const controls = [...path.matchAll(/(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)[,]/g)].map((match) => Number(match[2]));
        expect(controls.every((y) => y > 20)).toBe(true);
    });

    it('puts the words of a forward arrow in the gap between its two boxes', () => {
        const from = { x: 0, y: 0, width: 100, height: 40 };
        const to = { x: 150, y: 100, width: 100, height: 40 };
        const mid = page.edgeMidpoint(from, to);
        expect(mid.x).toBe(125);
        expect(mid.y).toBe(70);
    });

    it('puts the words of a backwards arrow at the bottom of its bow, under the row', () => {
        const from = { x: 150, y: 0, width: 100, height: 40 };
        const to = { x: 0, y: 0, width: 100, height: 40 };
        const mid = page.edgeMidpoint(from, to);
        expect(mid.x).toBe(125);
        expect(mid.y).toBeGreaterThan(40);
    });

    it('is stable across two runs of the same graph', () => {
        const nodes = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
        const edges = [
            { from: 'a', to: 'c' },
            { from: 'b', to: 'c' },
        ];
        const first = page.layoutDiagram(nodes, edges, METRICS);
        const second = page.layoutDiagram(nodes, edges, METRICS);
        for (const [id, box] of first.boxes) expect(second.boxes.get(id)).toEqual(box);
    });
});
