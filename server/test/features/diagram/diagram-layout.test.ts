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
