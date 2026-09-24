import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    descendants,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { effectiveMember } from '../../semantics/effective-member';
import { flattenList } from '../../semantics/effective-group';
import { findMemberThroughInheritance, ResolveReferenceFn } from '../../semantics/inheritance-resolver';
import { navigate } from '../../semantics/navigate-reference';
import { isSameOrSubclass } from '../navigation/schema-id-reference.navigation';
import { CELL_SET_FIELDS, MAP_FIELDS, PART_RULES_CLASS } from '../part-editor/part-fields';
import {
    childNamed,
    numberOf,
    readMapEntries,
    readRect,
    readRectEvaluated,
    readVector,
    readVectorEvaluated,
} from '../../semantics/vector-forms';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * Whole-document pass (default on, settable off): a cell, a map key or a rect the part's own size
 * puts out of the game's reach. The grid editor grows its render margin for these, so today they
 * are drawn and never reported.
 *
 * Every rule here is the game's own reachability, read out of `Cosmoteer.dll`:
 *
 *   - `AllowsDoorAt` is only ever asked about `DoorLocation.IdentifyOutsideCell(GetRect(...))`, and
 *     `DoorsManager.GetAllDoorLocationsFor` yields only the rect's perimeter door locations, so the
 *     cells `AllowedDoorLocations` can ever match are exactly the part rect's side neighbours, the
 *     same ring the field's own default uses. The four diagonal corners are not on it.
 *   - `IsTravelBlocked`, `GetExternalWalls`, `GetInternalWalls` and the blueprint pair are always
 *     reached by looking the part up at a ship cell and then asking that part about that cell, so a
 *     `BlockedTravelCells` entry or a `*ByCell` key outside the part is never consulted.
 *   - the part reader itself throws when `PhysicalRect` is not contained in the size rect, so that
 *     one is a load failure rather than dead weight.
 *   - a storage's `PickUpLocation` and `DeliveryLocation`, and a resource grid's `GridRect`, are
 *     added onto the part's own cell with no clamp, and the cell they land on is what crew walk to
 *     and what the resource search starts from. `PathManager` sizes that search's grid from the
 *     bounding box of the parts crew can walk through, grown by six cells, and
 *     `AStarGridPathfinder.FindAllNodeDistancePairs` seeds its queue from the start rect without
 *     checking it against that grid, so a cell far enough outside ends the search with an index
 *     error. The same grid is why a resource sink on a part whose `CrewSpeedFactor` is zero is
 *     worth reporting: such a part never grows the grid, but is still searched from.
 *
 * `SaveRect` is deliberately not judged: the game reads only its location, as an offset applied when
 * ships are saved, and parts place it outside themselves on purpose.
 *
 * False positives are kept out by staying with what the document itself says. Only a value written
 * on the part group in this file is judged, so the finding always has a span the author owns and a
 * base file is never blamed once per deriver. `Size` is the one member read through the inheritance
 * chain, because a third of all part roots inherit it and it is a vector member, which inheritance
 * replaces rather than merges, so the nearest declaration is the one the game loads. A part group
 * that writes no `ID` of its own is skipped: it is a template its deriving files complete, whose
 * size may be a placeholder they replace. Anything that is not a plain positive integer vector or
 * rect (math, a reference, a fractional value) is passed over rather than guessed at.
 */

/** A part's grid size in cells. */
interface PartSize {
    readonly width: number;
    readonly height: number;
}

/** The base class of every component the game picks resources up from and delivers them to. */
const RESOURCE_STORAGE_CLASS = 'Cosmoteer.Ships.Parts.Resources.BaseResourceStorageRules';

/** The two components that carve a grid of resource tiles out of the part they sit on. */
const RESOURCE_GRID_CLASSES: readonly string[] = [
    'Cosmoteer.Ships.Parts.Resources.TypedResourceGridRules',
    'Cosmoteer.Ships.Parts.Resources.FlexResourceGridRules',
];

