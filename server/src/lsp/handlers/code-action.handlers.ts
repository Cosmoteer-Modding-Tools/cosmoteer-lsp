import * as l10n from '@vscode/l10n';
import { CodeAction, CodeActionKind } from 'vscode-languageserver/node';
import { extractValueCodeAction } from '../../features/refactor/extract-value';
import { inlineValueCodeAction } from '../../features/refactor/inline-value';
import { makeModifiableCodeActions } from '../../features/refactor/make-modifiable';
import {
    CREATE_COMPONENT_ACTION_COMMAND,
    CreateComponentArgs,
} from '../../features/refactor/create-component/create-component.command';
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
        for (const diagnostic of params.context.diagnostics) {
            const data = diagnostic.data as ValidationErrorData | undefined;
            if (data?.quickFix) {
                actions.push({
                    title: data.quickFix.title,
                    kind: CodeActionKind.QuickFix,
                    diagnostics: [diagnostic],
                    isPreferred: true,
                    edit: {
                        changes: {
                            [params.textDocument.uri]: [{ range: diagnostic.range, newText: data.quickFix.newText }],
                        },
                    },
                });
            }
            // A rewrite (multi-edit migration, e.g. `Flammable = false` → TypeCategories entry) is
            // offered before the plain removal and preferred over it: it preserves the author's intent
            // where the removal would drop it.
            if (data?.rewrite) {
                const doc = documents.get(params.textDocument.uri);
                if (doc) {
                    const edits = data.rewrite.edits.map((edit) =>
                        edit.newText === ''
                            ? { range: removalRange(doc, edit.start, edit.end), newText: '' }
                            : {
                                  range: { start: doc.positionAt(edit.start), end: doc.positionAt(edit.end) },
                                  newText: edit.newText,
                              }
                    );
                    actions.push({
                        title: data.rewrite.title,
                        kind: CodeActionKind.QuickFix,
                        diagnostics: [diagnostic],
                        isPreferred: true,
                        edit: { changes: { [params.textDocument.uri]: edits } },
                    });
                }
            }
            if (data?.remove) {
                const doc = documents.get(params.textDocument.uri);
                if (doc) {
                    const range = removalRange(doc, data.remove.start, data.remove.end);
                    actions.push({
                        title: data.remove.title,
                        kind: CodeActionKind.QuickFix,
                        diagnostics: [diagnostic],
                        isPreferred: !data.rewrite,
                        edit: { changes: { [params.textDocument.uri]: [{ range, newText: '' }] } },
                    });
                }
            }
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
                const doc = documents.get(params.textDocument.uri);
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
                const doc = documents.get(params.textDocument.uri);
                const field = insert.fields.at(insert.fieldIndex);
                if (doc && field) {
                    const text = doc.getText();
                    const position = doc.positionAt(insert.offset);
                    const range = { start: position, end: position };
                    const one = requiredFieldInsertText(text, insert, [field]);
                    if (one !== null) {
                        actions.push({
                            title: l10n.t("Insert the missing required field '{0}'", field.name),
                            kind: CodeActionKind.QuickFix,
                            diagnostics: [diagnostic],
                            edit: { changes: { [params.textDocument.uri]: [{ range, newText: one }] } },
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
                            edit: { changes: { [params.textDocument.uri]: [{ range, newText: all }] } },
                        });
                    }
                }
            }
        }
        return actions;
    });
}
