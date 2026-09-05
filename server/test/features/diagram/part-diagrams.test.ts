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

describe('firing chain diagram', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('draws what fires a component and what it fires next', async () => {
        const diagram = await diagramAt(buildEffectChainDiagram, 'Shots');
        expect(edgeBetween(diagram, 'Turret', 'Shots')?.label).toBe('Trigger');
        expect(edgeBetween(diagram, 'Shots', 'Turret')?.label).toBe('ChainedTo');
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