/** The components that register a sink crew carry resources to, the grid consumer among them. */
const CREW_SINK_CLASSES: readonly string[] = [
    'Cosmoteer.Ships.Parts.Resources.ResourceConsumerRules',
    'Cosmoteer.Ships.Parts.Resources.FlexResourceGridRules',
];

/** The two storage access points, both written in tiles from the part's top left corner. */
const ACCESS_POINT_FIELDS: readonly string[] = ['PickUpLocation', 'DeliveryLocation'];

/** The members of a crew speed written in its group form, any one of which answers for all four. */
const CREW_SPEED_DIRECTIONS: readonly string[] = ['Left', 'Right', 'Up', 'Down'];

/** The component class whose cell the game turns into a door location beside the part. */
const DOOR_PRESENCE_TOGGLE_CLASS = 'Cosmoteer.Ships.Parts.Logic.DoorPresenceToggleRules';

/** The shorthand fields that each add one keep-out rect per category the part prohibits. */
const PROHIBIT_SHORTHANDS: readonly string[] = ['ProhibitLeft', 'ProhibitRight', 'ProhibitAbove', 'ProhibitBelow'];

/** Adapts the shared navigation strategy to the inheritance resolver's reference-resolution shape. */
const resolveReference: ResolveReferenceFn = (path, startNode, currentLocation, token, inheritanceVisited) =>
    navigate(path, startNode, currentLocation, token, new Set(), inheritanceVisited) as ReturnType<ResolveReferenceFn>;

/**
 * Whether a cell is one the part occupies, matching the engine's `IntRect.Contains(IntVector2)`.
 * @param cell the rules-relative cell.
 * @param size the part's size.
 * @returns true when the cell is inside the part rect.
 */
const occupies = (cell: { x: number; y: number }, size: PartSize): boolean =>
    cell.x >= 0 && cell.x < size.width && cell.y >= 0 && cell.y < size.height;

/**
 * Whether a cell is one of the part's side neighbours, matching the ring the engine's
 * `IntRect.GetAdjacentCells(AdjacencyFlags.Sides)` yields. The four diagonal corners are not on it.
 * @param cell the rules-relative cell.
 * @param size the part's size.
 * @returns true when a door between the part and that cell is possible.
 */
const touchesSide = (cell: { x: number; y: number }, size: PartSize): boolean =>
    (cell.x >= 0 && cell.x < size.width && (cell.y === -1 || cell.y === size.height)) ||
    (cell.y >= 0 && cell.y < size.height && (cell.x === -1 || cell.x === size.width));

/**
 * Whether a rect fits inside the part, matching the engine's `IntRect.Contains(IntRect)`.
 * @param rect the written rect.
 * @param size the part's size.
 * @returns true when the rect is contained.
 */
const fitsInside = (rect: { x: number; y: number; width: number; height: number }, size: PartSize): boolean =>
    rect.x >= 0 && rect.x + rect.width <= size.width && rect.y >= 0 && rect.y + rect.height <= size.height;

/**
 * A written vector read as a whole-number cell.
 * @param node the written value.
 * @returns the cell, or null when it is not two plain integers.
 */
const wholeCell = (node: AbstractNode | null | undefined): { x: number; y: number } | null => {
    const vector = readVector(node);
    return vector && Number.isInteger(vector.x) && Number.isInteger(vector.y) ? { x: vector.x, y: vector.y } : null;
};

/**
 * The part groups of a document the game instantiates: a group resolving to `PartRules` that writes
 * its own `ID`. A template completed by deriving files writes none, since two parts sharing one id
 * would collide in the game's part table, and its own size says nothing about the parts built on it.
 * @param document the parsed document.
 * @returns the part groups to judge, in source order.
 */
