import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { Diagram } from '../../../src/features/diagram/diagram.types';
import { buildEffectChainDiagram } from '../../../src/features/part-editor/effect-chain.diagram';
import { buildResourceFlowDiagram } from '../../../src/features/part-editor/resource-flow.diagram';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const token = CancellationToken.None;

const PART = [
    'HEAT_TARGET = Ammo',
    'Part',
    '{',
    '\tID = test.flow',
    '\tComponents',
    '\t{',
    '\t\tAmmo',
    '\t\t{',
    '\t\t\tType = ResourceStorage',
    '\t\t\tResourceType = bullets',
    '\t\t\tMaxResources = 40',
    '\t\t}',
    '\t\tPower',
    '\t\t{',
    '\t\t\tType = ResourceStorage',
    '\t\t\tResourceType = power',
    '\t\t\tMaxResources = 100',
    '\t\t\tSuppliesResources = true',
    '\t\t}',
    '\t\tMaker',
    '\t\t{',
    '\t\t\tType = ResourceConverter',
    '\t\t\tInterval = 3',
    '\t\t\tFromStorage = Power',
    '\t\t\tFromQuantity = 2',
    '\t\t\tToStorage = Ammo',
    '\t\t}',
    '\t\tDrain',
    '\t\t{',
    '\t\t\tType = ResourceConsumer',
    '\t\t\tResourceType = power',
    '\t\t\tStorage = Ammo',
    '\t\t}',
    '\t\tGone',
    '\t\t{',
    '\t\t\tType = ResourceConsumer',
    '\t\t\tResourceType = power',
    '\t\t\tStorage = NoSuchStore',
    '\t\t}',
    '\t\tViaConstant',
    '\t\t{',
    '\t\t\tType = ResourceConsumer',
    '\t\t\tResourceType = bullets',
    '\t\t\tStorage = &~/HEAT_TARGET',
    '\t\t}',
    '\t\tViaBrokenConstant',
    '\t\t{',
    '\t\t\tType = ResourceConsumer',
    '\t\t\tResourceType = bullets',
    '\t\t\tStorage = &~/NO_SUCH_CONSTANT',
    '\t\t}',
    '\t\tFiller',
    '\t\t{',
    '\t\t\tType = ResourceChange',
    '\t\t\tResourceStorage = Ammo',
    '\t\t\tAmount = 5',
    '\t\t}',
    '\t\tLeak',
    '\t\t{',
    '\t\t\tType = ResourceChange',
    '\t\t\tResourceStorage = Power',
    '\t\t\tTrigger = Turret',
    '\t\t\tAmount = -2',
    '\t\t}',
    '\t\tTurret',
    '\t\t{',
    '\t\t\tType = Turret',
    '\t\t}',
    '\t\tShots',
    '\t\t{',
    '\t\t\tType = TriggeredEffects',
    '\t\t\tTrigger = Turret',
    '\t\t\tChainedTo = Turret',
    '\t\t\tMediaEffects',
    '\t\t\t{',
    '\t\t\t\tType = Multi',
    '\t\t\t}',
    '\t\t}',
    '\t\tGun',
    '\t\t{',
    '\t\t\tType = BulletEmitter',
    '\t\t\tFireTrigger = Turret',
    '\t\t\tResourceStorage = Ammo',
    '\t\t\tResourcesUsed = 2',
    '\t\t}',
    '\t\tSecondGun : Gun',
    '\t\t{',
    '\t\t\tResourcesUsed = 3',
    '\t\t}',
    '\t\tShotProxy',
    '\t\t{',
    '\t\t\tType = TriggerProxy',
    '\t\t\tComponentID = Turret',
    '\t\t}',
    '\t\tRelay',
    '\t\t{',
    '\t\t\tType = TriggerProxy',
    '\t\t\tComponentID = ShotProxy',
    '\t\t}',
    '\t\tNeighbourProxy',
    '\t\t{',
    '\t\t\tType = TriggerProxy',
    '\t\t\tPartLocation = [0, 1]',
    '\t\t\tComponentID = FarAwayThing',
    '\t\t}',
    '\t\tRelayEffects',
    '\t\t{',
    '\t\t\tType = TriggeredEffects',
    '\t\t\tTrigger = Relay',
    '\t\t\tMediaEffects',
    '\t\t\t{',
    '\t\t\t\tType = Multi',
    '\t\t\t}',
    '\t\t}',
    '\t\tNeighbourEffects',
    '\t\t{',
    '\t\t\tType = TriggeredEffects',
    '\t\t\tTrigger = NeighbourProxy',
    '\t\t\tMediaEffects',
    '\t\t\t{',
    '\t\t\t\tType = Multi',
    '\t\t\t}',
    '\t\t}',
    '\t\tSwitched',
    '\t\t{',
    '\t\t\tType = ToggledComponents',
    '\t\t\tToggle = Turret',
    '\t\t\tComponents',
    '\t\t\t{',
    '\t\t\t\tBackup',
    '\t\t\t\t{',
    '\t\t\t\t\tType = TriggeredEffects',
    '\t\t\t\t\tTrigger',
    '\t\t\t\t\t{',
    '\t\t\t\t\t\tID = Gun',
    '\t\t\t\t\t\tTriggerID = HitIntervalElapsed',
    '\t\t\t\t\t}',
    '\t\t\t\t\tMediaEffects',
    '\t\t\t\t\t{',
    '\t\t\t\t\t\tType = Multi',
    '\t\t\t\t\t}',
    '\t\t\t\t}',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}',
    '',
].join('\n');

