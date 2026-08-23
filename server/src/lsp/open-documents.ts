import { TextDocument } from 'vscode-languageserver-textdocument';
import { BlockCommentSpan, lexer } from '../core/lexer/lexer';
import { parser } from '../core/parser/parser';
import { AbstractNodeDocument } from '../core/ast/ast';
import { ParserResultRegistrar } from '../registrar/parser-result-registrar';
import { ModRulesRegistrar } from '../mod/mod-rules.registrar';
import { WorkspaceSymbolService } from '../features/navigation/workspace-symbol.service';
import { SchemaIdIndex } from '../features/completion/schema-id.index';
import { TemplateBaseIndex } from '../features/diagnostics/template-base.index';
import { LocalizationKeyIndex } from '../features/completion/localization-key.index';
import { ReverseIncludeIndex } from '../features/navigation/reverse-include.index';
import { AddBaseIndex } from '../mod/add-base.index';
import { MemberInjectionIndex } from '../mod/member-injection.index';
import { ActionRootingIndex } from '../mod/action-rooting.index';
import { aliasRootIndex } from '../document/schema/alias-root';
import { basenameOf, isModRules, isShaderDocument } from '../document/document-kind';
import { invalidateModContext } from '../mod/mod-context';
import { invalidateComponentIdCache } from '../features/diagnostics/validator.schema-sibling';
import { invalidateEffectiveChainCache } from '../semantics/effective-group';
import { invalidateLooseDeclarationCache } from '../features/diagnostics/validator.schema-id-reference';
import { clearNavigationMemo, invalidateNavigationMemoForFile } from '../features/navigation/full.navigation-strategy';
import { normalizeUri } from '../features/navigation/reference-location';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { collectIncludeText } from '../features/shader/shader-index';
import { documents } from './context';
import { diagnosticsCache, inlayHintCache } from './document-caches';
import { bumpWorkspaceScanEpoch } from './scan-epoch';
import { invalidateShipLayersFor } from './ship-layers';

/**
 * The parsed AST for an open document, parsing the live buffer on demand when the validation
 * pipeline hasn't cached it yet. `validateTextDocument` only calls `setResult` after awaiting the
 * settings round-trip and the (potentially slow) alias-root index, so on a freshly-started server
 * the first already-open file has no cached result for a while. Read-only providers that need only
 * the AST (most visibly the colour provider, which the editor does not re-request once it has been
 * answered with an empty result) would otherwise return nothing until the file is edited or
 * reopened. Parsing here is pure and cheap (lex + parse, no settings, no indexing) and the result is
 * cached so the subsequent validate pass just overwrites it with an identical AST.
 *
 * @param uri the open document's uri.
 * @returns the parsed AST, or `undefined` when no document is open for that uri.
 */
export function ensureParserResult(uri: string): AbstractNodeDocument | undefined {
    const cached = ParserResultRegistrar.instance.getResult(uri);
    if (cached) return cached;
    const document = documents.get(uri);
    if (!document) return undefined;
    const result = parser(lexer(document.getText()), uri).value;
    ParserResultRegistrar.instance.setResult(uri, result);
    return result;
}

/**
 * The last lex+parse of each open document. {@link registerOpenDocument} fills it on every edit so
 * the validation that follows (push or pull) reuses the parse instead of lexing and parsing the
 * same text a second time. Entries live only as long as the document is open.
 */
export const openParseCache: Map<
    string,
    {
        version: number;
        tokens: ReturnType<typeof lexer>;
        blockComments: BlockCommentSpan[];
        parserResult: ReturnType<typeof parser>;
    }
> = new Map();

/**
 * The lexer output for an open document, reusing {@link openParseCache} while it is current and
 * lexing the live buffer otherwise. Folding reads the comment spans and the token extents, neither
 * of which the AST carries, and the cache is still empty for a file that was open before the server
 * started. Lexing here is pure and touches nothing else.
 *
 * @param document the open document to lex.
 * @returns the tokens and the block-comment spans of that document's current text.
 */
export function ensureLexResult(document: TextDocument): {
    tokens: ReturnType<typeof lexer>;
    blockComments: BlockCommentSpan[];
} {
    const cached = openParseCache.get(document.uri);
    if (cached && cached.version === document.version) {
        return { tokens: cached.tokens, blockComments: cached.blockComments };
    }
    const blockComments: BlockCommentSpan[] = [];
    return { tokens: lexer(document.getText(), blockComments), blockComments };
}

/**
 * Marks every content-derived project index stale for one file, so each of them re-reads it at its
 * next query. Every path that changes a file has to dirty the same set, an open-buffer edit, a disk
 * change and a refactor's write alike, so the set is named in one place here.
 *
 * @param uri the uri of the file whose content changed.
 */
export function markProjectIndexesDirty(uri: string): void {
    WorkspaceSymbolService.instance.markDirty(uri);
    SchemaIdIndex.instance.markDirty(uri);
    invalidateShipLayersFor(uri);
    TemplateBaseIndex.instance.markDirty(uri);
    LocalizationKeyIndex.instance.markDirty(uri);
    ReverseIncludeIndex.instance.markDirty(uri);
    AddBaseIndex.instance.markDirty(uri);
    MemberInjectionIndex.instance.markDirty(uri);
    ActionRootingIndex.instance.markDirty(uri);
}

