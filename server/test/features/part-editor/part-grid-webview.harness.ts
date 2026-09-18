import { createRequire } from 'module';
import { readFileSync } from 'fs';
import type { GridLayerData, GridMutation, PartGridData } from '../../../src/features/part-editor/part-grid.types';
import { mediaBundle } from '../../media-bundle';
import { Script } from 'vm';

/**
 * Loads the built part grid page into a Node vm under a hand-written DOM stub and drives it the
 * way a user does: render a payload, press the mouse on the canvas, click a sidebar button, and
 * read back the mutations the page posts to its host.
 *
 * The stub is deliberately small and hand-written rather than a DOM library. It only implements
 * what the page actually touches, so a page that starts reaching for something new fails loudly
 * here instead of passing against a simulated browser nobody reads.
 */

/**
 * The page under test. It is the built page, unless a sensitivity check points the suite at a
 * deliberately broken copy of it: that check patches the bundle in memory, writes the patched copy
 * outside the repository, and runs these tests against it to prove they fail. Nothing else sets
 * this, and the repository file is never written.
 */
const SOURCE_PATH = process.env.COSMOTEER_PART_GRID_PAGE || mediaBundle('part-grid-editor.js');

/** The page compiled once, so a test that loads a fresh copy pays only for running it. */
let compiled: Script | undefined;

/** The view state the page holds, mirrored here so a test can aim a click in a rotated view. */
interface ViewState {
    rotation: number;
    flipH: boolean;
    flipV: boolean;
}

/**
 * The page's own forward view transform, taken from the export the pure unit tests use. Aiming a
 * click with the page's own mapping keeps this harness from carrying a second copy of the transform
 * that could drift away from the one under test.
 */
const gridToStage = createRequire(__filename)(SOURCE_PATH).gridToStage as (
    x: number,
    y: number,
    view: ViewState,
    center: { x: number; y: number }
) => [number, number];

/**
 * Errors the page threw where nothing could catch them. It renders inside a promise continuation
 * (`loadSprites(...).then(draw)`), so a renderer that throws surfaces as an unhandled rejection
 * rather than out of the message handler. Collecting them here is what lets a test say the page
 * rendered, instead of only saying that delivering the message returned.
 */
const pageErrors: Error[] = [];
let watchingPageErrors = false;

/** Starts the one process-level rejection listener the harness needs, at most once. */
function watchPageErrors(): void {
    if (watchingPageErrors) return;
    watchingPageErrors = true;
    process.on('unhandledRejection', (reason) => {
        pageErrors.push(reason instanceof Error ? reason : new Error(String(reason)));
    });
}

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

/** The element registry a document stub hands out through `getElementById`. */
type ElementRegistry = Map<string, StubElement>;

/** A single DOM node: enough of an element for the page to build its sidebar out of. */
export class StubElement {
    readonly tagName: string;
    readonly children: StubElement[] = [];
    readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    readonly classList = new StubClassList();
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, unknown>;
    parentNode: StubElement | null = null;

    type = '';
    checked = false;
    indeterminate = false;
    disabled = false;
    value = '';
    placeholder = '';
    title = '';
    name = '';
    tabIndex = 0;
    hidden = false;
    open = false;
    width = 0;
    height = 0;
    clientWidth = 0;
    clientHeight = 0;

    /** Every canvas operation this element's 2D context recorded, in call order. */
    readonly drawing: DrawRecord[] = [];

    private context: unknown;
    private ownText = '';
    private ownId = '';
    private readonly registry: ElementRegistry;

    constructor(tagName: string, registry: ElementRegistry) {
        this.tagName = tagName.toUpperCase();
        this.registry = registry;
        this.style = {
            setProperty(name: string, value: unknown) {
                (this as Record<string, unknown>)[name] = value;
            },
            removeProperty(name: string) {
                delete (this as Record<string, unknown>)[name];
            },
            getPropertyValue(name: string) {
                return String((this as Record<string, unknown>)[name] ?? '');
            },
        };
    }

    get id(): string {
        return this.ownId;
    }

    set id(value: string) {
        this.ownId = value;
        this.registry.set(value, this);
    }