/** The diagram for the caret on a marker in the part source. */
const diagramAt = async (
    build: (document: ReturnType<typeof parse>, offset: number, token: CancellationToken) => Promise<Diagram | undefined>,
    marker: string
): Promise<Diagram> => {
    const offset = PART.indexOf(marker);
    if (offset < 0) throw new Error(`marker ${marker} not in the part`);
    const diagram = await build(parse(), offset, token);
    expect(diagram, `no diagram at ${marker}`).toBeDefined();
    return diagram!;
};

const parse = () => parser(lexer(PART), 'file:///inline.rules').value;

/** The edge between two boxes, by their labels. */
const edgeBetween = (diagram: Diagram, from: string, to: string) => {
    const id = (label: string) => diagram.nodes.find((node) => node.label === label)?.id;
    return diagram.edges.find((edge) => edge.from === id(from) && edge.to === id(to));
};

describe('resource flow diagram', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('says on each arrow how much of what moves, and how often', async () => {
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        expect(edgeBetween(diagram, 'Power', 'Maker')?.label).toBe('2 × power every 3 s');
        // The output leaves its quantity to the default of one, which the arrow still says.
        expect(edgeBetween(diagram, 'Maker', 'Ammo')?.label).toBe('1 × bullets every 3 s');
    });

    it('colours each arrow by the resource moving along it', async () => {
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        expect(edgeBetween(diagram, 'Power', 'Maker')?.series).toBe('power');
        expect(edgeBetween(diagram, 'Maker', 'Ammo')?.series).toBe('bullets');
        // Every arrow has a resource, so the plain arrow colour keys nothing and leaves the legend.
        expect(diagram.legend.map((entry) => entry.kind)).not.toContain('flow');
    });

    it('says what each component does with what reaches it', async () => {
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        const detail = (label: string) => diagram.nodes.find((node) => node.label === label)?.detail;
        expect(detail('Ammo')).toBe('holds up to 40 bullets');
        expect(detail('Power')).toBe('holds up to 100 power, and the crew may carry it away');
        expect(detail('Maker')).toBe('converts every 3 s');
        expect(detail('Drain')).toBe('crew deliver power here');
        expect(detail('Filler')).toBe('puts 5 × bullets in each time it is triggered');
        // `Leak` says what fires it, since a reader looking at a drain wants to know what drains it.
        expect(detail('Leak')).toBe('takes 2 × power out each time Turret fires');
    });

    it('draws the ship outside the part as where a delivered resource comes from', async () => {
        // A consumer is what puts the part on the crew's delivery list, so the resource arrives from
        // the ship rather than from anywhere in the part, and a reader who does not know that yet
        // can see it in the picture.
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        expect(edgeBetween(diagram, 'the ship', 'Drain')?.label).toBe('power');
        expect(edgeBetween(diagram, 'Power', 'the ship')?.label).toBe('power');
        expect(diagram.nodes.find((node) => node.label === 'the ship')?.kind).toBe('outside');
    });

    it('says what the part takes in and gives back', async () => {
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        expect(diagram.subtitle).toBe('Takes in: bullets, power. Gives back: power.');
    });

    it('marks a link between two components holding different resources', async () => {
        // `Drain` consumes power and delivers it into the bullet store, which is the mistake the
        // drawing exists to make visible.
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        expect(edgeBetween(diagram, 'Drain', 'Ammo')?.kind).toBe('warning');
    });

    it('draws a name matching no component rather than dropping the arrow', async () => {
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        const missing = diagram.nodes.find((node) => node.label === 'NoSuchStore');
        expect(missing?.kind).toBe('missing');
        expect(edgeBetween(diagram, 'Gone', 'NoSuchStore')).toBeDefined();
    });

    it('follows a storage named through a constant instead of by name', async () => {
        // `Storage = &~/HEAT_TARGET` is how a mod names one storage from several parts. The game
        // reads the constant and looks the resulting name up, so drawing the reference text as a
        // missing component would be a false statement about a component that is right there.
        const diagram = await diagramAt(buildResourceFlowDiagram, 'ViaConstant');
        expect(edgeBetween(diagram, 'ViaConstant', 'Ammo')).toBeDefined();
        expect(diagram.nodes.map((node) => node.label)).not.toContain('&~/HEAT_TARGET');
    });

    it('says a reference could not be followed rather than calling it a missing component', async () => {
        const diagram = await diagramAt(buildResourceFlowDiagram, 'ViaConstant');
        const box = diagram.nodes.find((node) => node.label === '&~/NO_SUCH_CONSTANT');
        expect(box?.kind).toBe('missing');
        expect(box?.detail).toBe('this reference could not be followed');
    });

    it('draws a resource change in the direction its amount says', async () => {
        // A positive amount adds to the storage, a negative one drains it, so the arrow follows the
        // number rather than the field the storage is named in.
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Filler');
        expect(edgeBetween(diagram, 'Filler', 'Ammo')?.label).toBe('5 × bullets per trigger');
        expect(edgeBetween(diagram, 'Power', 'Leak')?.label).toBe('2 × power per trigger');
    });

    it('tells the reader how to read an arrow', async () => {
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        expect(diagram.notes?.[0]).toContain('the amount, the resource, and how often it moves');
    });

    it('draws what a weapon spends on every shot', async () => {
        // The draw is a member of the emitter, which is not a resource component at all, so the
        // magazine used to fill and never empty on exactly the parts the picture is opened for.
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        expect(edgeBetween(diagram, 'Ammo', 'Gun')?.label).toBe('2 × bullets a shot');
    });

    it('reads a weapon that states its draw only in the base it narrows', async () => {
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        expect(edgeBetween(diagram, 'Ammo', 'SecondGun')?.label).toBe('3 × bullets a shot');
    });

    it('leaves out the components that carry no resources', async () => {
        const diagram = await diagramAt(buildResourceFlowDiagram, 'Maker');
        expect(diagram.nodes.map((node) => node.label)).not.toContain('Turret');
    });

    it('answers nothing for a file that holds no part', async () => {
        const document = parser(lexer('Group\n{\n\tA = 1\n}\n'), 'file:///inline.rules').value;
        expect(await buildResourceFlowDiagram(document, 0, token)).toBeUndefined();
    });
});

