import { Position, Range, WorkspaceEdit } from 'vscode-languageserver';

/**
 * The wire types shared by the part grid editor: the payload the `cosmoteer/partGridData` request
 * returns, the mutations the webview sends through `cosmoteer/partGridEdit`, and the edit result.
 * The client-side mirrors (VS Code panel, JetBrains service, webview JS) must stay shape-compatible
 * with these, they are the single protocol definition.
 */

/** Where a value was read from, for ghost rendering of inherited values and go-to-source. */
export interface AstProvenance {
    /** The file the node lives in (a base part's file when the value is inherited). */
    readonly uri: string;
    /** The node's anchor range in that file. */
    readonly range: Range;
    /** True when the value was resolved through inheritance rather than written locally. */
    readonly inherited: boolean;
}

/** An integer cell coordinate on the part grid, rotation-0 space. */
export interface GridCell {
    readonly x: number;
    readonly y: number;
}

/** A fractional position on the part grid in cell units, rotation-0 space. */
export interface GridPoint {
    readonly x: number;
    readonly y: number;
}

/**
 * One sprite composited under the grid (floor, walls, roof), placed in cell units. Placement
 * follows the game's quad construction: the sprite rectangle is centered on the graphics
 * component's `Location` shifted by the sprite offsets, so `offset` here is the pre-computed
 * top-left (`Location + DamageLevelSprites.Offset + AtlasSprite.Offset - Size / 2`).
 */
export interface SpriteLayerData {
    /** A stable identifier (`floor`, `walls`, `roof`, suffixed with the component name when several graphics components exist). */
    readonly id: string;
    /** The display label. */
    readonly label: string;
    /** The `file://` URI of the resolved image, or null when it did not resolve. The host inlines it as a data URI. */
    readonly uri: string | null;
    /** The sprite rectangle's top-left relative to grid cell (0,0), in cell units (sprites may overhang the grid). */
    readonly offset: readonly [number, number];
    /** The sprite rectangle's size in cell units, or null to fit the image to the part size. */
    readonly size: readonly [number, number] | null;
    /** Whether the layer starts visible (the roof defaults to hidden so the interior shows). */
    readonly defaultVisible: boolean;
}

/** The properties every grid layer carries, whatever its interaction kind. */
export interface GridLayerBase {
    /** A stable identifier, the field path joined with `/` (e.g. `Components/cannon/CrewDestinations`). */
    readonly id: string;
    /** The display label (the field name, suffixed with the component name for component fields). */
    readonly label: string;
    /** The schema field name, e.g. `AllowedDoorLocations`. */
    readonly fieldName: string;
    /** The member names from the Part group down to the container that owns the field (empty for part-root fields). */
    readonly fieldPath: readonly string[];
    /** True when the field only exists on a base part (no local node, edits materialize an override). */
    readonly inherited: boolean;
    /** The field's own list/map node, or null when the field is absent both locally and via inheritance. */
    readonly origin: AstProvenance | null;
    /** The sidebar section the layer sorts into (`Part`, `Colliders`, `Resources`, ...). */
    readonly group: string;
}

/** A set of cells (`AllowedDoorLocations`, `BlockedTravelCells`), toggled by clicking cells. */
export interface CellSetLayerData extends GridLayerBase {
    readonly kind: 'cellSet';
    /**
     * Where the game reads the cells: `inside` the part rect (blocked travel cells), `outside` it
     * (allowed door locations name the adjacent outside cells), or `any`. The webview highlights the
     * valid click region accordingly.
     */
    readonly domain: 'inside' | 'outside' | 'any';
    /**
     * The origin the authored cells are relative to, when not the part's own top-left. Resource
     * grid `DisableCells` are 0-based within `GridRect`, so their layer carries that rect's
     * location here. The webview renders at `cell + baseCell` and mutations stay grid-local.
     */
    readonly baseCell?: GridCell;
    readonly cells: ReadonlyArray<{ readonly cell: GridCell; readonly origin: AstProvenance }>;
}

/**
 * A cell-to-enum-values map (`BlockedTravelCellDirections`, `*WallsByCell`), authored in the rules
 * as a list of `{ Key = [x, y]; Value = [...] }` entries.
 */
