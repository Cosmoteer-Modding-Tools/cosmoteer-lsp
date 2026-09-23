import { describe, expect, it } from 'vitest';
import { loadTableWebview } from './part-table-webview.harness';

/**
 * The part table page against the state the host puts back. The kept view arrives out of the
 * host's own storage the moment the page says it is listening, which is well before the first
 * table, since a table is a walk of every part of the install. Everything the reader set up has to
 * survive that order, and the values they typed over cells have to stay with the parts the table
 * is actually showing.
 */

/** The kept view as the host holds it, filled out around the parts a test cares about. */
const keptView = (view: Record<string, unknown>) => ({
    type: 'views',
    views: {},
    activeView: '',
    state: {
        search: '',
        filter: { categories: [], components: [], sources: [] },
        picked: false,
        shown: [],
        formulas: [],
        frozen: ['id'],
        order: [],
        widths: {},
        sort: { key: 'id', descending: false },
        reference: '',
        asPercent: false,
        perTile: false,
        groupBy: '',
        collapsed: [],
        overrides: {},
        treeSelection: null,
        treeHidden: false,
        ...view,
    },
});

const parts = [
    { key: 'c:/game/armor.rules#part', id: 'cosmoteer.armor', cells: { MaxHealth: { text: '450', value: 450 } } },
    { key: 'c:/game/shield.rules#part', id: 'cosmoteer.shield', cells: { MaxHealth: { text: '800', value: 800 } } },
];

describe('the part table page when the host puts the kept view back', () => {
    it('asks for the parts the kept filter narrows to, although the dropdowns are still empty', async () => {
        const page = loadTableWebview();
        page.clear();
        await page.post(
            keptView({ filter: { categories: ['Weapons'], components: ['ShieldGeneratorRules'], sources: ['MyMod'] } })
        );
        expect(page.last('columns')?.filter).toEqual({
            categories: ['Weapons'],
            components: ['ShieldGeneratorRules'],
            sources: ['MyMod'],
        });
    });

    it('shows the kept filter in the dropdowns once the table brings their entries', async () => {
        const page = loadTableWebview();
        await page.post(keptView({ filter: { categories: ['Weapons'], components: [], sources: ['MyMod'] } }));
        await page.table({
            rows: parts,
            categories: ['Armor', 'Weapons'],
            componentTypes: ['ShieldGeneratorRules'],
            sources: ['Cosmoteer', 'MyMod'],
        });
        expect(page.byId('category').value).toBe('Weapons');
        expect(page.byId('source').value).toBe('MyMod');
    });

    it('keeps the filter in the state it writes back to the host', async () => {
        const page = loadTableWebview();
        await page.post(keptView({ filter: { categories: ['Weapons'], components: [], sources: [] } }));
        await page.table({ rows: parts, categories: ['Armor', 'Weapons'], sources: ['Cosmoteer'] });
        await new Promise((done) => setTimeout(done, 400));
        const saved = page.last('saveState')?.view as { filter: { categories: string[] } } | undefined;
        expect(saved?.filter.categories).toEqual(['Weapons']);
    });

    it('drops a pick the parts no longer offer rather than narrowing to nothing', async () => {
        const page = loadTableWebview();
        await page.post(keptView({ filter: { categories: ['Weapons'], components: [], sources: [] } }));
        // The mod that had the weapons is gone from the workspace, so the axis no longer offers it.
        await page.table({ rows: parts, categories: ['Armor'], sources: ['Cosmoteer'] });
        page.clear();
        await page.pick('source', '');
        expect(page.last('columns')?.filter).toEqual({ categories: [], components: [], sources: [] });
        expect(page.byId('category').value).toBe('');
    });

    it('narrows to the entry the reader picks in a dropdown', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts, categories: ['Armor', 'Weapons'], sources: ['Cosmoteer'] });
        page.clear();
        await page.pick('category', 'Armor');
        expect(page.last('columns')?.filter).toEqual({ categories: ['Armor'], components: [], sources: [] });
    });

    it('compares against the part a saved view names rather than the one on screen', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts });
        page.byId('reference').value = 'cosmoteer.armor';
        page.byId('reference').dispatch('change');
        await page.post({ type: 'views', views: { defences: { reference: 'cosmoteer.shield' } }, activeView: '' });
        await page.openView('defences');
        await page.table({ rows: parts });
        expect(page.byId('reference').value).toBe('cosmoteer.shield');
    });

    it('compares against nothing when the saved view named no part', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts });
        page.byId('reference').value = 'cosmoteer.armor';
        page.byId('reference').dispatch('change');
        await page.post({ type: 'views', views: { everything: { reference: '' } }, activeView: '' });
        await page.openView('everything');
        await page.table({ rows: parts });
        expect(page.byId('reference').value).toBe('');
    });

    it('compares against the part the kept view named once the rows arrive', async () => {
        const page = loadTableWebview();
        await page.post(keptView({ reference: 'cosmoteer.shield' }));
        await page.table({ rows: parts });
        expect(page.byId('reference').value).toBe('cosmoteer.shield');
        await new Promise((done) => setTimeout(done, 400));
        expect((page.last('saveState')?.view as { reference: string }).reference).toBe('cosmoteer.shield');
    });
});

