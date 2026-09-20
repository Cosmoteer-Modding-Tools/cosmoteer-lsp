// The tunable values of the diagram page: the box metrics, the zoom bounds, the arrow palette and
// the SVG namespace. They live here rather than beside their first use, so a value can be found and
// changed without reading the function that happens to read it first.

// The gap between two layers is where a forward arrow's words sit, so it is as wide as a short
// sentence such as "1 battery per 0.5 s".
export const BOX = { width: 190, height: 46, gapX: 130, gapY: 16 };
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;
// One colour per series of arrows: a resource in the flow view, a chain in the firing view. None
// of them is the warning red, the ones nearest a box border's colour come last, and all are
// mid-lightness so the same eight read on a light theme and on a dark one.
export const SERIES_COLOURS = ['#d18616', '#2aa198', '#e3699b', '#1f9fd0', '#8f9b2c', '#b07a4a', '#7d8fd6', '#b06be0'];

/** The SVG namespace every drawn element is created in. */
export const NS = 'http://www.w3.org/2000/svg';
