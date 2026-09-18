import { beforeEach, describe, expect, it } from 'vitest';
import type {
    CellSetLayerData,
    GridPoint,
    PartGridData,
    PointLayerData,
} from '../../../src/features/part-editor/part-grid.types';
import {
    ADJACENCY_NAMES,
    GridHarness,
    LAYER_BASE,
    LOCAL_ORIGIN,
    StubElement,
    loadGridWebview,
    partGrid,
} from './part-grid-webview.harness';

/**
 * The parts of the page that are neither a canvas gesture nor a layer panel: the messages the host
 * sends back, and the sidebar controls that edit the part itself rather than one of its layers.
 *
 * These read like the interaction suite: build a payload, drive a control, assert the mutation the
 * page posted. Where a control posts nothing, the assertion is on what the user is told instead.
 */

let page: GridHarness;

beforeEach(() => {
    page = loadGridWebview();
});

/** A plain inside cell set, the simplest layer a click can edit. */
function insideLayer(): CellSetLayerData {
    return {
        ...LAYER_BASE,
        kind: 'cellSet',
        id: 'BlockedTravelCells',
        label: 'BlockedTravelCells',
        fieldName: 'BlockedTravelCells',
        domain: 'inside',
        cells: [{ cell: { x: 0, y: 0 }, origin: LOCAL_ORIGIN }],
    };
}

/** An empty layer of another group, to sit in a sidebar group nothing has authored yet. */
function emptyGraphicsLayer(): CellSetLayerData {
    return {
        ...LAYER_BASE,
        kind: 'cellSet',
        id: 'BlueprintCells',
        label: 'BlueprintCells',
        fieldName: 'BlueprintCells',
        group: 'Graphics',
        domain: 'inside',
        cells: [],
    };
}

/** A single authored point, the kind whose panel carries the snap-step row. */
function pointLayer(): PointLayerData {
    return {
        ...LAYER_BASE,
        kind: 'point',
        id: 'PickUpLocation',
        label: 'PickUpLocation',
        fieldName: 'PickUpLocation',
        point: { x: 2, y: 2 },
    };
}

/** Every checkbox inside a sidebar section, in the order the panel built them. */
function checkboxes(within: StubElement): StubElement[] {
    return page.descendants(within).filter((node) => node.tagName === 'INPUT' && node.type === 'checkbox');
}

/** Every text input inside a sidebar section, in the order the panel built them. */
function inputs(within: StubElement): StubElement[] {
    return page.descendants(within).filter((node) => node.tagName === 'INPUT' && node.type === 'text');
}

/** The sidebar group of a layer list, found by the name in its summary. */
function group(name: string): StubElement {
    const found = page
        .descendants(page.section('Layers'))
        .filter((node) => node.tagName === 'DETAILS' && node.textContent.startsWith(name));
    if (found.length !== 1) throw new Error(`expected one layer group named ${name}, found ${found.length}`);
    return found[0];
}

/** The point of the most recent `setPoint` mutation. */
function lastPoint(): GridPoint {
    const mutation = page.lastMutation();
    if (!mutation || mutation.op !== 'setPoint' || !mutation.point) throw new Error('no point was written');
    return mutation.point;
}

