import * as l10n from '@vscode/l10n';
import { GridMutation } from './part-grid.types';

/**
 * The gate a grid mutation passes before any edit is built from it. The edit builders format the
 * payload's numbers and names straight into the part file, so a value outside the wire type (a
 * string where a number belongs, a member the client dropped) or outside the field's domain (half a
 * cell, a part zero cells wide, a name carrying a newline) becomes text in the author's file that
 * the game refuses to load. The shipped webview cannot produce any of it, which is exactly why the
 * refusal belongs here rather than in the panel: this is the boundary every client comes through.
 */

/**
 * The shape of a name written into a rules file. Ids in this game carry dots (`author.part`) and
 * the prohibit categories are ids, so the class is wider than an identifier, and it still admits
 * nothing that could close a value and start another member.
 */
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Whether a payload member is a number the file can hold.
 * @param value the member as it arrived.
 * @returns true for a finite number, false for anything else including null and a numeric string.
 */
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Whether a payload member is a whole number.
 * @param value the member as it arrived.
 * @returns true for a finite integer.
 */
const wholeNumber = (value: unknown): value is number => finiteNumber(value) && Number.isInteger(value);

/**
 * Whether a payload member is an index into a list the editor drew.
 * @param value the member as it arrived.
 * @returns true for a whole number that is not negative.
 */
const indexOk = (value: unknown): boolean => wholeNumber(value) && value >= 0;

/**
 * Whether a payload member is a fractional position. Component locations, crew destinations and
 * vertices are fractional in the game's own data, so only finiteness is asked here.
 * @param value the member as it arrived.
 * @returns true when both components are finite numbers.
 */
const pointOk = (value: unknown): boolean => {
    const point = value as { x?: unknown; y?: unknown } | null;
    return !!point && finiteNumber(point.x) && finiteNumber(point.y);
};

/**
 * Whether a payload member is a cell coordinate. The game reads these through an integer
 * serializer, which throws on a value that does not round-trip, so half a cell stops the load.
 * @param value the member as it arrived.
 * @returns true when both components are whole numbers.
 */
const cellOk = (value: unknown): boolean => {
    const cell = value as { x?: unknown; y?: unknown } | null;
    return !!cell && wholeNumber(cell.x) && wholeNumber(cell.y);
};

/**
 * Whether a payload member is a rectangle.
 * @param value the member as it arrived.
 * @returns true when all four components are finite numbers.
 */
const rectOk = (value: unknown): boolean => {
    const rect = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    return (
        !!rect && finiteNumber(rect.x) && finiteNumber(rect.y) && finiteNumber(rect.width) && finiteNumber(rect.height)
    );
};

/**
 * Whether a payload member is a name the file can carry.
 * @param value the member as it arrived.
 * @returns true when it is a string of the name shape.
 */
const nameOk = (value: unknown): boolean => typeof value === 'string' && NAME_SHAPE.test(value);

/**
 * Whether a payload member is a list of names.
 * @param value the member as it arrived.
 * @returns true when every element is a name.
 */
const namesOk = (value: unknown): boolean => Array.isArray(value) && value.every(nameOk);

/**
 * Whether a payload member is a layer id: name segments joined by `/`, with the entry-member form
 * (`ResourceLevels:Offset`) on the last one.
 * @param value the member as it arrived.
 * @returns true when every segment is a name.
 */
const layerIdOk = (value: unknown): boolean =>
    typeof value === 'string' && value.length > 0 && value.split(/[/:]/).every(nameOk);

/** What to say about a number the field cannot hold. */
const BAD_NUMBER = (): string => l10n.t('The edit carried a number this field cannot hold.');

/** What to say about a cell that is not a whole cell. */
const BAD_CELL = (): string => l10n.t('A cell is named in whole cells.');

/** What to say about a part size the game cannot build. */
const BAD_SIZE = (): string => l10n.t('A part is at least one cell wide and one cell high, in whole cells.');