/**
 * Lexes and parses an open document once per version and publishes the result to every consumer:
 * the parser-result registrar (completion/hover/navigation read the live AST back), the project
 * indexes (marked dirty for their next query), and the mod-manifest registrar. Validation used to
 * do all of this inline. It lives here so the AST is current the moment an edit arrives, even when
 * a pull-model client runs the actual validation later.
 *
 * @param document the open document to parse and register.
 */
export function registerOpenDocument(document: TextDocument): void {
    // `.shader` files are HLSL, the rules lexer/parser would flag every line.
    if (isShaderDocument(document.uri)) return;
    const cached = openParseCache.get(document.uri);
    if (cached && cached.version === document.version) return;
    const blockComments: BlockCommentSpan[] = [];
    const tokens = lexer(document.getText(), blockComments);
    const parserResult = parser(tokens, document.uri);
    openParseCache.set(document.uri, { version: document.version, tokens, blockComments, parserResult });
    ParserResultRegistrar.instance.setResult(document.uri, parserResult.value);
    // The edit changes what references touching this file resolve to, and the disk watcher never
    // sees open-buffer edits, so drop the navigation memo entries whose resolution read this file.
    // Entries that never read it (the vanilla-tree bulk) survive the keystroke.
    invalidateNavigationMemoForFile(document.uri);
    // Scanned files may derive diagnostics from this buffer (registrar-first parse reads), so
    // their cached scan results are stale from this edit on.
    bumpWorkspaceScanEpoch();
    // Other open documents may derive diagnostics and inlay values from this document (an
    // inherited base, a strings file, a component provider), so their version-keyed caches are
    // stale now even though their own versions did not change. Drop everyone else's entries.
    // The client's next pull recomputes them against the fresh AST.
    for (const uri of [...diagnosticsCache.keys()]) {
        if (uri !== document.uri) diagnosticsCache.delete(uri);
    }
    for (const uri of [...inlayHintCache.keys()]) {
        if (uri !== document.uri) inlayHintCache.delete(uri);
    }
    invalidateComponentIdCache();
    invalidateEffectiveChainCache();
    invalidateLooseDeclarationCache();
    // An edit changes which symbols this file contributes. Re-index it lazily at the next
    // workspace-symbol query. (find-all-references is stateless, it re-reads per query.)
    markProjectIndexesDirty(document.uri);
    if (isModRules(document.uri)) {
        // Parse the manifest's actions. A mod.rules edit changes the effective game tree.
        ModRulesRegistrar.instance.registerManifest(parserResult.value);
        invalidateModContext();
        // The effective tree changed under every memoized super-path, so scoped invalidation
        // isn't enough here.
        clearNavigationMemo();
    } else if (basenameOf(document.uri).toLowerCase() === 'cosmoteer.rules') {
        // The mod's own cosmoteer.rules contributes convenience globals to the effective tree.
        invalidateModContext();
        clearNavigationMemo();
        // Its aliases drive fragment rooting, rebuild that index on the next feature use.
        aliasRootIndex.invalidate();
    }
}

/** Normalized URIs of every document currently open in the editor (they get diagnostics via the normal flow). */
export const openDocumentNorms = (): Set<string> => new Set(documents.all().map((d) => normalizeUri(d.uri)));

/**
 * Whether a file is open in the editor right now, asked live rather than against a snapshot. A
 * whole-workspace pass takes seconds, so a file opened while it runs is missing from the set the
 * pass captured at its start. Publishing for such a file duplicates every diagnostic in it: the
 * client holds pushed and pulled diagnostics in separate collections, so the pushed copy stacks on
 * top of the one the open-file flow already answered.
 *
 * @param uri the uri to test, in any encoding.
 * @returns true when a document with that uri is open.
 */
export const isDocumentOpen = (uri: string): boolean => {
    const norm = normalizeUri(uri);
    for (const document of documents.all()) if (normalizeUri(document.uri) === norm) return true;
    return false;
};

/**
 * A read-override that returns an open editor buffer's text for an absolute path, so shader features
 * see unsaved edits instead of the on-disk file. Keyed by normalized (forward-slash, lower-case) path.
 *
 * @returns the lookup function, which answers undefined for a path no open buffer covers.
 */
export function openBufferReadOverride(): (absPath: string) => string | undefined {
    const openByPath = new Map<string, string>();
    for (const open of documents.all()) {
        openByPath.set(uriToFsPath(open.uri).replace(/\\/g, '/').toLowerCase(), open.getText());
    }
    return (absPath) => openByPath.get(absPath.replace(/\\/g, '/').toLowerCase());
}

/**
 * The text of a shader's whole `#include` chain, read the way every shader feature needs it: from the
 * live buffer of the file being edited, against the game `Data` directory, preferring open buffers over
 * disk, and yielding an empty string when the chain cannot be read. The override snapshots the open
 * documents, so it is built per call rather than once.
 *
 * @param text the source of the shader being edited (the open buffer).
 * @param uri the uri of that shader, the base for resolving its includes.
 * @returns the joined text of the included files, empty when there are none or the read failed.
 */
export const shaderIncludeTextFor = (text: string, uri: string): Promise<string> =>
    collectIncludeText(text, uriToFsPath(uri), undefined, openBufferReadOverride()).catch(() => '');
