import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { classAncestry } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { evaluateNumericValue } from '../../semantics/value-evaluator';
import {
    ComponentReference,
    PartComponent,
    componentReferenceOf,
    componentsOfPart,
} from '../../semantics/part-components';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { memberOrInherited } from '../../semantics/effective-member';
import { BUFF_PROXY_CLASS, proxyTargetsOf } from '../../semantics/part-components';
import { legendFor } from '../diagram/diagram-series';
import { Diagram, DiagramEdge, DiagramNode } from '../diagram/diagram.types';
import { partAt } from './part-at';

/**
 * The drawn resource wiring of one part: where each resource comes from, what happens to it on the
 * way through, how much of it moves and how often, and where it leaves again.
 *
 * "Why does this part never get ammo" is a question the files cannot be read for. The answer is
 * spread over a handful of components that name each other by id, each naming a resource somewhere
 * else again, and following it by eye means holding four names in your head while scrolling. So the
 * picture is written for someone who has not learned the component vocabulary yet: a box says in a
 * sentence what its component does, an arrow says what moves along it and how often, and the ship
 * outside the part is a box of its own, since a resource crew carry in has to come from somewhere
 * the drawing can point at.
 *
 * What it refuses to do is guess. A component id that resolves to nothing is drawn as a box saying
 * so rather than left out, a quantity that does not work out to one number is left off the arrow
 * rather than rounded to something, and a mismatch between what a converter draws from and what that
 * storage really holds is only marked when every link in the chain resolved concretely. The proxy
 * components are exactly where that chain does not resolve, and a picture confidently drawing a
 * broken arrow through one would be worse than a picture saying it does not know.
 */

/** The class namespaces whose components carry resources, which is what this diagram is about. */
const FLOW_NAMESPACES = ['Cosmoteer.Ships.Parts.Resources.', 'Cosmoteer.Ships.Networks.PartNetworkResource'];

const RESOURCES = 'Cosmoteer.Ships.Parts.Resources.';
const NETWORKS = 'Cosmoteer.Ships.Networks.';

/** The classes whose role in the wiring the sentences and the arrows are written for. */
const CLASSES = {
    storage: `${RESOURCES}BaseResourceStorageRules`,
    multiStorage: `${RESOURCES}MultiResourceStorageRules`,
    inlineConverter: `${RESOURCES}InlineResourceConverterRules`,
    converter: `${RESOURCES}ResourceConverterRules`,
    triggeredConverter: `${RESOURCES}TriggeredResourceConverterRules`,
    consumer: `${RESOURCES}ResourceConsumerRules`,
    change: `${RESOURCES}ResourceChangeRules`,
    drainSink: `${RESOURCES}ExplosiveResourceDrainSinkRules`,
    storageProxy: `${RESOURCES}ResourceStorageProxyRules`,
    flexGrid: `${RESOURCES}FlexResourceGridRules`,
    networkIn: `${NETWORKS}PartNetworkResourceInputRules`,
    networkOut: `${NETWORKS}PartNetworkResourceOutputRules`,
    networkStore: `${NETWORKS}PartNetworkResourceStoreRules`,
} as const;

/**
 * One way a component spends a resource it does not own. The weapons, the thrusters, the drives and
 * the shields all take from a storage on their own part, and none of them lives in a resource
 * namespace: a gun's ammo draw is a member of the emitter, a thruster's fuel draw a member of the
 * thruster. A drawing that walked only the resource components would show every gun's magazine
 * filling and never emptying, which is the one question a reader opens this picture with.
 *
 * Each entry says where to read that draw, in the two forms the engine accepts for all of them: the
 * entries of a list, and the single-entry shorthand written flat beside it.
 */
/**
 * The class behind fire suppression, hull repair and the heat exchanger. It trades a status held over
 * an area against a storage, and it is the reason the table below carries a direction: its two
 * storage members sit on one class and point opposite ways.
 */
const STATUS_REGULATOR = 'Cosmoteer.Ships.Statuses.StatusValueRegulatorRules';

interface ResourceDraw {
    /** The class whose components use a storage this way, matched through the ancestry so a mod's subclass counts. */
    readonly cls: string;
    /** The list member holding one entry per storage, absent for a class with only the flat form. */
    readonly list?: string;
    /** The member naming the storage, in a list entry and in the flat shorthand alike. */
    readonly storage: string;
    /**
     * Which way the resources move. The schema types both ends of such a slot the same, so this is
     * the one thing about a use of a storage that cannot be read off it.
     */
    readonly direction: 'from' | 'into';
    /** The member holding how much moves, absent where the class states no amount. */
    readonly quantity?: string;
    /** What the engine reads when the amount is left unwritten, absent where it has no default. */
    readonly defaultQuantity?: number;
    /** What the arrow says about how often, empty where nothing decides it. */
    readonly cadence: () => string;
    /** What the box says the component does. */
    readonly sentence: () => string;
}

