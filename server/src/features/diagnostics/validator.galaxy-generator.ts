import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    descendants,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { schema } from '../../document/schema/schema';

import { resolveClassThroughInheritance } from '../completion/inheritance-resolution';
import { flattenList } from '../../semantics/effective-group';
import { navigate } from '../../semantics/navigate-reference';
import { childNamed, numberOf, readIntList } from '../../semantics/vector-forms';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { ValidationError } from './validator';

/**
 * Whole-document pass (default on, settable off): a galaxy generator the game builds a broken map
 * from. Everything here loads without a word and fails once a career is started, where the engine
 * names no file, so the file is the only place these can be caught.
 *
 * Every rule is read out of `Cosmoteer.dll`:
 *
 *   - `MapNodeData.SectorType` answers `SectorTypes[0]` for every node whose `SectorTypeID` is
 *     null, and the only two writers of that field are the `RandomSectorTypes` spawner and the
 *     starting node picker, which sets the one node it picks. A career generator that runs no
 *     `RandomSectorTypes` therefore puts the whole galaxy on one sector type, silently, and a
 *     sector type carries the system generator, the trade routes, the missions and the encounters.
 *   - `ProgressionNodeTiersSpawner` sizes its queue array from `DesiredTierDeltas.Length` and then
 *     indexes it by each entry's own `Priority`, unguarded, so a priority the list is too short for
 *     throws where the player confirms a new game.
 *   - `MapNodesSpawner` keeps every pair of nodes at least `Distance.Min` apart and connects only
 *     inside `ConnectionRadius`, so a radius at or below that minimum yields a galaxy in which not
 *     one connection is ever made.
 *   - `StartingNodePickerSpawner` throws outright when its filters leave no node standing, and
 *     three of those filters are decidable from the numbers alone.
 *
 * A `Spawners` list is judged only where it already carries a career-only spawner, which is what
 * makes the sector-type rule sound: the five career spawners all return early outside career mode,
 * so a generator offered only to creative is unaffected and must not be reported. Anything the
 * walk cannot resolve in full leaves the whole list unjudged rather than half judged.
 */

/** The registry every element of a `Spawners` list belongs to. */
const GALAXY_SPAWNER_REGISTRY = 'Cosmoteer.Generators.Galaxies.GalaxySpawner';

/** The spawner that gives each map node its sector type. */
const SECTOR_TYPES = 'Cosmoteer.Modes.Career.Map.RandomSectorTypesSpawner';

/** The spawner whose priorities index an array its own list sizes. */
const PROGRESSION_TIERS = 'Cosmoteer.Modes.Career.Map.ProgressionNodeTiersSpawner';

/** The spawner that lays the nodes down and decides which of them are connected. */
const MAP_NODES = 'Cosmoteer.Generators.Galaxies.MapNodesSpawner';

/** The spawner that picks where the player starts. */
const STARTING_NODE = 'Cosmoteer.Modes.Career.Map.StartingNodePickerSpawner';

/**
 * The spawners that do nothing outside career mode, so a list carrying one is a career generator.
 * Read from the five `if (!(map.Game.Mode is CareerGameModeManager)) return;` early-outs.
 */
const CAREER_ONLY: readonly string[] = [
    PROGRESSION_TIERS,
    SECTOR_TYPES,
    STARTING_NODE,
    'Cosmoteer.Modes.Career.Map.FactionNodeTiersSpawner',
    'Cosmoteer.Modes.Career.Map.RandomNodeTiersSpawner',
];

/** One element of a `Spawners` list, resolved to the group and the class the game reads it as. */
interface Spawner {
    /** The group the element resolves to, which a reference element reaches through its target. */
    readonly group: GroupNode;
    readonly cls: string;
    /** The element as this document writes it, which is where a finding about the list is anchored. */
    readonly written: AbstractNode;
}

/**
 * Resolves one element of a `Spawners` list to the group the game reads.
 *
 * An element is written in three forms: the group itself, a group naming a base, or a bare
 * reference to a group in another file. The first two are already groups. The third has to be
 * followed, and a target this server cannot reach answers null so the caller can abstain.
 *
 * @param element the element as written.
 * @param uri the document the element is written in.
 * @param cancellationToken cancels the reference walk.
 * @returns the resolved spawner, or null when the element could not be read.
 */
