import { CancellationToken, CancellationTokenSource, TextDocumentPositionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNode, AbstractNodeDocument } from '../../core/ast/ast';
import { countReadersOf } from '../../features/part-editor/reference-writeback';
import { uriToFsPath } from '../../workspace/workspace-files';
import { buildShaderPreview } from '../../features/shader/shader-preview.service';
import { buildPartGridData } from '../../features/part-editor/part-grid-data.service';
import { buildPartGridEdit } from '../../features/part-editor/grid-edit.service';
import { PartGridEditParams } from '../../features/part-editor/part-grid.types';
import { generatePartWiringReport } from '../../features/part-editor/part-wiring.service';
import { generateModOverview } from '../../features/mod-report/mod-overview';
import { buildResourceFlowDiagram } from '../../features/part-editor/resource-flow.diagram';
import { buildEffectChainDiagram } from '../../features/part-editor/effect-chain.diagram';
import { ScanFinding, ScanFindings } from '../../features/mod-report/mod-health';
import { generateBaseDiffReport } from '../../features/effective-group/base-diff.report';
import { generateEffectiveGroupReport } from '../../features/effective-group/effective-group.report';
import { generateReferenceTraceReport } from '../../features/navigation/explain-reference/reference-trace.report';
import { generateShipBlueprintReport } from '../../features/ships/ship-blueprint.report';
import {
    SchemaSearchParams,
    resolveSchemaSearchContext,
    schemaSearchDetail,
    searchSchema,
} from '../../features/schema-search/schema-search';
import {
    buildPartTable,
    invalidatePartTable,
    onPartTableChange,
    onPartTableProgress,
} from '../../features/part-table/part-table.service';
import { buildPartTableEdit } from '../../features/part-table/part-table.edit';
import { evaluateFormula } from '../../features/part-table/part-table.formula';
import { buildPartTableWorkbook } from '../../features/part-table/part-table.workbook';
import {
    PartTableEditParams,
    PartTableEditResult,
    PartTableFormulaParams,
    PartTableParams,
    PartTableProgress,
    PartTableRow,
    PartTableWorkbookModel,
    PartTableWorkbookResult,
} from '../../features/part-table/part-table.types';
import { normalizeUri } from '../../document/reference-location';
import { modRootsUnder } from '../../features/refactor/register-part/ship-registry';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { findModRoot } from '../../mod/mod-root';
import { shipLayerContext } from '../ship-layers';
import { perfReset, perfSnapshot } from '../../utils/perf-counters';
import { globalSettings } from '../../settings';
import { traceFailure } from '../../utils/cancellation';
import { connection, documents } from '../context';
import { ensureFragmentRooting } from '../fragment-rooting';
import { ensureParserResult, openBufferReadOverride } from '../open-documents';
import { searchFolderUris } from '../workspace-folders';
import { currentScanCacheEntries } from '../workspace-scan';
import { COSMOTEER_METHOD } from '../../../../shared/lsp-methods';

/** How long a reader count may take before the write is answered without one. */
const READER_COUNT_BUDGET_MS = 500;

/**
 * The rows of the last part table built, which the formula requests are computed over. Held here
 * rather than rebuilt per formula: the rows are the expensive half and the formula does not change
 * them.
 */
let lastPartTableRows: readonly PartTableRow[] = [];

/** Answers one position request from the parsed document, the open buffer and the position. */
type PositionBuilder = (
    parserResult: AbstractNodeDocument,
    document: TextDocument,
    params: TextDocumentPositionParams,
    cancellationToken: CancellationToken
) => Promise<unknown>;

/**
 * Every request answered for the open document at a position, as a table of the request name and
 * the builder that answers it. {@link onPositionRequest} wraps each one, so the rooting, the
 * missing-document answer and the failure answer are written once rather than per request.
 */