    get className(): string {
        return '';
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

    addEventListener(name: string, handler: (event: unknown) => void): void {
        const existing = this.listeners.get(name);
        if (existing) existing.push(handler);
        else this.listeners.set(name, [handler]);
    }

    focus(): void {}

    getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
        return {
            left: 0,
            top: 0,
            width: Number.parseFloat(String(this.style.width ?? '0')) || 0,
            height: Number.parseFloat(String(this.style.height ?? '0')) || 0,
        };
    }

    getContext(): unknown {
        this.context ??= recordingContext(this.drawing);
        return this.context;
    }

    /** Fires the listeners registered for an event name, in registration order. */
    dispatch(name: string, event: Record<string, unknown> = {}): void {
        const handlers = this.listeners.get(name);
        if (!handlers) return;
        const payload = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
        for (const handler of handlers.slice()) handler(payload);
    }
}

/** The drawing state a recorded canvas operation was made under. */
export interface DrawState {
    readonly fillStyle: string;
    readonly strokeStyle: string;
    readonly globalAlpha: number;
    readonly lineWidth: number;
    readonly font: string;
    /** The dash pattern in force, empty for a solid line. */
    readonly lineDash: readonly number[];
}

/** One recorded canvas operation: a call, or a property assignment when `set` is true. */
export interface DrawRecord {
    /** The position in the recording, so a test can pin the order two draws happened in. */
    readonly index: number;
    /** The method name, or the property name of an assignment. */
    readonly name: string;
    /** The call arguments, or the single assigned value. */
    readonly args: readonly unknown[];
    /** True for a property assignment, false for a method call. */
    readonly set: boolean;
    /** The state in force for this operation, the assignment itself included. */
    readonly state: DrawState;
}

/** The natural size an image loads with when the test named no outcome for its URI. */
const DEFAULT_IMAGE = { width: 64, height: 64 };

/** The state a fresh context starts in, matching a real canvas. */
const INITIAL_DRAW_STATE: DrawState = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    font: '10px sans-serif',
    lineDash: [],
};

/**
 * A 2D context that records every call and every property assignment, in order, each stamped with
 * the drawing state it happened under. The page only writes to the canvas and never reads a pixel
 * back, so the recording is the only thing a test can assert the picture from.
 *
 * `save` and `restore` push and pop the tracked state the way a real context does, so a record
 * taken after a `restore` carries the state that was restored rather than the one drawing left
 * behind.
 *
 * @param records the list to append the recording to.
 * @returns the context object to hand to the page.
 */
function recordingContext(records: DrawRecord[]): unknown {
    // One state object is shared by every record taken under it, so a recording of a large grid
    // stays small: only a property write allocates.
    let state: DrawState = INITIAL_DRAW_STATE;
    const stack: DrawState[] = [];
    const methods = new Map<string, (...args: unknown[]) => void>();
    const record = (name: string, args: unknown[], set: boolean) =>
        records.push({ index: records.length, name, args, set, state });
    return new Proxy(
        {},
        {
            get(_target, property) {
                if (typeof property !== 'string') return undefined;
                let method = methods.get(property);
                if (!method) {
                    method = (...args: unknown[]) => {
                        if (property === 'save') stack.push(state);
                        else if (property === 'restore') state = stack.pop() ?? state;
                        else if (property === 'setLineDash') {
                            state = { ...state, lineDash: ((args[0] as number[]) || []).slice() };
                        }
                        record(property, args, false);
                    };
                    methods.set(property, method);
                }
                return method;
            },
            set(_target, property, value) {
                if (typeof property !== 'string') return true;
                if (property in state) state = { ...state, [property]: value };
                record(property, [value], true);
                return true;
            },
        }
    );
}

/** What an image load does: the natural size it resolves with, or null to fail the load. */
export type ImageOutcome = { readonly width: number; readonly height: number } | null;

/** The parts of the environment a test can change before the page loads. */
export interface GridWebviewOptions {
    /**
     * The size the stage panel reports, which is what the fit-to-panel zoom measures itself
     * against. Left out, the stage reports nothing and the page opens at its default zoom, which
     * is what the gesture tests aim their clicks at.
     */
    readonly stage?: { readonly width: number; readonly height: number };
    /** The display pixel ratio the page sees. */
    readonly devicePixelRatio?: number;
    /** What loading each sprite URI does, by the URI the page sets as the image source. */
    readonly images?: Readonly<Record<string, ImageOutcome>>;
}

