import { LSPErrorCodes, ResponseError, TextDocumentPositionParams } from 'vscode-languageserver/node';
import { DefinitionService } from '../../features/navigation/definition.service';
import { computeDocumentLinks, resolveDocumentLink } from '../../features/navigation/document-links';
import { DocumentSymbolService } from '../../features/navigation/document-symbol.service';
import { computeFoldingRanges } from '../../features/structure/folding-range.service';
import { computeSelectionRanges } from '../../features/structure/selection-range.service';
import { prepareTypeHierarchy, subtypesOf, supertypesOf } from '../../features/structure/type-hierarchy.service';
import { ReferenceIndex } from '../../features/navigation/reference-index';
import { documentHighlightsAt } from '../../features/navigation/document-highlight';
import { WorkspaceSymbolService } from '../../features/navigation/workspace-symbol.service';
import { RenameRefusedError, RenameService, dropEditsUnderRoot } from '../../features/navigation/rename.service';
import { shaderDocumentDefinition, shaderDocumentSymbols, shaderSymbolDefinition } from '../../features/shader/shader-document-features';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { isShaderDocument } from '../../document/document-kind';
import { globalSettings } from '../../settings';
import { CancellationError } from '../../utils/cancellation';
import { connection, documents } from '../context';
import { ensureFragmentRooting, workspaceReady } from '../fragment-rooting';
import { ensureLexResult, ensureParserResult, openBufferReadOverride } from '../open-documents';
import { getWorkspaceFoldersCached, searchFolderPaths, searchFolderUris } from '../workspace-folders';

/**
 * Registers the read-only navigation requests: go-to-definition, document links, the outline,
 * folding and selection ranges, the type hierarchy, find-all-references, occurrence highlighting,
 * workspace symbols and rename.
 */