// Armor is the part that carries a drain sink and nothing else: a picture of one box and no arrows,
// where every number it could say is written as arithmetic off the part's own health.
const ARMOR = [
    'Part',
    '{',
    '\tID = test.armor',
    '\tMaxHealth = 4000',
    '\tComponents',
    '\t{',
    '\t\tEmpAbsorber',
    '\t\t{',
    '\t\t\tType = ExplosiveResourceDrainSink',
    '\t\t\tResourceType = battery',
    '\t\t\tAbsorbsResourceDrain = ceil((&~/Part/MaxHealth)/4)',
    '\t\t\tRecoveryRate = ceil(&AbsorbsResourceDrain) * 0.1',
    '\t\t}',
    '\t}',
    '}',
    '',
].join('\n');

describe('resource flow of a part that moves nothing', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    const armorDiagram = async () => {
        const document = parser(lexer(ARMOR), 'file:///armor.rules').value;
        const diagram = await buildResourceFlowDiagram(document, ARMOR.indexOf('EmpAbsorber'), token);
        expect(diagram).toBeDefined();
        return diagram!;
    };

    it('says what a drain sink soaks up, with the numbers it works out to', async () => {
        // Both numbers are arithmetic off the part's health, which is how every armor part writes
        // them, so reading only plain values would leave the box saying nothing but its class name.
        const diagram = await armorDiagram();
        expect(diagram.nodes[0].detail).toBe(
            'soaks up 1000 points of battery drain aimed at this part, and gets 100 of that back a second'
        );
    });

    it('says outright that nothing moves rather than drawing one box and no arrows', async () => {
        const diagram = await armorDiagram();
        expect(diagram.edges).toHaveLength(0);
        expect(diagram.subtitle).toBe(
            'Nothing moves here. These components hold or absorb resources without passing them on.'
        );
    });
});

