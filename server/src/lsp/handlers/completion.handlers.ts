import {
    CancellationToken,
    CompletionItem,
    CompletionItemKind,
    CompletionList,
    Range,
    TextDocumentPositionParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNode, AbstractNodeDocument } from '../../core/ast/ast';
import { getCompletions } from '../../features/completion/autocompletion.service';
import { Completion } from '../../features/completion/autocompletion.service.types';
import {
    openQuoteSuffix,
    valueRunAtCursor,
    wholeValueRange,
    withReplaceRange,
} from '../../features/completion/completion-range';
import { modRulesOffsetCompletions } from '../../features/completion/autocompletion.mod-rules';
import { inheritanceTargetCompletionsAt } from '../../features/completion/autocompletion.inheritance-target';
import { warmInheritedClasses } from '../../features/completion/inheritance-resolution';
import { mathFunctionCompletionsAtLinePrefix } from '../../features/completion/autocompletion.math-function';
import { markupCompletionsAt } from '../../features/completion/autocompletion.text-markup';
import { textImageNames } from '../../features/text-markup/text-image.names';
import {
    asBareFieldNames,
    crossFileReferenceTargetAtOffset,
    editedMemberNameSpanAt,
    isBareFieldNameIdentifier,
    isIdDeclarationPositionAt,
    isInsideComment,
    isLocalizationKeyFieldAtOffset,
    atFinishedQuotedValue,
    schemaFieldNameCompletions,
    schemaValueCompletionsAtOffset,
} from '../../features/completion/autocompletion.schema-fields';
import { componentIdCompletionsForTarget } from '../../features/completion/autocompletion.component-id';
import { assetCompletionsAtOffset } from '../../features/completion/autocompletion.asset';
import { SchemaIdIndex } from '../../features/completion/schema-id.index';
import { LocalizationKeyIndex } from '../../features/completion/localization-key.index';
import { particleChannelCompletionsAtOffset } from '../../features/navigation/particle-channel';
import { mapKeyTargetOf, schemaReferenceFieldOf } from '../../features/navigation/schema-id-reference.navigation';
import {
    findEnclosingGroup,
    findEnclosingList,
    listElementReferenceTarget,
} from '../../document/schema/schema-context';
import { shaderCompletions, shaderIncludePathCompletions } from '../../features/shader/shader-completion';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { isModRules, isShaderDocument } from '../../document/document-kind';
import { findNodeAtPosition } from '../../utils/ast.utils';
import { uriToFsPath } from '../../workspace/workspace-files';
import { traceFailure } from '../../utils/cancellation';
import { finishCompletionList, resolveCompletionDocumentation } from '../completion-list';
import { connection, documents } from '../context';
import { ensureFragmentRooting } from '../fragment-rooting';
import { ensureParserResult, shaderIncludeTextFor } from '../open-documents';
import { scopedToShipLayers } from '../ship-layers';
import { searchFolderUris } from '../workspace-folders';

/** Everything a completion branch reads: the request, the parse, and the line the cursor landed on. */
interface CompletionContext {
    /** The document and the position the client asked about. */
    readonly textDocumentPosition: TextDocumentPositionParams;
    /** The parsed document the completions are computed from. */
    readonly parserResult: AbstractNodeDocument;
    /** The open buffer, absent when the server does not hold the document. */
    readonly openDocument: TextDocument | undefined;
    /** The line left of the cursor. */
    readonly linePrefix: string;
    /** The rest of the line, which says whether a quoted value still needs its closing quote. */
    readonly lineSuffix: string;
    /** The value run the cursor sits in, which the answer is filtered against. */
    readonly wordPrefix: string;
    /** The range a completion replaces when its label is the whole value. */
    readonly valueRange: Range;
    /** The closing quote an unclosed quoted value still needs appended to its insert. */
    readonly valueSuffix: string;
    /** Cancels every walk with the request. */
    readonly cancellationToken: CancellationToken;
}

/**
 * HLSL completion for a `.shader`: the builtins plus the uniforms, functions and structs the
 * file and its `#include` chain declare, and the file names inside an unclosed `#include`.
 *
 * @param textDocumentPosition the document and the position the cursor is at.
 * @param document the open buffer the text is read from.
 * @returns the completions for the position.
 */