describe('the part table page when it writes the typed values', () => {
    it('writes a value the reader typed into a row on the table', async () => {
        const page = loadTableWebview();
        await page.table({ rows: parts });
        await page.typeCell('cosmoteer.armor', 'MaxHealth', '999');
        page.clear();
        await page.apply();
        expect(page.last('applyEdits')?.edits).toEqual([
            { row: 'c:/game/armor.rules#part', column: 'MaxHealth', text: '999' },
        ]);
    });

    it('leaves a typed value alone when its part is not on the table', async () => {
        const page = loadTableWebview();
        // A row key is a path into the install, so a value typed in another workspace names a part
        // that resolves here as well. The table is what says which parts this reader is looking at.
        await page.post(
            keptView({
                overrides: {
                    'c:/mods/other/turret.rules#part': { MaxHealth: { value: 9.5, text: '9.5' } },
                    'c:/game/armor.rules#part': { MaxHealth: { value: 999, text: '999' } },
                },
            })
        );
        await page.table({ rows: parts });
        page.clear();
        await page.apply();
        expect(page.last('applyEdits')?.edits).toEqual([
            { row: 'c:/game/armor.rules#part', column: 'MaxHealth', text: '999' },
        ]);
        expect(page.notice()).toContain('not showing');
        // The outcome of the write must not take the line about them away again.
        await page.post({
            type: 'editsApplied',
            results: [
                {
                    row: 'c:/game/armor.rules#part',
                    column: 'MaxHealth',
                    status: 'ok',
                    note: 'Written into armor.rules.',
                },
            ],
        });
        expect(page.notice()).toContain('not showing');
        expect(page.notice()).toContain('Written into armor.rules.');
    });

    it('writes nothing at all when every typed value belongs to another table', async () => {
        const page = loadTableWebview();
        await page.post(
            keptView({ overrides: { 'c:/mods/other/turret.rules#part': { MaxHealth: { value: 9.5, text: '9.5' } } } })
        );
        await page.table({ rows: parts });
        page.clear();
        await page.apply();
        expect(page.last('applyEdits')).toBeUndefined();
        expect(page.notice()).toContain('not showing');
    });

    it('brings no typed value along when a saved view is opened', async () => {
        const page = loadTableWebview();
        // A view kept before the typed values were left out of one still carries them, and it is
        // offered in every workspace.
        await page.post({
            type: 'views',
            activeView: '',
            views: {
                Armour: {
                    filter: { categories: [], components: [], sources: [] },
                    overrides: { 'c:/game/armor.rules#part': { MaxHealth: { value: 999, text: '999' } } },
                },
            },
        });
        await page.table({ rows: parts });
        await page.openView('Armour');
        await page.table({ rows: parts });
        page.clear();
        await page.apply();
        expect(page.last('applyEdits')).toBeUndefined();
    });
});

