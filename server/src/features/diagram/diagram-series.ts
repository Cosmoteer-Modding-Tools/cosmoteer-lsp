import { DiagramEdge, DiagramEdgeKind, DiagramNodeKind } from './diagram.types';

/** One entry of a diagram's legend. */
type LegendEntry = { readonly kind: DiagramNodeKind | DiagramEdgeKind; readonly label: string };

/**
 * Drops the plain flow-arrow entry from a legend whose flow arrows every one carry a series. The page
 * adds a swatch per series, and beside those a swatch for a colour no arrow has is a key to nothing.
 *
 * @param legend the legend the builder wrote.
 * @param edges the diagram's arrows.
 * @returns the legend, without the flow entry when no arrow is drawn in the flow colour.
 */
export const legendFor = (legend: readonly LegendEntry[], edges: readonly DiagramEdge[]): LegendEntry[] => {
    const plain = edges.some((edge) => edge.kind === 'flow' && !edge.series);
    return legend.filter((entry) => entry.kind !== 'flow' || plain);
};

/**
 * Gives every arrow of a chain the series of the box the chain starts from, so one colour follows a
 * trigger through everything it sets off.
 *
 * A start is a box nothing points at, taken in the order the arrows were written. What one start
 * reaches is its chain, and an arrow two starts reach keeps the first, since a colour that changed
 * partway would read as a chain that ends. A ring nothing outside points at has no start, so the
 * first box of its first unclaimed arrow stands in for one.
 *
 * @param edges the arrows, in the order they were written.
 * @param nameOf the words a start is known by, which become the series and its swatch.
 * @returns the same arrows, each with its series.
 */
export const chainSeries = (edges: readonly DiagramEdge[], nameOf: (id: string) => string): DiagramEdge[] => {
    const outgoing = new Map<string, number[]>();
    const pointedAt = new Set<string>();
    edges.forEach((edge, index) => {
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
        outgoing.get(edge.from)!.push(index);
        pointedAt.add(edge.to);
    });
    const series = new Array<string | undefined>(edges.length);
    const claim = (start: string): void => {
        const name = nameOf(start);
        const queue = [start];
        const visited = new Set<string>([start]);
        for (let head = 0; head < queue.length; head++) {
            for (const index of outgoing.get(queue[head]) ?? []) {
                if (series[index] !== undefined) continue;
                series[index] = name;
                const next = edges[index].to;
                if (!visited.has(next)) {
                    visited.add(next);
                    queue.push(next);
                }
            }
        }
    };
    for (const edge of edges) if (!pointedAt.has(edge.from)) claim(edge.from);
    for (let index = 0; index < edges.length; index++) {
        if (series[index] === undefined) claim(edges[index].from);
    }
    return edges.map((edge, index) => ({ ...edge, series: series[index] }));
};