const shaderCompletionsFor = async (
    textDocumentPosition: TextDocumentPositionParams,
    document: TextDocument
): Promise<CompletionItem[] | CompletionList> => {
    const text = document.getText();
    const offset = document.offsetAt(textDocumentPosition.position);
    // Inside an `#include "…"` string, complete the include path from the file system.
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const includeMatch = /^\s*#\s*include\s+"([^"]*)$/.exec(text.slice(lineStart, offset));
    if (includeMatch) {
        return shaderIncludePathCompletions(
            includeMatch[1],
            uriToFsPath(textDocumentPosition.textDocument.uri),
            CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath
        ).catch(() => []);
    }
    // Widen completion to the include chain so a custom base shader's symbols resolve too.
    const includeText = await shaderIncludeTextFor(text, textDocumentPosition.textDocument.uri);
    return shaderCompletions(text, offset, includeText);
};

/**
 * The project's ids for a reference target, ship-layer narrowed and ranged onto the value.
 *
 * @param context the request, the parse and the line the cursor landed on.
 * @param target the class the reference at the cursor names.
 * @returns the id completions, ranged onto the whole written value.
 */
const idCompletionsFor = async (context: CompletionContext, target: string): Promise<Completion[]> => {
    const { parserResult, cancellationToken, textDocumentPosition, valueRange, valueSuffix } = context;
    const part = await componentIdCompletionsForTarget(target, parserResult, cancellationToken).catch(() => undefined);
    const ids =
        part ??
        (await SchemaIdIndex.instance
            .idCompletionsForClass(target, await searchFolderUris(), cancellationToken)
            .catch(() => []));
    const scoped = await scopedToShipLayers(
        ids,
        target,
        textDocumentPosition.textDocument.uri,
        parserResult,
        cancellationToken
    );
    return withReplaceRange(scoped, valueRange, valueSuffix);
};

/**
 * Offset-based completion, shared by the no-leaf branch below and the bare-identifier
 * fallback: at an empty `Key = ` value position offer that field's legal values, else
 * offer the enclosing group's not-yet-present schema field names.
 *
 * @param context the request, the parse and the line the cursor landed on.
 * @returns the completions for the offset, or none when the position offers nothing.
 */
const offsetBasedCompletions = async (context: CompletionContext): Promise<Completion[]> => {
    const { textDocumentPosition, parserResult, linePrefix, lineSuffix, cancellationToken, valueRange, valueSuffix } =
        context;
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) return [];
    const offset = document.offsetAt(textDocumentPosition.position);
    // Inside an unclosed function call (`Damage = ceil(sq`) the AST has no leaf and
    // the line is no `Key = ` value position either, so check the call context first
    // and offer the math-function names there instead of field names.
    const mathCompletions = mathFunctionCompletionsAtLinePrefix(parserResult, offset, linePrefix);
    const valueCompletions =
        mathCompletions.length > 0
            ? mathCompletions
            : await schemaValueCompletionsAtOffset(parserResult, offset, linePrefix, cancellationToken);
    if (valueCompletions === undefined && atFinishedQuotedValue(linePrefix)) {
        // The line already carries a finished `Key = "value"`, so the caret sits
        // behind it with nothing to write: a member of its own needs a separator
        // first, and a field name accepted here landed on the end of the value.
        return [];
    }
    if (valueCompletions === undefined) {
        // Not a `Key = ` value position → offer field names instead. A name being
        // retyped over an existing key (`Max<cursor> = 1`) takes the bare name: the
        // scaffolding snippet would write a second ` = ` after the one already there.
        // The cursor inside the name rather than at its end (`Fir<cursor>ingArc = 90`)
        // is the same case, and there the replace range has to cover the whole
        // written name, not just the letters in front of the cursor.
        const fieldNames = await schemaFieldNameCompletions(parserResult, offset, cancellationToken);
        const editedName = editedMemberNameSpanAt(parserResult, offset);
        if (editedName) {
            return asBareFieldNames(fieldNames, {
                start: document.positionAt(editedName.start),
                end: document.positionAt(editedName.end),
            });
        }
        return /^\s*=/.test(lineSuffix) ? asBareFieldNames(fieldNames, valueRange) : fieldNames;
    }
    // An asset path whose opening quote is not closed yet has no value node, so the
    // files it could name are read off the line instead of the tree.
    const assets = await assetCompletionsAtOffset(
        parserResult,
        offset,
        linePrefix,
        textDocumentPosition.position,
        cancellationToken
    ).catch(() => undefined);
    if (assets && assets.length > 0) return assets;
    if (valueCompletions.length > 0) {
        // Only inside an unclosed quote do these need the whole-value range: the insert
        // has to land on the typed text and carry the missing closing quote with it.
        return valueSuffix ? withReplaceRange(valueCompletions, valueRange, valueSuffix) : valueCompletions;
    }
    // A value position with no sync values: maybe a cross-file `ID<X>` field. Offer the
    // project's ids of the target class (e.g. `ResourceType = ` → resource ids). An
    // `ID = ` slot is the other way round: it declares an id, so the project's ids are
    // the set that is already taken and must not be offered.
    const target = isIdDeclarationPositionAt(parserResult, offset, linePrefix)
        ? undefined
        : crossFileReferenceTargetAtOffset(parserResult, offset, linePrefix);
    if (target) {
        return idCompletionsFor(context, target);
    }
    if (isLocalizationKeyFieldAtOffset(parserResult, offset, linePrefix)) {
        // A `KeyString` field (`NameKey = `) → the project's strings keys.
        return withReplaceRange(
            await LocalizationKeyIndex.instance
                .allKeyCompletions(await searchFolderUris(), cancellationToken)
                .catch(() => []),
            valueRange,
            valueSuffix
        );
    }
    return [];
};