describe('the part table page when a kept view names a formula column', () => {
    /** The part ids the table is drawing, top to bottom. */
    const drawnIds = (page: ReturnType<typeof loadTableWebview>): string[] =>
        page
            .byId('stage')
            .querySelectorAll('tr')
            .map((row) => row.children.find((cell) => cell.tagName === 'TD' && cell.dataset.key === 'id'))
            .filter((cell) => cell !== undefined && !cell.parentNode?.classList.contains('summary'))
            .map((cell) => cell!.textContent);

    it('asks for the column under the id the kept sort names', async () => {
        const page = loadTableWebview();
        page.clear();
        // The ids are handed out as formulas are written, and one written and refused burns an id,
        // so the second column of a view is not always the second id.
        await page.post(
            keptView({
                formulas: [{ id: 'formula:1', name: 'Health', formula: '[MaxHealth]' }],
                sort: { key: 'formula:1', descending: true },
            })
        );
        await page.table({ rows: parts });
        expect(page.last('formula')?.id).toBe('formula:1');
        await page.post({
            type: 'formulaResult',
            id: 'formula:1',
            values: { 'c:/game/armor.rules#part': 450, 'c:/game/shield.rules#part': 800 },
        });
        expect(drawnIds(page)).toEqual(['cosmoteer.shield', 'cosmoteer.armor']);
    });

    it('keeps the id when it writes the view back', async () => {
        const page = loadTableWebview();
        await page.post(
            keptView({
                formulas: [{ id: 'formula:1', name: 'Health', formula: '[MaxHealth]' }],
                sort: { key: 'formula:1', descending: true },
            })
        );
        await page.table({ rows: parts });
        page.byId('view-name').value = 'Mine';
        page.byId('view-save').dispatch('click');
        const view = page.last('saveView')?.view as Record<string, unknown>;
        expect(view.formulas).toEqual([{ id: 'formula:1', name: 'Health', formula: '[MaxHealth]' }]);
        expect(view.sort).toEqual({ key: 'formula:1', descending: true });
    });

    it('sorts by the part id when the kept sort names a column the view no longer carries', async () => {
        const page = loadTableWebview();
        await page.post(keptView({ formulas: [], sort: { key: 'formula:1', descending: true } }));
        await page.table({ rows: parts });
        expect(drawnIds(page)).toEqual(['cosmoteer.armor', 'cosmoteer.shield']);
    });
});

describe('the part table page when two parts share an id', () => {
    const twins = [
        {
            key: 'c:/game/armor/armor.rules#part',
            id: 'cosmoteer.armor',
            source: 'Cosmoteer',
            uri: 'file:///c:/game/armor/armor.rules',
            cells: { MaxHealth: { text: '450', value: 450 } },
        },
        {
            key: 'c:/mod/armor/armor.rules#part',
            id: 'cosmoteer.armor',
            source: 'MyMod',
            uri: 'file:///c:/mod/armor/armor.rules',
            cells: { MaxHealth: { text: '800', value: 800 } },
        },
    ];

    it('offers each of them in the compared-part box', async () => {
        const page = loadTableWebview();
        await page.table({ rows: twins });
        const offered = page
            .byId('reference-options')
            .children.map((option) => option.value)
            .sort();
        expect(offered).toEqual([
            'cosmoteer.armor (game/armor/armor.rules)',
            'cosmoteer.armor (mod/armor/armor.rules)',
        ]);
    });

    it('compares against the one the reader picked rather than the first', async () => {
        const page = loadTableWebview();
        await page.table({ rows: twins });
        const box = page.byId('reference');
        box.value = 'cosmoteer.armor (mod/armor/armor.rules)';
        box.dispatch('change');
        const marked = page
            .byId('stage')
            .querySelectorAll('tr')
            .filter((row) => row.classList.contains('reference'));
        expect(marked.length).toBe(1);
        expect(marked[0].children.find((cell) => cell.dataset.key === 'source')?.textContent).toBe('MyMod');
    });
});
