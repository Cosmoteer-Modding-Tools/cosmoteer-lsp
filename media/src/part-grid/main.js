// The part grid editor webview: renders a part's sprites split into the in-game cell grid and lets
// the user author per-cell fields (door locations, blocked travel cells, walls, crew destinations,
// virtual cells, rects) by clicking instead of typing coordinates. IDE-agnostic: VS Code provides
// acquireVsCodeApi natively, the JetBrains plugin shims it and replays host messages as
// MessageEvents after the page posts {type:'ready'}.
//
// This is the entry the bundle is built from. It stitches the layer-kind registry together out of
// the three halves the drawing, the clicking and the sidebar each own, starts the page when it is
// running in a webview, and exports the pure helpers the Node unit tests read out of the bundle.

import { initDom, vscode } from './dom.js';
import { initGestures } from './gestures.js';
import { initHost } from './host.js';
import { LAYER_HIT } from './hit-test.js';
import { LAYER_DRAW } from './layer-draw.js';
import { countOf, LAYER_KINDS, numberMemberOf, pointMemberOf } from './layer-kinds.js';
import { LAYER_PANEL } from './panels.js';
import {
    adjacencyAt,
    backingRatio,
    chainParentTransform,
    directionOffset,
    doorEdgeFor,
    edgeRegionDistanceAt,
    gridToStage,
    rotateDegrees,
    rotateQuarter,
    snapTo,
    stageToGrid,
} from './geometry.js';
import { inverseOf } from './undo.js';

// The registry is declared in three places because its three behaviours belong to three different
// parts of the page, and it is one object because a kind that lost one of them silently was the
// whole reason the registry exists. Stitching them here, in the entry nothing imports, is what
// keeps the drawing and the sidebar from having to import each other.
for (const [name, kind] of Object.entries(LAYER_KINDS)) {
    kind.draw = LAYER_DRAW[name];
    kind.hitTest = LAYER_HIT[name];
    kind.panel = LAYER_PANEL[name];
}

// A webview hands the page its host bridge, and a Node unit test that loads the bundle for the
// helpers below does not. Nothing above this line touches the document, so the page can be read
// without being started.
if (typeof acquireVsCodeApi !== 'undefined') startPage();

export {
    rotateQuarter,
    gridToStage,
    stageToGrid,
    snapTo,
    adjacencyAt,
    directionOffset,
    rotateDegrees,
    chainParentTransform,
    inverseOf,
    doorEdgeFor,
    edgeRegionDistanceAt,
    backingRatio,
    LAYER_KINDS,
    countOf,
    pointMemberOf,
    numberMemberOf,
};

/** Starts the page: the host bridge, the gestures, the host messages, and the first `ready`. */
function startPage() {
    initDom();
    initGestures();
    initHost();
    vscode.postMessage({ type: 'ready' });
}
