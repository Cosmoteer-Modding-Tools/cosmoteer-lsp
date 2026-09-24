import { describe, expect, it } from 'vitest';
import { StubElement, loadTableWebview } from './part-table-webview.harness';

/**
 * The part table page against the two places the view on screen and the view it reports part ways:
 * the tree, whose pick outlives the rows it named, and the workbook, which is built out of what the
 * reader is looking at.
 */

const parts = [
    {
        key: 'c:/game/armor.rules#part',
        id: 'cosmoteer.armor',
        ships: ['Terran'],
        editorGroups: ['Defenses'],
        cells: { MaxHealth: { text: '450', value: 450 } },
    },
    {
        key: 'c:/mod/shield.rules#part',
        id: 'mod.shield',
        source: 'MyMod',
        ships: ['ModShip'],
        editorGroups: ['Armor'],
        cells: { MaxHealth: { text: '800', value: 800 } },
    },
    {
        key: 'c:/game/cannon.rules#part',
        id: 'cosmoteer.cannon',
        ships: ['Terran'],
        editorGroups: ['Armor'],
        cells: { MaxHealth: { text: '200', value: 200 } },
    },
];

/** The node of the tree carrying a label, which is how a reader finds one to click. */
const treeNode = (page: { byId(id: string): StubElement }, label: string): StubElement | undefined =>
    page.byId('tree').children.find((node) => node.children[0]?.textContent === label);

describe('the part table page when the tree pick names rows the table no longer holds', () => {
    it('keeps the node on the tree, marked, on no parts', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts });
        treeNode(page, 'ModShip')?.dispatch('click');
        // The mod's part leaves the table, so the class the reader picked registers nothing.
        await page.table({ rows: [parts[0], parts[2]] });
        const node = treeNode(page, 'ModShip');
        expect(node).toBeDefined();
        expect(node?.classList.contains('selected')).toBe(true);
        expect(node?.textContent).toBe('ModShip0');
    });

    it('says the tree is what is narrowing, not the filter bar', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts });
        treeNode(page, 'ModShip')?.dispatch('click');
        await page.table({ rows: [parts[0], parts[2]] });
        expect(page.byId('empty').textContent).toBe('No part is left in the part of the tree you picked.');
    });

    it('blames the filter when the tree has no pick', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts });
        page.byId('search').value = 'nothing carries this';
        page.byId('search').dispatch('input');
        expect(page.byId('empty').textContent).toBe('No part matches the filter.');
    });
});

describe('the part table page when the reader exports the workbook', () => {
    it('hands over the rows in the order the groups on screen put them', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts });
        await page.pick('group', 'editorGroup');
        page.byId('export-excel').dispatch('click');
        const model = page.last('exportExcel')?.model as { rows: { id: string; groups: string[] }[] };
        // Sorted by part id the rows read armor, cannon, shield. Grouped they read Armor first.
        expect(model.rows.map((row) => row.id)).toEqual(['cosmoteer.cannon', 'mod.shield', 'cosmoteer.armor']);
        expect(model.rows.map((row) => row.groups[0])).toEqual(['Armor', 'Armor', 'Defenses']);
    });

    it('hands over the sorted order when the rows are not grouped', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts });
        page.byId('export-excel').dispatch('click');
        const model = page.last('exportExcel')?.model as { rows: { id: string }[] };
        expect(model.rows.map((row) => row.id)).toEqual(['cosmoteer.armor', 'cosmoteer.cannon', 'mod.shield']);
    });
});
