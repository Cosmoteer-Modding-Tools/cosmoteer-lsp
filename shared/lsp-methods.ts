/**
 * The method names of the requests and notifications the clients and the server speak on top of the
 * language protocol, in one place both sides read. A method name is only ever a string at runtime, so
 * a name that matches on one side and not the other is a request nobody answers and no error anywhere.
 * Importing the name from here turns that into a compile error.
 *
 * The file sits outside both source trees on purpose: it belongs to neither, and esbuild inlines it
 * into each bundle, so nothing new has to be shipped or resolved at runtime.
 */

/**
 * Every method the clients and the server speak by. The key is what the code names it by, the value
 * is what goes on the wire.
 */
export const COSMOTEER_METHOD = {
    /** The payload behind the live shader preview: translated shader, constants, textures, blending. */
    shaderPreview: 'cosmoteer/shaderPreview',
    /** The grid, sprites and per-cell field layers of the part the caret sits in. */
    partGridData: 'cosmoteer/partGridData',
    /** One mutation made in the grid editor, answered with the edit that writes it. */
    partGridEdit: 'cosmoteer/partGridEdit',
    /** The whole-mod overview report. */
    modOverview: 'cosmoteer/modOverview',
    /** The drawn resource wiring of the part the caret sits in. */
    resourceFlowDiagram: 'cosmoteer/resourceFlowDiagram',
    /** The drawn firing chain of the part the caret sits in. */
    effectChainDiagram: 'cosmoteer/effectChainDiagram',
    /** The "what does this part still need" report. */
    partWiring: 'cosmoteer/partWiring',
    /** The "what the game actually loads here" report for the container the caret sits in. */
    effectiveGroup: 'cosmoteer/effectiveGroup',
    /** What the group the caret sits in loads differently from the nearest base the game ships. */
    baseDiff: 'cosmoteer/baseDiff',
    /** One reference path explained hop by hop. */
    explainReference: 'cosmoteer/explainReference',
    /** What a saved ship places, read out of the picture. */
    shipBlueprint: 'cosmoteer/shipBlueprint',
    /** The schema browser search. */
    schemaSearch: 'cosmoteer/schemaSearch',
    /** One schema class in full, for the browser detail view. */
    schemaSearchDetail: 'cosmoteer/schemaSearchDetail',
    /** The rows of the part comparison table. */
    partTable: 'cosmoteer/partTable',
    /** One what-if formula evaluated over the table. */
    partTableFormula: 'cosmoteer/partTableFormula',
    /** One cell edited in the table, answered with the edit that writes it. */
    partTableEdit: 'cosmoteer/partTableEdit',
    /** The table as an Excel workbook. */
    partTableWorkbook: 'cosmoteer/partTableWorkbook',
    /** Server to client: a file change has made the open table stale. */
    partTableChanged: 'cosmoteer/partTableChanged',
    /** Server to client: how far the walk over the parts has come. */
    partTableProgress: 'cosmoteer/partTableProgress',
    /** Server to client: the game path is missing, so the settings page is worth opening. */
    openSettings: 'cosmoteer/openSettings',
    /** Server to client: a whole-workspace validation pass has finished. */
    workspaceValidated: 'cosmoteer/workspaceValidated',
    /** The server's own timing counters, for the perf benches. */
    perfStats: 'cosmoteer/perfStats',
} as const;
