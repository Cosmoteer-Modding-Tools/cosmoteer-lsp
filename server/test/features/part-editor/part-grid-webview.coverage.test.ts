import { beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { mediaBundle } from '../../media-bundle';
import type { CoverageLayerData } from '../../../src/features/part-editor/part-grid.types';
import { GridHarness, LAYER_BASE, StubElement, loadGridWebview, partGrid } from './part-grid-webview.harness';

// The weapon coverage layer of the part grid page: the drag handles and the sidebar rows post the
// `setCoverage` mutation the server writes, and undo restores the value the drag started from.

/** The page's own coverage resolution, read out of the bundle. */
const { effectiveCoverage } = createRequire(import.meta.url)(mediaBundle('part-grid-editor.js')) as {
    effectiveCoverage(layer: CoverageLayerData): { near: number; width: number; range: number; rest: number };
};

let page: GridHarness;

beforeEach(() => {
    page = loadGridWebview();
});

/**
 * A turret at the middle of a 4 by 4 part, facing +X, covering 90 degrees out to 1.5 cells.
 * @param overrides the fields to replace.
 * @returns the layer.
 */
function coverageLayer(overrides: Partial<CoverageLayerData> = {}): CoverageLayerData {
    return {
        ...LAYER_BASE,
        kind: 'coverage',
        id: 'Components/Turret/DefaultWeaponCoverage',
        label: 'Coverage (Turret)',
        fieldName: 'DefaultWeaponCoverage',
        group: 'Weapons',
        component: 'Turret',
        weaponKind: 'turret',
        center: { x: 2, y: 2 },
        mountDeg: 0,
        physicalArcDeg: 360,
        physicalRange: null,
        coverage: { range: 1.5, arcNearDeg: -45, arcWidthDeg: 90, restPosition: null },
        allowCoverageEditing: true,
        allowRangeEditing: true,
        allowArcEditing: true,
        forceWidthZero: false,
        matchWeaponCoverage: null,
        ...overrides,
    };
}

/**
 * The grid point at an angle and distance from the turret.
 * @param degrees the angle, 0 along +X and positive clockwise.
 * @param distance the distance in cells.
 * @returns the point.
 */
function polar(degrees: number, distance: number): [number, number] {
    const radians = (degrees * Math.PI) / 180;
    return [2 + Math.cos(radians) * distance, 2 + Math.sin(radians) * distance];
}

/**
 * The sidebar row whose label starts with a text.
 * @param label the label.
 * @returns the row.
 */
function panelRow(label: string): StubElement {
    const row = page
        .descendants(page.layerPanel())
        .find((node) => node.classList.contains('row') && node.children[0]?.textContent.startsWith(label));
    if (!row) throw new Error(`no panel row labelled ${label}`);
    return row;
}

describe('part grid webview coverage layer', () => {
    it('drags the near edge and keeps the far edge', async () => {
        await page.render(partGrid([coverageLayer()]));
        page.clear();
        await page.drag(polar(-45, 1.5), polar(-60, 1.5));
        expect(page.lastMutation()).toEqual({
            op: 'setCoverage',
            component: 'Turret',
            field: 'Arc',
            value: { nearDeg: -60, widthDeg: 105 },
        });
    });

    it('drags the far edge and keeps the near edge', async () => {
        await page.render(partGrid([coverageLayer()]));
        page.clear();
        await page.drag(polar(45, 1.5), polar(30, 1.5));
        expect(page.lastMutation()).toEqual({
            op: 'setCoverage',
            component: 'Turret',
            field: 'Arc',
            value: { nearDeg: -45, widthDeg: 75 },
        });
    });

    it('places the handles in the mount frame', async () => {
        await page.render(partGrid([coverageLayer({ mountDeg: -90 })]));
        page.clear();
        await page.drag(polar(-135, 1.5), polar(-150, 1.5));
        expect(page.lastMutation()).toEqual({
            op: 'setCoverage',
            component: 'Turret',
            field: 'Arc',
            value: { nearDeg: -60, widthDeg: 105 },
        });
    });

    it('drags the rest handle to a fraction of the arc', async () => {
        await page.render(partGrid([coverageLayer()]));
        page.clear();
        await page.drag(polar(0, 0.9), polar(27, 0.9));
        expect(page.lastMutation()).toEqual({
            op: 'setCoverage',
            component: 'Turret',
            field: 'RestPosition',
            value: 0.8,
        });
    });

    it('drags the rim to a whole range', async () => {
        await page.render(partGrid([coverageLayer()]));
        page.clear();
        await page.drag(polar(20, 1.5), polar(20, 2.3));
        expect(page.lastMutation()).toEqual({ op: 'setCoverage', component: 'Turret', field: 'Range', value: 2 });
    });

    it('offers a fixed weapon only its range', async () => {
        await page.render(partGrid([coverageLayer({ weaponKind: 'fixed' })]));
        page.clear();
        await page.drag(polar(-45, 1.5), polar(-60, 1.5));
        expect(page.mutations).toEqual([]);
        expect(page.buttons('Set', page.layerPanel())).toHaveLength(1);
    });

    it('undoes a drag back to the value it started from', async () => {
        await page.render(partGrid([coverageLayer()]));
        page.clear();
        await page.drag(polar(20, 1.5), polar(20, 2.3));
        await page.keyDown({ key: 'z', ctrlKey: true });
        expect(page.mutations).toEqual([
            { op: 'setCoverage', component: 'Turret', field: 'Range', value: 2 },
            { op: 'setCoverage', component: 'Turret', field: 'Range', value: 1.5 },
        ]);
    });

    it('writes the typed arc and undoes a cleared one', async () => {
        await page.render(partGrid([coverageLayer()]));
        page.clear();
        const row = panelRow('Arc');
        const inputs = page.descendants(row).filter((node) => node.tagName === 'INPUT');
        inputs[0].value = '-30';
        inputs[1].value = '60';
        await page.clickButton('Set', row);
        await page.clickButton('Clear', panelRow('Rest'));
        await page.keyDown({ key: 'z', ctrlKey: true });
        await page.keyDown({ key: 'z', ctrlKey: true });
        expect(page.mutations).toEqual([
            { op: 'setCoverage', component: 'Turret', field: 'Arc', value: { nearDeg: -30, widthDeg: 60 } },
            { op: 'setCoverage', component: 'Turret', field: 'RestPosition', value: null },
            { op: 'setCoverage', component: 'Turret', field: 'RestPosition', value: null },
            { op: 'setCoverage', component: 'Turret', field: 'Arc', value: { nearDeg: -45, widthDeg: 90 } },
        ]);
    });

    it('refuses a typed range below zero', async () => {
        await page.render(partGrid([coverageLayer()]));
        page.clear();
        page.input(panelRow('Range')).value = '-3';
        await page.clickButton('Set', panelRow('Range'));
        expect(page.mutations).toEqual([]);
        expect(page.status()).toContain('Range');
    });

    it('says which weapon the coverage follows', async () => {
        await page.render(partGrid([coverageLayer({ matchWeaponCoverage: 'WeaponB' })]));
        expect(page.layerPanel().textContent).toContain('Follows the player coverage of WeaponB.');
    });
});

describe('part grid webview coverage resolution', () => {
    it('narrows the authored arc to the physical arc and the range to the physical range', () => {
        const resolved = effectiveCoverage(coverageLayer({ physicalArcDeg: 60, physicalRange: 1 }));
        expect(resolved).toMatchObject({ near: -30, width: 60, range: 1, rest: 0 });
    });

    it('falls back to the physical arc where the authored one misses it', () => {
        const layer = coverageLayer({ physicalArcDeg: 20 });
        const resolved = effectiveCoverage({
            ...layer,
            coverage: { ...layer.coverage, arcNearDeg: 90, arcWidthDeg: 30 },
        });
        expect(resolved).toMatchObject({ near: -10, width: 20 });
    });

    it('clamps a zero-width arc into the physical arc and lines a forced one up with the mount', () => {
        const layer = coverageLayer({ physicalArcDeg: 40 });
        const line = effectiveCoverage({ ...layer, coverage: { ...layer.coverage, arcNearDeg: 50, arcWidthDeg: 0 } });
        expect(line).toMatchObject({ near: 20, width: 0 });
        const forced = effectiveCoverage({
            ...layer,
            forceWidthZero: true,
            coverage: { ...layer.coverage, arcNearDeg: null, arcWidthDeg: null },
        });
        expect(forced).toMatchObject({ near: 0, width: 0 });
    });
});
