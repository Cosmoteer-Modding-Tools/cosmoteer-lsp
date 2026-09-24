import { readFileSync } from 'fs';
import { Script } from 'vm';
import { mediaBundle } from '../../media-bundle';

/**
 * Loads the built part table page into a Node vm under a hand-written DOM stub and drives it the
 * way the host does: deliver the kept view, deliver a table, pick a dropdown, type over a cell,
 * and read back the messages the page posts.
 *
 * The stub is deliberately small and hand-written rather than a DOM library, so a page that starts
 * reaching for something new fails loudly here instead of passing against a simulated browser
 * nobody reads. One part of it is not a shortcut and must not become one: a dropdown takes a value
 * only when it holds an option carrying it, which is the whole subject of the restore tests.
 */

/** The page under test, the bundle a webview and the JetBrains host both load. */
const SOURCE_PATH = mediaBundle('part-table.js');

/** The page compiled once, so a test that loads a fresh copy pays only for running it. */
let compiled: Script | undefined;

/** A class attribute, kept as a set so the page's `classList` calls and `className` writes agree. */
class StubClassList {
    private readonly names = new Set<string>();

    add(...names: string[]): void {
        for (const name of names) this.names.add(name);
    }

    remove(...names: string[]): void {
        for (const name of names) this.names.delete(name);
    }

    contains(name: string): boolean {
        return this.names.has(name);
    }

    toggle(name: string, force?: boolean): boolean {
        const next = force === undefined ? !this.names.has(name) : force;
        if (next) this.names.add(name);
        else this.names.delete(name);
        return next;
    }

    replaceAll(value: string): void {
        this.names.clear();
        for (const name of value.split(/\s+/).filter((part) => part.length)) this.names.add(name);
    }
}

/** The ids the page's markup gives to dropdowns, which behave differently from every other box. */
const SELECT_IDS = new Set(['category', 'component', 'source', 'group']);

/** A single DOM node: enough of an element for the page to draw its table and its bar out of. */
export class StubElement {
    readonly tagName: string;
    readonly children: StubElement[] = [];
    readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    readonly classList = new StubClassList();
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, unknown> = {};
    parentNode: StubElement | null = null;

    type = '';
    checked = false;
    disabled = false;
    placeholder = '';
    title = '';
    hidden = false;
    colSpan = 1;

    private ownValue = '';
    private ownText = '';
    private ownId = '';

    constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
    }

    get id(): string {
        return this.ownId;
    }

    set id(value: string) {
        this.ownId = value;
    }

    /**
     * What the box holds. A dropdown is the one element that refuses what it is given: the browser
     * takes a value only when an option carries it and falls back to nothing otherwise, which is
     * why a pick put back before the options exist is lost.
     */
    get value(): string {
        return this.ownValue;
    }

    set value(next: string) {
        if (this.tagName !== 'SELECT') {
            this.ownValue = next;
            return;
        }
        this.ownValue = this.children.some((child) => child.tagName === 'OPTION' && child.value === next) ? next : '';
    }

    get className(): string {
        return [...this.classNames()].join(' ');
    }

    set className(value: string) {
        this.classList.replaceAll(value);
    }

    get textContent(): string {
        return this.ownText + this.children.map((child) => child.textContent).join('');
    }

    set textContent(value: string) {
        this.ownText = value;
        this.children.length = 0;
    }

    get childElementCount(): number {
        return this.children.length;
    }

    get parentElement(): StubElement | null {
        return this.parentNode;
    }

    appendChild(child: StubElement): StubElement {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    removeChild(child: StubElement): StubElement {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        return child;
    }

    remove(): void {
        if (this.parentNode) this.parentNode.removeChild(this);
    }

    setAttribute(name: string, value: string): void {
        if (name === 'id') this.id = value;
        else this.dataset[name] = value;
    }

    getAttribute(name: string): string | null {
        if (name === 'id') return this.id;
        return this.dataset[name.replace(/^data-/, '')] ?? null;
    }

    addEventListener(name: string, handler: (event: unknown) => void): void {
        const existing = this.listeners.get(name);
        if (existing) existing.push(handler);
        else this.listeners.set(name, [handler]);
    }

    focus(): void {}

    select(): void {}

    getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
        return { left: 0, top: 0, width: 80, height: 20 };
    }

    /** Every descendant of this node, itself excluded, in document order. */
    descendants(): StubElement[] {
        const found: StubElement[] = [];
        for (const child of this.children) {
            found.push(child, ...child.descendants());
        }
        return found;
    }

    querySelectorAll(selector: string): StubElement[] {
        return this.descendants().filter((node) => node.matchesChain(selector));
    }

    querySelector(selector: string): StubElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    /** Fires the listeners registered for an event name, in registration order. */
    dispatch(name: string, event: Record<string, unknown> = {}): void {
        const handlers = this.listeners.get(name);
        if (!handlers) return;
        const payload = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
        for (const handler of handlers.slice()) handler(payload);
    }

    /** The class names this node carries, read back out of the list. */
    private classNames(): string[] {
        const names: string[] = [];
        for (const name of ['sticky', 'last-sticky', 'row', 'check', 'path', 'name', 'full', 'count', 'text']) {
            if (this.classList.contains(name)) names.push(name);
        }
        return names;
    }

    /** Whether this node matches one compound selector: a tag, a class, or an attribute. */
    private matchesOne(selector: string): boolean {
        for (const part of selector.split(/(?=[.[])/)) {
            if (part.startsWith('.')) {
                if (!this.classList.contains(part.slice(1))) return false;
            } else if (part.startsWith('[')) {
                const name = part.slice(1, -1).replace(/^data-/, '');
                if (this.dataset[name] === undefined) return false;
            } else if (part && this.tagName !== part.toUpperCase()) return false;
        }
        return true;
    }

    /** Whether this node matches a descendant chain, the only combinator the page writes. */
    private matchesChain(selector: string): boolean {
        const steps = selector.trim().split(/\s+/);
        if (!this.matchesOne(steps[steps.length - 1])) return false;
        let node: StubElement | null = this.parentNode;
        for (let index = steps.length - 2; index >= 0; index--) {
            while (node && !node.matchesOne(steps[index])) node = node.parentNode;
            if (!node) return false;
            node = node.parentNode;
        }
        return true;
    }
}