const resolveSpawner = async (
    element: AbstractNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<Spawner | null> => {
    let group: AbstractNode | null = isGroupNode(element) ? element : null;
    if (!group) {
        const path = referencePathOf(element);
        if (!path) return null;
        const target = await navigate(path, element, uri, cancellationToken, new Set()).catch(() => null);
        group = target && typeof target === 'object' && 'type' in target ? (target as AbstractNode) : null;
    }
    if (!group || !isGroupNode(group)) return null;
    // A spawner written as `: <base>/MapNodes { Count = 75 }` carries no discriminator of its own,
    // so its class comes from the base it names rather than from the slot it sits in.
    const cls = (await resolveClassThroughInheritance(group, cancellationToken).catch(() => undefined)) ?? undefined;
    if (!cls || schema.types[cls]?.registry !== GALAXY_SPAWNER_REGISTRY) return null;
    return { group, cls, written: element };
};

/**
 * The path a bare reference element spells, without its sigil.
 *
 * @param element the element as written.
 * @returns the path, or undefined when the element is not a plain reference.
 */
const referencePathOf = (element: AbstractNode): string | undefined => {
    // A list element written as a bare `&path` parses to an identifier rather than to a value, so
    // both spellings have to be read here.
    const written = isIdentifierNode(element)
        ? element.name
        : isValueNode(element)
          ? String(element.valueType.value)
          : '';
    const text = written.trim();
    return text.startsWith('&') ? text : undefined;
};

/**
 * Every `Spawners` list a document writes, with its elements resolved.
 *
 * @param document the parsed document.
 * @param cancellationToken cancels the reference walks.
 * @returns one entry per list that resolved in full, in source order.
 */
const spawnerListsOf = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<Array<{ list: ListNode; spawners: Spawner[] }>> => {
    const lists: Array<{ list: ListNode; spawners: Spawner[] }> = [];
    for (const node of descendants(document)) {
        if (!isListNode(node) || node.identifier?.name.toLowerCase() !== 'spawners') continue;
        const flattened = await flattenList(node, cancellationToken).catch(() => null);
        // A list whose bases this server could not read might hold the very spawner the rule asks
        // for, so half a list is no basis for saying one is missing.
        if (!flattened || !flattened.complete) continue;
        const spawners: Spawner[] = [];
        let resolvedAll = true;
        for (const entry of flattened.entries) {
            const spawner = await resolveSpawner(entry.value, document.uri, cancellationToken);
            if (!spawner) {
                resolvedAll = false;
                break;
            }
            spawners.push(spawner);
        }
        if (resolvedAll && spawners.length > 0) lists.push({ list: node, spawners });
    }
    return lists;
};

/**
 * Flags a career galaxy generator that gives its nodes no sector type.
 *
 * @param list the `Spawners` list.
 * @param spawners its resolved elements.
 * @param errors collects the finding.
 */
const judgeSectorTypes = (list: ListNode, spawners: readonly Spawner[], errors: ValidationError[]): void => {
    if (!spawners.some((spawner) => CAREER_ONLY.includes(spawner.cls))) return;
    if (spawners.some((spawner) => spawner.cls === SECTOR_TYPES)) return;
    errors.push({
        message: l10n.t(
            'This career generator runs no RandomSectorTypes spawner, so every star system but the starting one falls back to the first sector type. A sector type carries the system generator, the trade routes, the missions and the encounters, so the whole galaxy ends up with one kind of system.'
        ),
        node: list.identifier ?? list,
        severity: 'warning',
    });
};

/**
 * Flags a progression spawner whose priorities reach past the array its own list sizes.
 *
 * @param spawner the resolved spawner.
 * @param errors collects the findings.
 */
const judgePriorities = (spawner: Spawner, errors: ValidationError[]): void => {
    const deltas = childNamed(spawner.group, 'DesiredTierDeltas');
    if (!deltas || !isListNode(deltas)) return;
    // An inherited entry is prepended, which shifts every index, so a list naming a base is left
    // alone rather than judged against the half of it this file writes.
    if (deltas.inheritance && deltas.inheritance.length > 0) return;
    const length = deltas.elements.length;
    if (length === 0) {
        errors.push({
            message: l10n.t(
                'DesiredTierDeltas is empty, and the spawner sizes its queue array from this list before writing to the first entry, so generating a galaxy stops with an index error.'
            ),
            node: deltas.identifier ?? deltas,
            severity: 'error',
        });
        return;
    }
    for (const element of deltas.elements) {
        if (!isGroupNode(element)) continue;
        const written = childNamed(element, 'Priority');
        const priority = numberOf(written);
        if (written === null || priority === null || !Number.isInteger(priority)) continue;
        if (priority >= 0 && priority < length) continue;
        errors.push({
            message: l10n.t(
                'Priority doubles as an index into one queue per entry of this list, so it has to be between 0 and {0}, and {1} reaches past the {2} entries written here. Generating a galaxy stops with an index error.',
                length - 1,
                priority,
                length
            ),
            node: written,
            severity: 'error',
        });
    }
};

/**
 * Flags a node spawner whose connection radius cannot reach the nearest node it allows.
 *
 * @param spawner the resolved spawner.
 * @param errors collects the finding.
 */
const judgeConnectionRadius = (spawner: Spawner, errors: ValidationError[]): void => {
    const radiusNode = childNamed(spawner.group, 'ConnectionRadius');
    const radius = numberOf(radiusNode);
    const distance = readIntList(childNamed(spawner.group, 'Distance'));
    const minimum = distance && distance.length === 2 ? distance[0] : null;
    if (radiusNode === null || radius === null || minimum === null) return;
    if (radius > minimum) return;
    errors.push({
        message: l10n.t(
            'Every pair of nodes is laid down at least {0} apart, and only nodes within {1} of each other are connected, so no node is ever connected to anything and the galaxy has no routes at all.',
            minimum,
            radius
        ),
        node: radiusNode,
        severity: 'error',
    });
};

/**
 * Flags a starting node picker whose filters can never leave a node standing.
 *
 * The two `Candidates*Center` members are guarded by a positivity test and mean "off" at zero,
 * while the two faction counts are not guarded, so zero there keeps nothing rather than keeping
 * everything. That asymmetry is the whole reason this one is worth reporting.
 *
 * @param spawner the resolved spawner.
 * @param errors collects the findings.
 */
const judgeStartingNode = (spawner: Spawner, errors: ValidationError[]): void => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
        ['MinTier', 'MaxTier'],
        ['MinConnections', 'MaxConnections'],
    ];
    for (const [lowName, highName] of pairs) {
        const lowNode = childNamed(spawner.group, lowName);
        const highNode = childNamed(spawner.group, highName);
        const low = numberOf(lowNode);
        const high = numberOf(highNode);
        if (lowNode === null || highNode === null || low === null || high === null || low <= high) continue;
        errors.push({
            message: l10n.t(
                'The picker keeps only the nodes inside this window, and {0} of {1} is above {2} of {3}, so every node is discarded and starting a game stops with an error.',
                lowName,
                low,
                highName,
                high
            ),
            node: lowNode,
            severity: 'error',
        });
    }
    for (const field of ['CandidatesClosestToFactions', 'CandidatesFarthestFromFactions']) {
        const written = childNamed(spawner.group, field);
        const count = written && isListNode(written) ? numberOf(written.elements[0]) : null;
        if (count === null || count > 0) continue;
        errors.push({
            message: l10n.t(
                "'{0}' keeps only its first {1} candidates, so a count of {1} keeps none and starting a game stops with an error. The count next to a faction list is not a switch: write no '{0}' at all to turn the filter off.",
                field,
                count
            ),
            node: written ?? spawner.group,
            severity: 'error',
        });
    }
};

/**
 * Runs the galaxy-generator checks over a document.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk and the reference reads.
 * @returns the findings, in source order.
 */
export const validateGalaxyGenerators = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    for (const { list, spawners } of await spawnerListsOf(document, cancellationToken)) {
        if (cancellationToken.isCancellationRequested) return errors;
        judgeSectorTypes(list, spawners, errors);
        for (const spawner of spawners) {
            // Only a spawner this document writes is judged on its own numbers. A referenced one
            // belongs to the file that declares it and would otherwise be reported once per
            // generator that names it.
            if (getStartOfAstNode(spawner.group).uri !== document.uri) continue;
            if (spawner.cls === PROGRESSION_TIERS) judgePriorities(spawner, errors);
            if (spawner.cls === MAP_NODES) judgeConnectionRadius(spawner, errors);
            if (spawner.cls === STARTING_NODE) judgeStartingNode(spawner, errors);
        }
    }
    return errors;
};
