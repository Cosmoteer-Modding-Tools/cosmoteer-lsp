// Everything the page changes while it runs, gathered into one object. An ES module cannot write to
// a binding it imported, so the pan, the payload and the layout live as properties here and every
// reader and writer goes through `state`.

export const state = {
    /** The pan offset and the zoom the drawing group is transformed by. */
    view: { x: 0, y: 0, zoom: 1 },
    // Whether the view is still the one `fit` chose. A resize re-fits until the reader moves it
    // themselves, after which their own pan and zoom stand.
    untouched: true,
    /**
     * The payload being drawn.
     *
     * @type {any}
     */
    diagram: { nodes: [], edges: [], legend: [], notes: [] },
    /**
     * The laid-out boxes and the size of the drawing.
     *
     * @type {{boxes: Map<string, import('./layout.js').Box>, width: number, height: number}}
     */
    laid: { boxes: new Map(), width: 0, height: 0 },
    /**
     * Where the pointer grabbed the drawing, while a pan is under way.
     *
     * @type {{x: number, y: number} | null}
     */
    dragging: null,
};
