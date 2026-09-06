import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import {
    classSatisfiesKind,
    componentTriggerFieldNames,
    fieldsOf,
    isComponentTriggerType,
    isMediaEffectType,
    isWaitType,
    mediaEffectFieldNames,
    typeDef,
    waitFieldNames,
} from '../../document/schema/schema';
import {
    ComponentReference,
    PartComponent,
    componentReferenceOf,
    componentsOfPart,
    isProxyComponent,
    proxyTargetsOf,
} from '../../semantics/part-components';
import { memberOrInherited } from '../../semantics/effective-member';
import { evaluateNumericValue, formatNumber } from '../../semantics/value-evaluator';
import { getStartOfAstNode, memberValueNamed, namedMembersOf } from '../../utils/ast.utils';
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
 *
 * Which members carry that wiring is asked of the schema rather than written here. The engine reads
 * "what fires me" out of seventeen differently named fields, all typed the same, and a drawing that
 * knew two of them would show a tenth of the chain. For the same reason `ChainedTo` is absent: it
 * sets a component's location and rotation relative to another, so a turret's sprites and crew seat
 * name the turret without any of them ever firing anything.
 */

/** The member a trigger group names its component in, for the `{ ID; TriggerID }` form. */
const TRIGGER_ID_MEMBER = 'ID';

/** The member a trigger group picks one of a component's several outputs with. */
const TRIGGER_OUTPUT_MEMBER = 'TriggerID';

/**
 * The runtime kind a component satisfies when it can fire something. A proxy stands in for another
 * component whatever it relays, but only the ones relaying a trigger belong in a firing chain: a
 * toggle, a mode or a value proxy passes on something else, and an arrow for it would say it fires.
 */
const TRIGGER_KIND = 'Cosmoteer.Ships.Parts.Logic.IPartComponentTrigger';

/** The prefix of a box standing for a component a proxy reaches on another part. */
const OTHER_PART_PREFIX = 'outside:other:';

/**
 * One trigger a component subscribes to: the component whose firing drives it, and the named output
 * of that component where it names one.
 */
interface TriggerLink {
    /** The value naming the component that fires. */
    readonly source: AbstractNode;
    /** The named output, absent where the trigger takes the component's default one. */
    readonly output?: string;
}

/**
 * The value nodes a member holds, whether written as one value, as a group, or as a list of either.
 *
 * @param group the component group.
 * @param name the member name.
 * @returns the nodes the member holds, empty when it is absent.
 */
const memberEntries = (group: GroupNode, name: string): AbstractNode[] => {
    const member = memberValueNamed(group, name);
    if (!member) return [];
    if (isListNode(member)) return member.elements.filter((element) => isValueNode(element) || isGroupNode(element));
    return [member];
};

/**
 * The trigger a value holds, in the two forms the engine reads it in: the firing component's id, or
 * a group naming that component in `ID` beside the `TriggerID` of one of its several outputs.
 *
 * @param node the value the trigger member holds.
 * @returns the link, or undefined when the value is neither shape.
 */
const triggerLinkOf = (node: AbstractNode): TriggerLink | undefined => {
    if (isValueNode(node)) return { source: node };
    if (!isGroupNode(node)) return undefined;
    const id = memberValueNamed(node, TRIGGER_ID_MEMBER);
    if (!id || !isValueNode(id)) return undefined;
    const output = memberValueNamed(node, TRIGGER_OUTPUT_MEMBER);
    return { source: id, output: output && isValueNode(output) ? String(output.valueType.value) : undefined };
};

/**
 * The members of a component that carry a kind of wiring, taken from the class the component
 * resolves to. A class that resolves answers exactly, since it declares the fields it reads.
 *
 * A component whose class does not resolve falls back to the schema-wide set of names typed that
 * way. That is a weaker answer, but the names are distinctive enough that reading `FireTrigger` off
 * an untyped group beats leaving the component out of the chain it visibly belongs to.
 *
 * @param component the component.
 * @param typed what makes a field's type one of this kind.
 * @param anyClass the schema-wide names of that kind, for a component without a class.
 * @returns the member names to read, in the order the class declares them.
 */
const wiringMembers = (
    component: PartComponent,
    typed: (valueType: Parameters<typeof isWaitType>[0]) => boolean,
    anyClass: () => ReadonlySet<string>
): string[] => {
    if (component.cls) return fieldsOf(component.cls).filter((field) => typed(field.valueType)).map((field) => field.name);
    const names = anyClass();
    return namedMembersOf(component.group)
        .map(([name]) => name)
        .filter((name) => names.has(name.toLowerCase()));
};

/**
 * The waits a component writes, as text ready for the box. Every wait the engine reads is a time, so
 * the members are taken from the class rather than from a list of names kept here.
 *
 * @param component the component.
 * @param token cancels the evaluation of each one.
 * @returns one entry per wait that works out to a number.
 */
