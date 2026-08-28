/**
 * Enum members a field's type allows and the class reading it refuses.
 *
 * The extracted schema says an enum field accepts every member of its enum. It cannot say that one
 * consuming class handles four of the seven and throws on the rest, or that a frame of reference
 * legal for a bullet is refused by a beam. Those decisions live in the reader and the update loop,
 * so a member that stops the game looks exactly like one that works, and the completion popup
 * offers it like any other.
 *
 * Every entry is read out of the shipped assembly, from the switch or the guard that refuses the
 * member. A row is keyed by the class that owns the read and the member path it reads through,
 * never by the enum alone. The same enum is handled in full elsewhere, and the same field name
 * appears on classes with no such limit, so a looser key would report values the game accepts.
 */

import { AbstractNode, GroupNode, isGroupNode } from '../../core/ast/ast';
import { classAncestry } from './schema';
import { resolveGroupClass } from './schema-context';

/** Which message a refused member gets, since what the game does with it differs per row. */
export type RefusalConsequence =
    /** The reader throws while the file is being read, so the game does not start. */
    | 'load'
    /** The bullet's update loop throws once that priority is reached. */
    | 'targetSearch'
    /** The death components throw when the bullet dies. */
    | 'bulletDeath'
    /** The beam throws when it hits something it draws effects for. */
    | 'beamHit';

/** One field a class reads only some of its enum's members from. */
export interface RefusedEnumRule {
    /** The class that owns the read. A group deriving from it is covered too. */
    readonly owner: string;
    /** The member path from that class to the value, so a nested group is reached by name. */
    readonly path: readonly string[];
    /** Whether the value is a list, in which case every element is judged. */
    readonly listed?: boolean;
    /** The members the consumer handles. Everything else in the enum is refused. */
    readonly accepted: readonly string[];
    readonly severity: 'error' | 'warning';
    readonly consequence: RefusalConsequence;
}

/** The six hit blocks a beam emitter reads a frame of reference out of. */
const BEAM_HIT_MEMBERS = [
    'HitAttenuator',
    'HitOperational',
    'HitShield',
    'HitStructural',
    'HitCrew',
    'HitNothing',
] as const;

export const REFUSED_ENUM_RULES: readonly RefusedEnumRule[] = [
    // FixedWeaponRules's constructor tests the member it just read and throws saying a fixed weapon
    // supports only ShipParts. The turret twin handles all seven, which is why the schema carries
    // no limit. The singular member name is what tells the two apart: a turret declares AutoTargets.
    {
        owner: 'Cosmoteer.Ships.Parts.Weapons.FixedWeaponRules',
        path: ['AutoTarget', 'TargetType'],
        accepted: ['ShipParts'],
        severity: 'error',
        consequence: 'load',
    },
    // BulletTargetSearch's update walks the priorities in order and switches on each, with four
    // arms and a throwing default. A refused member only fires once the search reaches it, which
    // needs every priority in front of it to find nothing.
    {
        owner: 'Cosmoteer.Bullets.Targeting.BulletTargetSearchRules',
        path: ['TargetTypesByPriority'],
        listed: true,
        accepted: ['ShipParts', 'ShipCenters', 'Bullets', 'Crew'],
        severity: 'warning',
        consequence: 'targetSearch',
    },
    // BaseBulletDeath resolves the frame of reference when the bullet dies, and the hit-object arm
    // is a throw saying so. Every death component derives from this class.
    {
        owner: 'Cosmoteer.Bullets.Death.BaseBulletDeathRules',
        path: ['OnDeath', 'FrameOfReference'],
        accepted: ['Grid', 'Inherit', 'Bullet'],
        severity: 'warning',
        consequence: 'bulletDeath',
    },
    // A beam has no bullet to take a velocity from, so BeamEmitter's own switch throws on that arm.
    // It is reached only once the hit draws something, which a block with no effects never does.
    ...BEAM_HIT_MEMBERS.map(
        (member): RefusedEnumRule => ({
            owner: 'Cosmoteer.Ships.Parts.Weapons.BeamEmitterRules',
            path: [member, 'FrameOfReference'],
            accepted: ['Grid', 'Inherit', 'HitObject'],
            severity: 'warning',
            consequence: 'beamHit',
        })
    ),
];

/**
 * The group a node sits in, which is the container a member path walks up through.
 *
 * @param node the node to walk up from.
 * @returns the nearest enclosing group, or undefined at the top of the file.
 */
const enclosingGroupOf = (node: AbstractNode): GroupNode | undefined => {
    let current = node.parent;
    while (current && !isGroupNode(current)) current = current.parent;
    return current;
};

/**
 * The members the class reading a field actually accepts, when a row covers it.
 *
 * Asked by the validator and by the value popup alike, so a member the game refuses is neither
 * reported after it was written nor offered before it is. Answers nothing where no row covers the
 * field, which is every field but a handful.
 *
 * @param group the group the field is written in.
 * @param fieldName the field being written.
 * @returns the accepted members, or undefined when the field carries no limit beyond its enum.
 */
export const acceptedMembersAt = (group: GroupNode, fieldName: string): readonly string[] | undefined => {
    const folded = fieldName.toLowerCase();
    for (const rule of REFUSED_ENUM_RULES) {
        if (rule.path[rule.path.length - 1].toLowerCase() !== folded) continue;
        let owner: GroupNode | undefined = group;
        for (let hop = rule.path.length - 1; hop > 0 && owner; hop--) owner = enclosingGroupOf(owner);
        if (!owner) continue;
        const cls = resolveGroupClass(owner);
        if (cls && classAncestry(cls).includes(rule.owner)) return rule.accepted;
    }
    return undefined;
};
