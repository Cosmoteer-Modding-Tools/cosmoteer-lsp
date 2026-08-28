import { CancellationToken, CancellationTokenSource, TextDocumentPositionParams } from 'vscode-languageserver/node';
import { AbstractNode } from '../../core/ast/ast';
import { countReadersOf } from '../../features/part-editor/reference-writeback';
import { uriToFsPath } from '../../features/navigation/workspace-files';
import { buildShaderPreview } from '../../features/shader/shader-preview.service';
import { buildPartGridData } from '../../features/part-editor/part-grid-data.service';
import { buildPartGridEdit } from '../../features/part-editor/grid-edit.service';
import { PartGridEditParams } from '../../features/part-editor/part-grid.types';
import { generatePartWiringReport } from '../../features/part-editor/part-wiring.service';
import { generateModOverview } from '../../mod/mod-overview';
import { ScanFinding, ScanFindings } from '../../mod/mod-health';
import { generateEffectiveGroupReport } from '../../features/effective-group/effective-group.report';
import { generateReferenceTraceReport } from '../../features/navigation/explain-reference/reference-trace.report';
import {
    SchemaSearchParams,
    resolveSchemaSearchContext,
    schemaSearchDetail,
    searchSchema,
} from '../../features/schema-search/schema-search';
import { perfReset, perfSnapshot } from '../../utils/perf-counters';
import { globalSettings } from '../../settings';
import { traceFailure } from '../../utils/cancellation';
import { connection, documents } from '../context';
import { ensureFragmentRooting } from '../fragment-rooting';
import { ensureParserResult, openBufferReadOverride } from '../open-documents';
import { searchFolderUris } from '../workspace-folders';
import { currentScanCacheEntries } from '../workspace-scan';

/** How long a reader count may take before the write is answered without one. */
const READER_COUNT_BUDGET_MS = 500;

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
 * Registers the `cosmoteer/*` requests: the webview payloads (shader preview, part grid editor),
 * the on-demand markdown reports, the schema search and the performance counters the benches read.
 * None of them is part of the language protocol, so both clients ask for them by name.
 */