// A component that takes its `Type` from a base rather than writing one, beside a hold that names no
// resource at all. Both used to fall out of the drawing: the first as a red box claiming the part
// had no such component, the second as a cargo bay reported to move nothing.
const INHERITED = [
    'Part',
    '{',
    '\tID = test.inherited',
    '\tComponents',
    '\t{',
    '\t\tBaseStore',
    '\t\t{',
    '\t\t\tType = ResourceStorage',
    '\t\t\tResourceType = heat',
    '\t\t\tMaxResources = 10',
    '\t\t}',
    '\t\tHeatStore : BaseStore',
    '\t\t{',
    '\t\t\tMaxResources = 20',
    '\t\t}',
    '\t\tDump',
    '\t\t{',
    '\t\t\tType = ResourceChange',
    '\t\t\tResourceStorage = HeatStore',
    '\t\t\tAmount = 5',
    '\t\t}',
    '\t\tHold',
    '\t\t{',
    '\t\t\tType = FlexResourceGrid',
    '\t\t}',
    '\t\tMirror',
    '\t\t{',
    '\t\t\tType = ResourceStorageProxy',
    '\t\t\tResourceType = heat',
    '\t\t\tComponentID = HeatStore',
    '\t\t\tQuantityScale = 2',
    '\t\t}',
    '\t\tFarMirror',
    '\t\t{',
    '\t\t\tType = ResourceStorageProxy',
    '\t\t\tResourceType = heat',
    '\t\t\tPartLocation = [0, 1]',
    '\t\t\tComponentID = NeighbourStore',
    '\t\t}',
    '\t\tPooled',
    '\t\t{',
    '\t\t\tType = MultiResourceStorage',
    '\t\t\tResourceType = heat',
    '\t\t\tResourceStorages = [HeatStore]',
    '\t\t\tViaBuffs',
    '\t\t\t{',
    '\t\t\t\tIncomingBuffTypes = [HeatCollection]',
    '\t\t\t\tComponentIDs = [CollectorStore]',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}',
    '',
].join('\n');

describe('resource flow of a part whose components inherit their type', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    const inheritedDiagram = async () => {
        const document = parser(lexer(INHERITED), 'file:///inherited.rules').value;
        const diagram = await buildResourceFlowDiagram(document, INHERITED.indexOf('Dump'), token);
        expect(diagram).toBeDefined();
        return diagram!;
    };

    it('reads a component that takes its type from a base rather than calling it missing', async () => {
        // `HeatStore : BaseStore { … }` writes no `Type` of its own, which is how a vanilla thruster
        // narrows the heat storage it inherits. Reading only the local declaration left the storage
        // out of the drawing and then reported the sibling naming it as a mistake the author made.
        const diagram = await inheritedDiagram();
        expect(diagram.nodes.filter((node) => node.kind === 'missing')).toHaveLength(0);
        expect(diagram.nodes.find((node) => node.label === 'HeatStore')?.detail).toBe('holds up to 20 heat');
        expect(edgeBetween(diagram, 'Dump', 'HeatStore')).toBeDefined();
    });

    it('follows a storage proxy to the store it stands in for', async () => {
        // A proxy holds nothing: every read and write lands in the storage it names. Left undrawn it
        // was a dead end, and the pool feeding it looked like it spread resources into nothing.
        const diagram = await inheritedDiagram();
        expect(edgeBetween(diagram, 'Mirror', 'HeatStore')?.label).toBe('stands in for');
        expect(diagram.nodes.find((node) => node.label === 'Mirror')?.detail).toBe(
            'stands in for another storage, counting 2 for each of its resources'
        );
    });

    it('says a storage proxy reaching across parts names a store somewhere else', async () => {
        const diagram = await inheritedDiagram();
        expect(diagram.nodes.find((node) => node.label === 'NeighbourStore')?.kind).toBe('outside');
        expect(diagram.nodes.filter((node) => node.kind === 'missing')).toHaveLength(0);
    });

    it('draws a storage pooled through a buff as one on another part', async () => {
        // `ViaBuffs` names components on the part at the other end of the buff, not on this one, so
        // looking the id up among this part's components would report a mistake that is not one.
        const diagram = await inheritedDiagram();
        const box = diagram.nodes.find((node) => node.label === 'CollectorStore');
        expect(box?.kind).toBe('outside');
        expect(box?.detail).toBe('on each part sending this one the buff it pools through');
        expect(edgeBetween(diagram, 'Pooled', 'CollectorStore')?.label).toBe('spread across');
        expect(diagram.nodes.filter((node) => node.kind === 'missing')).toHaveLength(0);
    });

    it('says a hold is a hold rather than that nothing moves', async () => {
        // A cargo bay names no resource, since it takes whatever stacks, so neither set of resource
        // names could say what it does and the part was summed up as moving nothing at all.
        const diagram = await inheritedDiagram();
        expect(diagram.subtitle).toContain('Crew stack tradeable goods here');
        expect(edgeBetween(diagram, 'the ship', 'Hold')).toBeDefined();
        expect(edgeBetween(diagram, 'Hold', 'the ship')).toBeDefined();
    });
});

