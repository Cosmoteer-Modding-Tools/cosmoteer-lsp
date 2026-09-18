import {
    CallHierarchyIncomingCallsParams,
    CallHierarchyOutgoingCallsParams,
    CallHierarchyPrepareParams,
    CancellationToken,
    DocumentHighlightParams,
    DocumentLink,
    DocumentLinkParams,
    DocumentSymbolParams,
    FoldingRangeParams,
    LSPErrorCodes,
    PrepareRenameParams,
    ReferenceParams,
    RenameParams,
    ResponseError,
    SelectionRangeParams,
    TextDocumentPositionParams,
    TypeHierarchyPrepareParams,
    TypeHierarchySubtypesParams,
    TypeHierarchySupertypesParams,
    WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import { getDefinition } from '../../features/navigation/definition.service';
import { computeDocumentLinks, resolveDocumentLink } from '../../features/navigation/document-links';
import { getDocumentSymbols } from '../../features/navigation/document-symbol.service';
import { computeFoldingRanges } from '../../features/structure/folding-range.service';
import { computeSelectionRanges } from '../../features/structure/selection-range.service';
import { prepareTypeHierarchy, subtypesOf, supertypesOf } from '../../features/structure/type-hierarchy.service';
import {
    incomingCallsOf,
    outgoingCallsOf,
    prepareCallHierarchy,
} from '../../features/structure/call-hierarchy.service';
import { findReferences } from '../../features/navigation/reference-index';
import { documentHighlightsAt } from '../../features/navigation/document-highlight';
import { WorkspaceSymbolService } from '../../features/navigation/workspace-symbol.service';
import {
    RenameRefusedError,
    prepareRename,
    refuseEditsUnderRoot,
    rename,
} from '../../features/navigation/rename.service';
import {
    shaderDocumentDefinition,
    shaderDocumentSymbols,
    shaderSymbolDefinition,
} from '../../features/shader/shader-document-features';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { isShaderDocument } from '../../document/document-kind';
import { globalSettings } from '../../settings';
import { traceFailure } from '../../utils/cancellation';
import { connection, documents } from '../context';
import { ensureFragmentRooting, workspaceReady } from '../fragment-rooting';
import { ensureLexResult, ensureParserResult, openBufferReadOverride } from '../open-documents';
import { searchFolderPaths, searchFolderUris, workspaceFolderUris } from '../workspace-folders';

/**
 * Go-to-definition: resolve the reference under the cursor to its target location.
 *
 * @param params the document and the position the cursor is at.
 * @param cancellationToken cancels the resolution with the request.
 * @returns the target location, or null when the position resolves to nothing.
 */
const handleDefinition = async (params: TextDocumentPositionParams, cancellationToken: CancellationToken) => {
    // `.shader` files: resolve an `#include "…"` under the cursor to the included file, or a `_uniform`
    // / function name to its declaration in this file or the include chain.
    if (isShaderDocument(params.textDocument.uri)) {
        const document = documents.get(params.textDocument.uri);
        if (!document) return null;
        const text = document.getText();
        const offset = document.offsetAt(params.position);
        const dataDir = CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath;
        const include = shaderDocumentDefinition(text, offset, params.textDocument.uri, dataDir);
        if (include) return include;
        return await shaderSymbolDefinition(text, offset, params.textDocument.uri, dataDir, openBufferReadOverride());
    }
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        await ensureFragmentRooting(cancellationToken);
        return await getDefinition(parserResult, params.position, cancellationToken, await searchFolderUris());
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Document links: underline every reference and asset in the file so they are visibly clickable
 * (Ctrl-click) without placing the cursor first. Ranges are computed from the cached AST here. Each
 * link's target is resolved lazily in onDocumentLinkResolve, so an unopened link costs nothing.
 *
 * @param params the document to underline the references of.
 * @returns the link ranges, or null when the document is not parsed.
 */
const handleDocumentLinks = (params: DocumentLinkParams) => {
    // `.shader` files have no `.rules` references. Their `#include` navigation is handled by definition.
    if (isShaderDocument(params.textDocument.uri)) return null;
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        return computeDocumentLinks(parserResult);
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Resolve a single link's target on demand, using the same resolution go-to-definition performs.
 *
 * @param link the link the editor is opening.
 * @param cancellationToken cancels the resolution with the request.
 * @returns the link with its target filled in, or the link unchanged.
 */
const handleDocumentLinkResolve = async (link: DocumentLink, cancellationToken: CancellationToken) => {
    const data = link.data as { uri: string; line: number; character: number } | undefined;
    if (!data) return link;
    const parserResult = ensureParserResult(data.uri);
    if (!parserResult) return link;
    try {
        await ensureFragmentRooting(cancellationToken);
        return await resolveDocumentLink(link, parserResult, await searchFolderUris(), cancellationToken);
    } catch (e) {
        traceFailure(e);
        return link;
    }
};

/**
 * Document outline: project the cached AST into a hierarchical symbol tree
 * (drives the breadcrumb bar + Outline view). Pure structural, no resolution.
 *
 * @param params the document to outline.
 * @param cancellationToken drops the answer when the request is already gone.
 * @returns the symbol tree, or null when the document is not parsed.
 */
const handleDocumentSymbol = (params: DocumentSymbolParams, cancellationToken: CancellationToken) => {
    // `.shader` files: outline the file's `_`-uniforms and functions from the HLSL scan.
    if (isShaderDocument(params.textDocument.uri)) {
        const document = documents.get(params.textDocument.uri);
        return document ? shaderDocumentSymbols(document.getText()) : null;
    }
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        if (cancellationToken.isCancellationRequested) return null;
        return getDocumentSymbols(parserResult);
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Folding: one region per `{ … }` / `[ … ]` body, plus the comment runs. Structural, no resolution.
 *
 * @param params the document to fold.
 * @param cancellationToken drops the answer when the request is already gone.
 * @returns the foldable regions, or null to leave the editor's own folding in place.
 */
const handleFoldingRanges = (params: FoldingRangeParams, cancellationToken: CancellationToken) => {
    // `.shader` files are HLSL, with no rules AST to fold. Answering `null` rather than an empty
    // list leaves the editor's own indentation folding in place instead of replacing it with nothing.
    if (isShaderDocument(params.textDocument.uri)) return null;
    const document = documents.get(params.textDocument.uri);
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!document || !parserResult) return null;
    try {
        if (cancellationToken.isCancellationRequested) return null;
        const { tokens, blockComments } = ensureLexResult(document);
        return computeFoldingRanges(document, parserResult, tokens, blockComments);
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Expand selection: the AST chain from the innermost node covering each caret out to the whole file.
 *
 * @param params the document and the carets to expand from.
 * @param cancellationToken drops the answer when the request is already gone.
 * @returns one chain per caret, or null when the document is not parsed.
 */
const handleSelectionRanges = (params: SelectionRangeParams, cancellationToken: CancellationToken) => {
    if (isShaderDocument(params.textDocument.uri)) return null;
    const document = documents.get(params.textDocument.uri);
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!document || !parserResult) return null;
    try {
        if (cancellationToken.isCancellationRequested) return null;
        return computeSelectionRanges(document, parserResult, params.positions);
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Type hierarchy: the inheritance graph of a `Foo : Bar` container. Up are the bases it writes plus
 * what a mod's `AddBase` appends, down is every container in the project naming it as a base. Only
 * the direct level per request, which is what keeps a chain like `Part` (177 vanilla files name it)
 * out of a single answer.
 *
 * @param params the document and the position the cursor is at.
 * @param cancellationToken drops the answer when the request is already gone.
 * @returns the item the hierarchy starts from, or null when the position is no container.
 */
const handleTypeHierarchyPrepare = async (params: TypeHierarchyPrepareParams, cancellationToken: CancellationToken) => {
    // `.shader` files are HLSL and carry no Object Text container to build a hierarchy from.
    if (isShaderDocument(params.textDocument.uri)) return null;
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        if (cancellationToken.isCancellationRequested) return null;
        return prepareTypeHierarchy(parserResult, params.position, await searchFolderPaths());
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * The bases the item writes, plus what a mod's `AddBase` appends, one level per request.
 *
 * @param params the item the editor is expanding.
 * @param cancellationToken cancels the walk with the request.
 * @returns the direct bases, or null when the walk failed.
 */
const handleSupertypes = async (params: TypeHierarchySupertypesParams, cancellationToken: CancellationToken) => {
    try {
        // Builds the indexes the resolution reads: the alias roots a `<…>` base resolves through and
        // the AddBase index holding the bases a mod appends.
        await ensureFragmentRooting(cancellationToken);
        return await supertypesOf(params.item, await searchFolderPaths(), cancellationToken);
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Every container in the project naming the item as a base, one level per request.
 *
 * @param params the item the editor is expanding.
 * @param cancellationToken cancels the scan with the request.
 * @returns the direct subtypes, or null when the request was cancelled or the scan failed.
 */
const handleSubtypes = async (params: TypeHierarchySubtypesParams, cancellationToken: CancellationToken) => {
    try {
        await ensureFragmentRooting(cancellationToken);
        const items = await subtypesOf(
            params.item,
            await searchFolderPaths(),
            cancellationToken,
            await connection.window.createWorkDoneProgress()
        );
        // The scan's own budget answers with a partial list when it runs long, which is the point.
        // A cancellation from the client is not that: the user moved on, so answer nothing.
        return cancellationToken.isCancellationRequested ? null : items;
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Call hierarchy: who reaches this declaration, and what it reaches in turn. Incoming folds the
 * three reference shapes (a plain reference, an included member, an inheritance base) into one
 * search, and adds the manifest actions that name the node as a target, which are written as
 * paths rather than references. One level per request, like the type hierarchy above.
 *
 * @param params the document and the position the cursor is at.
 * @param cancellationToken drops the answer when the request is already gone.
 * @returns the item the hierarchy starts from, or null when the position is no declaration.
 */
const handleCallHierarchyPrepare = async (params: CallHierarchyPrepareParams, cancellationToken: CancellationToken) => {
    // `.shader` files are HLSL and carry no Object Text declaration to build a hierarchy from.
    if (isShaderDocument(params.textDocument.uri)) return null;
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        if (cancellationToken.isCancellationRequested) return null;
        return prepareCallHierarchy(parserResult, params.position, await searchFolderPaths());
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Who reaches the declaration, one level per request.
 *
 * @param params the item the editor is expanding.
 * @param cancellationToken cancels the search with the request.
 * @returns the calls into the item, or null when the request was cancelled or the search failed.
 */
const handleIncomingCalls = async (params: CallHierarchyIncomingCallsParams, cancellationToken: CancellationToken) => {
    try {
        await ensureFragmentRooting(cancellationToken);
        const calls = await incomingCallsOf(params.item, await searchFolderPaths(), cancellationToken);
        return cancellationToken.isCancellationRequested ? null : calls;
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * What the declaration reaches in turn, one level per request.
 *
 * @param params the item the editor is expanding.
 * @param cancellationToken cancels the search with the request.
 * @returns the calls out of the item, or null when the request was cancelled or the search failed.
 */
const handleOutgoingCalls = async (params: CallHierarchyOutgoingCallsParams, cancellationToken: CancellationToken) => {
    try {
        await ensureFragmentRooting(cancellationToken);
        const calls = await outgoingCallsOf(params.item, await searchFolderPaths(), cancellationToken);
        return cancellationToken.isCancellationRequested ? null : calls;
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Find-all-references: the reverse of go-to-definition. Resolves the symbol under the
 * cursor, then searches the project (name-pre-filtered) for references resolving to it.
 *
 * @param params the document, the position and whether the declaration itself counts.
 * @param cancellationToken cancels the search with the request.
 * @returns every reference resolving to the symbol, or null when it resolves to nothing.
 */
const handleReferences = async (params: ReferenceParams, cancellationToken: CancellationToken) => {
    // `.shader` files are HLSL. Parsing one with the Object Text parser yields a nonsense AST, so
    // the reference scan would walk it for nothing.
    if (isShaderDocument(params.textDocument.uri)) return null;
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        await ensureFragmentRooting(cancellationToken);
        return await findReferences(
            parserResult,
            params.position,
            params.context?.includeDeclaration ?? true,
            await searchFolderUris(),
            cancellationToken,
            await connection.window.createWorkDoneProgress()
        );
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Occurrence highlighting: the same search find all references runs, narrowed to the open file, so
 * resting the caret on a name marks every place this file names the same thing. It answers on every
 * cursor move, so it never waits for the game scan, and a position it has no answer for answers null,
 * which is what leaves the editor's own word matching in place.
 *
 * @param params the document and the position the caret rests at.
 * @param cancellationToken cancels the search with the request.
 * @returns the occurrences in this file, or null to leave the editor's own word matching in place.
 */
const handleDocumentHighlight = async (params: DocumentHighlightParams, cancellationToken: CancellationToken) => {
    // `.shader` files are HLSL. Parsing one with the Object Text parser yields a nonsense AST, and a
    // word match over a shader is what the editor already does for free.
    if (isShaderDocument(params.textDocument.uri)) return null;
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        return await documentHighlightsAt(
            parserResult,
            params.position,
            workspaceReady,
            documents.get(params.textDocument.uri)?.version,
            cancellationToken
        );
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Workspace symbols: flat, project-wide name search ("Go to Symbol in Workspace").
 *
 * @param params the query the user typed.
 * @param cancellationToken cancels the search with the request.
 * @returns the matching symbols, or null when the search failed.
 */
const handleWorkspaceSymbol = async (params: WorkspaceSymbolParams, cancellationToken: CancellationToken) => {
    try {
        // Scoped to the open project (the mod), not the whole game tree. A project-wide
        // symbol table over all of Cosmoteer would be huge, and "go to symbol in workspace" is
        // about the files you're editing.
        const folderUris = await workspaceFolderUris();
        return await WorkspaceSymbolService.instance.getWorkspaceSymbols(params.query, folderUris, cancellationToken);
    } catch (e) {
        traceFailure(e);
        return null;
    }
};

/**
 * Rename: validate the symbol under the cursor, then rewrite its declaration and every
 * reference segment that resolves to it across the project.
 *
 * @param params the document and the position the cursor is at.
 * @param cancellationToken cancels the resolution with the request.
 * @returns the range being renamed, a refusal carrying the reason, or null.
 */
const handlePrepareRename = async (params: PrepareRenameParams, cancellationToken: CancellationToken) => {
    // Renaming inside a `.shader` is an HLSL rename, which the Object Text rename service cannot do.
    if (isShaderDocument(params.textDocument.uri)) return null;
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        return await prepareRename(parserResult, params.position, cancellationToken);
    } catch (e) {
        // A refusal carries the reason the rename cannot be done, so the editor shows that instead
        // of its own "this element cannot be renamed".
        if (e instanceof RenameRefusedError) return new ResponseError(LSPErrorCodes.RequestFailed, e.message);
        traceFailure(e);
        return null;
    }
};

/**
 * Rewrites the declaration under the cursor and every reference segment that resolves to it.
 *
 * @param params the document, the position and the name the symbol is being given.
 * @param cancellationToken cancels the search with the request.
 * @returns the edit, a refusal carrying the reason, or null when the rename failed.
 */
const handleRename = async (params: RenameParams, cancellationToken: CancellationToken) => {
    // Same as prepareRename: a `.shader` carries no Object Text symbol to rewrite.
    if (isShaderDocument(params.textDocument.uri)) return null;
    const parserResult = ensureParserResult(params.textDocument.uri);
    if (!parserResult) return null;
    try {
        const edit = await rename(
            parserResult,
            params.position,
            params.newName,
            await searchFolderUris(),
            cancellationToken,
            // The editor applies the edit to its own buffers, so a range in a file the author has
            // open has to be measured against the unsaved text rather than against what is on disk.
            openBufferReadOverride()
        );
        // Safety: rename searches the whole game tree but must never write to the read-only vanilla
        // install, and half a rename would leave the mod broken, so one that reaches the install is
        // refused. A developer working on the game data can opt into editing vanilla via the setting.
        if (!edit || globalSettings.allowEditingVanillaFiles) return edit;
        return refuseEditsUnderRoot(edit, CosmoteerWorkspaceService.instance.dataRootPath);
    } catch (e) {
        // A refusal carries the reason the rename cannot be done, which the author reads.
        if (e instanceof RenameRefusedError) return new ResponseError(LSPErrorCodes.RequestFailed, e.message);
        traceFailure(e);
        return null;
    }
};

/**
 * Registers the read-only navigation requests: go-to-definition, document links, the outline,
 * folding and selection ranges, the type hierarchy, find-all-references, occurrence highlighting,
 * workspace symbols and rename.
 */
export function register(): void {
    connection.onDefinition(handleDefinition);
    connection.onDocumentLinks(handleDocumentLinks);
    connection.onDocumentLinkResolve(handleDocumentLinkResolve);
    connection.onDocumentSymbol(handleDocumentSymbol);
    connection.onFoldingRanges(handleFoldingRanges);
    connection.onSelectionRanges(handleSelectionRanges);
    connection.languages.typeHierarchy.onPrepare(handleTypeHierarchyPrepare);
    connection.languages.typeHierarchy.onSupertypes(handleSupertypes);
    connection.languages.typeHierarchy.onSubtypes(handleSubtypes);
    connection.languages.callHierarchy.onPrepare(handleCallHierarchyPrepare);
    connection.languages.callHierarchy.onIncomingCalls(handleIncomingCalls);
    connection.languages.callHierarchy.onOutgoingCalls(handleOutgoingCalls);
    connection.onReferences(handleReferences);
    connection.onDocumentHighlight(handleDocumentHighlight);
    connection.onWorkspaceSymbol(handleWorkspaceSymbol);
    connection.onPrepareRename(handlePrepareRename);
    connection.onRenameRequest(handleRename);
}