export const instantiatedParts = (document: AbstractNodeDocument): GroupNode[] => {
    const parts: GroupNode[] = [];
    const visit = (node: AbstractNode): void => {
        // The id check runs first because it is a member scan, while resolving the class walks the
        // slot and the inheritance chain.
        if (isGroupNode(node) && childNamed(node, 'ID') && resolveGroupClass(node) === PART_RULES_CLASS)
            parts.push(node);
        if (isGroupNode(node) || isListNode(node)) for (const child of node.elements) visit(child);
    };
    for (const element of document.elements) visit(element);
    return parts;
};

/**
 * The part's effective grid size: its own `Size`, else the nearest one up its inheritance chain.
 * @param part the part group.
 * @param cancellationToken cancels the chain walk.
 * @returns the size in cells, or null when no declaration is reachable or it is not two positive integers.
 */
const effectiveSize = async (part: GroupNode, cancellationToken: CancellationToken): Promise<PartSize | null> => {
    const local = childNamed(part, 'Size');
    const node =
        local ??
        (await findMemberThroughInheritance(part, 'Size', resolveReference, cancellationToken).catch(() => null));
    const size = wholeCell(node);
    return size && size.x > 0 && size.y > 0 ? { width: size.x, height: size.y } : null;
};

/**
 * The finding for a value the part's geometry puts out of reach, faded as dead weight with a fix
 * that takes it out.
 * @param message the finding's text.
 * @param node the written value, whose span the finding covers.
 * @param removeTitle the fix's title.
 * @returns the validation error.
 */
const deadValue = (message: string, node: AbstractNode, removeTitle: string): ValidationError => ({
    message,
    node,
    severity: 'hint',
    unnecessary: true,
    data: { remove: { title: removeTitle, start: node.position.start, end: node.position.end } },
});

/**
 * Flags the cells of a cell-set field the part writes that fall outside the field's domain.
 * @param part the part group.
 * @param spec the field and the domain its cells belong to.
 * @param size the part's effective size.
 * @param errors collects the findings.
 */
const judgeCellSet = (
    part: GroupNode,
    spec: (typeof CELL_SET_FIELDS)[number],
    size: PartSize,
    errors: ValidationError[]
): void => {
    const node = childNamed(part, spec.field);
    if (!node || (!isListNode(node) && !isGroupNode(node))) return;
    for (const element of node.elements) {
        const cell = wholeCell(element);
        if (!cell) continue;
        if (spec.domain === 'outside' && !touchesSide(cell, size)) {
            errors.push(
                deadValue(
                    occupies(cell, size)
                        ? l10n.t(
                              'A door always sits between the part and a cell beside it, so [{0}, {1}], which is inside a {2} by {3} part, is never used.',
                              cell.x,
                              cell.y,
                              size.width,
                              size.height
                          )
                        : l10n.t(
                              'A door always sits between the part and a cell beside it, so [{0}, {1}], which does not touch a {2} by {3} part, is never used.',
                              cell.x,
                              cell.y,
                              size.width,
                              size.height
                          ),
                    element,
                    l10n.t('Remove this cell')
                )
            );
        } else if (spec.domain === 'inside' && !occupies(cell, size)) {
            errors.push(
                deadValue(
                    l10n.t(
                        "'{0}' is only read for the cells the part occupies, so [{1}, {2}], which is outside a {3} by {4} part, does nothing.",
                        spec.field,
                        cell.x,
                        cell.y,
                        size.width,
                        size.height
                    ),
                    element,
                    l10n.t('Remove this cell')
                )
            );
        }
    }
};

/**
 * Flags the entries of a per-cell map the part writes whose key names no cell of the part.
 * @param part the part group.
 * @param field the map field's name.
 * @param size the part's effective size.
 * @param errors collects the findings.
 */