describe('part grid webview host messages', () => {
    it('clears the history and asks for a resync when the host rejects an edit', async () => {
        await page.render(partGrid([insideLayer()]));
        await page.click(2.5, 2.5);
        expect(page.mutations).toHaveLength(1);
        page.clear();

        await page.post({ type: 'editRejected', reason: 'stale' });
        expect(page.status()).toContain('Edit rejected (stale)');
        expect(page.posted).toContainEqual({ type: 'refresh' });
        expect(page.buttons('↶ Undo')[0].disabled).toBe(true);

        // The document moved on under the recorded inverses, so there is nothing left to undo.
        await page.keyDown({ key: 'z', ctrlKey: true });
        expect(page.mutations).toEqual([]);
    });

    it('drops the edits queued behind a rejected one', async () => {
        await page.render(partGrid([insideLayer()]));
        page.clear();
        // Two gestures with no acknowledgement in between: the first is in flight, the second waits.
        page.mouseDown(2.5, 2.5);
        page.mouseUp();
        page.mouseDown(3.5, 2.5);
        page.mouseUp();
        expect(page.mutations).toHaveLength(1);

        await page.post({ type: 'editRejected', reason: 'stale' });
        await page.post({ type: 'editDone', dataVersion: 2 });
        expect(page.mutations).toHaveLength(1);
    });

    it('stamps every edit with the payload version it was made against', async () => {
        await page.render(partGrid([insideLayer()], { dataVersion: 7 }));
        page.clear();
        page.mouseDown(2.5, 2.5);
        page.mouseUp();
        page.mouseDown(3.5, 2.5);
        page.mouseUp();
        expect(page.posted[0].dataVersion).toBe(7);

        // The host answers with the version its edit produced, and the waiting click goes out
        // against that one rather than against the version it was aimed at.
        await page.post({ type: 'editDone', dataVersion: 9 });
        expect(page.posted[1].dataVersion).toBe(9);
    });

    it('shows a note from the host in the status line', async () => {
        await page.render(partGrid([insideLayer()]));
        await page.post({ type: 'note', note: 'Wrote SIZE in base.rules, read by 3 other parts.' });
        expect(page.status()).toBe('Wrote SIZE in base.rules, read by 3 other parts.');
    });

    it('clears the sidebar when the host reports no part at the cursor', async () => {
        await page.render(partGrid([insideLayer()]));
        expect(page.sidebar.children.length).toBeGreaterThan(0);

        await page.post({ type: 'empty' });
        expect(page.sidebar.children).toHaveLength(0);
        expect(page.status()).toBe('No part found at this position.');

        // With no payload the canvas is inert rather than editing the layer that used to be there.
        page.clear();
        page.mouseDown(2.5, 2.5);
        page.mouseUp();
        expect(page.mutations).toEqual([]);
    });

    it('builds the sidebar again when a payload arrives after an empty one', async () => {
        await page.render(partGrid([insideLayer()]));
        await page.post({ type: 'empty' });
        await page.render(partGrid([insideLayer()]));
        expect(page.layerRow('BlockedTravelCells')).toBeTruthy();
        expect(page.section('View')).toBeTruthy();
    });
});

describe('part grid webview rotation panel', () => {
    /** The payload's rotation block, with the fields a test does not set left unwritten. */
    const withRotation = (rotation: Partial<PartGridData['rotation']>): PartGridData =>
        partGrid([insideLayer()], {
            rotation: {
                isRotateable: { value: null, origin: null },
                isFlippable: { value: null, origin: null },
                flipHRotate: null,
                flipVRotate: null,
                selectionTypeRotations: null,
                ...rotation,
            },
        });

    it('shows a flag no part in the chain set as neither on nor off', async () => {
        await page.render(withRotation({}));
        const [rotateable, flippable] = checkboxes(page.section('Rotation & flipping'));
        expect(rotateable.checked).toBe(false);
        expect(rotateable.indeterminate).toBe(true);
        expect(flippable.indeterminate).toBe(true);
    });

    it('writes IsRotateable when its box is ticked', async () => {
        await page.render(withRotation({}));
        const [rotateable] = checkboxes(page.section('Rotation & flipping'));
        rotateable.checked = true;
        rotateable.dispatch('change');
        await page.settle();
        expect(page.lastMutation()).toEqual({ op: 'setBool', field: 'IsRotateable', value: true });
    });

    it('writes IsFlippable false when its box is unticked', async () => {
        await page.render(withRotation({ isFlippable: { value: true, origin: LOCAL_ORIGIN } }));
        const [, flippable] = checkboxes(page.section('Rotation & flipping'));
        expect(flippable.checked).toBe(true);
        flippable.checked = false;
        flippable.dispatch('change');
        await page.settle();
        expect(page.lastMutation()).toEqual({ op: 'setBool', field: 'IsFlippable', value: false });
    });

    it('badges a flag that only a base part sets', async () => {
        await page.render(
            withRotation({ isRotateable: { value: true, origin: { ...LOCAL_ORIGIN, inherited: true } } })
        );
        const badges = page
            .descendants(page.section('Rotation & flipping'))
            .filter((node) => node.classList.contains('badge'));
        expect(badges.map((node) => node.textContent)).toEqual(['inherited']);
    });

    it('writes the rotation table typed into FlipHRotate', async () => {
        await page.render(withRotation({}));
        const [flipH] = inputs(page.section('Rotation & flipping'));
        flipH.value = '0, 2, 1, 3';
        await page.clickButton('Set', page.section('Rotation & flipping').children[3]);
        expect(page.lastMutation()).toEqual({ op: 'setIntList', field: 'FlipHRotate', values: [0, 2, 1, 3] });
    });

    it('removes the rotation table when the field is emptied', async () => {
        await page.render(withRotation({ flipHRotate: { values: [0, 2, 1, 3], origin: LOCAL_ORIGIN } }));
        const [flipH] = inputs(page.section('Rotation & flipping'));
        expect(flipH.value).toBe('0, 2, 1, 3');
        flipH.value = '';
        await page.clickButton('Set', page.section('Rotation & flipping').children[3]);
        expect(page.lastMutation()).toEqual({ op: 'setIntList', field: 'FlipHRotate', values: null });
    });

    it('refuses a rotation table that is not whole numbers', async () => {
        await page.render(withRotation({}));
        const [, flipV] = inputs(page.section('Rotation & flipping'));
        flipV.value = '0, 1.5';
        await page.clickButton('Set', page.section('Rotation & flipping').children[4]);
        expect(page.mutations).toEqual([]);
        expect(page.status()).toContain('FlipVRotate: only integers');
    });
});