export function register(): void {
    // Go-to-definition: resolve the reference under the cursor to its target location.
    connection.onDefinition(async (params: TextDocumentPositionParams, cancellationToken) => {
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
            return await DefinitionService.instance.getDefinition(
                parserResult,
                params.position,
                cancellationToken,
                await searchFolderUris()
            );
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    // Document links: underline every reference and asset in the file so they are visibly clickable
    // (Ctrl-click) without placing the cursor first. Ranges are computed from the cached AST here. Each
    // link's target is resolved lazily in onDocumentLinkResolve, so an unopened link costs nothing.
    connection.onDocumentLinks((params, cancellationToken) => {
        // `.shader` files have no `.rules` references. Their `#include` navigation is handled by definition.
        if (isShaderDocument(params.textDocument.uri)) return null;
        const parserResult = ensureParserResult(params.textDocument.uri);
        if (!parserResult) return null;
        try {
            return computeDocumentLinks(parserResult);
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    // Resolve a single link's target on demand, using the same resolution go-to-definition performs.
    connection.onDocumentLinkResolve(async (link, cancellationToken) => {
        const data = link.data as { uri: string; line: number; character: number } | undefined;
        if (!data) return link;
        const parserResult = ensureParserResult(data.uri);
        if (!parserResult) return link;
        try {
            await ensureFragmentRooting(cancellationToken);
            return await resolveDocumentLink(link, parserResult, await searchFolderUris(), cancellationToken);
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return link;
        }
    });

    // Document outline: project the cached AST into a hierarchical symbol tree
    // (drives the breadcrumb bar + Outline view). Pure structural, no resolution.
    connection.onDocumentSymbol((params, cancellationToken) => {
        // `.shader` files: outline the file's `_`-uniforms and functions from the HLSL scan.
        if (isShaderDocument(params.textDocument.uri)) {
            const document = documents.get(params.textDocument.uri);
            return document ? shaderDocumentSymbols(document.getText()) : null;
        }
        const parserResult = ensureParserResult(params.textDocument.uri);
        if (!parserResult) return null;
        try {
            if (cancellationToken.isCancellationRequested) return null;
            return DocumentSymbolService.instance.getDocumentSymbols(parserResult);
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    // Folding: one region per `{ … }` / `[ … ]` body, plus the comment runs. Structural, no resolution.
    connection.onFoldingRanges((params, cancellationToken) => {
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
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    // Expand selection: the AST chain from the innermost node covering each caret out to the whole file.
    connection.onSelectionRanges((params, cancellationToken) => {
        if (isShaderDocument(params.textDocument.uri)) return null;
        const document = documents.get(params.textDocument.uri);
        const parserResult = ensureParserResult(params.textDocument.uri);
        if (!document || !parserResult) return null;
        try {
            if (cancellationToken.isCancellationRequested) return null;
            return computeSelectionRanges(document, parserResult, params.positions);
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    // Type hierarchy: the inheritance graph of a `Foo : Bar` container. Up are the bases it writes plus
    // what a mod's `AddBase` appends, down is every container in the project naming it as a base. Only
    // the direct level per request, which is what keeps a chain like `Part` (177 vanilla files name it)
    // out of a single answer.
    connection.languages.typeHierarchy.onPrepare(async (params, cancellationToken) => {
        // `.shader` files are HLSL and carry no Object Text container to build a hierarchy from.
        if (isShaderDocument(params.textDocument.uri)) return null;
        const parserResult = ensureParserResult(params.textDocument.uri);
        if (!parserResult) return null;
        try {
            if (cancellationToken.isCancellationRequested) return null;
            return prepareTypeHierarchy(parserResult, params.position, await searchFolderPaths());
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    connection.languages.typeHierarchy.onSupertypes(async (params, cancellationToken) => {
        try {
            // Builds the indexes the resolution reads: the alias roots a `<…>` base resolves through and
            // the AddBase index holding the bases a mod appends.
            await ensureFragmentRooting(cancellationToken);
            return await supertypesOf(params.item, await searchFolderPaths(), cancellationToken);
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    connection.languages.typeHierarchy.onSubtypes(async (params, cancellationToken) => {
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
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    // Find-all-references: the reverse of go-to-definition. Resolves the symbol under the
    // cursor, then searches the project (name-pre-filtered) for references resolving to it.
    connection.onReferences(async (params, cancellationToken) => {
        // `.shader` files are HLSL. Parsing one with the Object Text parser yields a nonsense AST, so
        // the reference scan would walk it for nothing.
        if (isShaderDocument(params.textDocument.uri)) return null;
        const parserResult = ensureParserResult(params.textDocument.uri);
        if (!parserResult) return null;
        try {
            await ensureFragmentRooting(cancellationToken);
            return await ReferenceIndex.instance.findReferences(
                parserResult,
                params.position,
                params.context?.includeDeclaration ?? true,
                await searchFolderUris(),
                cancellationToken,
                await connection.window.createWorkDoneProgress()
            );
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    // Occurrence highlighting: the same search find all references runs, narrowed to the open file, so
    // resting the caret on a name marks every place this file names the same thing. It answers on every
    // cursor move, so it never waits for the game scan, and a position it has no answer for answers null,
    // which is what leaves the editor's own word matching in place.
    connection.onDocumentHighlight(async (params, cancellationToken) => {
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
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    // Workspace symbols: flat, project-wide name search ("Go to Symbol in Workspace").
    connection.onWorkspaceSymbol(async (params, cancellationToken) => {
        try {
            // Scoped to the open project (the mod), not the whole game tree. A project-wide
            // symbol table over all of Cosmoteer would be huge, and "go to symbol in workspace" is
            // about the files you're editing.
            const folders = await getWorkspaceFoldersCached();
            const folderUris = (folders ?? []).map((folder) => folder.uri);
            return await WorkspaceSymbolService.instance.getWorkspaceSymbols(
                params.query,
                folderUris,
                cancellationToken
            );
        } catch (e) {
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    // Rename: validate the symbol under the cursor, then rewrite its declaration and every
    // reference segment that resolves to it across the project.
    connection.onPrepareRename(async (params, cancellationToken) => {
        // Renaming inside a `.shader` is an HLSL rename, which the Object Text rename service cannot do.
        if (isShaderDocument(params.textDocument.uri)) return null;
        const parserResult = ensureParserResult(params.textDocument.uri);
        if (!parserResult) return null;
        try {
            return await RenameService.instance.prepareRename(parserResult, params.position, cancellationToken);
        } catch (e) {
            // A refusal carries the reason the rename cannot be done, so the editor shows that instead
            // of its own "this element cannot be renamed".
            if (e instanceof RenameRefusedError) return new ResponseError(LSPErrorCodes.RequestFailed, e.message);
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });

    connection.onRenameRequest(async (params, cancellationToken) => {
        // Same as prepareRename: a `.shader` carries no Object Text symbol to rewrite.
        if (isShaderDocument(params.textDocument.uri)) return null;
        const parserResult = ensureParserResult(params.textDocument.uri);
        if (!parserResult) return null;
        try {
            const edit = await RenameService.instance.rename(
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
            // install. Strip any edits under the Data root so we only touch the open mod. A developer
            // working on the game data can opt into editing vanilla via the setting.
            if (!edit || globalSettings.allowEditingVanillaFiles) return edit;
            return dropEditsUnderRoot(edit, CosmoteerWorkspaceService.instance.dataRootPath);
        } catch (e) {
            // A refusal carries the reason the rename cannot be done, which the author reads.
            if (e instanceof RenameRefusedError) return new ResponseError(LSPErrorCodes.RequestFailed, e.message);
            if (globalSettings.trace.server === 'messages' && !(e instanceof CancellationError)) console.error(e);
            return null;
        }
    });
}