export function register(): void {
    // Live shader preview: build the payload (translated GLSL, constants, texture, blend mode) for the
    // material at a position, consumed by the client's WebGL preview webview.
    connection.onRequest('cosmoteer/shaderPreview', async (params: TextDocumentPositionParams, cancellationToken) => {
        const parserResult = ensureParserResult(params.textDocument.uri);
        const document = documents.get(params.textDocument.uri);
        if (!parserResult || !document) return null;
        try {
            // Root a standalone fragment (a particle `_def.rules` included through a `Def = &<…>` field, say)
            // so its material's schema class resolves and the preview can find the shader to render.
            await ensureFragmentRooting(cancellationToken);
            // Let the preview read the shader chain from any open editor buffer instead of disk, so editing
            // a `.shader` updates the preview live before the file is saved.
            const readOverride = openBufferReadOverride();
            return await buildShaderPreview(
                parserResult,
                document.getText(),
                document.offsetAt(params.position),
                cancellationToken,
                readOverride
            );
        } catch (e) {
            traceFailure(e);
            return null;
        }
    });

    // Part grid editor: build the payload (effective size, sprites, per-cell field layers, rotation
    // fields) for the part at a position, consumed by the client's interactive grid editor webview.
    connection.onRequest('cosmoteer/partGridData', async (params: TextDocumentPositionParams, cancellationToken) => {
        const parserResult = ensureParserResult(params.textDocument.uri);
        const document = documents.get(params.textDocument.uri);
        if (!parserResult || !document) return null;
        try {
            // Root a standalone fragment first so the part group's schema class (and its components')
            // resolves even when the part file is only reachable through an `&<includes>` field.
            await ensureFragmentRooting(cancellationToken);
            return await buildPartGridData(
                parserResult,
                document.offsetAt(params.position),
                document.version,
                cancellationToken
            );
        } catch (e) {
            traceFailure(e);
            return null;
        }
    });

    // Part grid editor write-back: turn one webview mutation into a minimal WorkspaceEdit. The client
    // applies the edit (keeping undo native) and the resulting change event re-renders the webview. A
    // version mismatch means the click was aimed at stale geometry, so it is refused and the client
    // resyncs instead.
    connection.onRequest('cosmoteer/partGridEdit', async (params: PartGridEditParams, cancellationToken) => {
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
    });

    // Mod overview: render the "what does this mod.rules do" markdown report, the manifest header,
    // every action with its resolution status, and the reachability section listing dead files.
    connection.onRequest('cosmoteer/modOverview', async (params: { textDocument: { uri: string } }, cancellationToken) => {
        try {
            // Action targets resolve against the effective game tree, so the workspace and the fragment
            // indexes must be ready, exactly as for validation of the manifest itself.
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
    });

    // Part wiring: render the "what does this part still need" markdown report for the part at a
    // position, the four rows of registration on a ship, build palette placement, game mode offerings
    // and language files. On demand only, it must never join validation or the workspace scan.
    connection.onRequest('cosmoteer/partWiring', async (params: TextDocumentPositionParams, cancellationToken) => {
        const parserResult = ensureParserResult(params.textDocument.uri);
        const document = documents.get(params.textDocument.uri);
        if (!parserResult || !document) return null;
        try {
            // Every row resolves references, schema classes or action-rooted fragments, so the rooting
            // indexes have to be current before any probe runs.
            await ensureFragmentRooting(cancellationToken);
            return (
                (await generatePartWiringReport(
                    parserResult,
                    document.offsetAt(params.position),
                    await searchFolderUris(),
                    cancellationToken
                )) ?? null
            );
        } catch (e) {
            traceFailure(e);
            return null;
        }
    });

    // Effective group: render the "what the game actually loads here" report for the container at a
    // position, its whole inheritance chain folded into one member set with the provenance of each row.
    // On demand only, since the fold crosses files.
    connection.onRequest('cosmoteer/effectiveGroup', async (params: TextDocumentPositionParams, cancellationToken) => {
        const parserResult = ensureParserResult(params.textDocument.uri);
        const document = documents.get(params.textDocument.uri);
        if (!parserResult || !document) return null;
        try {
            // Bases reach into action-wired fragments and mod-injected members, so the rooting indexes
            // have to be current or the fold would report a chain the game does not have.
            await ensureFragmentRooting(cancellationToken);
            return (
                (await generateEffectiveGroupReport(parserResult, document.offsetAt(params.position), cancellationToken)) ??
                null
            );
        } catch (e) {
            traceFailure(e);
            return null;
        }
    });

    // Reference trace: explain one reference path hop by hop, which segment stopped it, where the last
    // one that worked landed, and what the game really has at that place. On demand only, since the walk
    // crosses files.
    connection.onRequest('cosmoteer/explainReference', async (params: TextDocumentPositionParams, cancellationToken) => {
        const parserResult = ensureParserResult(params.textDocument.uri);
        const document = documents.get(params.textDocument.uri);
        if (!parserResult || !document) return null;
        try {
            // The walk resolves through mod additions and action-wired fragments, so the rooting indexes
            // have to be current or a reference the game reads perfectly well would come back unresolved.
            await ensureFragmentRooting(cancellationToken);
            return (await generateReferenceTraceReport(parserResult, params.position, cancellationToken)) ?? null;
        } catch (e) {
            traceFailure(e);
            return null;
        }
    });

    // Schema search: rank every schema type, field, enum member and Type= registry, plus the field
    // documentation, against a query. Pure in-memory work over the schema, so it never waits on the
    // workspace. Only the optional caret (sent once, when the picker opens) needs the fragment index,
    // which is why the position does not ride along on every keystroke.
    connection.onRequest('cosmoteer/schemaSearch', async (params: SchemaSearchParams, cancellationToken) => {
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
    });

    // The documentation page of one search hit, fetched only for the hit the user opened: shipping it
    // with every result would cost hundreds of kilobytes per keystroke, which is the same split
    // completion already makes between its list and its resolve.
    connection.onRequest('cosmoteer/schemaSearchDetail', (params: { id: string }) => {
        try {
            return schemaSearchDetail(params.id) ?? null;
        } catch (e) {
            if (globalSettings.trace.server === 'messages') console.error(e);
            return null;
        }
    });

    // Performance introspection for the scan bench (server/test/perf/scan-bench.mjs): the hot-path
    // counters, the peak heap sampled during workspace scans, and the current memory usage. The
    // optional reset lets the bench isolate a warm pass from the cold one that preceded it.
    connection.onRequest('cosmoteer/perfStats', (params: { reset?: boolean } | null) => {
        const snapshot = { ...perfSnapshot(), memory: process.memoryUsage() };
        if (params?.reset) perfReset();
        return snapshot;
    });
}