describe('firing chain diagram', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('draws what fires a component, whatever the member it is written in is called', async () => {
        // The engine reads "what fires me" out of seventeen differently named members of one type,
        // so the members are taken from the schema rather than from the two names this file used to
        // know. `FireTrigger` is the one every weapon in the game is driven through.
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        expect(edgeBetween(diagram, 'Turret', 'Shots')?.label).toBe('Trigger');
        expect(edgeBetween(diagram, 'Turret', 'Gun')?.label).toBe('FireTrigger');
    });

    it('does not draw a chained component as one that fires', async () => {
        // `ChainedTo` places a component relative to another. Drawn as a firing edge it put a
        // turret's sprites and crew seat into the chain, and pointed the arrow the wrong way round
        // on the member that matters most: a weapon names the same turret in `ChainedTo` and in
        // `FireTrigger`, and only the second of the two is the chain.
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        expect(edgeBetween(diagram, 'Shots', 'Turret')).toBeUndefined();
        expect(diagram.notes?.join(' ')).toContain('ChainedTo');
    });

    it('colours a whole chain after the box it starts from', async () => {
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        expect(edgeBetween(diagram, 'Turret', 'Gun')?.series).toBe('Turret');
        expect(edgeBetween(diagram, 'Gun', 'Backup')?.series).toBe('Turret');
        expect(edgeBetween(diagram, 'Relay', 'RelayEffects')?.series).toBe('Turret');
        expect(diagram.legend.map((entry) => entry.kind)).not.toContain('flow');
    });

    it('names the output a trigger picks where a component offers several', async () => {
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        expect(edgeBetween(diagram, 'Gun', 'Backup')?.label).toBe('Trigger · HitIntervalElapsed');
    });

    it('joins the chain through a proxy, and through a proxy of a proxy', async () => {
        // A proxy fires when what it stands in for fires. Without that link the chain broke at every
        // one of them and the branch beyond read as something nothing sets off, which is most of a
        // weapon: the effects hang off the proxy rather than off the emitter itself.
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        expect(edgeBetween(diagram, 'Turret', 'ShotProxy')?.label).toBe('proxies');
        expect(edgeBetween(diagram, 'ShotProxy', 'Relay')?.label).toBe('proxies');
        expect(edgeBetween(diagram, 'Relay', 'RelayEffects')?.label).toBe('Trigger');
    });

    it('says a proxy reaching across parts names a component somewhere else', async () => {
        // `PartLocation` sends the proxy to whatever part sits there, so the id it then names is not
        // this part's to have and calling it a missing component would be a false accusation.
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        const box = diagram.nodes.find((node) => node.label === 'FarAwayThing');
        expect(box?.kind).toBe('outside');
        expect(diagram.nodes.filter((node) => node.kind === 'missing')).toHaveLength(0);
    });

    it('reaches the components a toggle switches between', async () => {
        // `ToggledComponents` hands its children to the part under the same flat ids the top-level
        // components use, so a reader that stopped at the wrapper saw none of the emitters a laser
        // blaster keeps in one.
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        expect(diagram.nodes.map((node) => node.label)).toContain('Backup');
    });

    it('says which box plays something', async () => {
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        expect(diagram.nodes.find((node) => node.label === 'Shots')?.detail).toContain('plays effects');
    });

    it('leaves out a component no chain reaches', async () => {
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        expect(diagram.nodes.map((node) => node.label)).not.toContain('Ammo');
    });

    it('says nothing is drawn to scale', async () => {
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        expect(diagram.notes?.join(' ')).toContain('nothing here is drawn to scale');
    });
});
