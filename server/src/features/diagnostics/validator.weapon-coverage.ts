import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    descendants,
    isGroupNode,
    isValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { classAncestry } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { flattenGroup } from '../../semantics/effective-group';
import { EffectiveMemberEntry } from '../../semantics/effective-group.types';
import { booleanOf, readTupleEvaluated } from '../../semantics/vector-forms';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { numberFrom } from './validator.resource-pickup';
import { PLAIN_ID } from './validator.schema-sibling';
import { ValidationError } from './validator';

/**
 * Whole-document pass (default on, settable off): a weapon's default coverage and coverage matching
 * written in a way the game silently ignores or that breaks the weapon.
 *
 * Nothing about `DefaultWeaponCoverage` or `MatchWeaponCoverage` is checked when the game loads, so
 * every mistake here is silent. Read from the decompiled `Weapon`, `TurretWeapon` and `FixedWeapon`
 * and from `Halfling.Geometry.Arc`. An arc is a start edge and a width in radians, measured from the
 * mount direction. A turret intersects it with its physical arc (`ValidArc`, else `FiringArc`,
 * centred on the mount direction) and falls back to the whole physical arc when the two do not
 * meet. The coverage range caps the weapon's own range. `RestPosition` is a fraction along the
 * effective arc that only a turret returning to centre reads. A fixed weapon reads its arc only for
 * `MatchWeaponCoverageStrictFire`, and only a fixed weapon reads that flag. `MatchWeaponCoverage`
 * borrows the player-set coverage of one other weapon, a single hop, and switches editing off for
 * the weapon that writes it.
 *
 * Values are read through the inheritance fold, and a chain that could not be read to the end says
 * nothing. A finding is reported only on a node this document writes, once, so a template shared by
 * several weapons is blamed in its own file and not once per weapon inheriting it.
 */

const WEAPON_CLASS = 'Cosmoteer.Ships.Parts.Weapons.WeaponRules';
const TURRET_CLASS = 'Cosmoteer.Ships.Parts.Weapons.TurretWeaponRules';
const FIXED_CLASS = 'Cosmoteer.Ships.Parts.Weapons.FixedWeaponRules';

/** A full turn, the width at which an arc stops being an arc. */
const FULL_TURN = 2 * Math.PI;

/** Slack on the overlap test, so an arc that only touches the physical one is left alone. */
const ANGLE_SLACK = 1e-4;

/** The arc's members in the order its list form writes them. */
const ARC_MEMBERS = ['NearEdge', 'Width'] as const;

/**
 * The effective members of a group by folded name.
 *
 * @param group the group to fold.
 * @param token cancels the fold.
 * @returns the members, or null when the chain could not be read to the end.
 */
const membersOf = async (
    group: GroupNode,
    token: CancellationToken
): Promise<Map<string, EffectiveMemberEntry> | null> => {
    const folded = await flattenGroup(group, token).catch(() => null);
    if (!folded || !folded.complete) return null;
    const members = new Map<string, EffectiveMemberEntry>();
    for (const member of folded.members) if (member.value) members.set(member.name.toLowerCase(), member);
    return members;
};

/**
 * The positive angle from one direction to another, the way `Direction.PositiveAngleTo` measures it.
 *
 * @param from the direction to start at.
 * @param to the direction to end at.
 * @returns the angle in radians, from 0 up to a full turn.
 */
const positiveAngle = (from: number, to: number): number => (((to - from) % FULL_TURN) + FULL_TURN) % FULL_TURN;

/**
 * Checks one weapon's coverage and coverage matching.
 *
 * @param weapon the weapon component group.
 * @param ancestry the weapon's class and every class above it.
 * @param token cancels the folds and evaluations.
 * @param report records a finding on a node, once.
 */
