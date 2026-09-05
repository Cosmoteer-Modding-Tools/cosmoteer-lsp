import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isValueNode } from '../../core/ast/ast';
import { ComponentReference, PartComponent, componentReferenceOf, componentsOfPart } from '../../semantics/part-components';
import { evaluateNumericValue, formatNumber } from '../../semantics/value-evaluator';
import { getStartOfAstNode, memberValueNamed } from '../../utils/ast.utils';
import { Diagram, DiagramEdge, DiagramNode } from '../diagram/diagram.types';
import { partAt } from './part-at';

/**
 * The drawn firing chain of one part: what triggers what, what each link waits, and which of them
 * plays effects.
 *
 * Effect timing is tuned by trial, and every attempt costs a restart because rules cannot reload
 * into a running game. What makes that expensive is not the numbers but the shape: a trigger names a
 * component, that component chains to another, and the delays sit on three different kinds of
 * component, so working out what actually fires when means reading the whole `Components` group.
 *
 * It is drawn as a chain rather than as a bar chart on purpose. A bar needs a start and a length,
 * and here a delay can be buff-driven, a particle lifetime can be a range rolled per shot, and a
 * continuous effect never ends. Bars would have to be drawn for all three, and most of them would be
 * a guess presented as a measurement. What is decidable is who fires whom and what each link waits,
 * and that is what this shows.
 */

/** The member naming what fires a component, written either as an id or as a group holding one. */
const TRIGGER_FIELDS: readonly string[] = ['Trigger', 'DelayTrigger'];

/** The member naming what a component fires next. */
const CHAIN_FIELD = 'ChainedTo';

/** The members carrying a wait, in the order they are shown. */
const DELAY_FIELDS: readonly string[] = ['Delay', 'InitialDelay', 'DelayAfterTrigger', 'Interval'];

/** The members whose presence makes a component one that plays something. */
const EFFECT_FIELDS: readonly string[] = ['MediaEffects', 'HitEffects'];

/**
 * The value naming the component a trigger member points at, whether it is written as the name
 * itself or as the group that holds one.
 *
 * @param group the component group.
 * @param field the trigger member's name.
 * @returns the value node, or undefined when the component writes no trigger.
 */
const triggerValue = (group: GroupNode, field: string): AbstractNode | undefined => {
    const member = memberValueNamed(group, field);
    if (!member) return undefined;
    if (isValueNode(member)) return member;
    if (isGroupNode(member)) {
        const id = memberValueNamed(member, 'ID');
        if (id && isValueNode(id)) return id;
    }
    return undefined;
};

/**
 * The waits a component writes, as text ready for the box.
 *
 * @param group the component group.
 * @param token cancels the evaluation of each one.
 * @returns one entry per wait that works out to a number.
 */
const delaysOf = async (group: GroupNode, token: CancellationToken): Promise<string[]> => {
    const out: string[] = [];
    for (const field of DELAY_FIELDS) {
        const member = memberValueNamed(group, field);
        if (!member) continue;
        const value = await evaluateNumericValue(member, token);
        // A wait written as a modifiable group, or read off a buff, has no one number to show. The
        // member is left out rather than shown with a number that is only sometimes right.
        if (value !== null) out.push(`${field} ${formatNumber(value)}`);
    }
    return out;
};

/**
 * The name a part is known by: the id it registers under, falling back to the name of the group
 * itself. Almost every part file calls its group `Part`, which names nothing on its own.
 *
 * @param part the part group.
 * @returns the display name.
 */
const partNameOf = (part: GroupNode): string => {
    const id = memberValueNamed(part, 'ID');
    if (id && isValueNode(id)) return String(id.valueType.value);
    return part.identifier?.name ?? l10n.t('this part');
};

/**
 * Builds the drawn firing chain of the part at an offset.
 *
 * @param document the parsed document.
 * @param offset the caret's byte offset.
 * @param token cancels the component walk and the delay evaluations.
 * @returns the diagram, or undefined when the caret is not in a part that triggers anything.
 */