/** Everything a loaded page exposes to a test. */
export interface GridHarness {
    /** Every message the page posted to its host, cloned at post time. */
    readonly posted: Array<Record<string, unknown>>;
    /** The mutations out of those messages, in the order the page sent them. */
    readonly mutations: GridMutation[];
    /** The most recent mutation, or undefined when the page sent none. */
    lastMutation(): GridMutation | undefined;
    /** The page's current status line text. */
    status(): string;
    /** The sidebar root, for the few assertions that have no mutation to look at. */
    readonly sidebar: StubElement;
    /**
     * Delivers a `render` message and waits for the page to finish rendering.
     *
     * @param data the payload to render.
     * @param spriteData the sprite image URIs by sprite id, as the host inlines them.
     */
    render(data: PartGridData, spriteData?: Record<string, string>): Promise<void>;
    /** Every canvas operation the page has made, oldest first. */
    drawCalls(): DrawRecord[];
    /** The operations of the most recent draw pass, which starts at the page's `clearRect`. */
    frame(): DrawRecord[];
    /** The calls of one name in the most recent draw pass, assignments excluded. */
    calls(name: string): DrawRecord[];
    /** Forgets the recording so far, so an assertion sees only what the next draw produces. */
    clearDrawing(): void;
    /** The zoom the page settled on, read back out of the canvas size it asked for. */
    scale(): number;
    /** The canvas size in CSS pixels and the backing store the page allocated for it. */
    canvasMetrics(): { cssWidth: number; cssHeight: number; pixelWidth: number; pixelHeight: number };
    /** Delivers any host message and waits for the page to settle. */
    post(message: Record<string, unknown>): Promise<void>;
    /** Forgets the messages recorded so far, so an assertion sees only what follows. */
    clear(): void;
    /** Presses the mouse at a grid point (button 0 left, 2 right). */
    mouseDown(x: number, y: number, button?: number): void;
    /** Moves the mouse to a grid point. */
    mouseMove(x: number, y: number): void;
    /** Releases the mouse. */
    mouseUp(): void;
    /** A press and release at one grid point, with no movement in between. */
    click(x: number, y: number, button?: number): Promise<void>;
    /** A press, one move, and a release: the gesture every handle drag is made of. */
    drag(from: [number, number], to: [number, number]): Promise<void>;
    /** Sends a keydown to the window, for the undo and redo shortcuts. */
    keyDown(init: Record<string, unknown>): Promise<void>;
    /** Turns the view a quarter-turn clockwise through the sidebar button. */
    rotateView(): Promise<void>;
    /** Mirrors the view horizontally through the sidebar button. */
    flipViewH(): Promise<void>;
    /** Waits until every queued edit has been acknowledged and sent. */
    settle(): Promise<void>;
    /** The sidebar section holding the active layer's panel. */
    layerPanel(): StubElement;
    /** The sidebar section whose heading starts with the given text. */
    section(heading: string): StubElement;
    /** The legend row of a layer, found by its label. */
    layerRow(label: string): StubElement;
    /** Makes a layer the edited one through its sidebar radio, the way a click does. */
    activateLayer(label: string): Promise<void>;
    /** Every button with the given text, inside a subtree (the whole sidebar by default). */
    buttons(label: string, within?: StubElement): StubElement[];
    /** Clicks the one button with the given text inside a subtree. */
    clickButton(label: string, within?: StubElement): Promise<void>;
    /** The one text input inside a subtree, for the panels that take a typed value. */
    input(within: StubElement): StubElement;
    /** Every descendant of a subtree, the subtree root included. */
    descendants(root: StubElement): StubElement[];
}

/**
 * Loads the webview page under the DOM stub.
 *
 * @param options the parts of the environment this test wants to change.
 * @returns the harness for driving the loaded page.
 */