const POSITION_REQUESTS: readonly (readonly [string, PositionBuilder])[] = [
    // Live shader preview: build the payload (translated GLSL, constants, texture, blend mode) for the
    // material at a position, consumed by the client's WebGL preview webview. The preview reads the
    // shader chain from any open editor buffer instead of disk, so editing a `.shader` updates it
    // live before the file is saved.
    [
        COSMOTEER_METHOD.shaderPreview,
        (parserResult, document, params, cancellationToken) =>
            buildShaderPreview(
                parserResult,
                document.getText(),
                document.offsetAt(params.position),
                cancellationToken,
                openBufferReadOverride()
            ),
    ],
    // Part grid editor: build the payload (effective size, sprites, per-cell field layers, rotation
    // fields) for the part at a position, consumed by the client's interactive grid editor webview.
    [
        COSMOTEER_METHOD.partGridData,
        (parserResult, document, params, cancellationToken) =>
            buildPartGridData(parserResult, document.offsetAt(params.position), document.version, cancellationToken),
    ],
    // Resource flow diagram: the drawn resource wiring of the part at a position.
    [
        COSMOTEER_METHOD.resourceFlowDiagram,
        (parserResult, document, params, cancellationToken) =>
            buildResourceFlowDiagram(parserResult, document.offsetAt(params.position), cancellationToken),
    ],
    // Effect chain diagram: what the part at a position fires, in what order, and what each link waits.
    [
        COSMOTEER_METHOD.effectChainDiagram,
        (parserResult, document, params, cancellationToken) =>
            buildEffectChainDiagram(parserResult, document.offsetAt(params.position), cancellationToken),
    ],
    // Part wiring: render the "what does this part still need" markdown report for the part at a
    // position, the four rows of registration on a ship, build palette placement, game mode offerings
    // and language files. On demand only, it must never join validation or the workspace scan.
    [
        COSMOTEER_METHOD.partWiring,
        async (parserResult, document, params, cancellationToken) =>
            generatePartWiringReport(
                parserResult,
                document.offsetAt(params.position),
                await searchFolderUris(),
                cancellationToken
            ),
    ],
    // Effective group: render the "what the game actually loads here" report for the container at a
    // position, its whole inheritance chain folded into one member set with the provenance of each row.
    // On demand only, since the fold crosses files.
    [
        COSMOTEER_METHOD.effectiveGroup,
        (parserResult, document, params, cancellationToken) =>
            generateEffectiveGroupReport(parserResult, document.offsetAt(params.position), cancellationToken),
    ],
    // Base diff: render what the group at a position loads differently from the nearest base of it the
    // game ships itself. On demand only, since it folds two chains.
    [
        COSMOTEER_METHOD.baseDiff,
        (parserResult, document, params, cancellationToken) =>
            generateBaseDiffReport(parserResult, document.offsetAt(params.position), cancellationToken),
    ],
    // Reference trace: explain one reference path hop by hop, which segment stopped it, where the last
    // one that worked landed, and what the game really has at that place. On demand only, since the walk
    // crosses files.
    [
        COSMOTEER_METHOD.explainReference,
        (parserResult, _document, params, cancellationToken) =>
            generateReferenceTraceReport(parserResult, params.position, cancellationToken),
    ],
];

/**
 * How many places other than the declaration itself read the value a grid write landed in, so the
 * editor can say that moving one handle moved every one of them.
 *
 * The search sweeps the project, which a drag cannot wait on indefinitely, so it runs against a
 * budget and the note is written without a count when it does not finish. The number is
 * informational, and a missing one costs nothing but a shorter sentence. The budget cancels the
 * sweep rather than only stopping the wait for it, so a drag held down does not leave a project
 * walk running behind every gesture.
 *
 * @param declaration the declaration the write landed in.
 * @param uri the file it is written in.
 * @param token cancels the search with the request.
 * @returns the reader count, or null when it was not available in time.
 */
const countDeclarationReaders = async (
    declaration: AbstractNode,
    uri: string,
    token: CancellationToken
): Promise<number | null> => {
    const source = new CancellationTokenSource();
    const withRequest = token.onCancellationRequested(() => source.cancel());
    const search = countReadersOf(declaration, uri, await searchFolderUris(), source.token);
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            source.cancel();
            resolve(null);
        }, READER_COUNT_BUDGET_MS);
    });
    try {
        return await Promise.race([search.catch(() => null), budget]);
    } finally {
        if (timer) clearTimeout(timer);
        withRequest.dispose();
        source.dispose();
    }
};

/**
 * What the workspace scan already found, in the shape the mod overview's health table reads. Only
 * results computed under the state the session is in right now are offered, which is the same gate
 * the persisted cache is written behind.
 *
 * A file whose findings the editor cut at the problem limit is left out: its list stops short of
 * what the file really holds, and a row counting it would report fewer findings than there are. The
 * report reads such a file itself.
 *
 * @returns the findings per file, or undefined when nothing has been scanned yet.
 */
