// The command-pattern half of undo: the mutation that exactly reverts another one, computed against
// the payload state BEFORE that mutation is applied.
//
// The inverse replays through the normal edit pipeline, so stale protection and inherited-field
// materialization still apply. A mutation whose prior state cannot be restored has no inverse, and
// the caller clears the history rather than keeping it wrong.
//
// One builder per operation, in a table rather than a switch, for the same reason the layer kinds
// sit in a registry: an operation the page can send is one entry here, and the entry is next to the
// operation it reverts rather than in the middle of a chain twenty arms long.

import { chainParentTransform, rotateDegrees, rotationKeyOf } from './geometry.js';
import { numberMemberOf, pointMemberOf } from './layer-kinds.js';

/**
 * The inverse of each mutation operation, taking the mutation, the payload as it stands before the
 * mutation is applied, and the layer the mutation names (absent for the whole-part operations).
 * Each builder returns null when the prior state cannot be restored.
 */
const INVERSE_BUILDERS = {
    addCell: (mutation) => ({ op: 'removeCell', layerId: mutation.layerId, cell: mutation.cell }),
    removeCell: (mutation) => ({ op: 'addCell', layerId: mutation.layerId, cell: mutation.cell }),
    setEntryValues: (mutation, data, layer) => {
        const entry =
            layer && layer.entries.find(({ cell }) => cell.x === mutation.cell.x && cell.y === mutation.cell.y);
        return {
            op: 'setEntryValues',
            layerId: mutation.layerId,
            cell: mutation.cell,
            values: entry ? entry.values.slice() : [],
        };
    },
    addPoint: (mutation, data, layer) => ({
        op: 'removePoint',
        layerId: mutation.layerId,
        index: layer ? layer.points.length : 0,
    }),
    movePoint: (mutation, data, layer) => {
        const old = layer && layer.points[mutation.index];
        return old
            ? { op: 'movePoint', layerId: mutation.layerId, index: mutation.index, point: clonePoint(old.point) }
            : null;
    },
    removePoint: (mutation, data, layer) => {
        const old = layer && layer.points[mutation.index];
        // The undo appends the point again, its list position may differ from the original.
        return old ? { op: 'addPoint', layerId: mutation.layerId, point: clonePoint(old.point) } : null;
    },
    setPair: (mutation, data, layer) => {
        if (mutation.index === null) {
            return { op: 'removePair', layerId: mutation.layerId, index: layer ? layer.pairs.length : 0 };
        }
        const old = layer && layer.pairs[mutation.index];
        return old
            ? {
                  op: 'setPair',
                  layerId: mutation.layerId,
                  index: mutation.index,
                  external: clonePoint(old.external),
                  internal: clonePoint(old.internal),
              }
            : null;
    },
    removePair: (mutation, data, layer) => {
        const old = layer && layer.pairs[mutation.index];
        return old
            ? {
                  op: 'setPair',
                  layerId: mutation.layerId,
                  index: null,
                  external: clonePoint(old.external),
                  internal: clonePoint(old.internal),
              }
            : null;
    },
    setRect: (mutation, data, layer) =>
        layer ? { op: 'setRect', layerId: mutation.layerId, rect: cloneRect(layer.rect) } : null,
    setSize: (mutation, data) => ({
        op: 'setSize',
        size: { width: data.size.width, height: data.size.height },
    }),
    setBool: (mutation, data) => {
        const key = mutation.field === 'IsRotateable' ? 'isRotateable' : 'isFlippable';
        return { op: 'setBool', field: mutation.field, value: data.rotation[key].value };
    },
    setIntList: (mutation, data) => {
        const old = data.rotation[rotationKeyOf(mutation.field)];
        return { op: 'setIntList', field: mutation.field, values: old ? old.values.slice() : null };
    },
    setPoint: (mutation, data, layer) => {
        if (!layer) return null;
        const old = pointMemberOf(layer).read(layer);
        return { op: 'setPoint', layerId: mutation.layerId, point: clonePoint(old) };
    },
    setCell: (mutation, data, layer) =>
        layer ? { op: 'setCell', layerId: mutation.layerId, cell: clonePoint(layer.cell) } : null,
    setDirection: (mutation, data, layer) => {
        if (!layer) return null;
        // A previously unset facing undoes by removing the Direction member outright.
        return layer.direction
            ? { op: 'setDirection', layerId: mutation.layerId, direction: layer.direction }
            : { op: 'setNumber', layerId: mutation.layerId, field: 'Direction', value: null };
    },
    setNumber: (mutation, data, layer) => {
        if (!layer) return null;
        const old = numberMemberOf(layer).read(layer);
        return { op: 'setNumber', layerId: mutation.layerId, field: mutation.field, value: old };
    },
    moveVertex: (mutation, data, layer) => {
        const old = layer && layer.vertices[mutation.index];
        return old
            ? { op: 'moveVertex', layerId: mutation.layerId, index: mutation.index, point: clonePoint(old.point) }
            : null;
    },
    insertVertex: (mutation) => ({ op: 'removeVertex', layerId: mutation.layerId, index: mutation.index }),
    removeVertex: (mutation, data, layer) => {
        const old = layer && layer.vertices[mutation.index];
        return old
            ? { op: 'insertVertex', layerId: mutation.layerId, index: mutation.index, point: clonePoint(old.point) }
            : null;
    },
    setRectEntry: (mutation, data, layer) => {
        if (mutation.index === null) {
            return { op: 'removeRectEntry', layerId: mutation.layerId, index: layer ? layer.entries.length : 0 };
        }
        const old = layer && layer.entries[mutation.index];
        return old
            ? {
                  op: 'setRectEntry',
                  layerId: mutation.layerId,
                  index: mutation.index,
                  tag: old.tag,
                  rect: cloneRect(old.rect),
              }
            : null;
    },
    removeRectEntry: (mutation, data, layer) => {
        const old = layer && layer.entries[mutation.index];
        return old
            ? {
                  op: 'setRectEntry',
                  layerId: mutation.layerId,
                  index: null,
                  tag: old.tag,
                  rect: cloneRect(old.rect),
              }
            : null;
    },
    moveComponentLocation: (mutation, data) => {
        const gizmo = data.layers.find((candidate) => candidate.kind === 'componentPoints');
        const entry = gizmo && gizmo.entries.find((candidate) => candidate.component === mutation.component);
        if (!entry || !entry.location) return null;
        const parent = entry.chainedTo ? chainParentTransform(gizmo, entry) : null;
        if (!parent) {
            return { op: 'moveComponentLocation', component: mutation.component, point: clonePoint(entry.location) };
        }
        const [ox, oy] = rotateDegrees(
            entry.location.x - parent.location.x,
            entry.location.y - parent.location.y,
            -parent.rotation
        );
        return { op: 'moveComponentLocation', component: mutation.component, point: { x: ox, y: oy } };
    },
    setComponentRotation: (mutation, data) => {
        const gizmo = data.layers.find((candidate) => candidate.kind === 'componentPoints');
        const entry = gizmo && gizmo.entries.find((candidate) => candidate.component === mutation.component);
        return entry ? { op: 'setComponentRotation', component: mutation.component, degrees: entry.rotationDeg } : null;
    },
    setFlags: (mutation, data) => ({
        op: 'setFlags',
        field: mutation.field,
        values: data.contiguity && data.contiguity.values ? data.contiguity.values.slice() : null,
    }),
};

/**
 * Copies a point, so the inverse holds the values the payload had rather than the object it will
 * go on changing.
 *
 * @param point the point, which may be absent.
 * @returns the copy, or null.
 */
function clonePoint(point) {
    return point ? { x: point.x, y: point.y } : null;
}

/**
 * Copies a rect, for the same reason {@link clonePoint} copies a point.
 *
 * @param rect the rect, which may be absent.
 * @returns the copy, or null.
 */
function cloneRect(rect) {
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
}

/**
 * The mutation that exactly reverts `mutation`, computed against the payload state before the
 * mutation is applied.
 *
 * @param mutation the mutation about to be applied.
 * @param data the payload as it stands.
 * @returns the inverse, or null for a mutation whose prior state cannot be restored.
 */
export function inverseOf(mutation, data) {
    const build = INVERSE_BUILDERS[mutation.op];
    if (!build) return null;
    return build(
        mutation,
        data,
        data.layers.find((candidate) => candidate.id === mutation.layerId)
    );
}