const judgeMapKeys = (part: GroupNode, field: string, size: PartSize, errors: ValidationError[]): void => {
    const node = childNamed(part, field);
    if (!node) return;
    for (const entry of readMapEntries(node)) {
        const key = wholeCell(entry.key.node);
        if (!key || occupies(key, size)) continue;
        errors.push(
            deadValue(
                l10n.t(
                    "'{0}' is only read for the cells the part occupies, so [{1}, {2}], which is outside a {3} by {4} part, does nothing.",
                    field,
                    key.x,
                    key.y,
                    size.width,
                    size.height
                ),
                entry.entry,
                l10n.t('Remove this entry')
            )
        );
    }
};

/**
 * Flags a `PhysicalRect` the part's own size does not contain. The game checks this itself while it
 * reads the part and throws, so the file never loads.
 * @param part the part group.
 * @param size the part's effective size.
 * @param errors collects the finding.
 */
const judgePhysicalRect = (part: GroupNode, size: PartSize, errors: ValidationError[]): void => {
    const node = childNamed(part, 'PhysicalRect');
    const rect = node ? readRect(node) : null;
    if (!node || !rect) return;
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)) return;
    if (fitsInside(rect, size)) return;
    errors.push({
        message: l10n.t(
            'PhysicalRect must fit inside the part, and [{0}, {1}, {2}, {3}] is a {2} by {3} rect at column {0}, row {1}, which reaches past a {4} by {5} part, so the game refuses to load it.',
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            size.width,
            size.height
        ),
        node,
        severity: 'error',
    });
};

/**
 * Flags a door presence toggle whose cell lies inside the part it belongs to.
 *
 * The engine turns the cell into a door location by asking which side of the part rect it is past,
 * and its four tests are the whole method. A cell inside the rect is past none of them and falls
 * through to a bare internal error, which happens when the part materialises rather than while the
 * blueprint is being drawn, since a blueprint part builds no toggle at all. A cell outside the rect
 * is the point of the field and is left alone wherever it sits, because the door it names is looked
 * up across the whole ship rather than around the part.
 * @param part the part group.
 * @param size the part's effective size.
 * @param errors collects the findings.
 */
const judgeDoorToggles = (part: GroupNode, size: PartSize, errors: ValidationError[]): void => {
    const visit = (node: AbstractNode): void => {
        if (isGroupNode(node) && resolveGroupClass(node) === DOOR_PRESENCE_TOGGLE_CLASS) {
            const written = childNamed(node, 'AdjacentCell');
            const cell = wholeCell(written);
            if (written && cell && occupies(cell, size)) {
                errors.push({
                    message: l10n.t(
                        'This cell is inside the part, so the game cannot read it as a door beside it and stops when the part is created.'
                    ),
                    node: written,
                    severity: 'error',
                });
            }
        }
        if (isGroupNode(node) || isListNode(node)) for (const child of node.elements) visit(child);
    };
    for (const element of part.elements) visit(element);
};

/**
 * The part's own group and every group under it that resolves to a schema class, paired with it.
 * @param part the part group.
 * @yields each group the walk reaches, with the class it resolves to.
 */
function* classifiedGroups(part: GroupNode): Generator<{ group: GroupNode; cls: string }> {
    for (const node of descendants(part)) {
        if (!isGroupNode(node)) continue;
        const cls = resolveGroupClass(node);
        if (cls) yield { group: node, cls };
    }
}

/**
 * Whether a group resolves to one of the named classes or to something deriving from one.
 * @param cls the class the group resolved to.
 * @param bases the classes to match against.
 * @returns true when the class is one of them or below one of them.
 */
const isAnyOf = (cls: string, bases: readonly string[]): boolean => bases.some((base) => isSameOrSubclass(cls, base));

/**
 * Flags a storage access point that falls on a cell the part does not own.
 *
 * Fractions are the point of these fields, so the finding judges the cell the point lands in rather
 * than the point itself, matching the floor the game applies when it turns the location into a cell.
 *
 * @param part the part group.
 * @param size the part's effective size.
 * @param cancellationToken cancels the value reads.
 * @param errors collects the findings.
 */