/**
 * An inheritance header (`Child : <cursor>`) is answered before anything else. The line
 * declares what a body starts from, so it is never a field-name and never a value
 * position, and the schema completions answering there is what buried the base targets
 * under a hundred field snippets inside every typed group.
 *
 * @param context the request, the parse and the line the cursor landed on.
 * @returns the base targets, or undefined when the cursor is in no inheritance header.
 */
const inheritanceHeaderCompletions = async (context: CompletionContext): Promise<Completion[] | undefined> => {
    const { openDocument, textDocumentPosition, parserResult, linePrefix, cancellationToken } = context;
    const headerOffset = openDocument?.offsetAt(textDocumentPosition.position);
    const headerCompletions =
        headerOffset === undefined || isModRules(textDocumentPosition.textDocument.uri)
            ? undefined
            : await inheritanceTargetCompletionsAt(
                  parserResult,
                  headerOffset,
                  linePrefix,
                  textDocumentPosition.position,
                  cancellationToken
              ).catch(() => undefined);
    return headerCompletions;
};

/**
 * The completions for the AST leaf under the cursor. The node completers answer first, then the
 * part-wide component ids, the project's cross-file ids and the localization keys, each tried
 * only when the ones before it found nothing.
 *
 * @param context the request, the parse and the line the cursor landed on.
 * @param node the leaf the cursor sits in.
 * @returns the completions, or none when no branch matched.
 */
const nodeCompletions = async (context: CompletionContext, node: AbstractNode): Promise<Completion[]> => {
    const { textDocumentPosition, parserResult, cancellationToken, valueRange, valueSuffix } = context;
    // The cursor offset lets the reference completer complete the path segment at the
    // cursor rather than the whole written value, so editing a middle segment of a long
    // reference path offers that segment's members instead of a stale suggestion.
    const cursorOffset = documents.get(textDocumentPosition.textDocument.uri)?.offsetAt(textDocumentPosition.position);
    let completions: Completion[] = await getCompletions(node, cancellationToken, cursorOffset).catch(() => []);
    // A part-component target (a router's `Routes [ [A, B, 0] ]` tuple slot): the ids are
    // part-local, so the part-wide component union serves them, not the cross-file index.
    // Tried first, because the index would otherwise answer with just the engine builtins.
    if (completions.length === 0) {
        const ref = schemaReferenceFieldOf(node);
        if (ref) {
            completions = withReplaceRange(
                (await componentIdCompletionsForTarget(ref.targetClass, parserResult, cancellationToken).catch(
                    () => undefined
                )) ?? [],
                valueRange,
                valueSuffix
            );
        }
    }
    // Cross-file `ID<X>` value completion (e.g. `ResourceType = ` → project resource ids).
    // Only when nothing else matched, and gated internally to reference fields.
    if (completions.length === 0) {
        const ids = await SchemaIdIndex.instance
            .idCompletions(node, await searchFolderUris(), cancellationToken)
            .catch(() => []);
        completions = withReplaceRange(
            await scopedToShipLayers(
                ids,
                schemaReferenceFieldOf(node)?.targetClass,
                textDocumentPosition.textDocument.uri,
                parserResult,
                cancellationToken
            ),
            valueRange,
            valueSuffix
        );
    }
    // Localization-key value completion (a `KeyString` field, e.g. `NameKey = "…"`) → every
    // key declared in the project's strings files. Gated internally to `KeyString` fields.
    if (completions.length === 0) {
        completions = withReplaceRange(
            await LocalizationKeyIndex.instance
                .keyCompletionsForNode(node, await searchFolderUris(), cancellationToken)
                .catch(() => []),
            valueRange,
            valueSuffix
        );
    }
    // A partially typed field name on its own line (`Ig`) parses as a bare Identifier
    // member, which no node completer serves, so typing a field name went dark the
    // moment its first character landed (the offset path only fires when no leaf is
    // under the cursor). Route such identifiers to the same offset-based completion an
    // empty insertion point gets. The client filters by the typed prefix.
    if (
        completions.length === 0 &&
        isBareFieldNameIdentifier(node) &&
        !isModRules(textDocumentPosition.textDocument.uri)
    ) {
        completions = await offsetBasedCompletions(context);
    }
    return completions;
};