export interface CellToValuesLayerData extends GridLayerBase {
    readonly kind: 'cellToValues';
    /** How the values are picked: `flags` renders the AdjacencyFlags edge/corner rosette, `enumList` per-value toggles. */
    readonly valueModel: 'flags' | 'enumList';
    /** The enum's C# FullName. */
    readonly enumRef: string;
    /** The enum's member names, from the schema. */
    readonly enumNames: readonly string[];
    /** The effective whole-part scalar fallback (`ExternalWalls` for `ExternalWallsByCell`), or null. */
    readonly fallback: readonly string[] | null;
    readonly entries: ReadonlyArray<{
        readonly cell: GridCell;
        readonly values: readonly string[];
        readonly origin: AstProvenance;
    }>;
}

/** A list of fractional points (`CrewDestinations`), placed and dragged with sub-cell precision. */
export interface PointListLayerData extends GridLayerBase {
    readonly kind: 'pointList';
    /**
     * When set, the list's elements are groups and each point is that member of its element
     * (`ResourceLevels [ { Offset = [x, y] } ]`). Such lists are move-only: adding or removing
     * entries would change what the surrounding group means.
     */
    readonly entryMember?: string;
    /** True when points may only be moved, not added or removed. */
    readonly fixedCount?: boolean;
    readonly points: ReadonlyArray<{ readonly point: GridPoint; readonly origin: AstProvenance }>;
}

/** A single optional fractional point (`PickUpLocation`, `EnterExitPoint`, toggle button offsets). */
export interface PointLayerData extends GridLayerBase {
    readonly kind: 'point';
    readonly point: GridPoint | null;
}

/** A single optional cell (`ProxyRules.PartLocation`, `AdjacentCell`, `NewPartLocation`). */
export interface CellLayerData extends GridLayerBase {
    readonly kind: 'cell';
    readonly cell: GridCell | null;
}

/** A cell with an orthogonal facing (`NetworkPort` Location + Direction). */
export interface CellDirectionLayerData extends GridLayerBase {
    readonly kind: 'cellDirection';
    readonly cell: GridCell | null;
    readonly direction: string | null;
    /** The direction enum's member names. */
    readonly directions: readonly string[];
}

/** A cell ray (`TileLine`: start cell, orthogonal direction, tile count). */
export interface CellRayLayerData extends GridLayerBase {
    readonly kind: 'cellRay';
    readonly cell: GridCell | null;
    readonly direction: string | null;
    readonly maxTiles: number | null;
    readonly directions: readonly string[];
}

/** A polygon (`PolygonCollider.Vertices`, root `CustomCollider`), vertices in tile units. */
export interface PolygonLayerData extends GridLayerBase {
    readonly kind: 'polygon';
    readonly vertices: ReadonlyArray<{
        readonly point: GridPoint;
        readonly origin: AstProvenance;
        /** True when the vertex is written as references or math (evaluated for display, not draggable). */
        readonly isRef?: boolean;
    }>;
}

/** A circle (`BuffCenter` + `BuffRadius`, `CircleCollider.Radius`): fractional center plus a radius in tiles. */
export interface CircleLayerData extends GridLayerBase {
    readonly kind: 'circle';
    readonly center: GridPoint | null;
    readonly radius: number | null;
    /** The sibling field the radius is written to. */
    readonly radiusField: string;
    /** False when the center comes from the component's `Location` (moved via the gizmo, not here). */
    readonly centerEditable: boolean;
}

/** A tagged rect list (`ProhibitRects`: `[category, [x, y, w, h]]` tuple rows). */
export interface RectListLayerData extends GridLayerBase {
    readonly kind: 'rectList';
    readonly entries: ReadonlyArray<{
        readonly tag: string | null;
        readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
        readonly origin: AstProvenance;
    }>;
    /** The effective scalar sugar fields (`ProhibitLeft` etc.) rendered as ghost rects. */
    readonly fallbackRects: ReadonlyArray<{
        readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
        readonly label: string;
    }>;
}

