import { CompletionItem, CompletionList, TextDocumentPositionParams } from 'vscode-languageserver/node';
import { AutoCompletionService, Completion } from '../../features/completion/autocompletion.service';
import { openQuoteSuffix, valueRunAtCursor, wholeValueRange, withReplaceRange } from '../../features/completion/completion-range';
import { modRulesOffsetCompletions } from '../../features/completion/autocompletion.mod-rules';
import { inheritanceTargetCompletions } from '../../features/completion/autocompletion.inheritance-target';
import { mathFunctionCompletionsAtLinePrefix } from '../../features/completion/autocompletion.math-function';
import {
    crossFileReferenceTargetAtOffset,
    isBareFieldNameIdentifier,
    isIdDeclarationPositionAt,
    isLocalizationKeyFieldAtOffset,
    schemaFieldNameCompletions,
    schemaValueCompletionsAtOffset,
} from '../../features/completion/autocompletion.schema-fields';
import { componentIdCompletionsForTarget } from '../../features/completion/autocompletion.component-id';
import { SchemaIdIndex } from '../../features/completion/schema-id.index';
import { LocalizationKeyIndex } from '../../features/completion/localization-key.index';
import { particleChannelCompletionsAtOffset } from '../../features/navigation/particle-channel';
import { mapKeyTargetOf, schemaReferenceFieldOf } from '../../features/navigation/schema-id-reference.navigation';
import { findEnclosingGroup, findEnclosingList, listElementReferenceTarget } from '../../document/schema/schema-context';
import { shaderCompletions, shaderIncludePathCompletions } from '../../features/shader/shader-completion';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { isModRules, isShaderDocument } from '../../document/document-kind';
import { findNodeAtPosition } from '../../utils/ast.utils';
import { uriToFsPath } from '../../features/navigation/workspace-files';
import { traceFailure } from '../../utils/cancellation';
import { finishCompletionList, resolveCompletionDocumentation } from '../completion-list';
import { connection, documents } from '../context';
import { ensureFragmentRooting } from '../fragment-rooting';
import { ensureParserResult, shaderIncludeTextFor } from '../open-documents';
import { scopedToShipLayers } from '../ship-layers';
import { searchFolderUris } from '../workspace-folders';