/**
 * Empty insertion point in a mod.rules: offer the action entry's remaining field names,
 * or a full action-block snippet at the `Actions [ … ]` list level. Needs the byte
 * offset, so use the open document.
 *
 * @param context the request, the parse and the line the cursor landed on.
 * @returns the completions, or none when the server does not hold the document.
 */
const modRulesCompletions = async (context: CompletionContext): Promise<Completion[]> => {
    const { textDocumentPosition, parserResult, linePrefix, cancellationToken } = context;
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) return [];
    return modRulesOffsetCompletions(
        parserResult,
        document.offsetAt(textDocumentPosition.position),
        linePrefix,
        cancellationToken
    );
};

/**
 * Cross-file id fallback: when nothing else matched, offer the project's ids for the
 * reference class at the cursor. This covers a `map<reference X>` key position
 * (`MaxBuffValues = { … }`), a direct reference value, and a `list<reference X>` element
 * (`TypeCategories = [ … ]`). It runs after the branches above because an empty list or
 * map resolves the cursor to its container node, which skips the offset-based detection.
 *
 * @param context the request, the parse and the line the cursor landed on.
 * @returns the ids for the reference class at the cursor, or none when there is no such class.
 */
const crossFileIdFallback = async (context: CompletionContext): Promise<Completion[]> => {
    const { textDocumentPosition, parserResult, linePrefix } = context;
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) return [];
    const offset = document.offsetAt(textDocumentPosition.position);
    // A particle data channel field (`AIn = `, `DataOut = `) offers the file's channel
    // names, a same-file symbol set, no project index needed.
    const channels = particleChannelCompletionsAtOffset(parserResult, offset, linePrefix);
    if (channels && channels.length > 0) {
        return channels;
    } else {
        const enclosingGroup = findEnclosingGroup(parserResult, offset);
        const enclosingList = findEnclosingList(parserResult, offset);
        const target =
            (enclosingGroup ? mapKeyTargetOf(enclosingGroup) : undefined) ??
            (enclosingList ? listElementReferenceTarget(enclosingList, offset) : undefined) ??
            crossFileReferenceTargetAtOffset(parserResult, offset, linePrefix);
        // An empty `OtherIDs [ … ]` resolves the cursor to the list rather than a
        // value node, so the declaration check runs here too.
        if (target && !isIdDeclarationPositionAt(parserResult, offset, linePrefix)) {
            return idCompletionsFor(context, target);
        }
    }
    return [];
};

/**
 * The `.rules` completions for a position, which is every branch that needs the parsed document:
 * the inheritance header, the leaf under the cursor, the mod.rules action fields, the
 * offset-based field and value names, and the cross-file id fallback.
 *
 * A branch that throws leaves whatever was already gathered, which is answered rather than
 * dropped, and the failure is traced.
 *
 * @param context the request, the parse and the line the cursor landed on.
 * @returns the completion list the client renders.
 */
const schemaCompletions = async (context: CompletionContext): Promise<CompletionList> => {
    const { textDocumentPosition, parserResult, cancellationToken, wordPrefix } = context;
    let completions: Completion[] = [];
    try {
        await ensureFragmentRooting(cancellationToken);
        // The list, reference and discriminator completions resolve classes synchronously, so a
        // group deriving from a base in another file is classified for them up front.
        await warmInheritedClasses(parserResult, cancellationToken).catch(() => undefined);
        const headerCompletions = await inheritanceHeaderCompletions(context);
        if (headerCompletions) {
            return finishCompletionList(headerCompletions, wordPrefix);
        }
        const node = findNodeAtPosition(parserResult, textDocumentPosition?.position);
        if (node) {
            completions = await nodeCompletions(context, node);
        } else if (isModRules(textDocumentPosition.textDocument.uri)) {
            completions = await modRulesCompletions(context);
        } else {
            // Empty insertion point in a normal `.rules` (no AST leaf under the cursor).
            completions = await offsetBasedCompletions(context);
        }
        if (completions.length === 0) {
            completions = await crossFileIdFallback(context);
        }
    } catch (e) {
        traceFailure(e);
    }
    return finishCompletionList(completions, wordPrefix);
};