/** One entry of the aggregated component gizmo layer. */
export interface ComponentPointEntry {
    /** The component's member path under `Components` (usually just its name). */
    readonly component: string;
    readonly label: string;
    /** The component's `Type` discriminator, for grouping and icons. */
    readonly typeName: string | null;
    /** The resolved rules-relative position (chain transform applied), or null when unreadable. */
    readonly location: GridPoint | null;
    /** The component's own rotation in degrees, or null when unset or unreadable. */
    readonly rotationDeg: number | null;
    /** The `ChainedTo` target when the transform rides another component. */
    readonly chainedTo: string | null;
    /** True when `Location` is a reference or expression, so dragging is disabled. */
    readonly locationIsRef: boolean;
    readonly origin: AstProvenance | null;
}

/** Every chainable component's Location/Rotation in one gizmo layer. */
export interface ComponentPointsLayerData extends GridLayerBase {
    readonly kind: 'componentPoints';
    readonly entries: readonly ComponentPointEntry[];
}

/** A list of external/internal cell pairs (`VirtualInternalCells`), authored by two-click pairing. */
export interface CellPairListLayerData extends GridLayerBase {
    readonly kind: 'cellPairList';
    readonly pairs: ReadonlyArray<{
        readonly external: GridCell;
        readonly internal: GridCell;
        readonly origin: AstProvenance;
    }>;
}

/** A single rectangle (`PhysicalRect`, `GridRect`, `IdleRect`), dragged by its handles. */
export interface RectLayerData extends GridLayerBase {
    readonly kind: 'rect';
    /** True when the rect takes fractional coordinates (`IdleRect`, `UITileRect`). */
    readonly fractional?: boolean;
    readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
}

/**
 * The discriminated layer union the webview dispatches on. New per-cell field kinds extend this
 * union (and the webview gains a renderer/interaction for the new `kind`), nothing else changes.
 */
export type GridLayerData =
    | CellSetLayerData
    | CellToValuesLayerData
    | PointListLayerData
    | PointLayerData
    | CellLayerData
    | CellDirectionLayerData
    | CellRayLayerData
    | PolygonLayerData
    | CircleLayerData
    | RectListLayerData
    | ComponentPointsLayerData
    | CellPairListLayerData
    | RectLayerData;

/** A boolean rotation field's effective value with its provenance (null when unset everywhere). */
export interface RotationBoolData {
    readonly value: boolean | null;
    readonly origin: AstProvenance | null;
}

/** An int-list rotation field's effective values with provenance, or null when absent. */
export interface RotationIntListData {
    readonly values: readonly number[];
    readonly origin: AstProvenance;
}

/** The part's rotation and flip capabilities, editable from the sidebar. */
export interface RotationFieldData {
    readonly isRotateable: RotationBoolData;
    readonly isFlippable: RotationBoolData;
    readonly flipHRotate: RotationIntListData | null;
    readonly flipVRotate: RotationIntListData | null;
    readonly selectionTypeRotations: RotationIntListData | null;
}

/** The payload of `cosmoteer/partGridData`, everything the grid editor webview renders. */
export interface PartGridData {
    /** The part's display name (the root group identifier, or the file stem). */
    readonly partName: string;
    /** The part document's version when this payload was built, echoed by edits for stale detection. */
    readonly dataVersion: number;
    /** The position of the Part group's identifier, echoed by edits so the server can re-locate the group. */
    readonly anchor: Position;
    /** The effective grid dimensions in cells. */
    readonly size: {
        readonly width: number;
        readonly height: number;
        readonly origin: AstProvenance | null;
    };
    /** Extra cells rendered around the grid, grown to fit out-of-bounds entries (virtual cells, rects). */
    readonly margin: number;
    readonly sprites: readonly SpriteLayerData[];
    readonly layers: readonly GridLayerData[];
    readonly rotation: RotationFieldData;
    /** The part's `AllowedContiguity` flags (which neighbor sides count as connected), for the sidebar. */
    readonly contiguity: {
        readonly values: readonly string[] | null;
        readonly enumNames: readonly string[];
        readonly origin: AstProvenance | null;
    };
}