export const DRAWS: readonly ResourceDraw[] = [
    {
        cls: 'Cosmoteer.Ships.Parts.Weapons.EmitterRules',
        list: 'ResourceUsage',
        storage: 'ResourceStorage',
        direction: 'from',
        quantity: 'ResourcesUsed',
        defaultQuantity: 1,
        cadence: () => l10n.t('a shot'),
        sentence: () => l10n.t('spends this on every shot it fires'),
    },
    {
        cls: 'Cosmoteer.Ships.Parts.Thrusters.ThrusterRules',
        list: 'FuelUsage',
        storage: 'FuelStorage',
        direction: 'from',
        quantity: 'FuelUsagePerSecond',
        cadence: () => l10n.t('a second at full throttle'),
        sentence: () => l10n.t('burns this while it thrusts'),
    },
    {
        cls: 'Cosmoteer.Ships.Parts.Ftl.FtlDriveRules',
        storage: 'PowerStorage',
        direction: 'from',
        cadence: () => l10n.t('while charging'),
        sentence: () => l10n.t('charges from one storage and burns fuel from another to jump'),
    },
    {
        cls: 'Cosmoteer.Ships.Parts.Ftl.FtlDriveRules',
        storage: 'FuelStorage',
        direction: 'from',
        cadence: () => l10n.t('a jump'),
        sentence: () => l10n.t('charges from one storage and burns fuel from another to jump'),
    },
    {
        cls: 'Cosmoteer.Ships.Parts.Defenses.ArcShieldRules',
        storage: 'DrainResourcesFrom',
        direction: 'from',
        quantity: 'ResourceDrainPerDamage',
        cadence: () => l10n.t('per point of damage absorbed'),
        sentence: () => l10n.t('spends this to absorb what hits the shield'),
    },
    {
        cls: STATUS_REGULATOR,
        storage: 'ValueSourceStorage',
        direction: 'from',
        cadence: () => l10n.t('per trigger'),
        sentence: () => l10n.t('trades this against a status over the area it covers'),
    },
    {
        cls: STATUS_REGULATOR,
        storage: 'ValueTargetStorage',
        direction: 'into',
        cadence: () => l10n.t('per trigger'),
        sentence: () => l10n.t('trades this against a status over the area it covers'),
    },
];

/**
 * The storage members the roles below follow, as `Class.Member`, beside the ones {@link DRAWS}
 * covers. The schema types every member that names a storage, so the two lists together are held
 * against it: a member the game reads as a storage and neither list accounts for is one whose arrow
 * this drawing would leave off in silence, which is how the weapons went missing from it. A member
 * left out on purpose is written into {@link STORAGE_MEMBERS_NOT_DRAWN} with the reason.
 */
export const STORAGE_MEMBERS_BY_ROLE: readonly string[] = [
    `${RESOURCES}ResourceConsumerRules.Storage`,
    `${RESOURCES}InlineResourceConverterRules.FromStorage`,
    `${RESOURCES}MultiResourceStorageRules.ResourceStorages`,
    `${RESOURCES}ResourceChangeRules.ResourceStorage`,
    `${RESOURCES}ResourceConverterRules.FromStorage`,
    `${RESOURCES}ResourceConverterRules.ToStorage`,
    `${RESOURCES}ResourceConverterRules.Storage`,
    `${RESOURCES}TriggeredResourceConverterRules.FromStorage`,
    `${RESOURCES}TriggeredResourceConverterRules.ToStorage`,
    `${NETWORKS}PartNetworkResourceStoreRules.ResourceStorage`,
];

/** The storage members no arrow is drawn for, each with what it does instead. */
export const STORAGE_MEMBERS_NOT_DRAWN: ReadonlyMap<string, string> = new Map([
    [
        `${RESOURCES}BaseResourceStorageRules.AnticipateMoreResourcesFrom`,
        'tells the crew more is on its way, so nothing moves along it',
    ],
    [
        'Cosmoteer.Ships.Parts.Graphics.PartResourceSpritesRules.ResourceStorage',
        'draws what a storage holds, so nothing moves along it',
    ],
]);

/** What a component does with resources, which decides its sentence and the arrows drawn for it. */
type Role =
    | 'storage'
    | 'converter'
    | 'triggered-converter'
    | 'inline-converter'
    | 'consumer'
    | 'change'
    | 'drain-sink'
    | 'flex-grid'
    | 'storage-proxy'
    | 'draws'
    | 'network-in'
    | 'network-out'
    | 'network-store'
    | 'multi-storage'
    | 'other';

/** The two ends of the wiring outside the part, drawn so a resource entering or leaving has a source. */
const CREW_ID = 'outside:crew';
const NETWORK_ID = 'outside:network';

/** The prefix of a box standing for a storage pooled from another part through a buff. */
const BUFFED_PREFIX = 'outside:buffed:';

/** The prefix of a box standing for a storage a proxy reaches on another part. */
const PROXIED_PREFIX = 'outside:proxied:';

/**
 * The members naming the pooled component, in the list form and the single form. The group holding
 * them reaches storages the part does not own: a buff links two parts, and these ids name components
 * on the part at the other end of it, the ones buffing this part where `IncomingBuffTypes` is
 * written and the ones this part buffs where `OutgoingBuffProviders` is. Reading them as siblings
 * would name a component this part need not have, which is why they are drawn as what they are.
 */
const VIA_BUFFS_COMPONENTS = ['ComponentIDs', 'ComponentID'];

/** The member that makes the buff an incoming one, so the storages sit on the parts buffing this. */
const INCOMING_BUFFS_MEMBER = 'IncomingBuffTypes';