/**
 * Answers `textDocument/completion`: the HLSL completions of a `.shader`, the text-markup
 * vocabulary of a language file, and otherwise the schema completions of the parsed document.
 *
 * @param textDocumentPosition the document and the position the cursor is at.
 * @param cancellationToken cancels every walk with the request.
 * @returns the completions, marked incomplete when the client has to ask again.
 */
const handleCompletion = async (
    textDocumentPosition: TextDocumentPositionParams,
    cancellationToken: CancellationToken
): Promise<CompletionItem[] | CompletionList> => {
    // `.shader` files get HLSL completion (builtins plus the uniforms/functions/structs the file and
    // its `#include` chain declare), not the OT schema completion below.
    if (isShaderDocument(textDocumentPosition.textDocument.uri)) {
        const document = documents.get(textDocumentPosition.textDocument.uri);
        if (!document) return [];
        return shaderCompletionsFor(textDocumentPosition, document);
    }
    // The line left of the cursor drives both the whole-value replace range and the over-cap
    // narrowing, so it is read once here instead of per branch. Reading it before the awaits also
    // pairs it with the position and AST snapshot the completions are computed from.
    const openDocument = documents.get(textDocumentPosition.textDocument.uri);
    const linePrefix = openDocument
        ? openDocument.getText({
              start: { line: textDocumentPosition.position.line, character: 0 },
              end: textDocumentPosition.position,
          })
        : '';
    const wordPrefix = valueRunAtCursor(linePrefix);
    // The range a completion replaces when its label is the whole value: a localization key, a
    // cross-file id, a component id. Never handed to the reference completer, whose labels are
    // single path segments.
    const valueRange = wholeValueRange(textDocumentPosition.position, wordPrefix);
    // The rest of the line, read for the same snapshot reason as the prefix: it says whether a
    // quoted value the cursor sits in still needs its closing quote appended to the insert.
    const lineSuffix = openDocument
        ? openDocument.getText({
              start: textDocumentPosition.position,
              end: { line: textDocumentPosition.position.line + 1, character: 0 },
          })
        : '';
    const valueSuffix = openQuoteSuffix(linePrefix, lineSuffix);
    // A language file's strings carry the game's own text markup, whose vocabulary is closed.
    // Answered off the written line, before the tree is consulted at all, because a half-typed
    // `<col` is still plain text to the parser.
    const markup = markupCompletionsAt(
        textDocumentPosition.textDocument.uri,
        linePrefix,
        textDocumentPosition.position
    );
    if (markup) {
        const keys = markup.localizationKeys
            ? await LocalizationKeyIndex.instance
                  .allKeyCompletions(await searchFolderUris(), cancellationToken)
                  .catch(() => [])
            : [];
        // The images a `<img name='…'/>` may name are the ones the project registers: the
        // game root's text sprites, the resources and the factions.
        const images: Completion[] = markup.imageNames
            ? [...(await textImageNames(await searchFolderUris(), cancellationToken).catch(() => new Set<string>()))]
                  .sort()
                  .map((name) => ({ label: name, kind: CompletionItemKind.Value }))
            : [];
        const list = finishCompletionList(
            withReplaceRange(markup.completions.concat(keys).concat(images), markup.range),
            wordPrefix
        );
        // The offered set changes with every character typed inside a tag (an element name,
        // then its attributes, then their values), so the client has to ask again rather than
        // refilter what it already holds.
        return { ...list, isIncomplete: true };
    }
    // Text the game never reads gets no suggestions: a commented-out assignment still reads
    // as one, so without this a `// Layer = "` was answered with the render layers, and a
    // `/* Mode = */` with the enum members, of a line that is not in the file's data at all.
    if (openDocument && isInsideComment(openDocument.getText(), openDocument.offsetAt(textDocumentPosition.position))) {
        return { isIncomplete: false, items: [] };
    }
    const parserResult = ensureParserResult(textDocumentPosition.textDocument.uri);
    // Incomplete for the same reason as the empty case in finishCompletionList: the document
    // may simply not be parsed yet, and the client must ask again rather than cache nothing.
    if (!parserResult) return { isIncomplete: true, items: [] };
    return schemaCompletions({
        textDocumentPosition,
        parserResult,
        openDocument,
        linePrefix,
        lineSuffix,
        wordPrefix,
        valueRange,
        valueSuffix,
        cancellationToken,
    });
};

/** Registers the completion request and the lazy documentation resolve that pairs with it. */
export function register(): void {
    connection.onCompletion(handleCompletion);
    // Reattach the documentation deferred out of the completion response for the item the client is
    // about to show. An item without deferred documentation resolves to itself.
    connection.onCompletionResolve(resolveCompletionDocumentation);
}
