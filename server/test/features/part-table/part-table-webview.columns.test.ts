import { describe, expect, it } from 'vitest';
import { StubElement, loadTableWebview } from './part-table-webview.harness';

/**
 * The part table page against the column pick: what the picker's two buttons do with it, what an
 * answer that names no columns does to it, and what the page does with an answer carrying no table
 * at all. The pick is the reader's own work, so nothing but the picker may change it.
 */

const parts = [
    {
        key: 'c:/game/armor.rules#part',
        id: 'cosmoteer.armor',
        source: 'Cosmoteer',
        cells: { MaxHealth: { text: '450', value: 450 }, Density: { text: '2', value: 2 } },
    },
    {
        key: 'c:/mod/shield.rules#part',
        id: 'mod.shield',
        source: 'MyMod',
        cells: { MaxHealth: { text: '800', value: 800 }, Density: { text: '3', value: 3 } },
    },
];

/** The column keys the table is drawing, in the order their headers stand. */
const drawnColumns = (stage: StubElement): string[] =>
    stage
        .querySelectorAll('th')
        .map((cell) => cell.dataset.key)
        .filter((key): key is string => key !== undefined);

/** Ticks or unticks a column in the picker, the way a click on its box does. */
const toggleColumn = (list: StubElement, label: string): void => {
    const row = list.children.find((node) => node.textContent.includes(label));
    if (!row) throw new Error(`the picker is listing no column called ${label}`);
    const box = row.children.find((child) => child.tagName === 'INPUT');
    if (!box) throw new Error(`the picker's ${label} row has no box to tick`);
    box.checked = !box.checked;
    box.dispatch('change');
};

describe('the part table page when the reader picks columns', () => {
    it('keeps a column the filter has taken off the table when the picker is closed', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts, sources: ['Cosmoteer', 'MyMod'] });
        page.byId('pick-columns').dispatch('click');
        page.byId('columns-apply').dispatch('click');
        // The reader narrows to the mod, whose parts carry no density, so the server answers with a
        // column set that no longer offers it while the page holds it picked.
        await page.post({
            type: 'table',
            columns: ['MaxHealth', 'Density'],
            table: {
                rows: [parts[1]].map((row) => ({ ...row, categories: [], components: [], ships: [] })),
                columns: [{ path: 'MaxHealth', label: 'MaxHealth', rows: 1 }],
                columnsVersion: 'v2',
                total: 1,
                categories: [],
                componentTypes: [],
                sources: ['Cosmoteer', 'MyMod'],
                editorGroups: [],
                ships: [],
                mod: 'MyMod',
                suggested: ['MaxHealth'],
                truncated: false,
            },
        });
        page.byId('pick-columns').dispatch('click');
        page.byId('columns-close').dispatch('click');
        page.clear();
        // Widening the filter again asks for the parts, and the ask carries the pick the reader made.
        await page.pick('source', '');
        expect(page.last('columns')?.columns).toEqual(['MaxHealth', 'Density']);
    });

    it('keeps the pick when an answer names no columns', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts });
        page.byId('pick-columns').dispatch('click');
        toggleColumn(page.byId('column-list'), 'Density');
        page.byId('columns-apply').dispatch('click');
        await page.post({ type: 'table', columns: ['MaxHealth'], table: tableOf() });
        expect(drawnColumns(page.byId('stage'))).toContain('MaxHealth');
        expect(drawnColumns(page.byId('stage'))).not.toContain('Density');
        // The table is opened a second time, which asks for the parts without naming the columns.
        await page.table({ rows: parts });
        expect(drawnColumns(page.byId('stage'))).not.toContain('Density');
    });

    it('takes the columns the server ranks until the reader has picked', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts });
        expect(drawnColumns(page.byId('stage'))).toEqual(expect.arrayContaining(['MaxHealth', 'Density']));
    });
});

describe('the part table page when the reader closes the column picker', () => {
    /** A table of both parts whose only suggested column is health, so a tick adds a column. */
    const oneSuggested = () => ({ ...tableOf(), suggested: ['MaxHealth'] });

    it('leaves the table on the columns it was showing', async () => {
        const page = loadTableWebview();
        await page.post({ type: 'table', table: oneSuggested() });
        expect(drawnColumns(page.byId('stage'))).not.toContain('Density');
        page.byId('pick-columns').dispatch('click');
        toggleColumn(page.byId('column-list'), 'Density');
        page.clear();
        page.byId('columns-close').dispatch('click');
        // A column drawn without asking the server for it would be a column of empty cells.
        expect(drawnColumns(page.byId('stage'))).not.toContain('Density');
        expect(page.last('columns')).toBeUndefined();
    });

    it('forgets the ticks, so the picker opens on the table again', async () => {
        const page = loadTableWebview();
        await page.post({ type: 'table', table: oneSuggested() });
        page.byId('pick-columns').dispatch('click');
        toggleColumn(page.byId('column-list'), 'Density');
        page.byId('columns-close').dispatch('click');
        page.byId('pick-columns').dispatch('click');
        const row = page.byId('column-list').children.find((node) => node.textContent.includes('Density'));
        expect(row?.children.find((child) => child.tagName === 'INPUT')?.checked).toBe(false);
    });

    it('puts the ticked column on the table when the reader presses the other button', async () => {
        const page = loadTableWebview();
        await page.post({ type: 'table', table: oneSuggested() });
        page.byId('pick-columns').dispatch('click');
        toggleColumn(page.byId('column-list'), 'Density');
        page.clear();
        page.byId('columns-apply').dispatch('click');
        expect(page.last('columns')?.columns).toEqual(['MaxHealth', 'Density']);
    });
});

describe('the part table page when the host could not read the parts', () => {
    it('says so and stays usable', async () => {
        const page = loadTableWebview();
        await page.post({ type: 'table' });
        expect(page.notice()).toBe('The parts could not be read.');
        // The page is still holding a table it can work from, so the next good answer draws.
        await page.table({ rows: parts });
        expect(drawnColumns(page.byId('stage'))).toContain('MaxHealth');
        page.clear();
        page.byId('refresh').dispatch('click');
        expect(page.last('columns')?.refresh).toBe(true);
    });
});

/** A table of both parts, as the host posts one, for the tests that write their own message. */
const tableOf = () => ({
    rows: parts.map((row) => ({
        file: 'x.rules',
        uri: 'file:///c%3A/game/x.rules',
        line: 0,
        character: 0,
        origin: 'game',
        name: row.id,
        categories: [],
        components: [],
        editorGroup: '',
        editorGroups: [],
        ships: [],
        ...row,
    })),
    columns: [
        { path: 'MaxHealth', label: 'MaxHealth', rows: 2 },
        { path: 'Density', label: 'Density', rows: 2 },
    ],
    columnsVersion: 'v1',
    total: 2,
    categories: [],
    componentTypes: [],
    sources: [],
    editorGroups: [],
    ships: [],
    mod: '',
    suggested: ['MaxHealth', 'Density'],
    truncated: false,
});
