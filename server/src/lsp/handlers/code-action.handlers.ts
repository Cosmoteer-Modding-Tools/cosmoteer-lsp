import * as l10n from '@vscode/l10n';
import { CodeAction, CodeActionKind, Diagnostic, TextEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { extractValueCodeAction } from '../../features/refactor/extract-value';
import { inlineValueCodeAction } from '../../features/refactor/inline-value';
import { makeModifiableCodeActions } from '../../features/refactor/make-modifiable';
import { selfRootReferenceCodeAction } from '../../features/refactor/self-root-reference';
import { sortMembersCodeAction } from '../../features/refactor/sort-members';
import { CREATE_COMPONENT_ACTION_COMMAND } from '../../features/refactor/create-component/create-component.command';
import { CreateComponentArgs } from '../../features/refactor/create-component/create-component.types';
import { extractGroupCodeAction } from '../../features/refactor/extract-group/extract-group.codeaction';
import { extractLocalizationKeyCodeAction } from '../../features/refactor/extract-localization-key';
import { extractSharedBaseCodeActions } from '../../features/refactor/shared-base/extract-shared-base.codeaction';
import { registerPartInShipCodeAction } from '../../features/refactor/register-part/register-part.codeaction';
import { overrideInModCodeAction } from '../../features/refactor/override-in-mod/override-in-mod.codeaction';
import { cloneDeclarationCodeAction } from '../../features/refactor/clone-declaration/clone.codeaction';
import { migrateSymbolCodeAction } from '../../features/migration/migrate-symbol';
import { ValidationErrorData } from '../../features/diagnostics/validator';
import { buildFillLanguageKeysEdit, buildInsertLocalizationKeyEdit } from '../../features/diagnostics/localization-key-insert';
import { requiredFieldInsertText } from '../../features/diagnostics/required-field-insert';
import { addDependencyEdit } from '../../mod/mod-dependencies';
import { findModRoot } from '../../mod/mod-root';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { isShaderDocument } from '../../document/document-kind';
import { removalRange } from '../../utils/removal-range';
import { globalSettings } from '../../settings';
import { connection, documents } from '../context';
import { ensureParserResult, openBufferReadOverride } from '../open-documents';
import { reachableFileFilter } from '../validation-scope';
import { searchFolderPaths, searchFolderUris, workspaceFolderPaths } from '../workspace-folders';

/** A quoted value as the author wrote it, with the `@` of a raw string kept apart from the body. */
const QUOTED_VALUE = /^(@?)"([\s\S]*)"$/;

/** The name a fix title names in quotes, which is the text the fix's span is meant to cover. */
const QUOTED_IN_TITLE = /'([^']+)'/;

/** A byte span a fix carries, measured while the file was validated. */
interface FixSpan {
    /** The inclusive start byte offset. */
    readonly start: number;
    /** The exclusive end byte offset. */
    readonly end: number;
}

/**
 * Whether the client asked for actions of this kind. The protocol matches a requested kind against
 * an offered one by prefix, so a request for `quickfix` also asks for `quickfix.foo`.
 *
 * @param only the kinds the request was restricted to, absent when it asked for everything.
 * @param kind the kind an action would be offered under.
 * @returns true when the action may be offered.
 */
const wantsKind = (only: string[] | undefined, kind: string): boolean =>
    !only || only.some((requested) => kind === requested || kind.startsWith(`${requested}.`));

/**
 * The replacement text of a did-you-mean fix, written back with the quoting the text it replaces
 * carries. The suggestion itself is a bare name, and the flagged range covers the whole written
 * value, so replacing one with the other used to turn `File = "icno.png"` into `File = icon.png`,
 * which the game reads as a different kind of value entirely.
 *
 * @param current the text the fix replaces, as it stands in the file.
 * @param newText the suggestion, as the diagnostic carries it.
 * @returns the text to write.
 */
