import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, GroupNode, isGroupNode, isValueNode } from '../core/ast/ast';
import { registryForGroup, resolveGroupClass } from '../document/schema/schema-context';
import { classByDiscriminator, fieldsOf, typeDef } from '../document/schema/schema';
import { effectiveMember, effectiveSubGroups } from './effective-member';
import { resolveValueReference } from './value-evaluator';

/** One component of a part, with the class the schema reads it as. */
export interface PartComponent {
    readonly name: string;
    readonly group: GroupNode;
    /** The resolved schema class, undefined when the `Type` names nothing the schema knows. */
    readonly cls: string | undefined;
}

/**
 * Every named component of a part, whatever its class, merged across the `Components` group's own
 * inheritance chain so components a part gathers from other files are included.
 *
 * A part's components are the unit almost every part-wide question is asked of, so the walk lives
 * here rather than beside whichever feature asked for it first.
 *
 * @param part the part group.
 * @param token cancels reference resolution.
 * @returns the components with their resolved class, local declarations first.
 */
export const componentsOfPart = async (part: GroupNode, token: CancellationToken): Promise<PartComponent[]> => {
    const components = await effectiveMember(part, 'Components', token);
    if (!components || !isGroupNode(components.node)) return [];
    const resolved: PartComponent[] = [];
    await collectComponents(components.node, resolved, token, 0);
    return resolved;
};

/** How deep a nest of components is followed, so a cycle through a base cannot spin. */
const MAX_COMPONENT_NESTING = 8;

/**
 * The member of a component that holds components of its own kind, or undefined for one that holds
 * none. Read as a shape rather than as a class name: a component whose class declares a map or a
 * list of the very registry the component itself belongs to is, by that fact, a container of more of
 * them. The engine's one such class today is `ToggledComponents`, and a mod's own subclass of it,
 * or another the game adds later, is picked up without this file learning a new name.
 *
 * @param cls the component's resolved class.
 * @returns the member name, or undefined when the class holds no components.
 */
const nestedComponentsMember = (cls: string | undefined): string | undefined => {
    const registry = cls ? typeDef(cls)?.registry : undefined;
    if (!registry) return undefined;
    for (const field of fieldsOf(cls!)) {
        const type = field.valueType;
        const held = type.kind === 'map' ? type.value : type.kind === 'list' ? type.element : undefined;
        if (held?.kind === 'polymorphicGroup' && held.ref === registry) return field.name;
    }
    return undefined;
};

/**
 * Collects a `Components` group's components into `into`, following the components that hold more of
 * them.
 *
 * A toggled group is not a container in the rules only: `PartToggledComponents.AddComponents` hands
 * its children to `Part.AddComponents`, which registers each one in the part's single id map beside
 * the components written at the top level. So a sibling naming one of them by id resolves, and a
 * reader that stopped at the wrapper would call a component that is right there missing. That is not
 * a corner: it is how every laser blaster, missile launcher and reactor writes the components its
 * overclock toggle switches between.
 *
 * @param group the `Components` group to read.
 * @param into the list the components are appended to, nearest declaration first.
 * @param token cancels reference resolution.
 * @param depth guards a nest that leads back into itself.
 */
const collectComponents = async (
    group: GroupNode,
    into: PartComponent[],
    token: CancellationToken,
    depth: number
): Promise<void> => {
    for (const entry of await effectiveSubGroups(group, token)) {
        const cls = resolveGroupClass(entry.group) ?? (await inheritedComponentClass(entry.group, token));
        into.push({ name: entry.name, group: entry.group, cls });
        const holder = depth < MAX_COMPONENT_NESTING ? nestedComponentsMember(cls) : undefined;
        if (!holder) continue;
        const nested = await effectiveMember(entry.group, holder, token);
        if (nested && isGroupNode(nested.node)) await collectComponents(nested.node, into, token, depth + 1);
    }
};

/**
 * The class of a component that writes no `Type` of its own because it takes one from a base
 * (`HeatDistributionStorage : ^/0/HeatDistributionStorage { … }`). The synchronous class resolution
 * follows a same-file base only, so a component redeclared over one reached through the part's own
 * inheritance list, or over one in another file, resolves to nothing at all. That is not a rare
 * shape: it is how a vanilla thruster narrows the heat storage it inherits, and a reader that drops
 * such a component then reports every sibling naming it as a component that does not exist.
 *
 * @param group the component group.
 * @param token cancels the inheritance walk.
 * @returns the class FullName, or undefined when the `Type` is unreadable or names nothing known.
 */
const inheritedComponentClass = async (group: GroupNode, token: CancellationToken): Promise<string | undefined> => {
    if (!group.inheritance?.length) return undefined;
    const type = await effectiveMember(group, 'Type', token);
    if (!type || !isValueNode(type.node)) return undefined;
    return classByDiscriminator(String(type.node.valueType.value), registryForGroup(group)?.name);
};

/** What a field naming a sibling component really names. */
export interface ComponentReference {
    /** The component name the game reads, absent when a reference could not be followed. */
    readonly name?: string;
    /** The text as written, for a message that has to name what it could not follow. */
    readonly written: string;
}

/**
 * The component a field names, following a reference where the field holds one.
 *
 * A component field is written either as the sibling's own name (`Storage = AmmoStore`) or as a
 * reference to a constant holding one (`ResourceStorage = &~/Part/^/0/HEAT_TARGET_STORAGE`). The
 * game reads the reference and looks the resulting name up among the part's components, so anything
 * reading these fields has to follow it too. Reporting the reference text as a missing component is
 * the false statement it looks like: the component is right there, under the name the constant
 * holds.
 *
 * @param value the field's value node.
 * @param token cancels the reference resolution.
 * @returns the name the game reads, or just the written text when the reference leads nowhere.
 */
export const componentReferenceOf = async (
    value: AbstractNode,
    token: CancellationToken
): Promise<ComponentReference> => {
    if (!isValueNode(value)) return { written: '' };
    const written = String(value.valueType.value);
    if (value.valueType.type !== 'Reference') return { name: written, written };
    const target = await resolveValueReference(value, token).catch(() => null);
    if (target && isValueNode(target)) return { name: String(target.valueType.value), written };
    return { written };
};