export function loadGridWebview(options: GridWebviewOptions = {}): GridHarness {
    const registry: ElementRegistry = new Map();
    const create = (tag: string) => new StubElement(tag, registry);

    const canvas = create('canvas');
    canvas.id = 'grid';
    const statusEl = create('div');
    statusEl.id = 'status';
    const sidebar = create('div');
    sidebar.id = 'sidebar';
    // The panel the canvas sits in. A stage of no size is what a panel that has not been laid out
    // yet reports, and the page falls back to its default zoom for it.
    const stage = create('div');
    stage.id = 'stage';
    stage.clientWidth = options.stage ? options.stage.width : 0;
    stage.clientHeight = options.stage ? options.stage.height : 0;

    // The image loads the page has started and the harness has not delivered yet.
    const pendingImages: Array<() => void> = [];
    const windowListeners = new Map<string, Array<(event: unknown) => void>>();
    const posted: Array<Record<string, unknown>> = [];
    const pendingAcks: Array<Record<string, unknown>> = [];
    let data: PartGridData | null = null;

    const documentStub = {
        getElementById: (id: string) => registry.get(id) ?? null,
        createElement: (tag: string) => create(tag),
        documentElement: create('html'),
        addEventListener: () => {},
    };

    const windowStub = {
        addEventListener: (name: string, handler: (event: unknown) => void) => {
            const existing = windowListeners.get(name);
            if (existing) existing.push(handler);
            else windowListeners.set(name, [handler]);
        },
        devicePixelRatio: options.devicePixelRatio ?? 1,
        cosmoteerStrings: {},
    };

    /**
     * An image that loads the way a browser's does: setting the source starts the load and the
     * outcome arrives on a later turn, when the harness delivers what is in flight. A URI the test
     * declared as a failed load fires `error` instead, which is the path a broken data URI takes.
     */
    class StubImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 0;
        naturalHeight = 0;
        private uri = '';

        addEventListener(name: string, handler: () => void) {
            if (name === 'load') this.onload = handler;
            if (name === 'error') this.onerror = handler;
        }

        get src(): string {
            return this.uri;
        }

        set src(value: string) {
            this.uri = value;
            const outcome = options.images && value in options.images ? options.images[value] : DEFAULT_IMAGE;
            pendingImages.push(() => {
                if (!outcome) {
                    this.onerror?.();
                    return;
                }
                this.naturalWidth = outcome.width;
                this.naturalHeight = outcome.height;
                this.onload?.();
            });
        }
    }

    // The page narrows a click target with `instanceof` to keep the row click from stealing the
    // checkbox. A tag-name check is the honest stand-in for a constructor the stub has no instances of.
    const tagGuard = (tag: string) => ({
        [Symbol.hasInstance]: (value: unknown) => value instanceof StubElement && value.tagName === tag,
    });

    const sandbox: Record<string, unknown> = {
        // The page catches a failed render and reports it, rather than letting it escape as an
        // unhandled rejection that would leave a silently stale panel. That catch is the right
        // behaviour but it hides the failure from the rejection listener, so the error it logs is
        // collected here instead. Without this a renderer could throw on every payload and the
        // tests would still pass.
        console: {
            ...console,
            error: (...args: unknown[]) => {
                const first = args[0];
                pageErrors.push(first instanceof Error ? first : new Error(args.map(String).join(' ')));
            },
        },
        acquireVsCodeApi: () => ({
            postMessage: (message: Record<string, unknown>) => {
                const clone = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
                posted.push(clone);
                if (clone.type === 'edit') pendingAcks.push(clone);
            },
            getState: () => undefined,
            setState: () => {},
        }),
        document: documentStub,
        window: windowStub,
        getComputedStyle: () => ({ getPropertyValue: () => '#cccccc' }),
        Image: StubImage,
        HTMLInputElement: tagGuard('INPUT'),
        HTMLButtonElement: tagGuard('BUTTON'),
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(0), 0),
    };

    watchPageErrors();
    pageErrors.length = 0;
    compiled ??= new Script(readFileSync(SOURCE_PATH, 'utf8'), { filename: 'part-grid-editor.js' });
    compiled.runInNewContext(sandbox);

    const fireWindow = (name: string, event: Record<string, unknown>) => {
        const handlers = windowListeners.get(name);
        if (!handlers) return;
        const payload = { preventDefault() {}, stopPropagation() {}, ...event };
        for (const handler of handlers.slice()) handler(payload);
    };

    /**
     * Lets the page's promise chains run out, then reports anything it threw. Each round first
     * completes the image loads the page started: the page itself uses no timer, so delivering the
     * loads here keeps a render a deterministic drain rather than a race with the clock.
     */
    const flush = async () => {
        for (let round = 0; round < 4; round++) {
            for (const deliver of pendingImages.splice(0)) deliver();
            await new Promise((done) => setImmediate(done));
        }
        const failure = pageErrors.shift();
        if (failure) throw new Error(`the page threw while rendering: ${failure.message}`, { cause: failure });
    };

    const settle = async () => {
        for (let round = 0; round < 64 && pendingAcks.length; round++) {
            pendingAcks.shift();
            fireWindow('message', {
                data: { type: 'editDone', dataVersion: data ? data.dataVersion : 1 },
            });
            await flush();
        }
        await flush();
    };

    /** The view the page is showing, tracked as the harness clicks the view buttons. */
    const view: ViewState = { rotation: 0, flipH: false, flipV: false };

    /**
     * The client point that lands on a grid point. The scale comes back out of the canvas size the
     * page computed, so the mapping follows whatever zoom and rotation the page settled on rather
     * than assuming one.
     */
    const toClient = (x: number, y: number) => {
        if (!data) throw new Error('render a payload before driving the canvas');
        const bounds = canvas.getBoundingClientRect();
        const swapped = view.rotation === 90 || view.rotation === 270;
        const across = (swapped ? data.size.height : data.size.width) + 2 * data.margin;
        const scale = bounds.width / across;
        const center = { x: data.size.width / 2, y: data.size.height / 2 };
        const [sx, sy] = gridToStage(x, y, view, center);
        return { clientX: sx * scale + bounds.width / 2, clientY: sy * scale + bounds.height / 2 };
    };

    const descendants = (root: StubElement): StubElement[] => {
        const found: StubElement[] = [root];
        for (const child of root.children) found.push(...descendants(child));
        return found;
    };

    const buttons = (label: string, within?: StubElement) =>
        descendants(within ?? sidebar).filter((node) => node.tagName === 'BUTTON' && node.textContent === label);

    const harness: GridHarness = {
        posted,
        get mutations() {
            return posted
                .filter((message) => message.type === 'edit')
                .map((message) => message.mutation as GridMutation);
        },
        lastMutation() {
            return this.mutations[this.mutations.length - 1];
        },
        status: () => statusEl.textContent,
        sidebar,
        async render(payload: PartGridData, spriteData?: Record<string, string>) {
            data = payload;
            fireWindow('message', { data: { type: 'render', data: payload, spriteData } });
            await flush();
            await settle();
        },
        drawCalls: () => canvas.drawing,
        frame() {
            // A draw pass opens with the page clearing the canvas, so the last clear is where the
            // picture on screen begins.
            let start = 0;
            for (const entry of canvas.drawing) if (entry.name === 'clearRect') start = entry.index;
            return canvas.drawing.slice(start);
        },
        calls(name: string) {
            return this.frame().filter((entry) => entry.name === name && !entry.set);
        },
        clearDrawing() {
            canvas.drawing.length = 0;
        },
        scale() {
            if (!data) throw new Error('render a payload before reading the zoom');
            const swapped = view.rotation === 90 || view.rotation === 270;
            const across = (swapped ? data.size.height : data.size.width) + 2 * data.margin;
            return canvas.getBoundingClientRect().width / across;
        },
        canvasMetrics() {
            const bounds = canvas.getBoundingClientRect();
            return {
                cssWidth: bounds.width,
                cssHeight: bounds.height,
                pixelWidth: canvas.width,
                pixelHeight: canvas.height,
            };
        },
        async post(message: Record<string, unknown>) {
            fireWindow('message', { data: message });
            await flush();
        },
        clear() {
            posted.length = 0;
        },
        mouseDown(x, y, button = 0) {
            canvas.dispatch('mousedown', { button, ...toClient(x, y) });
        },
        mouseMove(x, y) {
            canvas.dispatch('mousemove', { button: 0, ...toClient(x, y) });
        },
        mouseUp() {
            fireWindow('mouseup', {});
        },
        async click(x, y, button = 0) {
            this.mouseDown(x, y, button);
            this.mouseUp();
            await settle();
        },
        async drag(from, to) {
            this.mouseDown(from[0], from[1]);
            this.mouseMove(to[0], to[1]);
            this.mouseUp();
            await settle();
        },
        async keyDown(init) {
            fireWindow('keydown', { ctrlKey: false, metaKey: false, shiftKey: false, ...init });
            await settle();
        },
        async rotateView() {
            await this.clickButton('⟳');
            view.rotation = (view.rotation + 90) % 360;
        },
        async flipViewH() {
            await this.clickButton('↔');
            view.flipH = !view.flipH;
        },
        settle,
        layerPanel() {
            const panel = sidebar.children.find((child) => child.classList.contains('layer-panel'));
            if (!panel) throw new Error('no layer panel is showing');
            return panel;
        },
        section(heading: string) {
            const found = sidebar.children.find((child) => {
                const title = child.children[0];
                return title && title.tagName === 'H3' && title.textContent.startsWith(heading);
            });
            if (!found) throw new Error(`no sidebar section headed ${heading}`);
            return found;
        },
        layerRow(label: string) {
            const rows = descendants(sidebar).filter(
                (node) =>
                    node.classList.contains('layer-row') &&
                    node.children.some((child) => child.classList.contains('grow') && child.textContent === label)
            );
            if (rows.length !== 1) throw new Error(`expected one legend row labelled ${label}, found ${rows.length}`);
            return rows[0];
        },
        async activateLayer(label: string) {
            const radio = this.layerRow(label).children.find(
                (child) => child.tagName === 'INPUT' && child.type === 'radio'
            );
            if (!radio) throw new Error(`the row labelled ${label} has no activation radio`);
            radio.checked = true;
            radio.dispatch('change');
            await settle();
        },
        buttons,
        async clickButton(label: string, within?: StubElement) {
            const found = buttons(label, within);
            if (found.length !== 1) throw new Error(`expected one button labelled ${label}, found ${found.length}`);
            found[0].dispatch('click');
            await settle();
        },
        input(within: StubElement) {
            const inputs = descendants(within).filter((node) => node.tagName === 'INPUT' && node.type === 'text');
            if (inputs.length !== 1) throw new Error(`expected one text input, found ${inputs.length}`);
            return inputs[0];
        },
        descendants,
    };
    return harness;
}