/** One user gesture in the webview, translated by the server into a minimal WorkspaceEdit. */
export type GridMutation =
    | { readonly op: 'addCell'; readonly layerId: string; readonly cell: GridCell }
    | { readonly op: 'removeCell'; readonly layerId: string; readonly cell: GridCell }
    /** Sets a map entry's values, an empty array removes the entry. */
    | { readonly op: 'setEntryValues'; readonly layerId: string; readonly cell: GridCell; readonly values: readonly string[] }
    | { readonly op: 'addPoint'; readonly layerId: string; readonly point: GridPoint }
    | { readonly op: 'movePoint'; readonly layerId: string; readonly index: number; readonly point: GridPoint }
    | { readonly op: 'removePoint'; readonly layerId: string; readonly index: number }
    /** Sets a cell pair, a null index appends a new pair. */
    | {
          readonly op: 'setPair';
          readonly layerId: string;
          readonly index: number | null;
          readonly external: GridCell;
          readonly internal: GridCell;
      }
    | { readonly op: 'removePair'; readonly layerId: string; readonly index: number }
    /** Sets the rect layer's rectangle, null removes the local field. */
    | {
          readonly op: 'setRect';
          readonly layerId: string;
          readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
      }
    | { readonly op: 'setSize'; readonly size: { readonly width: number; readonly height: number } }
    /** Sets a boolean part-root field, null removes the local assignment (the undo of a first write). */
    | { readonly op: 'setBool'; readonly field: 'IsRotateable' | 'IsFlippable'; readonly value: boolean | null }
    /** Sets an int-list rotation field, null removes the local assignment. */
    | {
          readonly op: 'setIntList';
          readonly field: 'FlipHRotate' | 'FlipVRotate' | 'SelectionTypeRotations';
          readonly values: readonly number[] | null;
      }
    /** Sets a single-point layer's point, null removes the local field. */
    | { readonly op: 'setPoint'; readonly layerId: string; readonly point: GridPoint | null }
    /** Sets a single-cell layer's cell, null removes the local field. */
    | { readonly op: 'setCell'; readonly layerId: string; readonly cell: GridCell | null }
    /** Sets a cellDirection/cellRay layer's facing. */
    | { readonly op: 'setDirection'; readonly layerId: string; readonly direction: string }
    /** Sets a named numeric sibling of a layer (`MaxTiles`, `BuffRadius`), null removes it. */
    | { readonly op: 'setNumber'; readonly layerId: string; readonly field: string; readonly value: number | null }
    | { readonly op: 'moveVertex'; readonly layerId: string; readonly index: number; readonly point: GridPoint }
    /** Inserts a vertex before `index` (at the end when index equals the vertex count). */
    | { readonly op: 'insertVertex'; readonly layerId: string; readonly index: number; readonly point: GridPoint }
    | { readonly op: 'removeVertex'; readonly layerId: string; readonly index: number }
    /** Sets a tagged rect entry, a null index appends (`tag` falls back to the first entry's tag). */
    | {
          readonly op: 'setRectEntry';
          readonly layerId: string;
          readonly index: number | null;
          readonly tag: string | null;
          readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
      }
    | { readonly op: 'removeRectEntry'; readonly layerId: string; readonly index: number }
    /** Moves a component's own `Location` (rules-relative, chain transform already inverted by the webview). */
    | { readonly op: 'moveComponentLocation'; readonly component: string; readonly point: GridPoint }
    /** Sets a component's `Rotation` in degrees (written with the `d` suffix), null removes it. */
    | { readonly op: 'setComponentRotation'; readonly component: string; readonly degrees: number | null }
    /** Sets a part-root flags field (`AllowedContiguity`), null removes the local assignment. */
    | { readonly op: 'setFlags'; readonly field: string; readonly values: readonly string[] | null };

/** The parameters of `cosmoteer/partGridEdit`. */
export interface PartGridEditParams {
    readonly textDocument: { readonly uri: string };
    /** The `PartGridData.anchor` the webview state was built from. */
    readonly anchor: Position;
    /** The `PartGridData.dataVersion` the webview state was built from. */
    readonly dataVersion: number;
    readonly mutation: GridMutation;
}

/** The result of `cosmoteer/partGridEdit`. The host applies `edit` and lets the change event re-render. */
export interface PartGridEditResult {
    /** `stale` means the document changed since the payload was built and the click was dropped. */
    readonly status: 'ok' | 'stale' | 'notFound' | 'error';
    /** A localized message for a status toast, on non-ok results. */
    readonly message?: string;
    /** The edit to apply, present on `ok`. Its changes always target the part's own file. */
    readonly edit?: WorkspaceEdit;
}