export const quotedLikeSource = (current: string, newText: string): string => {
    const quoted = QUOTED_VALUE.exec(current);
    if (!quoted || QUOTED_VALUE.test(newText)) return newText;
    // A raw string takes its body verbatim, a plain one needs its quotes and backslashes escaped.
    const body = quoted[1] === '@' ? newText : newText.replace(/["\\]/g, (char) => `\\${char}`);
    return `${quoted[1]}"${body}"`;
};

/**
 * Whether a fix's span still sits where the finding is underlined: it starts with the range, ends
 * with it, or encloses it. Every producer places its span in one of those three relations to the
 * node it reports, and an edit above the finding breaks all three at once.
 *
 * @param start the finding's current start byte offset.
 * @param end the finding's current end byte offset.
 * @param span the span the fix carries.
 * @returns true while the span and the range still agree.
 */
const anchoredOnFinding = (start: number, end: number, span: FixSpan): boolean =>
    span.start === start || span.end === end || (span.start <= start && span.end >= end);

/**
 * Whether the byte offsets a fix carries still describe the text they were measured on.
 *
 * The offsets are taken during validation and the fix is applied against whatever the buffer holds
 * when the author picks it. The client moves a diagnostic's range along with the edits in between,
 * but it never moves the offsets in its `data`, so a single line typed above the finding is enough
 * to make them name a different piece of text, which the fix would then delete. A span that no
 * longer lines up with the range is refused rather than applied blind.
 *
 * @param doc the buffer the fix would be applied to.
 * @param diagnostic the finding the fix hangs off, whose range the client keeps current.
 * @param spans the byte spans the fix would rewrite.
 * @param expected text the spans must still contain, when the fix names it.
 * @returns true while every span is safe to use.
 */
export const fixOffsetsAreCurrent = (
    doc: TextDocument,
    diagnostic: Diagnostic,
    spans: readonly FixSpan[],
    expected?: string
): boolean => {
    const text = doc.getText();
    const start = doc.offsetAt(diagnostic.range.start);
    const end = doc.offsetAt(diagnostic.range.end);
    for (const span of spans) {
        if (span.start < 0 || span.end > text.length || span.start > span.end) return false;
        // An insertion writes text without taking any away, and the manifest fixes deliberately
        // write at an offset of their own rather than at the finding, so neither is judged here.
        if (span.start === span.end) continue;
        if (!anchoredOnFinding(start, end, span)) return false;
        if (expected !== undefined && !text.slice(span.start, span.end).includes(expected)) return false;
    }
    return true;
};

/**
 * The edits of the deterministic fixes one finding carries: a migration rewrite, else the removal
 * of something the game already ignores. A did-you-mean replacement is left out on purpose, since
 * the closest name is a guess and a fix-all must not apply guesses.
 *
 * @param doc the buffer the fixes would be applied to.
 * @param diagnostic the finding.
 * @returns the edits, empty when the finding carries no such fix or its offsets went stale.
 */
const safeFixEdits = (doc: TextDocument, diagnostic: Diagnostic): TextEdit[] => {
    const data = diagnostic.data as ValidationErrorData | undefined;
    if (data?.rewrite && fixOffsetsAreCurrent(doc, diagnostic, data.rewrite.edits)) {
        return data.rewrite.edits.map((edit) => rewriteEdit(doc, edit));
    }
    if (data?.remove && fixOffsetsAreCurrent(doc, diagnostic, [data.remove], QUOTED_IN_TITLE.exec(data.remove.title)?.[1])) {
        return [{ range: removalRange(doc, data.remove.start, data.remove.end), newText: '' }];
    }
    return [];
};

/**
 * An insertion in the client's terms, from the byte offset and the text a scaffold fix computed.
 *
 * @param doc the buffer the fix would be applied to.
 * @param insertion the offset to write at and the text to write.
 * @returns the edit in the client's terms.
 */
const editOf = (doc: TextDocument, insertion: { offset: number; newText: string }): TextEdit => {
    const position = doc.positionAt(insertion.offset);
    return { range: { start: position, end: position }, newText: insertion.newText };
};

/**
 * One edit of a rewrite fix, with the whole-line widening a removal gets so it leaves no blank line.
 *
 * @param doc the buffer the fix would be applied to.
 * @param edit the byte-offset edit the fix carries.
 * @returns the edit in the client's terms.
 */
const rewriteEdit = (doc: TextDocument, edit: { start: number; end: number; newText: string }): TextEdit =>
    edit.newText === ''
        ? { range: removalRange(doc, edit.start, edit.end), newText: '' }
        : {
              range: { start: doc.positionAt(edit.start), end: doc.positionAt(edit.end) },
              newText: edit.newText,
          };

/**
 * The quick fixes one finding carries that are plain edits of the file it sits in: the did-you-mean
 * replacement, the multi-edit migration rewrite and the removal. Each is built from the buffer the
 * fix would be applied to rather than from the text the validation pass saw.
 *
 * @param doc the buffer the fixes would be applied to.
 * @param uri the file the finding sits in.
 * @param diagnostic the finding.
 * @returns the actions, in the order they are offered.
 */
export const textFixActions = (doc: TextDocument, uri: string, diagnostic: Diagnostic): CodeAction[] => {
    const data = diagnostic.data as ValidationErrorData | undefined;
    const actions: CodeAction[] = [];
    if (data?.quickFix) {
        // The suggestion is a bare name and the flagged range can cover a quoted value, so the
        // quoting the author wrote is put back around it.
        const newText = quotedLikeSource(doc.getText(diagnostic.range), data.quickFix.newText);
        actions.push({
            title: data.quickFix.title,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred: true,
            edit: { changes: { [uri]: [{ range: diagnostic.range, newText }] } },
        });
    }
    // A rewrite (multi-edit migration, e.g. `Flammable = false` → TypeCategories entry) is offered
    // before the plain removal and preferred over it: it preserves the author's intent where the
    // removal would drop it. A rewrite saying exactly what the did-you-mean fix above already says
    // (one edit, the flagged range, the same text) is dropped rather than offered twice.
    const restated =
        !!data?.quickFix &&
        data.rewrite?.edits.length === 1 &&
        data.rewrite.edits[0].newText === data.quickFix.newText &&
        data.rewrite.edits[0].start === doc.offsetAt(diagnostic.range.start) &&
        data.rewrite.edits[0].end === doc.offsetAt(diagnostic.range.end);
    if (data?.rewrite && !restated && fixOffsetsAreCurrent(doc, diagnostic, data.rewrite.edits)) {
        actions.push({
            title: data.rewrite.title,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred: true,
            edit: { changes: { [uri]: data.rewrite.edits.map((edit) => rewriteEdit(doc, edit)) } },
        });
    }
    if (data?.remove) {
        const expected = QUOTED_IN_TITLE.exec(data.remove.title)?.[1];
        if (fixOffsetsAreCurrent(doc, diagnostic, [data.remove], expected)) {
            actions.push({
                title: data.remove.title,
                kind: CodeActionKind.QuickFix,
                diagnostics: [diagnostic],
                isPreferred: !data.rewrite,
                edit: {
                    changes: { [uri]: [{ range: removalRange(doc, data.remove.start, data.remove.end), newText: '' }] },
                },
            });
        }
    }
    return actions;
};

/**
 * The one `source.fixAll` action for a file: every deterministic fix its findings carry, merged into
 * a single edit so a whole file's deprecations and dead members go in one step instead of one
 * lightbulb at a time. Overlapping edits are dropped rather than merged, since two fixes rewriting
 * the same bytes cannot both be right.
 *
 * @param doc the buffer the fixes would be applied to.
 * @param uri the file the findings sit in.
 * @param context the request's context, which carries the findings and the kinds asked for.
 * @returns the action, or nothing when no finding carries such a fix.
 */
export const fixAllAction = (
    doc: TextDocument,
    uri: string,
    context: { only?: string[]; diagnostics: Diagnostic[] }
): CodeAction[] => {
    if (!wantsKind(context.only, CodeActionKind.SourceFixAll)) return [];
    const taken: Array<{ start: number; end: number }> = [];
    const edits: TextEdit[] = [];
    const fixed: Diagnostic[] = [];
    for (const diagnostic of context.diagnostics) {
        const candidates = safeFixEdits(doc, diagnostic);
        if (candidates.length === 0) continue;
        const spans = candidates.map((edit) => ({
            start: doc.offsetAt(edit.range.start),
            end: doc.offsetAt(edit.range.end),
        }));
        if (spans.some((span) => taken.some((other) => span.start < other.end && other.start < span.end))) continue;
        taken.push(...spans);
        edits.push(...candidates);
        fixed.push(diagnostic);
    }
    if (edits.length === 0) return [];
    return [
        {
            title: l10n.t('Apply all safe fixes in this file ({0})', fixed.length),
            kind: CodeActionKind.SourceFixAll,
            diagnostics: fixed,
            edit: { changes: { [uri]: edits } },
        },
    ];
};

/**
 * The fix-all action for the buffer the request names, or nothing when the file is not open.
 *
 * @param uri the file the request is about.
 * @param context the request's context.
 * @returns the action, or nothing.
 */
const fixAllActionFor = (uri: string, context: { only?: string[]; diagnostics: Diagnostic[] }): CodeAction[] => {
    const doc = documents.get(uri);
    return doc ? fixAllAction(doc, uri, context) : [];
};

/**
 * Registers the code-action request: the refactorings offered on the tree under the caret and the
 * quick fixes carried on a diagnostic's `data`.
 */
export function register(): void {
    // removalRange moved to utils/removal-range.ts so the workspace migration shares the exact
    // whole-line widening the code-action fixes use.

    // Code actions: surface the quick fixes carried on diagnostics' `data`, the "did you mean …"
    // replacements (a typo'd reference name, asset filename, or localization key) as one-click edits of
    // the flagged range, and the "insert missing localization key" fix as a cross-file edit that adds the
    // key to every language strings file of the mod, plus the extract-repeated-value refactoring.
    connection.onCodeAction(async (params, cancellationToken): Promise<CodeAction[]> => {
        const actions: CodeAction[] = [];
        // Extract-to-shared-field refactoring, offered on repeated literal values independent of any
        // diagnostic (skipped when the client asked only for kinds that exclude refactorings).
        // The refactorings below read an Object Text AST, so they are never offered on a `.shader`, whose
        // parse is nonsense. The diagnostic-driven fixes further down stay, they read the diagnostic's
        // own data rather than the tree.
        const wantsRefactor =
            !isShaderDocument(params.textDocument.uri) &&
            (!params.context.only ||
                params.context.only.some((kind) =>
                    [CodeActionKind.RefactorExtract, CodeActionKind.RefactorInline, CodeActionKind.RefactorRewrite].some(
                        (offered) =>
                            offered.startsWith(kind)
                    )
                ));
        if (wantsRefactor) {
            const parserResult = ensureParserResult(params.textDocument.uri);
            const text = documents.get(params.textDocument.uri)?.getText();
            const document = documents.get(params.textDocument.uri);
            if (parserResult && text !== undefined) {
                const extract = extractValueCodeAction(parserResult, text, params.range.start, params.textDocument.uri);
                if (extract) actions.push(extract);
                // Display text written where a localization key belongs: offer to move it into the mod's
                // language files. Not tied to a diagnostic, the literal itself is not an error.
                const extractKey = await extractLocalizationKeyCodeAction(
                    parserResult,
                    text,
                    params.range.start,
                    params.textDocument.uri,
                    await searchFolderUris(),
                    cancellationToken
                ).catch(() => undefined);
                if (extractKey) actions.push(extractKey);
                // A reference read once costs a reader a jump to learn one number: offer to replace it
                // with the value the game reads through it.
                const inline = await inlineValueCodeAction(
                    parserResult,
                    text,
                    params.range.start,
                    params.textDocument.uri,
                    cancellationToken
                ).catch(() => undefined);
                if (inline) actions.push(inline);
                // A number the game also reads as a `{ BaseValue = … }` group: offer the group form, so a
                // field that is about to take a buff is written the way the game reads one. The reverse is
                // offered on a group that carries nothing but its `BaseValue`.
                if (document)
                    actions.push(
                        ...makeModifiableCodeActions(
                            parserResult,
                            document,
                            document.offsetAt(params.range.start),
                            params.textDocument.uri
                        )
                    );
                // A reference naming its own file: offer the `~` form, which says the same thing and
                // keeps saying it after the file is renamed.
                if (document) {
                    const selfRooted = await selfRootReferenceCodeAction(
                        parserResult,
                        document,
                        params.range.start,
                        params.textDocument.uri,
                        cancellationToken
                    ).catch(() => undefined);
                    if (selfRooted) actions.push(selfRooted);
                }
                // A group whose every member the schema knows: offer to write them in the order the
                // class declares, so a mod file reads next to the game's own.
                if (document) {
                    const sorted = sortMembersCodeAction(
                        parserResult,
                        document,
                        document.offsetAt(params.range.start),
                        params.textDocument.uri
                    );
                    if (sorted) actions.push(sorted);
                }
            }
            // The shared-base extraction creates a file and rewrites every file that will inherit it, so
            // it is offered as a command rather than an edit (see extract-shared-base.codeaction.ts).
            if (parserResult && text !== undefined && document && globalSettings.diagnostics?.validateDuplicateFields) {
                actions.push(
                    ...(await extractSharedBaseCodeActions(
                        parserResult,
                        text,
                        document.offsetAt(params.range.start),
                        await searchFolderUris(),
                        cancellationToken,
                        await reachableFileFilter(cancellationToken)
                    ).catch(() => []))
                );
            }
            // Moving an inline block into a file of its own. It creates a file, and whether the block
            // can move at all depends on what its values read, so the offer carries a command.
            if (parserResult && document) {
                const extractGroup = extractGroupCodeAction(
                    parserResult,
                    document.offsetAt(params.range.start),
                    params.textDocument.uri
                );
                if (extractGroup) actions.push(extractGroup);
            }
            // The registration writes into a ship file or into the mod's manifest, neither of which is
            // the file the cursor is in, so it is offered as a command rather than an edit. Not gated on
            // any diagnostics setting, unlike the shared-base offer above: it carries no hint of its own.
            if (parserResult && document) {
                const register = registerPartInShipCodeAction(
                    parserResult,
                    document.offsetAt(params.range.start),
                    params.textDocument.uri
                );
                if (register) actions.push(register);
            }
            // Overriding a value of the game's own install from a mod. The edit lands in the mod's
            // manifest rather than in the file the caret is in, and which mod it goes into is a
            // choice only the author can make, so this is carried as a command too. The offer
            // consults no index: it reads the document in front of it and the folders it is handed.
            if (parserResult && text !== undefined && document) {
                const override = overrideInModCodeAction(
                    parserResult,
                    text,
                    document.offsetAt(params.range.start),
                    params.textDocument.uri,
                    CosmoteerWorkspaceService.instance.dataRootPath,
                    await workspaceFolderPaths()
                );
                if (override) actions.push(override);
            }
            // The copy writes files that are not the one the caret is in, and its new id is a name only
            // the author can choose, so it is offered as a command rather than as an edit. Not gated on
            // the source being editable, unlike the offer above: copying a file of the game's own install
            // into a mod is what this exists for, and it is the destination the command gates.
            if (parserResult && document) {
                const clone = cloneDeclarationCodeAction(
                    parserResult,
                    document.offsetAt(params.range.start),
                    params.textDocument.uri
                );
                if (clone) actions.push(clone);
            }
        }
        if (!wantsKind(params.context.only, CodeActionKind.QuickFix)) {
            return [...actions, ...fixAllActionFor(params.textDocument.uri, params.context)];
        }
        for (const diagnostic of params.context.diagnostics) {
            const data = diagnostic.data as ValidationErrorData | undefined;
            const doc = documents.get(params.textDocument.uri);
            if (doc) actions.push(...textFixActions(doc, params.textDocument.uri, diagnostic));
            // The same deprecation usually repeats across a mod, one `Flammable = false` per part file,
            // so the whole-mod fix is offered beside the single-file one. It carries a command rather
            // than an edit: which files change is only known after a sweep, which must not happen while
            // the lightbulb menu is being built.
            const bulkMigration = migrateSymbolCodeAction(diagnostic, params.textDocument.uri, data);
            if (bulkMigration) actions.push(bulkMigration);
            // A part that wires a component before declaring it: offer to declare it. The offer carries
            // a command rather than an edit, since which kind of component it is cannot be read off the
            // reference and only the author knows it.
            if (data?.createComponent) {
                if (doc) {
                    const args: CreateComponentArgs = {
                        uri: params.textDocument.uri,
                        offset: doc.offsetAt(diagnostic.range.start),
                        name: data.createComponent.name,
                    };
                    const title = l10n.t("Create the component '{0}'...", data.createComponent.name);
                    actions.push({
                        title,
                        kind: CodeActionKind.QuickFix,
                        diagnostics: [diagnostic],
                        command: { title, command: CREATE_COMPONENT_ACTION_COMMAND, arguments: [args] },
                    });
                }
            }
            if (data?.insertLocalizationKey) {
                const key = data.insertLocalizationKey.key;
                const edit = await buildInsertLocalizationKeyEdit(params.textDocument.uri, key, cancellationToken).catch(
                    () => null
                );
                if (edit) {
                    actions.push({
                        title: l10n.t('Add "{0}" to the mod\'s strings files', key),
                        kind: CodeActionKind.QuickFix,
                        diagnostics: [diagnostic],
                        edit,
                    });
                }
            }
            // A language of the mod that is behind the languages beside it: write every key they
            // declare into it, each with the English sentence to translate rather than a blank.
            if (data?.fillLanguageKeys) {
                const { count } = data.fillLanguageKeys;
                const edit = await buildFillLanguageKeysEdit(
                    params.textDocument.uri,
                    await searchFolderPaths(),
                    cancellationToken,
                    openBufferReadOverride()
                ).catch(() => null);
                if (edit) {
                    actions.push({
                        title: l10n.t('Add the {0} missing key(s) to this language', count),
                        kind: CodeActionKind.QuickFix,
                        diagnostics: [diagnostic],
                        edit,
                    });
                }
            }
            // A mod this file leans on without saying so: write it into the manifest's Dependencies, so
            // the mod states what it needs instead of only working where that mod happens to be
            // installed. The edit lands in the manifest, not in the file the diagnostic sits in.
            if (data?.addModDependency) {
                const { token, name } = data.addModDependency;
                const modRoot = findModRoot(params.textDocument.uri);
                const insert = modRoot ? await addDependencyEdit(modRoot, token).catch(() => null) : null;
                if (insert) {
                    actions.push({
                        title: l10n.t("Add '{0}' to the manifest's Dependencies", name),
                        kind: CodeActionKind.QuickFix,
                        diagnostics: [diagnostic],
                        edit: { changes: { [insert.uri]: [insert.edit] } },
                    });
                }
            }
            // A group missing a schema-required field: write the field in, at the end of the group and
            // with the indentation its other members use. The edit is literal text, so each scaffolded
            // field gets a starting value to replace rather than an empty one, which the game reads as a
            // parse error the moment it stands in front of the closing brace. Never preferred: the value
            // is the fix's, not the author's, so it must not be applied without being looked at.
            if (data?.insertRequiredFields) {
                const insert = data.insertRequiredFields;
                const field = insert.fields.at(insert.fieldIndex);
                if (doc && field && doc.offsetAt(diagnostic.range.end) <= insert.offset) {
                    const text = doc.getText();
                    const one = requiredFieldInsertText(text, insert, [field]);
                    if (one !== null) {
                        actions.push({
                            title: l10n.t("Insert the missing required field '{0}'", field.name),
                            kind: CodeActionKind.QuickFix,
                            diagnostics: [diagnostic],
                            edit: { changes: { [params.textDocument.uri]: [editOf(doc, one)] } },
                        });
                    }
                    // One fix for the whole group, so a component short several fields is scaffolded in
                    // one go rather than one lightbulb at a time.
                    const all = insert.fields.length > 1 ? requiredFieldInsertText(text, insert, insert.fields) : null;
                    if (all !== null) {
                        actions.push({
                            title: l10n.t('Insert the {0} missing required fields', insert.fields.length),
                            kind: CodeActionKind.QuickFix,
                            diagnostics: [diagnostic],
                            edit: { changes: { [params.textDocument.uri]: [editOf(doc, all)] } },
                        });
                    }
                }
            }
        }
        return [...actions, ...fixAllActionFor(params.textDocument.uri, params.context)];
    });
}
