// Everything the part grid editor tunes. It lives here rather than beside its first use, so a value
// can be found and changed without reading the function that happens to read it first.

// What a browser will hand out for one canvas backing store. Asking for more yields a canvas
// that draws nothing at all, which is what a dead zoom button on a large part really is.
export const MAX_CANVAS_DIMENSION = 8192;
export const MAX_CANVAS_AREA = 1 << 25;

// The zoom range the buttons step through, in canvas pixels per cell.
export const MIN_SCALE = 24;
export const DEFAULT_SCALE = 96;
export const MAX_SCALE = 384;

/** The most history entries kept, oldest dropped beyond it. */
export const HISTORY_LIMIT = 100;

/** The legend color of a layer, by the rules field it edits. */
export const LAYER_COLORS = {
    AllowedDoorLocations: '#4fc1ff',
    BlockedTravelCells: '#f14c4c',
    BlockedTravelCellDirections: '#ff8800',
    ExternalWallsByCell: '#73c991',
    InternalWallsByCell: '#c586c0',
    BlueprintExternalWallsByCell: '#2aa198',
    BlueprintInternalWallsByCell: '#b58900',
    VirtualInternalCells: '#dcdcaa',
    PhysicalRect: '#569cd6',
    SaveRect: '#9cdcfe',
    ProhibitRects: '#e06c75',
    GridRect: '#61afef',
    DisableCells: '#be5046',
    BuffArea: '#98c379',
    BuffCenter: '#98c379',
    Vertices: '#e5c07b',
    CustomCollider: '#e5c07b',
    Line: '#56b6c2',
    PartLocation: '#d19a66',
    AdjacentCell: '#d19a66',
    NewPartLocation: '#d19a66',
    PartNetworkOverlayMidpoint: '#61afef',
    ComponentLocations: '#ff79c6',
};

/** The fallback legend color of a layer whose field is not named above, by its kind. */
export const KIND_COLORS = {
    pointList: '#ffd700',
    point: '#7ec699',
    cell: '#d19a66',
    cellDirection: '#61afef',
    cellRay: '#56b6c2',
    polygon: '#e5c07b',
    circle: '#98c379',
    edgeRegion: '#c678dd',
    rectList: '#e06c75',
    componentPoints: '#ff79c6',
};

/** The sidebar order of the layer groups. Unknown groups sort last. */
export const GROUP_ORDER = [
    'Part',
    'Components',
    'Colliders',
    'Networks',
    'Crew',
    'Resources',
    'Regions',
    'Logic',
    'Graphics',
];