const judgeAccessPoints = async (
    part: GroupNode,
    size: PartSize,
    cancellationToken: CancellationToken,
    errors: ValidationError[]
): Promise<void> => {
    for (const { group, cls } of classifiedGroups(part)) {
        if (!isSameOrSubclass(cls, RESOURCE_STORAGE_CLASS)) continue;
        for (const field of ACCESS_POINT_FIELDS) {
            const written = childNamed(group, field);
            if (!written) continue;
            const point = await readVectorEvaluated(written, cancellationToken).catch(() => null);
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
            const cell = { x: Math.floor(point.x), y: Math.floor(point.y) };
            if (occupies(cell, size)) continue;
            errors.push({
                message: l10n.t(
                    "'{0}' is read in tiles from the part's top left corner, and [{1}, {2}] falls on cell [{3}, {4}], which a {5} by {6} part does not own. Crew are then sent outside the part, and far enough out the resource search leaves the ship's path grid and stops with an index error.",
                    field,
                    point.x,
                    point.y,
                    cell.x,
                    cell.y,
                    size.width,
                    size.height
                ),
                node: written,
                severity: 'warning',
            });
        }
    }
};

/**
 * Flags a resource grid whose `GridRect` reaches past the part it sits on.
 * @param part the part group.
 * @param size the part's effective size.
 * @param cancellationToken cancels the value reads.
 * @param errors collects the findings.
 */
const judgeGridRects = async (
    part: GroupNode,
    size: PartSize,
    cancellationToken: CancellationToken,
    errors: ValidationError[]
): Promise<void> => {
    for (const { group, cls } of classifiedGroups(part)) {
        if (!isAnyOf(cls, RESOURCE_GRID_CLASSES)) continue;
        const written = childNamed(group, 'GridRect');
        if (!written) continue;
        const rect = await readRectEvaluated(written, cancellationToken).catch(() => null);
        if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)) continue;
        // Containment alone lets a negative extent through, since it only compares the sums, and
        // the game fills the grid with `i < Height` and `j < Width` loops that a non-positive
        // extent never enters.
        if (rect.width <= 0 || rect.height <= 0) {
            errors.push({
                message: l10n.t(
                    'GridRect needs a positive width and height, and [{0}, {1}, {2}, {3}] gives the grid none, so it holds no resource tile at all.',
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height
                ),
                node: written,
                severity: 'warning',
            });
            continue;
        }
        if (fitsInside(rect, size)) continue;
        errors.push({
            message: l10n.t(
                'GridRect carves the resource tiles out of the part, and [{0}, {1}, {2}, {3}] reaches past a {4} by {5} part. The tiles beyond it sit on cells the part does not own, which crew cannot reach.',
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                size.width,
                size.height
            ),
            node: written,
            severity: 'warning',
        });
    }
};

/**
 * Whether the part's effective crew speed is zero, which keeps it out of the ship's path grid.
 *
 * The game reads a single number as all four directions at once, and its reader throws on a group
 * that mixes a zero direction with a non-zero one, so any one direction answers for the whole
 * group and the first the reader can resolve is taken. Anything it cannot resolve to a plain
 * number is passed over rather than guessed at.
 *
 * @param part the part group.
 * @param cancellationToken cancels the chain walk.
 * @returns true when the part is impassable.
 */
const crewSpeedIsZero = async (part: GroupNode, cancellationToken: CancellationToken): Promise<boolean> => {
    const local = childNamed(part, 'CrewSpeedFactor');
    const node =
        local ??
        (await findMemberThroughInheritance(part, 'CrewSpeedFactor', resolveReference, cancellationToken).catch(
            () => null
        ));
    if (!node) return false;
    const scalar = numberOf(node);
    if (scalar !== null) return scalar === 0;
    if (!isGroupNode(node)) return false;
    for (const direction of CREW_SPEED_DIRECTIONS) {
        const written = numberOf(childNamed(node, direction));
        if (written !== null) return written === 0;
    }
    return false;
};