describe('part grid webview contiguity panel', () => {
    /** The contiguity block of a payload, with the enum names the schema hands over. */
    const withContiguity = (values: string[] | null): PartGridData =>
        partGrid([insideLayer()], { contiguity: { values, enumNames: ADJACENCY_NAMES, origin: null } });

    it('shows the game default as the live set while the field is unset', async () => {
        await page.render(withContiguity(null));
        const section = page.section('AllowedContiguity');
        expect(section.textContent).toContain('Unset, the game defaults to Sides.');
        const on = page
            .descendants(section)
            .filter((node) => node.tagName === 'BUTTON' && node.classList.contains('on'))
            .map((node) => node.textContent);
        expect(on).toEqual(['Top', 'Right', 'Bottom', 'Left']);
    });

    it('writes the remaining sides when one is toggled off', async () => {
        await page.render(withContiguity(null));
        await page.clickButton('Top', page.section('AllowedContiguity'));
        expect(page.lastMutation()).toEqual({
            op: 'setFlags',
            field: 'AllowedContiguity',
            values: ['Right', 'Bottom', 'Left'],
        });
    });

    it('adds a corner to an authored set', async () => {
        await page.render(withContiguity(['Top']));
        await page.clickButton('TopLeft', page.section('AllowedContiguity'));
        expect(page.lastMutation()).toEqual({
            op: 'setFlags',
            field: 'AllowedContiguity',
            values: ['Top', 'TopLeft'],
        });
    });

    it('writes a composite through its shortcut button', async () => {
        await page.render(withContiguity(['Top']));
        const section = page.section('AllowedContiguity');
        expect(section.textContent).toContain('Toggling writes the field.');
        await page.clickButton('All', section);
        expect(page.lastMutation()).toEqual({ op: 'setFlags', field: 'AllowedContiguity', values: ['All'] });
    });

    it('removes the local field through the unset button', async () => {
        await page.render(withContiguity(['Top']));
        await page.clickButton('Unset', page.section('AllowedContiguity'));
        expect(page.lastMutation()).toEqual({ op: 'setFlags', field: 'AllowedContiguity', values: null });
    });
});

describe('part grid webview size controls', () => {
    it('shows the effective size of the part', async () => {
        await page.render(partGrid([insideLayer()], { size: { width: 3, height: 5, origin: null } }));
        expect(page.section('Size').textContent).toContain('3 × 5');
    });

    it('grows the part in each direction', async () => {
        await page.render(partGrid([insideLayer()]));
        await page.clickButton('W+', page.section('Size'));
        expect(page.lastMutation()).toEqual({ op: 'setSize', size: { width: 5, height: 4 } });
        await page.clickButton('H+', page.section('Size'));
        expect(page.lastMutation()).toEqual({ op: 'setSize', size: { width: 5, height: 5 } });
    });

    it('shrinks the part in each direction', async () => {
        await page.render(partGrid([insideLayer()]));
        await page.clickButton('W−', page.section('Size'));
        expect(page.lastMutation()).toEqual({ op: 'setSize', size: { width: 3, height: 4 } });
        await page.clickButton('H−', page.section('Size'));
        expect(page.lastMutation()).toEqual({ op: 'setSize', size: { width: 3, height: 3 } });
    });

    it('never shrinks a dimension below one cell', async () => {
        await page.render(partGrid([insideLayer()], { size: { width: 1, height: 1, origin: null } }));
        await page.clickButton('W−', page.section('Size'));
        await page.clickButton('H−', page.section('Size'));
        expect(page.mutations).toEqual([
            { op: 'setSize', size: { width: 1, height: 1 } },
            { op: 'setSize', size: { width: 1, height: 1 } },
        ]);
        expect(page.section('Size').textContent).toContain('1 × 1');
    });

    it('shows the new size without waiting for the host to answer', async () => {
        await page.render(partGrid([insideLayer()]));
        await page.clickButton('W+', page.section('Size'));
        expect(page.section('Size').textContent).toContain('5 × 4');
    });
});