/** What to say about an entry index that names nothing. */
const BAD_INDEX = (): string => l10n.t('The edit named an entry the editor cannot count to.');

/** What to say about a name that is not written the way a rules name is. */
const BAD_NAME = (): string => l10n.t('The edit carried a name that is not written the way a rules name is.');

/**
 * Judges one mutation before it reaches an edit builder.
 *
 * @param mutation the mutation as the client sent it.
 * @returns the localized refusal, or null when the payload is one the file can hold.
 */
export const mutationRefusal = (mutation: GridMutation): string | null => {
    switch (mutation.op) {
        case 'addCell':
        case 'removeCell':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            return cellOk(mutation.cell) ? null : BAD_CELL();
        case 'setEntryValues':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            if (!cellOk(mutation.cell)) return BAD_CELL();
            return namesOk(mutation.values) ? null : BAD_NAME();
        case 'addPoint':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            return pointOk(mutation.point) ? null : BAD_NUMBER();
        case 'movePoint':
        case 'moveVertex':
        case 'insertVertex':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            if (!indexOk(mutation.index)) return BAD_INDEX();
            return pointOk(mutation.point) ? null : BAD_NUMBER();
        case 'removePoint':
        case 'removeVertex':
        case 'removePair':
        case 'removeRectEntry':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            return indexOk(mutation.index) ? null : BAD_INDEX();
        case 'setPair':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            if (mutation.index !== null && !indexOk(mutation.index)) return BAD_INDEX();
            return cellOk(mutation.external) && cellOk(mutation.internal) ? null : BAD_CELL();
        case 'setRect':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            return mutation.rect === null || rectOk(mutation.rect) ? null : BAD_NUMBER();
        case 'setRectEntry':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            if (mutation.index !== null && !indexOk(mutation.index)) return BAD_INDEX();
            if (mutation.tag !== null && !nameOk(mutation.tag)) return BAD_NAME();
            return rectOk(mutation.rect) ? null : BAD_NUMBER();
        case 'setSize': {
            const { width, height } = mutation.size ?? {};
            return wholeNumber(width) && wholeNumber(height) && width >= 1 && height >= 1 ? null : BAD_SIZE();
        }
        case 'setBool':
            if (!nameOk(mutation.field)) return BAD_NAME();
            return mutation.value === null || typeof mutation.value === 'boolean' ? null : BAD_NUMBER();
        case 'setIntList':
            if (!nameOk(mutation.field)) return BAD_NAME();
            if (mutation.values === null) return null;
            return Array.isArray(mutation.values) && mutation.values.every(wholeNumber) ? null : BAD_NUMBER();
        case 'setPoint':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            return mutation.point === null || pointOk(mutation.point) ? null : BAD_NUMBER();
        case 'setCell':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            return mutation.cell === null || cellOk(mutation.cell) ? null : BAD_CELL();
        case 'setDirection':
            if (!layerIdOk(mutation.layerId)) return BAD_NAME();
            return nameOk(mutation.direction) ? null : BAD_NAME();
        case 'setNumber':
            if (!layerIdOk(mutation.layerId) || !nameOk(mutation.field)) return BAD_NAME();
            return mutation.value === null || finiteNumber(mutation.value) ? null : BAD_NUMBER();
        case 'moveComponentLocation':
            if (!nameOk(mutation.component)) return BAD_NAME();
            return pointOk(mutation.point) ? null : BAD_NUMBER();
        case 'setComponentRotation':
            if (!nameOk(mutation.component)) return BAD_NAME();
            return mutation.degrees === null || finiteNumber(mutation.degrees) ? null : BAD_NUMBER();
        case 'setFlags':
            if (!nameOk(mutation.field)) return BAD_NAME();
            return mutation.values === null || namesOk(mutation.values) ? null : BAD_NAME();
        default:
            return null;
    }
};