const judgeWeapon = async (
    weapon: GroupNode,
    ancestry: string[],
    token: CancellationToken,
    report: (node: AbstractNode, message: string, severity: 'warning' | 'hint', member?: EffectiveMemberEntry) => void
): Promise<void> => {
    const turret = ancestry.includes(TURRET_CLASS);
    const fixed = ancestry.includes(FIXED_CLASS);
    const members = await membersOf(weapon, token);
    if (!members) return;
    const value = (name: string): AbstractNode | undefined => members.get(name.toLowerCase())?.value ?? undefined;
    const strictFire = booleanOf(value('MatchWeaponCoverageStrictFire')) === true;

    const strictMember = members.get('matchweaponcoveragestrictfire');
    if (turret && strictMember) {
        report(
            strictMember.value!,
            l10n.t('Only a fixed weapon reads MatchWeaponCoverageStrictFire, so it has no effect on a turret.'),
            'hint',
            strictMember
        );
    }

    await judgeMatch(weapon, value('MatchWeaponCoverage'), token, report);

    const coverage = value('DefaultWeaponCoverage');
    if (!coverage || !isGroupNode(coverage)) return;
    const fields = await membersOf(coverage, token);
    if (!fields) return;

    const rangeMember = fields.get('range');
    const range = await numberFrom(rangeMember?.value ?? undefined, token);
    if (rangeMember && range !== null) {
        const validRange = turret ? await physicalNumber(value('ValidRange'), token) : null;
        if (range <= 0) {
            report(
                rangeMember.value!,
                l10n.t(
                    'A coverage range of {0} keeps every target out of range, so the weapon never fires on its own. Write a range above zero.',
                    range
                ),
                'warning'
            );
        } else if (validRange !== null && range >= validRange) {
            report(
                rangeMember.value!,
                l10n.t(
                    'The turret never reaches past its ValidRange of {0}, so a coverage range of {1} changes nothing.',
                    validRange,
                    range
                ),
                'hint',
                rangeMember
            );
        }
    }

    const restMember = fields.get('restposition');
    const rest = await numberFrom(restMember?.value ?? undefined, token);
    if (restMember && fixed) {
        report(
            restMember.value!,
            l10n.t('A fixed weapon never turns, so the game ignores RestPosition.'),
            'hint',
            restMember
        );
    } else if (
        restMember &&
        rest !== null &&
        turret &&
        booleanOf(value('ReturnToCenter')) !== false &&
        (rest < 0 || rest > 1)
    ) {
        report(
            restMember.value!,
            l10n.t(
                'RestPosition is a fraction of the coverage arc from its start edge to its far edge, so {0} parks the turret outside its own coverage. Write a value from 0 to 1.',
                rest
            ),
            'warning'
        );
    }

    const arcMember = fields.get('arc');
    if (!arcMember) return;
    if (fixed && !strictFire) {
        report(
            arcMember.value!,
            l10n.t(
                'A fixed weapon reads its coverage arc only when MatchWeaponCoverageStrictFire is true, so the game ignores this arc.'
            ),
            'hint',
            arcMember
        );
        return;
    }
    const arc = await readTupleEvaluated(arcMember.value, ARC_MEMBERS, token).catch(() => null);
    if (!arc || !arc.every(Number.isFinite)) return;
    const [nearEdge, width] = arc;
    if (width < 0) {
        report(
            arcMember.value!,
            l10n.t(
                "The arc's width is negative, so the arc holds no direction and the weapon never treats a target as covered. Write the start edge first and a positive width after it."
            ),
            'warning'
        );
        return;
    }
    if (!turret) return;
    if (width !== 0 && booleanOf(value('ForceCustomCoverageWidthZero')) === true) {
        report(
            arcMember.value!,
            l10n.t(
                'ForceCustomCoverageWidthZero only applies when no default arc is written. This arc is used as written, while players can only ever set an arc of zero width.'
            ),
            'warning'
        );
    }
    const physical = await physicalNumber(value('ValidArc') ?? value('FiringArc'), token);
    if (physical === null || physical < 0 || physical >= FULL_TURN - ANGLE_SLACK) return;
    if (width === 0 || width >= FULL_TURN - ANGLE_SLACK) return;
    // `Arc.FindIntersection` finds nothing when neither arc holds the other's start edge.
    const physicalNear = -physical / 2;
    const physicalHoldsNear = positiveAngle(physicalNear, nearEdge) < physical + ANGLE_SLACK;
    const arcHoldsPhysicalNear = positiveAngle(nearEdge, physicalNear) < width + ANGLE_SLACK;
    if (physicalHoldsNear || arcHoldsPhysicalNear) return;
    report(
        arcMember.value!,
        l10n.t(
            "This arc does not overlap the turret's physical arc anywhere, so the game drops it and the turret covers its whole physical arc instead. Coverage arcs are measured from the mount direction, with 0 straight ahead."
        ),
        'warning'
    );
};