/** A row of the table payload, as little of one as a test has to write out. */
export interface TableRow {
    readonly key: string;
    readonly id: string;
    readonly source?: string;
    readonly cells?: Record<string, { text: string; value: number | null }>;
    readonly [more: string]: unknown;
}

/** What a test hands the page as a table, filled out around the rows it cares about. */
export interface TablePayload {
    readonly rows: readonly TableRow[];
    readonly categories?: readonly string[];
    readonly componentTypes?: readonly string[];
    readonly sources?: readonly string[];
    readonly columns?: readonly { path: string; label?: string; rows?: number }[];
    readonly [more: string]: unknown;
}

/** Everything a loaded page exposes to a test. */
export interface TableHarness {
    /** Every message the page posted to its host, cloned at post time. */
    readonly posted: Array<Record<string, unknown>>;
    /** The last message of a type, or undefined when the page posted none. */
    last(type: string): Record<string, unknown> | undefined;
    /** Delivers any host message and lets the page settle. */
    post(message: Record<string, unknown>): Promise<void>;
    /** Delivers a table, filled out around the rows the test wrote. */
    table(payload: TablePayload): Promise<void>;
    /** The element behind an id in the page's markup. */
    byId(id: string): StubElement;
    /** Picks a value in one of the three narrowing dropdowns, the way a click on it does. */
    pick(id: string, value: string): Promise<void>;
    /** Types a value over a cell, the way a double click and an Enter do. */
    typeCell(partId: string, column: string, text: string): Promise<void>;
    /** Presses the button that writes the typed values to the files. */
    apply(): Promise<void>;
    /** Opens a saved view through the panel that lists them, the way a click on its name does. */
    openView(name: string): Promise<void>;
    /** The notice line the page is showing. */
    notice(): string;
    /** Forgets the messages recorded so far, so an assertion sees only what follows. */
    clear(): void;
}

/** The ids the page's markup carries, so the stub hands out the same elements the panel does. */
const PAGE_IDS = [
    'search',
    'category',
    'component',
    'source',
    'group',
    'tree',
    'toggle-tree',
    'reference',
    'reference-options',
    'percent',
    'legend',
    'per-tile',
    'apply-edits',
    'discard-edits',
    'status',
    'notice',
    'stage',
    'empty',
    'loading',
    'columns-panel',
    'column-search',
    'column-list',
    'formula-panel',
    'formula-name',
    'formula-text',
    'formula-error',
    'formula-examples',
    'formula-columns',
    'views-panel',
    'view-name',
    'view-list',
    'pick-columns',
    'columns-apply',
    'columns-close',
    'add-formula',
    'formula-apply',
    'formula-close',
    'clear-formulas',
    'refresh',
    'pick-views',
    'views-close',
    'view-save',
    'export-excel',
];

/**
 * Loads the part table page under the DOM stub.
 *
 * @returns the harness for driving the loaded page.
 */