const delaysOf = async (component: PartComponent, token: CancellationToken): Promise<string[]> => {
    const out: string[] = [];
    for (const field of wiringMembers(component, isWaitType, waitFieldNames)) {
        const member = await memberOrInherited(component.group, field, token);
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
    // A part that switches between two sets of components declares the same id in each of them, and
    // only one of the two is wired in at a time. The first is kept, which is the one written before
    // the overclocked or otherwise switched-in alternative.
    let switched = 0;
    for (const component of components) {
        const key = component.name.toLowerCase();
        if (byName.has(key)) switched++;
        else byName.set(key, component);
    }

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
        const written = memberValueNamed(component.group, 'Type');
        // The written `Type` first, since that is the word the reader is looking at, and the class's
        // own discriminator where the component takes its type from a base instead of writing one.
        const kind =
            written && isValueNode(written)
                ? String(written.valueType.value)
                : component.cls
                  ? typeDef(component.cls)?.derivedType
                  : undefined;
        const delays = await delaysOf(component, token);
        const plays = wiringMembers(component, isMediaEffectType, mediaEffectFieldNames).some((field) =>
            memberValueNamed(component.group, field)
        );
        const detail = [kind, ...delays, plays ? l10n.t('plays effects') : undefined].filter(Boolean).join(' · ');
        nodes.set(id, {
            id,
            label: component.name,
            detail: detail || undefined,
            kind: plays ? 'component' : 'member',
            place: { uri, line: component.group.position.line + 1 },
        });
        return id;
    };

    // Only the components kept above are read, so a part that switches between two sets does not get
    // the wiring of both drawn over each other.
    /**
     * The box for a component a proxy reaches on another part. Such a component is not this part's
     * to have, so it gets a box saying where it lives rather than one calling it missing.
     *
     * @param reference what the proxy names.
     * @returns the box id.
     */
    const otherPart = (reference: ComponentReference): string => {
        const name = reference.name ?? reference.written;
        const id = `${OTHER_PART_PREFIX}${name.toLowerCase()}`;
        if (!nodes.has(id)) {
            nodes.set(id, {
                id,
                label: name,
                detail: l10n.t('on whichever part the proxy finds beside this one'),
                kind: 'outside',
            });
        }
        return id;
    };

    for (const component of byName.values()) {
        if (token.isCancellationRequested) return undefined;
        for (const field of wiringMembers(component, isComponentTriggerType, componentTriggerFieldNames)) {
            const member = await memberOrInherited(component.group, field, token);
            if (!member) continue;
            for (const entry of isListNode(member) ? memberEntries(component.group, field) : [member]) {
                const link = triggerLinkOf(entry);
                if (!link) continue;
                const from = await boxFor(await componentReferenceOf(link.source, token));
                const to = await boxFor({ name: component.name, written: component.name });
                // The output the trigger picks belongs on the arrow, since a component offering
                // several of them fires each at a different moment.
                edges.push({ from, to, kind: 'flow', label: link.output ? `${field} · ${link.output}` : field });
                wired.add(from);
                wired.add(to);
            }
        }

    }

    // A proxy fires when the component it stands in for fires, so without this the chain breaks at
    // every one of them and the branch beyond reads as something nothing sets off. Only a proxy the
    // trigger pass above already reached is joined up: a storage proxy satisfies the trigger kind
    // too, because every storage offers one, and drawing the resource plumbing of a part into its
    // firing chain would fill the picture with pairs that fire nothing and are fired by nothing.
    // A proxy standing in for another proxy joins the chain only once the first is in it, so the
    // pass runs again while it keeps reaching further. Each one is expanded once, which bounds it.
    const expanded = new Set<string>();
    for (let reached = true; reached; ) {
        reached = false;
        for (const component of byName.values()) {
            if (token.isCancellationRequested) return undefined;
            if (!isProxyComponent(component.cls) || classSatisfiesKind(component.cls, TRIGGER_KIND) !== true) {
                continue;
            }
            const self = `c:${component.name.toLowerCase()}`;
            if (expanded.has(self) || !wired.has(self)) continue;
            expanded.add(self);
            const relayed = memberValueNamed(component.group, TRIGGER_OUTPUT_MEMBER);
            const output = relayed && isValueNode(relayed) ? String(relayed.valueType.value) : undefined;
            for (const target of await proxyTargetsOf(component.group, token)) {
                const reference = await componentReferenceOf(target.component, token);
                const from = target.otherPart ? otherPart(reference) : await boxFor(reference);
                edges.push({
                    from,
                    to: self,
                    kind: 'flow',
                    label: output ? `proxies · ${output}` : l10n.t('proxies'),
                });
                wired.add(from);
                reached = true;
            }
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
        l10n.t(
            'A proxy is drawn as fired by what it stands in for, since that is when it passes the trigger on. Only the proxies that relay a trigger are drawn, not the ones relaying a toggle or a value.'
        ),
        l10n.t(
            '`ChainedTo` is not drawn. It places a component relative to another rather than firing it, so a turret’s sprites and crew seat name the turret without taking part in any chain.'
        ),
    ];
    if (unresolved > 0) {
        notes.push(l10n.t('{0} of the names written here match no component of this part.', String(unresolved)));
    }
    if (switched > 0) {
        notes.push(
            l10n.t(
                '{0} of this part’s components share a name with another, in the sets a toggle switches between. Only the first of each is drawn, since only one of them fires at a time.',
                String(switched)
            )
        );
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
            { kind: 'outside', label: l10n.t('on another part') },
            { kind: 'flow', label: l10n.t('fires') },
        ],
        notes,
    };
};
