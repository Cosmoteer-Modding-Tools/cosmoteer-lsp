/**
 * The messages a diagram page posts back to the extension.
 *
 * One case per kind rather than one shape with every field optional, so the handler's branches
 * narrow and a kind the page starts sending without a branch here stops compiling.
 */
export type DiagramPanelMessage =
    /** The page has loaded and is ready for its payload. */
    | { type: 'ready' }
    /** A click on a node, asking the editor to open where it is written. */
    | { type: 'openLocation'; uri?: string; range?: unknown };