describe('part grid webview snap step', () => {
    it('snaps a dragged point to quarter cells by default', async () => {
        await page.render(partGrid([pointLayer()]));
        page.clear();
        await page.drag([2, 2], [1.33, 2]);
        expect(lastPoint().x).toBeCloseTo(1.25, 6);
    });

    it('snaps to the finer step once it is picked', async () => {
        await page.render(partGrid([pointLayer()]));
        await page.clickButton('0.05', page.layerPanel());
        page.clear();
        await page.drag([2, 2], [1.33, 2]);
        expect(lastPoint().x).toBeCloseTo(1.35, 6);
    });

    it('places a point freely when snapping is switched off', async () => {
        await page.render(partGrid([pointLayer()]));
        await page.clickButton('free', page.layerPanel());
        page.clear();
        await page.drag([2, 2], [1.33, 2]);
        expect(lastPoint().x).toBeCloseTo(1.33, 6);
    });

    it('marks the step in force', async () => {
        await page.render(partGrid([pointLayer()]));
        const stepOf = (label: string) => page.buttons(label, page.layerPanel())[0].classList.contains('on');
        expect([stepOf('¼'), stepOf('0.05'), stepOf('free')]).toEqual([true, false, false]);
        await page.clickButton('free', page.layerPanel());
        expect([stepOf('¼'), stepOf('0.05'), stepOf('free')]).toEqual([false, false, true]);
    });
});

describe('part grid webview layer groups', () => {
    it('opens the part group and leaves a group nothing has authored closed', async () => {
        await page.render(partGrid([insideLayer(), emptyGraphicsLayer()]));
        expect(group('Part').open).toBe(true);
        expect(group('Graphics').open).toBe(false);
    });

    it('opens a group that holds the edited layer', async () => {
        await page.render(partGrid([insideLayer(), emptyGraphicsLayer()]));
        await page.activateLayer('BlueprintCells');
        expect(group('Graphics').open).toBe(true);
    });

    it('counts the layers of each group in its summary', async () => {
        await page.render(partGrid([insideLayer(), emptyGraphicsLayer()]));
        expect(group('Part').textContent).toContain('Part 1');
        expect(group('Graphics').textContent).toContain('Graphics 1');
    });
});

describe('part grid webview legend rows', () => {
    it('makes a row the edited layer when it is activated from the keyboard', async () => {
        await page.render(partGrid([insideLayer(), emptyGraphicsLayer()]));
        page.layerRow('BlueprintCells').dispatch('keydown', { key: 'Enter' });
        await page.settle();
        expect(page.layerRow('BlueprintCells').classList.contains('active')).toBe(true);
        expect(page.layerPanel().textContent).toContain('BlueprintCells');
    });

    it('activates a row with the space bar as well', async () => {
        await page.render(partGrid([insideLayer(), emptyGraphicsLayer()]));
        page.layerRow('BlueprintCells').dispatch('keydown', { key: ' ' });
        await page.settle();
        expect(page.layerRow('BlueprintCells').classList.contains('active')).toBe(true);
    });

    it('leaves the edited layer alone for any other key', async () => {
        await page.render(partGrid([insideLayer(), emptyGraphicsLayer()]));
        page.layerRow('BlueprintCells').dispatch('keydown', { key: 'a' });
        await page.settle();
        expect(page.layerRow('BlockedTravelCells').classList.contains('active')).toBe(true);
    });

    it('switching a layer off swaps its panel for the reason it is inert', async () => {
        await page.render(partGrid([insideLayer()]));
        const box = page
            .layerRow('BlockedTravelCells')
            .children.find((child) => child.tagName === 'INPUT' && child.type === 'checkbox') as StubElement;
        box.checked = false;
        box.dispatch('change');
        await page.settle();
        expect(page.layerPanel().textContent).toContain('is hidden. Tick its checkbox to edit it.');
        expect(page.layerPanel().classList.contains('hidden-layer')).toBe(true);
    });
});
