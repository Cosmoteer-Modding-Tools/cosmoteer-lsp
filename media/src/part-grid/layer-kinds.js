// The layer-kind registry.
//
// Everything one `layer.kind` does is declared in one entry here, so adding a kind is one new entry
// rather than a new arm in five switch chains scattered over the page. The counting and the undo
// accessors are written out below, because they are pure and unit tested. The rendering, the click
// handling and the sidebar panel are filled in by `main.js` out of the maps that `layer-draw.js`,
// `hit-test.js` and `panels.js` each export, which is what keeps this module free of any dependency
// on the drawing half of the page.

/**
 * A member of a layer that holds exactly one value, paired with the reader the undo path uses
 * to capture the previous value and the writer the optimistic local apply uses.
 * @typedef {object} LayerMember
 * @property {(layer: any) => any} read
 * @property {(layer: any, value: any) => void} write
 */

/**
 * Everything the page knows about one layer kind.
 * @typedef {object} LayerKind
 * @property {(layer: any) => number} count how many authored entries the layer holds.
 * @property {LayerMember} [point] the single point member, read and written by `setPoint`.
 * @property {LayerMember} [number] the single number member, read and written by `setNumber`.
 * @property {(layer: any, color: string, active: boolean, ghost: boolean) => void} [draw]
 * @property {(layer: any, gesture: any) => void} [hitTest] handles a canvas mousedown.
 * @property {(layer: any, section: any) => void} [panel] fills the sidebar panel.
 */

/** @type {Record<string, LayerKind>} */
export const LAYER_KINDS = {
    cellSet: {
        count: (layer) => layer.cells.length,
    },
    cellToValues: {
        count: (layer) => layer.entries.length,
    },
    pointList: {
        count: (layer) => layer.points.length,
    },
    cellPairList: {
        count: (layer) => layer.pairs.length,
    },
    point: {
        count: (layer) => (layer.point ? 1 : 0),
        point: { read: (layer) => layer.point, write: (layer, value) => (layer.point = value) },
    },
    cell: {
        count: (layer) => (layer.cell ? 1 : 0),
    },
    cellDirection: {
        count: (layer) => (layer.cell ? 1 : 0),
    },
    cellRay: {
        count: (layer) => (layer.cell ? 1 : 0),
        number: { read: (layer) => layer.maxTiles, write: (layer, value) => (layer.maxTiles = value) },
    },
    polygon: {
        count: (layer) => layer.vertices.length,
    },
    circle: {
        // A written zero is a value, not an absence: the payload says so by typing these as
        // `number | null`, where null is "unreadable or not written". Counting truthiness
        // instead would hide a `Radius = 0` layer, leaving it switched off with no badge even
        // though the author wrote it.
        count: (layer) => (layer.center || typeof layer.radius === 'number' ? 1 : 0),
        point: { read: (layer) => layer.center, write: (layer, value) => (layer.center = value) },
        number: { read: (layer) => layer.radius, write: (layer, value) => (layer.radius = value) },
    },
    edgeRegion: {
        // `Distance = 0` is a legal value meaning the region is exactly the part rect, so it
        // counts like any other written distance. See the note on the circle entry above.
        count: (layer) => (typeof layer.distance === 'number' ? 1 : 0),
        number: { read: (layer) => layer.distance, write: (layer, value) => (layer.distance = value) },
    },
    rectList: {
        count: (layer) => layer.entries.length,
    },
    componentPoints: {
        count: (layer) => layer.entries.length,
    },
    rect: {
        count: (layer) => (layer.rect ? 1 : 0),
    },
};

/**
 * How many authored entries a layer holds, which the layer list shows as its badge and the
 * first render uses to decide which layers start visible.
 *
 * @param layer the layer to count.
 * @returns the entry count, 0 for an empty layer and for a kind this page does not know.
 */
export function countOf(layer) {
    const kind = LAYER_KINDS[layer.kind];
    return kind ? kind.count(layer) : 0;
}

/**
 * The point member a `setPoint` mutation reads and writes on a layer, defaulting to `point` for
 * a kind that names no other.
 *
 * @param layer the layer the mutation targets.
 * @returns the member accessors.
 */
export function pointMemberOf(layer) {
    const kind = LAYER_KINDS[layer.kind];
    return (
        (kind && kind.point) || {
            read: (target) => target.point,
            write: (target, value) => (target.point = value),
        }
    );
}

/**
 * The number member a `setNumber` mutation reads and writes on a layer. A kind that holds no
 * single number reads null and writes nothing, which is what the pre-registry chain did.
 *
 * @param layer the layer the mutation targets.
 * @returns the member accessors.
 */
export function numberMemberOf(layer) {
    const kind = LAYER_KINDS[layer.kind];
    return (kind && kind.number) || { read: () => null, write: () => {} };
}