const scanFindings = (): ScanFindings | undefined => {
    const entries = currentScanCacheEntries();
    if (entries.length === 0) return undefined;
    const limit = globalSettings.maxNumberOfProblems;
    const findings = new Map<string, ScanFinding[]>();
    for (const [path, , , diagnostics] of entries) {
        if (diagnostics.length >= limit) continue;
        findings.set(
            path,
            diagnostics
                .filter((diagnostic) => typeof diagnostic.code === 'string')
                .map((diagnostic) => ({ code: String(diagnostic.code), line: diagnostic.range.start.line + 1 }))
        );
    }
    return findings;
};

/**
 * Registers a request answered for the open document at a position. Every one of these resolves
 * references, schema classes or action-rooted fragments, so the rooting indexes are brought current
 * before the builder runs (a standalone fragment reached only through an `&<includes>` field or a
 * manifest action would otherwise have no class). A document the server does not hold, a builder
 * that answers nothing and a failure all answer null.
 *
 * @param method the request name.
 * @param build answers the request from the parsed document, the open buffer and the position.
 */
const onPositionRequest = <T>(
    method: string,
    build: (
        parserResult: AbstractNodeDocument,
        document: TextDocument,
        params: TextDocumentPositionParams,
        cancellationToken: CancellationToken
    ) => Promise<T | null | undefined>
): void => {
    // The connection is told the answer is `unknown` rather than `T`. Its own result type folds a
    // conditional over whatever it is given, which an unresolved `T` leaves unreduced and so
    // assignable to nothing, and what travels the wire is JSON either way. The answer `build` owes
    // is still `T`.
    connection.onRequest<unknown, void>(
        method,
        async (params: TextDocumentPositionParams, cancellationToken: CancellationToken): Promise<T | null> => {
            const parserResult = ensureParserResult(params.textDocument.uri);
            const document = documents.get(params.textDocument.uri);
            if (!parserResult || !document) return null;
            try {
                await ensureFragmentRooting(cancellationToken);
                return (await build(parserResult, document, params, cancellationToken)) ?? null;
            } catch (e) {
                traceFailure(e);
                return null;
            }
        }
    );
};

/**
 * Turns one part grid editor mutation into a minimal WorkspaceEdit. The client applies the edit,
 * which keeps undo native, and the resulting change event re-renders the webview.
 *
 * A version mismatch means the click was aimed at stale geometry, so it is refused and the client
 * resyncs instead.
 *
 * @param params the mutation, the anchor it was aimed at and the data version it was drawn from.
 * @param cancellationToken cancels the build with the request.
 * @returns the edit, or the status that says why there is none.
 */
const handlePartGridEdit = async (params: PartGridEditParams, cancellationToken: CancellationToken) => {
    const parserResult = ensureParserResult(params.textDocument.uri);
    const document = documents.get(params.textDocument.uri);
    if (!parserResult || !document) return { status: 'notFound' };
    if (params.dataVersion !== document.version) return { status: 'stale' };
    try {
        await ensureFragmentRooting(cancellationToken);
        const openText = openBufferReadOverride();
        return await buildPartGridEdit(
            parserResult,
            document.getText(),
            params.textDocument.uri,
            document.offsetAt(params.anchor),
            params.mutation,
            cancellationToken,
            {
                openText: (uri) => openText(uriToFsPath(uri)),
                countReaders: countDeclarationReaders,
            }
        );
    } catch (e) {
        traceFailure(e);
        return { status: 'error' };
    }
};

/**
 * Renders the "what does this mod.rules do" markdown report: the manifest header, every action with
 * its resolution status, and the reachability section listing dead files.
 *
 * Action targets resolve against the effective game tree, so the workspace and the fragment indexes
 * have to be ready, exactly as for validation of the manifest itself.
 *
 * @param params the manifest the report is about.
 * @param cancellationToken cancels the report with the request.
 * @returns the report, or null when there is none.
 */