/**
 * A physical arc or range, read only when the field is a plain value. The group form carries
 * modifiers that buffs change at run time, so no single number stands for it.
 *
 * @param node the written field value.
 * @param token cancels the evaluation.
 * @returns the number, or null when it is not a plain value that resolves to one.
 */
const physicalNumber = async (node: AbstractNode | undefined, token: CancellationToken): Promise<number | null> =>
    node && isValueNode(node) ? numberFrom(node, token) : null;

/**
 * Checks what a `MatchWeaponCoverage` names, against the part's own component dictionary.
 *
 * @param weapon the weapon component group.
 * @param match the written `MatchWeaponCoverage` value.
 * @param token cancels the folds.
 * @param report records a finding on a node, once.
 */
const judgeMatch = async (
    weapon: GroupNode,
    match: AbstractNode | undefined,
    token: CancellationToken,
    report: (node: AbstractNode, message: string, severity: 'warning' | 'hint') => void
): Promise<void> => {
    if (!match || !isValueNode(match) || match.valueType.type === 'Reference') return;
    const target = String(match.valueType.value).trim();
    if (!PLAIN_ID.test(target)) return;
    // The dictionary is the `Components` group the weapon is written in, inside a part or at the top
    // of a part fragment a part includes. Component ids share one space across the part, so a name
    // this group does not hold is left alone rather than read as missing.
    const components = weapon.parent;
    if (!isGroupNode(components) || components.identifier?.name.toLowerCase() !== 'components') return;
    if (weapon.identifier?.name.toLowerCase() === target.toLowerCase()) {
        report(
            match,
            l10n.t(
                'A weapon matching its own coverage only switches off coverage editing for players. Name another weapon or remove MatchWeaponCoverage.'
            ),
            'warning'
        );
        return;
    }
    const dictionary = await membersOf(components, token);
    const named = dictionary?.get(target.toLowerCase())?.value;
    if (!named || !isGroupNode(named)) return;
    const cls = resolveGroupClass(named);
    if (!cls) return;
    if (!classAncestry(cls).includes(WEAPON_CLASS)) {
        report(
            match,
            l10n.t(
                "'{0}' is not a weapon, so there is no coverage to match. This weapon keeps its default coverage and players cannot edit it.",
                target
            ),
            'warning'
        );
        return;
    }
    const targetMembers = await membersOf(named, token);
    if (!targetMembers?.get('matchweaponcoverage')) return;
    report(
        match,
        l10n.t(
            "'{0}' matches another weapon's coverage itself, so players can never set one on it, and matching is a single hop, so this weapon never follows anything. Name the weapon whose coverage players edit.",
            target
        ),
        'warning'
    );
};

/**
 * Runs the weapon coverage check over a document.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk.
 * @returns the findings, each on a node this document writes.
 */
export const validateWeaponCoverage = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    const reported = new Set<string>();
    const report = (
        node: AbstractNode,
        message: string,
        severity: 'warning' | 'hint',
        member?: EffectiveMemberEntry
    ): void => {
        if (getStartOfAstNode(node).uri !== document.uri) return;
        const key = `${node.position?.start}:${message}`;
        if (reported.has(key)) return;
        reported.add(key);
        // A hint fades the whole field, name and value, the way the other dead-field hints do.
        const name = member?.origin.node.position;
        const range = name && node.position ? { start: name.start, end: node.position.end } : undefined;
        errors.push(
            severity === 'hint' ? { message, node, severity, unnecessary: true, range } : { message, node, severity }
        );
    };
    for (const node of descendants(document)) {
        if (cancellationToken.isCancellationRequested) return errors;
        if (!isGroupNode(node)) continue;
        const cls = resolveGroupClass(node);
        const ancestry = cls ? classAncestry(cls) : [];
        if (ancestry.includes(WEAPON_CLASS)) await judgeWeapon(node, ancestry, cancellationToken, report);
    }
    return errors;
};