/** A provenance stamp for a value written locally in the part's own file. */
export const LOCAL_ORIGIN = {
    uri: 'file:///part.rules',
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
    inherited: false,
};

/** The properties every layer carries, so a test only writes the ones its kind cares about. */
export const LAYER_BASE = {
    fieldPath: [] as string[],
    inherited: false,
    origin: null,
    group: 'Part',
};

/** The AdjacencyFlags member names, as the schema hands them to the webview. */
export const ADJACENCY_NAMES = [
    'None',
    'Top',
    'Right',
    'Bottom',
    'Left',
    'TopLeft',
    'TopRight',
    'BottomRight',
    'BottomLeft',
    'Sides',
    'Corners',
    'All',
];

/** The TravelDirection member names. */
export const TRAVEL_NAMES = ['Up', 'Right', 'Down', 'Left'];

/**
 * Builds a payload of the shape the server sends, with the parts a test does not care about
 * filled in.
 *
 * @param layers the layers to render, the first one becomes the edited layer.
 * @param overrides the payload fields to replace.
 * @returns the payload to hand to `render`.
 */
export function partGrid(layers: GridLayerData[], overrides: Partial<PartGridData> = {}): PartGridData {
    return {
        partName: 'TestPart',
        dataVersion: 1,
        anchor: { line: 0, character: 0 },
        size: { width: 4, height: 4, origin: null },
        margin: 1,
        dependsOn: [],
        sprites: [],
        layers,
        rotation: {
            isRotateable: { value: null, origin: null },
            isFlippable: { value: null, origin: null },
            flipHRotate: null,
            flipVRotate: null,
            selectionTypeRotations: null,
        },
        contiguity: { values: null, enumNames: ADJACENCY_NAMES, origin: null },
        ...overrides,
    };
}
