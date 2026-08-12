import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode } from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { findMemberThroughInheritance, ResolveReferenceFn } from '../../semantics/inheritance-resolver';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { CELL_SET_FIELDS, MAP_FIELDS, PART_RULES_CLASS } from '../part-editor/part-fields';
import { ReadRect, childNamed, readMapEntries, readRect, readVector } from '../part-editor/vector-forms';
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

const navigation = new FullNavigationStrategy();

/** Adapts the shared navigation strategy to the inheritance resolver's reference-resolution shape. */
const resolveReference: ResolveReferenceFn = (path, startNode, currentLocation, token, inheritanceVisited) =>
    navigation.navigate(path, startNode, currentLocation, token, new Set(), inheritanceVisited) as ReturnType<ResolveReferenceFn>;

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
const fitsInside = (rect: ReadRect, size: PartSize): boolean =>
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
const instantiatedParts = (document: AbstractNodeDocument): GroupNode[] => {
    const parts: GroupNode[] = [];
    const visit = (node: AbstractNode): void => {
        // The id check runs first because it is a member scan, while resolving the class walks the
        // slot and the inheritance chain.
        if (isGroupNode(node) && childNamed(node, 'ID') && resolveGroupClass(node) === PART_RULES_CLASS) parts.push(node);
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
        local ?? (await findMemberThroughInheritance(part, 'Size', resolveReference, cancellationToken).catch(() => null));
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
            'PhysicalRect must fit inside the part, and [{0}, {1}, {2}, {3}] leaves a {4} by {5} part, so the game refuses to load it.',
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
        const size = await effectiveSize(part, cancellationToken);
        if (!size) continue;
        for (const spec of CELL_SET_FIELDS) judgeCellSet(part, spec, size, errors);
        for (const spec of MAP_FIELDS) judgeMapKeys(part, spec.field, size, errors);
        judgePhysicalRect(part, size, errors);
    }
    return errors;
};