export const buildEffectChainDiagram = async (
    document: AbstractNodeDocument,
    offset: number,
    token: CancellationToken
): Promise<Diagram | undefined> => {
    const part = partAt(document, offset);
    if (!part) return undefined;
    const components = await componentsOfPart(part, token);
    if (components.length === 0) return undefined;

    const byName = new Map<string, PartComponent>();
    for (const component of components) byName.set(component.name.toLowerCase(), component);

    const uri = getStartOfAstNode(part).uri;
    const nodes = new Map<string, DiagramNode>();
    const edges: DiagramEdge[] = [];
    const wired = new Set<string>();
    let unresolved = 0;

    /**
     * The box for a component, added on first use. A name matching no component of the part gets a
     * box saying so, since a chain that stops there is exactly what the reader is looking for, and a
     * reference that could not be followed gets one saying that instead.
     *
     * @param reference what the field names.
     * @returns the box id.
     */
    const boxFor = async (reference: ComponentReference): Promise<string> => {
        const name = reference.name ?? reference.written;
        const key = name.toLowerCase();
        const id = `c:${key}`;
        if (nodes.has(id)) return id;
        const component = reference.name ? byName.get(key) : undefined;
        if (!component) {
            unresolved++;
            nodes.set(id, {
                id,
                label: name,
                detail: reference.name
                    ? l10n.t('no component of this part')
                    : l10n.t('this reference could not be followed'),
                kind: 'missing',
            });
            return id;
        }
        const type = memberValueNamed(component.group, 'Type');
        const delays = await delaysOf(component.group, token);
        const plays = EFFECT_FIELDS.some((field) => memberValueNamed(component.group, field));
        const detail = [
            type && isValueNode(type) ? String(type.valueType.value) : undefined,
            ...delays,
            plays ? l10n.t('plays effects') : undefined,
        ]
            .filter(Boolean)
            .join(' · ');
        nodes.set(id, {
            id,
            label: component.name,
            detail: detail || undefined,
            kind: plays ? 'component' : 'member',
            place: { uri, line: component.group.position.line + 1 },
        });
        return id;
    };

    for (const component of components) {
        if (token.isCancellationRequested) return undefined;
        for (const field of TRIGGER_FIELDS) {
            const source = triggerValue(component.group, field);
            if (!source) continue;
            const from = await boxFor(await componentReferenceOf(source, token));
            const to = await boxFor({ name: component.name, written: component.name });
            edges.push({ from, to, kind: 'flow', label: field });
            wired.add(from);
            wired.add(to);
        }
        const chained = memberValueNamed(component.group, CHAIN_FIELD);
        if (chained && isValueNode(chained)) {
            const from = await boxFor({ name: component.name, written: component.name });
            const to = await boxFor(await componentReferenceOf(chained, token));
            edges.push({ from, to, kind: 'flow', label: CHAIN_FIELD });
            wired.add(from);
            wired.add(to);
        }
    }

    // A component nothing fires and that fires nothing is not part of a chain, so it stays out of the
    // drawing rather than filling it with disconnected boxes.
    for (const id of [...nodes.keys()]) if (!wired.has(id)) nodes.delete(id);
    if (nodes.size === 0) return undefined;

    const notes = [
        l10n.t(
            'A wait is shown only where it works out to one number. A wait a buff can move, and a particle lifetime rolled per shot, have no single value to show.'
        ),
        l10n.t('A continuous effect never ends, so nothing here is drawn to scale.'),
    ];
    if (unresolved > 0) {
        notes.push(l10n.t('{0} of the names written here match no component of this part.', String(unresolved)));
    }

    return {
        title: l10n.t('Firing chain of {0}', partNameOf(part)),
        subtitle: l10n.t('{0} of {1} components are wired into a chain', String(nodes.size), String(components.length)),
        nodes: [...nodes.values()],
        edges,
        legend: [
            { kind: 'component', label: l10n.t('plays effects') },
            { kind: 'member', label: l10n.t('passes the trigger on') },
            { kind: 'missing', label: l10n.t('names no component') },
            { kind: 'flow', label: l10n.t('fires') },
        ],
        notes,
    };
};