/** One component as the drawing needs it. */
interface FlowNode {
    readonly component: PartComponent;
    readonly id: string;
    readonly role: Role;
    /** The resource id the component holds, undefined when it holds none or names one unreadably. */
    readonly resource?: string;
}

/** One input or output entry of a converter, written as a list entry or through the shorthand. */
interface ConversionEntry {
    /** The value naming the storage the resources come from or go to. */
    readonly storage: AbstractNode;
    /** The value holding how many move, undefined where the entry leaves the default of one. */
    readonly quantity?: AbstractNode;
}

/**
 * Whether a component takes part in the resource wiring.
 *
 * @param cls the component's resolved class.
 * @returns true when the class is one of the resource or network-resource kinds.
 */
const isFlowComponent = (cls: string | undefined): boolean => {
    if (!cls) return false;
    if (FLOW_NAMESPACES.some((namespace) => cls.startsWith(namespace))) return true;
    return drawsOf(cls).length > 0;
};

/**
 * The ways a component spends a resource it does not own, read from its class.
 *
 * @param cls the component's resolved class.
 * @returns the draws that apply, empty for a component that spends nothing.
 */
const drawsOf = (cls: string | undefined): ResourceDraw[] => {
    if (!cls) return [];
    const ancestry = classAncestry(cls);
    return DRAWS.filter((draw) => ancestry.includes(draw.cls));
};

/**
 * What a component does with resources, read from its class rather than from the fields it happens
 * to write, so a mod's own subclass of a vanilla component is drawn like the one it derives from.
 *
 * @param cls the component's resolved class.
 * @returns the role, `other` for a resource component none of the sentences is written for.
 */
const roleOf = (cls: string | undefined): Role => {
    const ancestry = classAncestry(cls ?? '');
    const is = (name: string) => ancestry.includes(name);
    if (drawsOf(cls).length > 0) return 'draws';
    // Ahead of the storage case it derives from: a proxy holds nothing of its own, so saying how
    // much it holds would describe a store that is not there.
    if (is(CLASSES.storageProxy)) return 'storage-proxy';
    if (is(CLASSES.flexGrid)) return 'flex-grid';
    if (is(CLASSES.consumer)) return 'consumer';
    if (is(CLASSES.change)) return 'change';
    if (is(CLASSES.drainSink)) return 'drain-sink';
    if (is(CLASSES.triggeredConverter)) return 'triggered-converter';
    if (is(CLASSES.inlineConverter)) return 'inline-converter';
    if (is(CLASSES.converter)) return 'converter';
    if (is(CLASSES.networkStore)) return 'network-store';
    if (is(CLASSES.networkIn)) return 'network-in';
    if (is(CLASSES.networkOut)) return 'network-out';
    if (is(CLASSES.multiStorage)) return 'multi-storage';
    if (is(CLASSES.storage)) return 'storage';
    return 'other';
};

/**
 * The written text of a component's member, for the fields naming a resource or a sibling.
 *
 * @param group the component group.
 * @param field the member name.
 * @returns the text, or undefined when the member is absent or is not a plain value.
 */
const memberText = (group: GroupNode, field: string): string | undefined => {
    for (const element of group.elements) {
        if (!isAssignmentNode(element) || element.left.name.toLowerCase() !== field.toLowerCase()) continue;
        const value = element.right;
        return value && isValueNode(value) ? String(value.valueType.value) : undefined;
    }
    return undefined;
};

/**
 * The written text of a member, read through the component's inheritance where it declares a base. A
 * component narrowing another (`HeatStore : BaseStore { MaxResources = 20 }`) keeps every member it
 * does not overwrite, so the resource such a storage holds is usually written one file away.
 *
 * @param group the component group.
 * @param field the member name.
 * @param token cancels the inheritance walk.
 * @returns the text, or undefined when the member is absent or is not a plain value.
 */
const inheritedText = async (
    group: GroupNode,
    field: string,
    token: CancellationToken
): Promise<string | undefined> => {
    const node = await memberOrInherited(group, field, token);
    return node && isValueNode(node) ? String(node.valueType.value) : undefined;
};

/**
 * Whether a boolean member reads as on, through the component's inheritance like every other read.
 *
 * @param group the component group.
 * @param field the member name.
 * @param token cancels the inheritance walk.
 * @returns true when the member is written anywhere in the chain and reads as true.
 */
const inheritedIsOn = async (group: GroupNode, field: string, token: CancellationToken): Promise<boolean> =>
    (await inheritedText(group, field, token))?.toLowerCase() === 'true';

/**
 * The value nodes a member holds, whether it is written as one value or a list of them. The nodes
 * rather than their text, since a value naming a component can be a reference that has to be
 * followed.
 *
 * @param group the component group.
 * @param field the member name.
 * @returns the value nodes, empty when the member is absent.
 */
const memberValues = (group: GroupNode, field: string): AbstractNode[] => {
    for (const element of group.elements) {
        if (!isAssignmentNode(element) || element.left.name.toLowerCase() !== field.toLowerCase()) continue;
        const value = element.right;
        if (!value) return [];
        if (isValueNode(value)) return [value];
        if (isListNode(value)) return value.elements.filter(isValueNode);
        return [];
    }
    // A list is written without an `=`, so it is a named child rather than an assignment.
    for (const element of group.elements) {
        if (!isListNode(element) || element.identifier?.name.toLowerCase() !== field.toLowerCase()) continue;
        return element.elements.filter(isValueNode);
    }
    return [];
};