const handleModOverview = async (params: { textDocument: { uri: string } }, cancellationToken: CancellationToken) => {
    try {
        await ensureFragmentRooting(cancellationToken);
        return (
            (await generateModOverview(
                params.textDocument.uri,
                await searchFolderUris(),
                cancellationToken,
                scanFindings()
            )) ?? null
        );
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Reads what a `.ship.png` places out of the low bits of the picture, and judges every part id it
 * names the way the reference validator judges one.
 *
 * @param params the blueprint the report is about.
 * @param cancellationToken cancels the report with the request.
 * @returns the report, or null when there is none.
 */
const handleShipBlueprint = async (params: { textDocument: { uri: string } }, cancellationToken: CancellationToken) => {
    try {
        return (
            (await generateShipBlueprintReport(
                uriToFsPath(params.textDocument.uri),
                await searchFolderUris(),
                cancellationToken
            )) ?? null
        );
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Ranks every schema type, field, enum member and Type= registry, plus the field documentation,
 * against a query.
 *
 * Pure in-memory work over the schema, so it never waits on the workspace. Only the optional caret,
 * sent once when the picker opens, needs the fragment index, which is why the position does not ride
 * along on every keystroke.
 *
 * @param params the query and the optional caret the picker opened at.
 * @param cancellationToken cancels the context resolution with the request.
 * @returns the ranked results, or null when the search failed.
 */
const handleSchemaSearch = async (params: SchemaSearchParams, cancellationToken: CancellationToken) => {
    try {
        let contextClass: string | undefined;
        const target = params.textDocument;
        if (target && params.position) {
            const parserResult = ensureParserResult(target.uri);
            const document = documents.get(target.uri);
            if (parserResult && document) {
                await ensureFragmentRooting(cancellationToken);
                contextClass = await resolveSchemaSearchContext(
                    parserResult,
                    document.offsetAt(params.position),
                    cancellationToken
                );
            }
        }
        return searchSchema(params, contextClass);
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * The documentation page of one search hit, fetched only for the hit the user opened. Shipping it
 * with every result would cost hundreds of kilobytes per keystroke, which is the same split
 * completion already makes between its list and its resolve.
 *
 * @param params the hit that was opened.
 * @returns the documentation page, or null when there is none.
 */
const handleSchemaSearchDetail = (params: { id: string }) => {
    try {
        return schemaSearchDetail(params.id) ?? null;
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * The editor's own parse of a file, for the part table to read a part the way the reader sees it.
 *
 * @param fsPath the file the table is about to read.
 * @returns the parsed open buffer, or undefined when no editor holds the file and the table reads
 * the disk instead.
 */
const openPartDocument = (fsPath: string) => {
    const wanted = normalizeUri(fsPath);
    const open = documents.all().find((document) => normalizeUri(document.uri) === wanted);
    return open ? ensureParserResult(open.uri) : undefined;
};

/**
 * The mod the table reads when no document says which: the one mod the workspace holds. A table
 * opened from the command palette with no editor active is still about the mod the workspace is open
 * on, and a workspace holding several mods names none of them.
 *
 * @param folderPaths the workspace folders to look in.
 * @returns the one mod root, or undefined when there is not exactly one.
 */
const workspaceModRoot = (folderPaths: readonly string[]): string | undefined => {
    const roots = new Set<string>();
    for (const folder of folderPaths) for (const root of modRootsUnder(folder)) roots.add(root);
    return roots.size === 1 ? [...roots][0] : undefined;
};

/**
 * Every part of the game and of the mod being edited, with every member path they carry resolved to
 * the number the game computes, for the comparison view.
 *
 * A part gathers its components and its stats from other files, and a mod rewrites them through
 * manifest actions, so the rooting indexes have to be current before the walk.
 *
 * @param params the columns, the filter and the document the table was opened from.
 * @param cancellationToken cancels the walk with the request.
 * @returns the table, or null when the walk failed.
 */
const handlePartTable = async (params: PartTableParams | null, cancellationToken: CancellationToken) => {
    try {
        await ensureFragmentRooting(cancellationToken);
        const uri = params?.textDocument?.uri;
        if (params?.refresh) invalidatePartTable();
        const context = await shipLayerContext();
        const table = await buildPartTable(
            {
                context,
                modRoot: (uri ? findModRoot(uri) : null) ?? workspaceModRoot(context.folderPaths),
                openDocument: openPartDocument,
            },
            params?.columns,
            params?.filter,
            cancellationToken,
            params?.columnsVersion
        );
        lastPartTableRows = table.rows;
        return table;
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * One formula column of the part table, computed over the table the last build produced. The rows
 * are not rebuilt for it: a formula is written a character at a time, and re-reading the whole
 * project per keystroke would make the column unusable.
 *
 * @param params the formula, the row it is anchored to and the values typed over the cells.
 * @returns the computed values, or the error to show in the column header.
 */
const handlePartTableFormula = (params: PartTableFormulaParams) => {
    try {
        const rows = lastPartTableRows;
        const reference = params.reference ? rows.find((row) => row.key === params.reference) : undefined;
        return evaluateFormula(params.formula, rows, reference, {
            formulas: params.formulas,
            visible: params.rows,
            overrides: params.overrides,
        });
    } catch (e) {
        traceFailure(e);
        return { values: {}, error: 'The formula cannot be read.' };
    }
};

/**
 * A value typed over a cell of the part table, written into the file it belongs in. The edit is
 * built here and applied by the client, so it lands in the editor with its undo.
 *
 * @param params the row, the column and the text that was typed.
 * @returns the edit, or the status that says why there is none.
 */
const handlePartTableEdit = async (params: PartTableEditParams): Promise<PartTableEditResult> => {
    try {
        const openText = openBufferReadOverride();
        return await buildPartTableEdit(params.row, params.column, params.text, {
            openText: (uri) => openText(uriToFsPath(uri)),
            dataRootPath: CosmoteerWorkspaceService.instance.dataRootPath,
        });
    } catch (e) {
        traceFailure(e);
        return { status: 'notFound', message: 'The table has to be read again before it can be edited.' };
    }
};

/**
 * The part table as a workbook, built out of what the view is showing rather than out of a fresh
 * walk, so the file holds the rows, columns and typed-over values the reader was looking at. The
 * client writes the bytes to the file the reader picks.
 *
 * @param params the rows, columns and typed-over values the view is showing.
 * @returns the workbook, or null when it cannot be built.
 */
const handlePartTableWorkbook = (params: PartTableWorkbookModel): PartTableWorkbookResult | null => {
    try {
        return buildPartTableWorkbook(params);
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Performance introspection for the scan bench (server/test/perf/scan-bench.mjs): the hot-path
 * counters, the peak heap sampled during workspace scans, and the current memory usage.
 *
 * @param params the optional reset, which lets the bench isolate a warm pass from the cold one that
 * preceded it.
 * @returns the counters and the memory usage as they were before any reset.
 */
const handlePerfStats = (params: { reset?: boolean } | null) => {
    const snapshot = { ...perfSnapshot(), memory: process.memoryUsage() };
    if (params?.reset) perfReset();
    return snapshot;
};

/**
 * Registers the `cosmoteer/*` requests: the webview payloads (shader preview, part grid editor),
 * the on-demand markdown reports, the schema search and the performance counters the benches read.
 * None of them is part of the language protocol, so both clients ask for them by name.
 */
export function register(): void {
    for (const [method, build] of POSITION_REQUESTS) onPositionRequest(method, build);

    connection.onRequest(COSMOTEER_METHOD.partGridEdit, handlePartGridEdit);
    connection.onRequest(COSMOTEER_METHOD.modOverview, handleModOverview);
    connection.onRequest(COSMOTEER_METHOD.shipBlueprint, handleShipBlueprint);
    connection.onRequest(COSMOTEER_METHOD.schemaSearch, handleSchemaSearch);
    connection.onRequest(COSMOTEER_METHOD.schemaSearchDetail, handleSchemaSearchDetail);
    connection.onRequest(COSMOTEER_METHOD.partTable, handlePartTable);
    connection.onRequest(COSMOTEER_METHOD.partTableFormula, handlePartTableFormula);
    connection.onRequest(COSMOTEER_METHOD.partTableEdit, handlePartTableEdit);
    connection.onRequest(COSMOTEER_METHOD.partTableWorkbook, handlePartTableWorkbook);
    connection.onRequest(COSMOTEER_METHOD.perfStats, handlePerfStats);

    // A file change that makes the last table stale is forwarded to the view, which asks for the
    // table again. The walk repairs only the parts the change touched, so a table open beside the
    // editor follows an edit as it is typed.
    onPartTableChange(() => {
        void connection.sendNotification(COSMOTEER_METHOD.partTableChanged, {});
    });

    // How far the walk has come, so the view can say which part it is reading while a large mod
    // takes its seconds.
    onPartTableProgress((done, total) => {
        const progress: PartTableProgress = { done, total };
        void connection.sendNotification(COSMOTEER_METHOD.partTableProgress, progress);
    });
}
