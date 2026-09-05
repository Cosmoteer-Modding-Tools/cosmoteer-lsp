import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, GroupNode, isGroupNode, isValueNode } from '../core/ast/ast';
import { resolveGroupClass } from '../document/schema/schema-context';
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
    return (await effectiveSubGroups(components.node, token)).map((entry) => ({
        name: entry.name,
        group: entry.group,
        cls: resolveGroupClass(entry.group),
    }));
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