export function loadTableWebview(): TableHarness {
    const registry = new Map<string, StubElement>();
    for (const id of PAGE_IDS) {
        const element = new StubElement(SELECT_IDS.has(id) ? 'select' : 'div');
        element.id = id;
        registry.set(id, element);
    }
    // The spinner holds the line that says what is being waited on, which the page reaches for by
    // class rather than by id.
    const spinnerText = new StubElement('span');
    spinnerText.className = 'text';
    registry.get('loading')!.appendChild(spinnerText);
    // Each switch sits in the label that explains it, which is where the page hangs its tooltip.
    for (const id of ['percent', 'per-tile']) new StubElement('label').appendChild(registry.get(id)!);

    const posted: Array<Record<string, unknown>> = [];
    const windowListeners = new Map<string, Array<(event: unknown) => void>>();

    const documentStub = {
        getElementById: (id: string) => registry.get(id) ?? null,
        createElement: (tag: string) => new StubElement(tag),
        createTextNode: (text: string) => {
            const node = new StubElement('#text');
            node.textContent = text;
            return node;
        },
        createDocumentFragment: () => new StubElement('#fragment'),
        documentElement: new StubElement('html'),
        addEventListener: () => {},
    };

    const windowStub = {
        addEventListener: (name: string, handler: (event: unknown) => void) => {
            const existing = windowListeners.get(name);
            if (existing) existing.push(handler);
            else windowListeners.set(name, [handler]);
        },
        cosmoteerStrings: {},
    };

    const sandbox: Record<string, unknown> = {
        console,
        acquireVsCodeApi: () => ({
            postMessage: (message: Record<string, unknown>) => {
                posted.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>);
            },
            getState: () => undefined,
            setState: () => {},
        }),
        document: documentStub,
        window: windowStub,
        setTimeout,
        clearTimeout,
    };

    compiled ??= new Script(readFileSync(SOURCE_PATH, 'utf8'), { filename: 'part-table.js' });
    compiled.runInNewContext(sandbox);

    const fireWindow = (name: string, event: Record<string, unknown>) => {
        const handlers = windowListeners.get(name);
        if (!handlers) return;
        for (const handler of handlers.slice()) handler({ preventDefault() {}, stopPropagation() {}, ...event });
    };

    const flush = async () => {
        for (let round = 0; round < 4; round++) await new Promise((done) => setImmediate(done));
    };

    const byId = (id: string): StubElement => {
        const element = registry.get(id);
        if (!element) throw new Error(`the page's markup has no element called ${id}`);
        return element;
    };

    /** The cell of a drawn row, found the way a reader finds one: by the part's id and the column. */
    const cellOf = (partId: string, column: string): StubElement => {
        const drawn = byId('stage')
            .querySelectorAll('tr')
            .find((row) => row.children.some((cell) => cell.dataset.key === 'id' && cell.textContent === partId));
        const found = drawn?.children.find((cell) => cell.dataset.key === column);
        if (!found) throw new Error(`the table is showing no ${column} cell for ${partId}`);
        return found;
    };

    return {
        posted,
        last(type: string) {
            return [...posted].reverse().find((message) => message.type === type);
        },
        async post(message: Record<string, unknown>) {
            fireWindow('message', { data: message });
            await flush();
        },
        async table(payload: TablePayload) {
            const columns =
                payload.columns ??
                [...new Set(payload.rows.flatMap((row) => Object.keys(row.cells ?? {})))].map((path) => ({
                    path,
                    label: path,
                    rows: payload.rows.length,
                }));
            await this.post({
                type: 'table',
                table: {
                    rows: payload.rows.map((row) => ({
                        source: 'Cosmoteer',
                        name: row.id,
                        file: `${row.id}.rules`,
                        uri: `file:///c%3A/game/${row.id}.rules`,
                        line: 0,
                        character: 0,
                        origin: 'game',
                        categories: [],
                        components: [],
                        editorGroup: '',
                        editorGroups: [],
                        ships: [],
                        cells: {},
                        ...row,
                    })),
                    columns,
                    columnsVersion: 'v1',
                    total: payload.rows.length,
                    categories: payload.categories ?? [],
                    componentTypes: payload.componentTypes ?? [],
                    sources: payload.sources ?? [],
                    editorGroups: [],
                    ships: [],
                    mod: '',
                    suggested: columns.map((column) => column.path),
                    truncated: false,
                },
            });
        },
        byId,
        async pick(id: string, value: string) {
            const select = byId(id);
            select.value = value;
            select.dispatch('change');
            await flush();
        },
        async typeCell(partId: string, column: string, text: string) {
            const cell = cellOf(partId, column);
            cell.dispatch('dblclick');
            await flush();
            const input = cell.children.find((child) => child.tagName === 'INPUT');
            if (!input) throw new Error(`the cell ${column} of ${partId} did not open a box to type in`);
            input.value = text;
            input.dispatch('keydown', { key: 'Enter' });
            await flush();
        },
        async apply() {
            byId('apply-edits').dispatch('click');
            await flush();
        },
        async openView(name: string) {
            byId('pick-views').dispatch('click');
            await flush();
            const entry = byId('view-list')
                .descendants()
                .find((node) => node.tagName === 'BUTTON' && node.textContent === name);
            if (!entry) throw new Error(`the views panel is listing no view called ${name}`);
            entry.dispatch('click');
            await flush();
        },
        notice: () => byId('notice').textContent,
        clear() {
            posted.length = 0;
        },
    };
}