/**
 * Flags a resource sink on a part crew cannot walk through.
 *
 * This is the one check here that the part's own geometry cannot settle on its own: whether the
 * search actually leaves the grid depends on where the part ends up on a ship. The pairing itself
 * is the signal, since an impassable part contributes nothing to the grid the search runs in. The
 * finding is about the part rather than about any one sink, so a part carrying several of them is
 * reported once, on the first.
 *
 * @param part the part group.
 * @param cancellationToken cancels the chain walk.
 * @param errors collects the finding.
 */
const judgeCrewSinks = async (
    part: GroupNode,
    cancellationToken: CancellationToken,
    errors: ValidationError[]
): Promise<void> => {
    const first = [...classifiedGroups(part)].find(({ cls }) => isAnyOf(cls, CREW_SINK_CLASSES));
    if (!first) return;
    if (!(await crewSpeedIsZero(part, cancellationToken))) return;
    errors.push({
        message: l10n.t(
            "This part's CrewSpeedFactor is zero, so it is left out of the ship's path grid, but a resource sink on it is still searched for from the part's own cells. On a ship that puts the part more than six cells outside the walkable hull, that search leaves the grid and stops with an index error."
        ),
        node: first.group.identifier ?? first.group,
        severity: 'warning',
    });
};

/**
 * Flags a prohibit shorthand on a part whose effective `Prohibits` list is empty.
 *
 * The shorthands add one keep-out rect per category the list names, so with no category named they
 * add nothing and the part happily takes the neighbour it was written to keep away. Parts inherit
 * `Prohibits = [default]` from `base_part.rules`, so this can only fire on a part that clears the
 * inherited list, which is the shape the shorthand is silently dead in.
 *
 * @param part the part group.
 * @param cancellationToken cancels the inheritance fold of the list.
 * @param errors collects the findings.
 */
const judgeProhibits = async (
    part: GroupNode,
    cancellationToken: CancellationToken,
    errors: ValidationError[]
): Promise<void> => {
    const written = PROHIBIT_SHORTHANDS.map((field) => childNamed(part, field)).filter(
        (node): node is AbstractNode => !!node
    );
    if (written.length === 0) return;
    const member = await effectiveMember(part, 'Prohibits', cancellationToken).catch(() => null);
    if (!member || !isListNode(member.node)) return;
    const flattened = await flattenList(member.node, cancellationToken);
    // A chain the walk could not read in full might supply a category this level cannot see, and a
    // report on half a chain would be a false one.
    if (!flattened.complete || flattened.entries.length > 0) return;
    for (const node of written) {
        errors.push({
            message: l10n.t(
                'This part prohibits no category, so this keep-out distance adds nothing. The shorthands add one rect per category in `Prohibits`, which is empty here.'
            ),
            node,
            severity: 'warning',
        });
    }
};

/**
 * Runs the part-geometry checks over a document.
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk and the inheritance reads.
 * @returns the findings, in source order per part.
 */
export const validatePartGeometry = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    for (const part of instantiatedParts(document)) {
        if (cancellationToken.isCancellationRequested) return errors;
        // The crew-sink pairing is the one check that does not measure anything against the part's
        // size, so it still answers for a part whose size the reader cannot resolve.
        await judgeCrewSinks(part, cancellationToken, errors);
        const size = await effectiveSize(part, cancellationToken);
        if (!size) continue;
        for (const spec of CELL_SET_FIELDS) judgeCellSet(part, spec, size, errors);
        for (const spec of MAP_FIELDS) judgeMapKeys(part, spec.field, size, errors);
        judgePhysicalRect(part, size, errors);
        judgeDoorToggles(part, size, errors);
        await judgeAccessPoints(part, size, cancellationToken, errors);
        await judgeGridRects(part, size, cancellationToken, errors);
        await judgeProhibits(part, cancellationToken, errors);
    }
    return errors;
};