/** Registers the completion request and the lazy documentation resolve that pairs with it. */
export function register(): void {
    // This handler provides the initial list of the completion items.
    connection.onCompletion(
        async (textDocumentPosition: TextDocumentPositionParams, cancellationToken): Promise<CompletionItem[] | CompletionList> => {
            // `.shader` files get HLSL completion (builtins plus the uniforms/functions/structs the file and
            // its `#include` chain declare), not the OT schema completion below.
            if (isShaderDocument(textDocumentPosition.textDocument.uri)) {
                const document = documents.get(textDocumentPosition.textDocument.uri);
                if (!document) return [];
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
            const parserResult = ensureParserResult(textDocumentPosition.textDocument.uri);
            let completions: Completion[] = [];
            try {
                // Incomplete for the same reason as the empty case in finishCompletionList: the document
                // may simply not be parsed yet, and the client must ask again rather than cache nothing.
                if (!parserResult) return { isIncomplete: true, items: [] };
                await ensureFragmentRooting(cancellationToken);
                /** The project's ids for a reference target, ship-layer narrowed and ranged onto the value. */
                const idCompletionsFor = async (target: string): Promise<Completion[]> =>
                    withReplaceRange(
                        await scopedToShipLayers(
                            (await componentIdCompletionsForTarget(target, parserResult, cancellationToken).catch(
                                () => undefined
                            )) ??
                                (await SchemaIdIndex.instance
                                    .idCompletionsForClass(target, await searchFolderUris(), cancellationToken)
                                    .catch(() => [])),
                            target,
                            textDocumentPosition.textDocument.uri,
                            parserResult,
                            cancellationToken
                        ),
                        valueRange,
                        valueSuffix
                    );
                // Offset-based completion, shared by the no-leaf branch below and the bare-identifier
                // fallback: at an empty `Key = ` value position offer that field's legal values, else
                // offer the enclosing group's not-yet-present schema field names.
                const offsetBasedCompletions = async (): Promise<Completion[]> => {
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
                    if (valueCompletions === undefined) {
                        // Not a `Key = ` value position → offer field names instead.
                        return schemaFieldNameCompletions(parserResult, offset, cancellationToken);
                    }
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
                        return idCompletionsFor(target);
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
                const node = findNodeAtPosition(parserResult, textDocumentPosition?.position);
                if (node) {
                    // The cursor offset lets the reference completer complete the path segment at the
                    // cursor rather than the whole written value, so editing a middle segment of a long
                    // reference path offers that segment's members instead of a stale suggestion.
                    const cursorOffset = documents.get(textDocumentPosition.textDocument.uri)?.offsetAt(textDocumentPosition.position);
                    completions = await AutoCompletionService.instance
                        .getCompletions(node, cancellationToken, cursorOffset)
                        .catch(() => []);
                    // A part-component target (a router's `Routes [ [A, B, 0] ]` tuple slot): the ids are
                    // part-local, so the part-wide component union serves them, not the cross-file index.
                    // Tried first, because the index would otherwise answer with just the engine builtins.
                    if (completions.length === 0) {
                        const ref = schemaReferenceFieldOf(node);
                        if (ref) {
                            completions = withReplaceRange(
                                (await componentIdCompletionsForTarget(
                                    ref.targetClass,
                                    parserResult,
                                    cancellationToken
                                ).catch(() => undefined)) ?? [],
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
                        completions = await offsetBasedCompletions();
                    }
                } else if (isModRules(textDocumentPosition.textDocument.uri)) {
                    // Empty insertion point in a mod.rules: offer the action entry's remaining field names,
                    // or a full action-block snippet at the `Actions [ … ]` list level. Needs the byte
                    // offset, so use the open document.
                    const document = documents.get(textDocumentPosition.textDocument.uri);
                    if (document) {
                        completions = modRulesOffsetCompletions(
                            parserResult,
                            document.offsetAt(textDocumentPosition.position)
                        );
                    }
                } else {
                    // Empty insertion point in a normal `.rules` (no AST leaf under the cursor).
                    completions = await offsetBasedCompletions();
                }
                // Cross-file id fallback: when nothing else matched, offer the project's ids for the
                // reference class at the cursor. This covers a `map<reference X>` key position
                // (`MaxBuffValues = { … }`), a direct reference value, and a `list<reference X>` element
                // (`TypeCategories = [ … ]`). It runs after the branches above because an empty list or
                // map resolves the cursor to its container node, which skips the offset-based detection.
                if (completions.length === 0) {
                    const document = documents.get(textDocumentPosition.textDocument.uri);
                    if (document) {
                        const offset = document.offsetAt(textDocumentPosition.position);
                        // An inheritance-target header position (`Child : <cursor>`, or a lone `^` after
                        // it): the parser produces no reference value node there, so offer the sibling
                        // names, `^/N/` caret paths and reference-path prefixes directly. In a Components
                        // map the siblings are the sibling component ids.
                        const inheritanceTargets = inheritanceTargetCompletions(parserResult, offset, linePrefix);
                        if (inheritanceTargets && inheritanceTargets.length > 0) {
                            completions = inheritanceTargets;
                        } else {
                        // A particle data channel field (`AIn = `, `DataOut = `) offers the file's channel
                        // names, a same-file symbol set, no project index needed.
                        const channels = particleChannelCompletionsAtOffset(parserResult, offset, linePrefix);
                        if (channels && channels.length > 0) {
                            completions = channels;
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
                                completions = await idCompletionsFor(target);
                            }
                        }
                        }
                    }
                }
            } catch (e) {
                traceFailure(e);
            }
            return finishCompletionList(completions, wordPrefix);
        }
    );
    // Reattach the documentation deferred out of the completion response for the item the client is
    // about to show. An item without deferred documentation resolves to itself.
    connection.onCompletionResolve(resolveCompletionDocumentation);
}