/**
 * The value node a member holds, for the members that hold one number.
 *
 * @param group the component group.
 * @param field the member name.
 * @returns the value node, or undefined when the member is absent.
 */
const memberValue = (group: GroupNode, field: string): AbstractNode | undefined => memberValues(group, field)[0];

/**
 * The node a numeric member holds, whatever shape it is written in. Unlike the members naming a
 * component, a number is usually arithmetic (`ceil((&~/Part/MaxHealth)/4)`) rather than a literal,
 * and reading only the plain values would leave every computed amount off the drawing.
 *
 * @param group the component group.
 * @param field the member name.
 * @returns the node to evaluate, or undefined when the member is absent.
 */
const numberMember = (group: GroupNode, field: string): AbstractNode | undefined => {
    for (const element of group.elements) {
        if (!isAssignmentNode(element) || element.left.name.toLowerCase() !== field.toLowerCase()) continue;
        return element.right ?? undefined;
    }
    return undefined;
};

/**
 * The inputs or the outputs of a converter, in the two forms the game accepts for them: the entries
 * of the `From`/`To` list, and the single-entry shorthand written as `FromStorage` beside
 * `FromQuantity`.
 *
 * @param group the component group.
 * @param side which end of the conversion is wanted.
 * @returns one entry per storage the conversion touches on that side.
 */
const conversionEntries = (group: GroupNode, side: 'From' | 'To'): ConversionEntry[] => {
    const entries: ConversionEntry[] = [];
    for (const element of group.elements) {
        const list =
            isListNode(element) && element.identifier?.name.toLowerCase() === side.toLowerCase() ? element : null;
        if (!list) continue;
        for (const entry of list.elements) {
            if (!isGroupNode(entry)) continue;
            const storage = memberValue(entry, 'Storage');
            if (storage) entries.push({ storage, quantity: numberMember(entry, 'Quantity') });
        }
    }
    const shorthand = memberValue(group, `${side}Storage`);
    if (shorthand) entries.push({ storage: shorthand, quantity: numberMember(group, `${side}Quantity`) });
    return entries;
};

/**
 * The storages one draw takes from, in the two forms the engine accepts for all of them: the entries
 * of the class's list member, and the single-entry shorthand written flat in the component itself.
 *
 * @param group the component group.
 * @param draw where the class states its draw.
 * @returns one entry per storage the component takes from.
 */
const drawEntries = async (
    group: GroupNode,
    draw: ResourceDraw,
    token: CancellationToken
): Promise<ConversionEntry[]> => {
    const entries: ConversionEntry[] = [];
    // A weapon written once and narrowed twice (`EmitterLeft : EmitterBase { Location = … }`) states
    // its draw only in the base, so the members are read through the inheritance the same way the
    // game reads them.
    const list = draw.list ? await memberOrInherited(group, draw.list, token) : undefined;
    if (list && isListNode(list)) {
        for (const entry of list.elements) {
            if (!isGroupNode(entry)) continue;
            const storage = memberValue(entry, draw.storage);
            if (!storage) continue;
            entries.push({ storage, quantity: draw.quantity ? numberMember(entry, draw.quantity) : undefined });
        }
    }
    const shorthand = await memberOrInherited(group, draw.storage, token);
    if (shorthand && isValueNode(shorthand)) {
        const quantity = draw.quantity ? await memberOrInherited(group, draw.quantity, token) : undefined;
        entries.push({ storage: shorthand, quantity });
    }
    return entries;
};

/**
 * A number as a reader would write it, with the trailing zeros of the arithmetic dropped.
 *
 * @param value the number.
 * @returns the text.
 */
const numberText = (value: number): string => String(Math.round(value * 1000) / 1000);

/**
 * The name a part is known by: the id it registers under, falling back to the name of the group
 * itself. Almost every part file calls its group `Part`, which names nothing on its own.
 *
 * @param part the part group.
 * @returns the display name.
 */
const partNameOf = (part: GroupNode): string => memberText(part, 'ID') ?? part.identifier?.name ?? l10n.t('this part');

/**
 * Builds the drawn resource wiring of the part at an offset.
 *
 * @param document the parsed document.
 * @param offset the caret's byte offset.
 * @param token cancels the component walk.
 * @returns the diagram, or undefined when the caret is not in a part with resource components.
 */
export const buildResourceFlowDiagram = async (
    document: AbstractNodeDocument,
    offset: number,
    token: CancellationToken
): Promise<Diagram | undefined> => {
    const part = partAt(document, offset);
    if (!part) return undefined;
    const components = await componentsOfPart(part, token);
    const flow = components.filter((component) => isFlowComponent(component.cls));
    if (flow.length === 0) return undefined;

    const byName = new Map<string, FlowNode>();
    const nodes: DiagramNode[] = [];
    const edges: DiagramEdge[] = [];
    const uri = getStartOfAstNode(part).uri;
    let unresolved = 0;
    // How many quantities were drawn without their number because they do not work out to one.
    let unreadableNumbers = 0;
    // What the part cannot make for itself, and what it offers the rest of the ship.
    const takesIn = new Set<string>();
    const givesOut = new Set<string>();
    // A hold names no resource of its own, so it cannot be said in either set, and a part that is
    // only a hold would otherwise be summed up as moving nothing.
    let carriesGoods = false;
    // How many component names are declared twice, in the alternative sets a toggle switches between.
    let switched = 0;

    /**
     * The number a member works out to.
     *
     * @param node the value node, or undefined when the member is absent.
     * @returns the number, or null when it is absent or does not work out to one.
     */
    const numberOf = async (node: AbstractNode | undefined): Promise<number | null> =>
        node ? await evaluateNumericValue(node, token).catch(() => null) : null;

    /**
     * Adds the box standing for the world outside the part, once, the first time an arrow needs it.
     *
     * @param id which outside end is wanted.
     * @returns the box id, so the caller can wire to it.
     */
    const outside = (id: typeof CREW_ID | typeof NETWORK_ID): string => {
        if (!nodes.some((node) => node.id === id)) {
            nodes.push({
                id,
                label: id === CREW_ID ? l10n.t('the ship') : l10n.t('the parts next door'),
                detail:
                    id === CREW_ID
                        ? l10n.t('crew carry resources here from elsewhere on the ship')
                        : l10n.t('the resource network this part is wired into'),
                kind: 'outside',
            });
        }
        return id;
    };

    /**
     * The box for a storage this part pools from another one through a buff.
     *
     * @param reference the component the buff rules name.
     * @param incoming true when the buff comes in, so the storage sits on the part providing it.
     * @returns the box id.
     */
    const buffed = (reference: ComponentReference, incoming: boolean): string =>
        elsewhere(
            reference,
            BUFFED_PREFIX,
            incoming
                ? l10n.t('on each part sending this one the buff it pools through')
                : l10n.t('on each part this one buffs')
        );

    /**
     * The box for a storage that lives on another part.
     *
     * @param reference the component the rules name.
     * @param prefix which kind of link reached it, so two links to one name stay two boxes.
     * @param detail where the storage sits, which is the whole point of drawing it apart.
     * @returns the box id.
     */
    const elsewhere = (reference: ComponentReference, prefix: string, detail: string): string => {
        const name = reference.name ?? reference.written;
        const id = `${prefix}${name.toLowerCase()}`;
        if (!nodes.some((node) => node.id === id)) nodes.push({ id, label: name, detail, kind: 'outside' });
        return id;
    };

    for (const component of flow) {
        const key = component.name.toLowerCase();
        // A part that switches between two sets of components declares the same id in each of them,
        // and only one of the two is ever registered at a time. The first is kept, which is the one
        // written before the overclocked or otherwise switched-in alternative.
        if (byName.has(key)) {
            switched++;
            continue;
        }
        // Both a storage and a consumer name their resource in `ResourceType`, and a component that
        // only moves resources between two storages names none at all.
        const resource = await inheritedText(component.group, 'ResourceType', token);
        const role = roleOf(component.cls);
        byName.set(key, { component, id: `c:${key}`, role, resource });
    }

    /**
     * What a component does, in one sentence with its own numbers in it. This is the line that makes
     * the picture readable without the schema open beside it, so it says the behavior rather than
     * the class name: a storage says what it holds and how much of it, a converter says how often it
     * runs, and a component fed by the crew says so.
     *
     * @param entry the component.
     * @returns the sentence.
     */
    async function sentenceFor(entry: FlowNode): Promise<string> {
        const group = entry.component.group;
        const resource = entry.resource ?? l10n.t('resources');
        switch (entry.role) {
            case 'storage': {
                const max = await numberOf(numberMember(group, 'MaxResources'));
                const held =
                    max === null
                        ? l10n.t('holds {0}', resource)
                        : l10n.t('holds up to {0} {1}', numberText(max), resource);
                return (await inheritedIsOn(group, 'SuppliesResources', token))
                    ? l10n.t('{0}, and the crew may carry it away', held)
                    : held;
            }
            case 'multi-storage':
                return l10n.t('several storages pooled into one');
            case 'converter': {
                const interval = await numberOf(numberMember(group, 'Interval'));
                return interval === null
                    ? l10n.t('converts one resource into another on a timer')
                    : l10n.t('converts every {0} s', numberText(interval));
            }
            case 'triggered-converter': {
                const trigger = await triggerNameOf(group);
                return trigger
                    ? l10n.t('converts once each time {0} fires', trigger)
                    : l10n.t('converts once each time it is triggered');
            }
            case 'inline-converter':
                return l10n.t('converts on demand out of another storage, holding nothing itself');
            case 'consumer':
                return l10n.t('crew deliver {0} here', resource);
            case 'storage-proxy': {
                // It holds nothing of its own: every read and write goes to the storage it names,
                // scaled where the rules say so, which is worth saying since the number a reader
                // sees on the proxy is not the number in the store behind it.
                const scale = await numberOf(numberMember(group, 'QuantityScale'));
                return scale === null || scale === 1
                    ? l10n.t('stands in for another storage, holding nothing itself')
                    : l10n.t(
                          'stands in for another storage, counting {0} for each of its resources',
                          numberText(scale)
                      );
            }
            case 'flex-grid':
                // A cargo hold names no resource: it takes whatever stacks, and the crew both fill
                // it and empty it, which is why it is drawn wired to the ship in both directions.
                return l10n.t('a hold the crew stack any tradeable goods in');
            case 'draws': {
                const draws = drawsOf(entry.component.cls);
                return draws[0]?.sentence() ?? l10n.t('spends resources it does not hold');
            }
            case 'change': {
                const amount = await numberOf(numberMember(group, 'Amount'));
                const target = await storageResourceOf(group, 'ResourceStorage');
                const trigger = await triggerNameOf(group);
                const when = trigger ? l10n.t('each time {0} fires', trigger) : l10n.t('each time it is triggered');
                if (amount === null) return l10n.t('changes {0} {1}', target ?? l10n.t('a storage'), when);
                const moved = movementLabel(Math.abs(amount), target, '');
                return amount < 0 ? l10n.t('takes {0} out {1}', moved, when) : l10n.t('puts {0} in {1}', moved, when);
            }
            case 'drain-sink': {
                const absorbs = await numberOf(numberMember(group, 'AbsorbsResourceDrain'));
                const recovery = await numberOf(numberMember(group, 'RecoveryRate'));
                const soaks =
                    absorbs === null
                        ? l10n.t('soaks up {0} drain aimed at this part', resource)
                        : l10n.t('soaks up {0} points of {1} drain aimed at this part', numberText(absorbs), resource);
                return recovery === null
                    ? soaks
                    : l10n.t('{0}, and gets {1} of that back a second', soaks, numberText(recovery));
            }
            case 'network-in':
                return l10n.t('takes {0} in and hands it to the parts next door', resource);
            case 'network-out':
                return l10n.t('fills itself with {0} from the parts next door', resource);
            case 'network-store':
                return l10n.t('opens a storage to the parts next door');
            default:
                return memberText(group, 'Type') ?? l10n.t('moves resources');
        }
    }

    /**
     * The component whose firing drives a triggered component, named so the box can say what sets it
     * off rather than only that something does. A trigger is written as the component's id, or as a
     * group naming it in `ID` where one component offers several triggers.
     *
     * @param group the component group.
     * @returns the component's name, or undefined where the trigger names none this walk can follow.
     */
    const triggerNameOf = async (group: GroupNode): Promise<string | undefined> => {
        const written = memberValue(group, 'Trigger');
        if (written) return (await componentReferenceOf(written, token)).name;
        for (const element of group.elements) {
            if (!isGroupNode(element) || element.identifier?.name.toLowerCase() !== 'trigger') continue;
            const id = memberValue(element, 'ID');
            if (id) return (await componentReferenceOf(id, token)).name;
        }
        return undefined;
    };

    /**
     * The resource held by the storage a member names, for the components that carry no resource type
     * of their own and are only readable through the storage they act on.
     *
     * @param group the component group.
     * @param field the member naming the storage.
     * @returns the resource id, or undefined when the storage is unknown or names none.
     */
    const storageResourceOf = async (group: GroupNode, field: string): Promise<string | undefined> => {
        const written = memberValue(group, field);
        if (!written) return undefined;
        const name = (await componentReferenceOf(written, token)).name;
        return name ? byName.get(name.toLowerCase())?.resource : undefined;
    };

    /**
     * The box one end of an arrow lands on. A name matching no component of the part gets a box
     * saying so, and a reference that could not be followed gets one saying that instead, since the
     * two are different problems and only the first is the author's mistake.
     *
     * @param reference what the field names.
     * @returns the box, either a component of this part or the stand-in drawn for it.
     */
    const endpointFor = (reference: ComponentReference): FlowNode | string => {
        const found = reference.name ? byName.get(reference.name.toLowerCase()) : undefined;
        if (found) return found;
        const id = `x:${(reference.name ?? reference.written).toLowerCase()}`;
        if (!nodes.some((node) => node.id === id)) {
            unresolved++;
            nodes.push({
                id,
                label: reference.name ?? reference.written,
                detail: reference.name
                    ? l10n.t('no component of this part')
                    : l10n.t('this reference could not be followed'),
                kind: 'missing',
            });
        }
        return id;
    };

    const resourceOf = (side: FlowNode | string): string | undefined =>
        typeof side === 'string' ? undefined : side.resource;

    /**
     * Adds one arrow between two ends of the wiring.
     *
     * @param from the component the resources leave.
     * @param to the component they arrive in.
     * @param label what moves along the arrow, and how often.
     * @param series the resource the arrow is coloured by, which is the one either end holds unless
     * the caller knows better, such as the goods a flex grid stacks that no storage names.
     */
    const wire = (
        from: FlowNode | string,
        to: FlowNode | string,
        label: string,
        series = resourceOf(from) ?? resourceOf(to)
    ): void => {
        const idOf = (side: FlowNode | string): string => (typeof side === 'string' ? side : side.id);
        // A mismatch is only claimed where both sides resolved and both name a resource, since every
        // proxy component in this schema is a link the walk cannot follow.
        const mismatch =
            typeof from !== 'string' &&
            typeof to !== 'string' &&
            !!from.resource &&
            !!to.resource &&
            from.resource !== to.resource;
        edges.push({ from: idOf(from), to: idOf(to), kind: mismatch ? 'warning' : 'flow', label, series });
    };

    /**
     * The words on an arrow: how much of what moves along it, and how often. The resource is the one
     * the storage end of the arrow holds, since that is where the type is written, and a quantity
     * that does not work out to one number is left off rather than guessed at.
     *
     * @param quantity the number of resources moved, null where it is unwritten or unreadable.
     * @param resource the resource moving, undefined where the storage names none.
     * @param cadence how often it moves, empty where nothing says.
     * @returns the label.
     */
    const movementLabel = (quantity: number | null, resource: string | undefined, cadence: string): string => {
        const what =
            quantity === null
                ? (resource ?? l10n.t('resources'))
                : l10n.t('{0} × {1}', numberText(quantity), resource ?? l10n.t('resources'));
        return cadence ? l10n.t('{0} {1}', what, cadence) : what;
    };

    /**
     * How often a converter runs, in the words that go on its arrows.
     *
     * @param entry the converter.
     * @returns the cadence, empty where the component does not say.
     */
    const cadenceOf = async (entry: FlowNode): Promise<string> => {
        if (entry.role === 'triggered-converter') return l10n.t('per trigger');
        if (entry.role !== 'converter') return '';
        const interval = await numberOf(numberMember(entry.component.group, 'Interval'));
        return interval === null ? '' : l10n.t('every {0} s', numberText(interval));
    };

    /**
     * The resource a side of an arrow holds, so the arrow can name what moves along it.
     *
     * @param side the box the arrow touches.
     * @returns the resource id, or undefined for a box that names none.
     */
    // The sentences are written once every component is known, since a component that names no
    // resource of its own, such as a resource change, is described with the one its storage holds.
    for (const entry of byName.values()) {
        nodes.push({
            id: entry.id,
            label: entry.component.name,
            detail: await sentenceFor(entry),
            kind:
                entry.role === 'storage' || entry.role === 'multi-storage' || entry.role === 'flex-grid'
                    ? 'resource'
                    : 'component',
            place: { uri, line: entry.component.group.position.line + 1 },
        });
    }

    for (const entry of byName.values()) {
        if (token.isCancellationRequested) return undefined;
        const group = entry.component.group;

        if (entry.role === 'converter' || entry.role === 'triggered-converter' || entry.role === 'inline-converter') {
            const cadence = await cadenceOf(entry);
            for (const input of conversionEntries(group, 'From')) {
                const other = endpointFor(await componentReferenceOf(input.storage, token));
                const quantity = input.quantity ? await numberOf(input.quantity) : 1;
                if (quantity === null) unreadableNumbers++;
                wire(other, entry, movementLabel(quantity, resourceOf(other), cadence));
            }
            for (const output of conversionEntries(group, 'To')) {
                const other = endpointFor(await componentReferenceOf(output.storage, token));
                const quantity = output.quantity ? await numberOf(output.quantity) : 1;
                if (quantity === null) unreadableNumbers++;
                wire(entry, other, movementLabel(quantity, resourceOf(other), cadence));
            }
        }

        if (entry.role === 'change') {
            for (const value of memberValues(group, 'ResourceStorage')) {
                const other = endpointFor(await componentReferenceOf(value, token));
                // A change adds what its `Amount` says and takes away what a negative one says, so
                // the arrow follows the number rather than the field. An amount that does not work
                // out to one number is drawn as an addition, which the note below says.
                const amount = await numberOf(numberMember(group, 'Amount'));
                if (amount === null) unreadableNumbers++;
                const label = movementLabel(
                    amount === null ? null : Math.abs(amount),
                    resourceOf(other),
                    l10n.t('per trigger')
                );
                if (amount !== null && amount < 0) wire(other, entry, label);
                else wire(entry, other, label);
            }
        }

        if (entry.role === 'consumer') {
            // A consumer is what puts the part on the crew's delivery list, so the resource comes
            // from the ship rather than from anywhere inside the part, and lands in the storage the
            // consumer names.
            wire(outside(CREW_ID), entry, entry.resource ?? l10n.t('resources'));
            if (entry.resource) takesIn.add(entry.resource);
            for (const value of memberValues(group, 'Storage')) {
                const other = endpointFor(await componentReferenceOf(value, token));
                wire(entry, other, entry.resource ?? resourceOf(other) ?? l10n.t('resources'));
            }
        }

        if (entry.role === 'draws') {
            // The storage a gun, a thruster, a drive or a shield spends out of lives on the same
            // part, so the arrow runs from that storage into the component that empties it, and the
            // other way round for the one member that fills a storage instead.
            for (const draw of drawsOf(entry.component.cls)) {
                for (const site of await drawEntries(group, draw, token)) {
                    const other = endpointFor(await componentReferenceOf(site.storage, token));
                    const quantity = site.quantity ? await numberOf(site.quantity) : (draw.defaultQuantity ?? null);
                    if (site.quantity && quantity === null) unreadableNumbers++;
                    const label = movementLabel(quantity, resourceOf(other), draw.cadence());
                    if (draw.direction === 'from') wire(other, entry, label);
                    else wire(entry, other, label);
                }
            }
        }

        if (entry.role === 'storage-proxy') {
            // Everything read from or written to the proxy lands in the storage it names, so the
            // arrow runs to that storage. Without it a proxy is a dead end, and the pool feeding it
            // looks like it spreads resources into nothing.
            for (const target of await proxyTargetsOf(group, token)) {
                const reference = await componentReferenceOf(target.component, token);
                const other = target.otherPart
                    ? elsewhere(reference, PROXIED_PREFIX, l10n.t('on whichever part the proxy finds beside this one'))
                    : endpointFor(reference);
                wire(entry, other, l10n.t('stands in for'));
            }
        }

        if (entry.role === 'flex-grid') {
            wire(outside(CREW_ID), entry, l10n.t('goods'), l10n.t('goods'));
            wire(entry, outside(CREW_ID), l10n.t('goods'), l10n.t('goods'));
            carriesGoods = true;
        }

        if (entry.role === 'storage' && (await inheritedIsOn(group, 'SuppliesResources', token))) {
            wire(entry, outside(CREW_ID), entry.resource ?? l10n.t('resources'));
            if (entry.resource) givesOut.add(entry.resource);
        }

        if (entry.role === 'multi-storage') {
            for (const value of memberValues(group, 'ResourceStorages')) {
                const other = endpointFor(await componentReferenceOf(value, token));
                wire(entry, other, l10n.t('spread across'));
            }
            for (const element of group.elements) {
                // Found by the class the schema types the group as, the same way the sibling check
                // finds it, rather than by the member name each of them would otherwise repeat.
                if (
                    !isGroupNode(element) ||
                    !classAncestry(resolveGroupClass(element) ?? '').includes(BUFF_PROXY_CLASS)
                ) {
                    continue;
                }
                const incoming = memberValues(element, INCOMING_BUFFS_MEMBER).length > 0;
                for (const field of VIA_BUFFS_COMPONENTS) {
                    for (const value of memberValues(element, field)) {
                        const reference = await componentReferenceOf(value, token);
                        wire(entry, buffed(reference, incoming), l10n.t('spread across'));
                    }
                }
            }
        }

        if (entry.role === 'network-in') {
            wire(entry, outside(NETWORK_ID), entry.resource ?? l10n.t('resources'));
            if (entry.resource) givesOut.add(entry.resource);
        }

        if (entry.role === 'network-out') {
            wire(outside(NETWORK_ID), entry, entry.resource ?? l10n.t('resources'));
            if (entry.resource) takesIn.add(entry.resource);
        }

        if (entry.role === 'network-store') {
            for (const value of memberValues(group, 'ResourceStorage')) {
                const other = endpointFor(await componentReferenceOf(value, token));
                const resource = entry.resource ?? resourceOf(other) ?? l10n.t('resources');
                wire(other, outside(NETWORK_ID), resource);
                wire(outside(NETWORK_ID), other, resource);
                if (entry.resource) {
                    givesOut.add(entry.resource);
                    takesIn.add(entry.resource);
                }
            }
        }
    }

    const notes = [
        l10n.t(
            'Read an arrow as what moves along it: the amount, the resource, and how often it moves. A box says what its component does with what reaches it.'
        ),
        l10n.t('Only the members that move resources are drawn. A toggle or a trigger naming a component is left out.'),
        l10n.t(
            'A storage pooled through a buff sits on the part at the other end of that buff, so it is drawn as a store outside this part rather than as one of its own components.'
        ),
    ];
    if (unresolved > 0) {
        notes.push(l10n.t('{0} of the names written here match no component of this part.', String(unresolved)));
    }
    if (switched > 0) {
        notes.push(
            l10n.t(
                '{0} of this part’s components share a name with another, in the sets a toggle switches between. Only the first of each is drawn, since only one of them is wired in at a time.',
                String(switched)
            )
        );
    }
    if (unreadableNumbers > 0) {
        notes.push(
            l10n.t(
                '{0} of the amounts here do not work out to one number, usually because a buff can move them, so those arrows say what moves without saying how much.',
                String(unreadableNumbers)
            )
        );
    }
    if (edges.some((edge) => edge.kind === 'warning')) {
        notes.push(
            l10n.t(
                'A red arrow runs between two components holding different resources, which is only marked where both of them resolved.'
            )
        );
    }

    // The heading answers "what is this part doing with resources" before the boxes are read at all.
    // A part that moves none is the common case for armor, which carries a drain sink and nothing
    // else, and saying that outright is better than a picture of one box and no arrows.
    const goodsClause = carriesGoods ? l10n.t('Crew stack tradeable goods here and carry them away again.') : '';
    const subtitle =
        takesIn.size > 0 || givesOut.size > 0 || carriesGoods
            ? [
                  takesIn.size > 0 ? l10n.t('Takes in: {0}.', [...takesIn].sort().join(', ')) : '',
                  givesOut.size > 0 ? l10n.t('Gives back: {0}.', [...givesOut].sort().join(', ')) : '',
                  goodsClause,
              ]
                  .filter(Boolean)
                  .join(' ')
            : edges.length === 0
              ? l10n.t('Nothing moves here. These components hold or absorb resources without passing them on.')
              : l10n.t('Everything it moves stays inside the part.');

    return {
        title: l10n.t('Resource flow of {0}', partNameOf(part)),
        subtitle,
        nodes,
        edges,
        legend: legendFor(
            [
                { kind: 'resource', label: l10n.t('holds a resource') },
                { kind: 'component', label: l10n.t('moves resources') },
                { kind: 'outside', label: l10n.t('outside this part') },
                { kind: 'missing', label: l10n.t('names no component') },
                { kind: 'flow', label: l10n.t('resources move this way') },
                { kind: 'warning', label: l10n.t('the two hold different resources') },
            ],
            edges
        ),
        notes,
    };
};
