import { CancellationToken, Diagnostic, DiagnosticSeverity, DiagnosticTag } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { BlockCommentSpan, lexer } from '../core/lexer/lexer';
import { parser } from '../core/parser/parser';
import { findingSpanOf, ValidationError, Validator } from '../features/diagnostics/validator';
import { ValidationForDocumentDuplicates } from '../features/diagnostics/validator.duplicate-key';
import { validateInheritanceCycles } from '../features/diagnostics/validator.inheritance-cycle';
import { validateAnonymousBlocks } from '../features/diagnostics/validator.anonymous-block';
import { validateSchema } from '../features/diagnostics/validator.schema';
import { validateSchemaSiblingReferences } from '../features/diagnostics/validator.schema-sibling';
import { validateCrossFileIdReferences } from '../features/diagnostics/validator.schema-id-reference';
import { validateRequiredFields } from '../features/diagnostics/validator.required-fields';
import { validateShaderConstants } from '../features/diagnostics/validator.shader-constants';
import { validateLocalizationKeys } from '../features/diagnostics/validator.localization-key';
import { validatePathValues } from '../features/diagnostics/validator.path-value';
import {
    validateMissingSeparators,
    validateRedundantSeparators,
    validateUnbracketedValueList,
} from '../features/diagnostics/validator.separator';
import {
    validateOrphanCommentTerminators,
    validateUnclosedComments,
    validateUnterminatedComments,
} from '../features/diagnostics/validator.comment';
import { validateIgnoredFields } from '../features/diagnostics/validator.ignored-field';
import { validateDefaultValuedFields } from '../features/diagnostics/validator.default-value';
import { validateUnusedConstants } from '../features/diagnostics/validator.unused-constant';
import { validateDuplicateFields } from '../features/diagnostics/validator.duplicate-fields';
import { validateRedundantOverrides } from '../features/diagnostics/validator.redundant-override';
import { validatePartGeometry } from '../features/diagnostics/validator.part-geometry';
import { validateSpriteGeometry } from '../features/diagnostics/validator.sprite-geometry';
import { validateRenderLayers } from '../features/diagnostics/validator.render-layer';
import { validateUnusedParticleChannels } from '../features/diagnostics/validator.particle-channel';
import { validateDuplicateModIds } from '../features/diagnostics/validator.duplicate-id';
import { validateUnreceivableBuffs } from '../features/diagnostics/validator.unreceivable-buff';
import { validateEffectBuckets } from '../features/diagnostics/validator.effect-bucket';
import { validateMarkerVocabulary } from '../features/diagnostics/validator.marker-vocabulary';
import { validateLocalizationCoverage } from '../features/diagnostics/validator.localization-coverage';
import { validateInertFields } from '../features/diagnostics/validator.inert-field';
import { validateModConflicts } from '../features/diagnostics/validator.mod-conflict';
import { validateModActions } from '../features/diagnostics/validator.mod-action';
import { validateManifestVersion } from '../features/diagnostics/validator.manifest-version';
import { validateModManifest } from '../features/diagnostics/validator.mod-manifest';
import { TemplateBaseIndex } from '../features/diagnostics/template-base.index';
import { validateShaderDocument } from '../features/shader/shader-diagnostics';
import { ModRulesRegistrar } from '../mod/mod-rules.registrar';
import { isActionFragmentDocument, parseModActions } from '../mod/action-parser';
import { basenameOf, isDocumentationFileName, isModRules, isShaderDocument } from '../document/document-kind';
import { CosmoteerWorkspaceService } from '../workspace/cosmoteer-workspace.service';
import { primeParsedFile } from '../workspace/fs-cache';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { globalSettings } from '../settings';
import { traceFailure } from '../utils/cancellation';
import { perfCount } from '../utils/perf-counters';
import { hasDiagnosticRelatedInformationCapability } from './capabilities';
import { getDocumentSettings } from './document-settings';
import { ensureFragmentRooting } from './fragment-rooting';
import { openBufferReadOverride, openParseCache, registerOpenDocument } from './open-documents';
import { shipLayerContext } from './ship-layers';
import { reachableFileFilter } from './validation-scope';
import { gameIndexAvailable, searchFolderPaths, searchFolderUris } from './workspace-folders';

/** Maps a {@link ValidationError} severity (default 'error') to the LSP DiagnosticSeverity. */
const VALIDATION_SEVERITY: Record<NonNullable<ValidationError['severity']>, DiagnosticSeverity> = {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    information: DiagnosticSeverity.Information,
    hint: DiagnosticSeverity.Hint,
};

/**
 * Stamp a pass's findings with the rule every report identifies them by, leaving a finding that
 * already named its own rule alone. Called where a pass is invoked, which is the only place the
 * pass a finding came from is known.
 *
 * @param errors the findings one pass produced.
 * @param code the rule id of that pass, from the table in server/src/cli/rule-ids.ts.
 * @returns the same findings, now carrying the rule id.
 */
const tagged = (errors: ValidationError[], code: string): ValidationError[] => {
    for (const error of errors) error.code ??= code;
    return errors;
};

/**
 * Lexes, parses and validates one document, running every enabled validator pass over it and
 * mapping the findings onto LSP diagnostics. Serves both the open-document flow and the
 * whole-workspace pass over unopened files, so on-disk files go through the exact same path.
 *
 * @param textDocument the document to validate.
 * @param cancelToken cancels the parse and the validator passes.
 * @param persist when false (the whole-workspace pass over unopened files), the parsed AST is not
 *     cached in ParserResultRegistrar. It is used to produce diagnostics and then discarded so it
 *     can be GC'd. Caching every project file's AST permanently is what exhausted the heap. The
 *     open-file flow keeps `persist: true` because completion/navigation read the live AST back.
 * @returns the document's diagnostics, capped at the configured problem limit.
 */
export async function validateTextDocument(
    textDocument: TextDocument,
    cancelToken: CancellationToken,
    persist = true
): Promise<Diagnostic[]> {
    // `.shader` files reach the server (for semantic tokens / hover / include navigation) but are HLSL,
    // not OT, so never run the `.rules` lexer/parser/validators on them, which would flag every line as a
    // rules syntax error. Their only diagnostics are the lexical shader checks, which are on by default.
    if (isShaderDocument(textDocument.uri)) {
        const shaderSettings = persist ? await getDocumentSettings(textDocument.uri) : globalSettings;
        if (!shaderSettings.diagnostics.validateShaderCode) return [];
        return validateShaderDocument(
            textDocument.getText(),
            uriToFsPath(textDocument.uri),
            CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
            openBufferReadOverride()
        ).catch(() => []);
    }
    // A readme or a changelog is prose whatever extension it carries, and the game loads neither, so
    // it gets no diagnostics even when it is open in the editor. Parsing one as rules only produces
    // findings about sentences.
    if (isDocumentationFileName(basenameOf(textDocument.uri))) return [];
    // The bulk pass uses the global settings rather than per-file config: a `workspace/configuration`
    // round-trip per file (cached in an unbounded map) would mean thousands of requests + retained
    // entries. Open files keep per-document settings (folder-specific overrides matter there).
    const settings = persist ? await getDocumentSettings(textDocument.uri) : globalSettings;
    // A standalone fragment file is rooted forward through cosmoteer.rules's aliases or in reverse
    // through the field that includes it. Make sure both indexes are built so schema validation and
    // resolution inside a fragment work. This is a no-op once built and when there is no game root.
    await ensureFragmentRooting(cancelToken);
    let tokens: ReturnType<typeof lexer>;
    let blockComments: BlockCommentSpan[];
    let parserResult: ReturnType<typeof parser>;
    if (persist) {
        // The open-document flow: reuse the parse {@link registerOpenDocument} already did for
        // this version. It also published the AST and marked the project indexes dirty.
        registerOpenDocument(textDocument);
        const cached = openParseCache.get(textDocument.uri);
        if (!cached) return [];
        tokens = cached.tokens;
        blockComments = cached.blockComments;
        parserResult = cached.parserResult;
    } else {
        perfCount('scan.parse');
        const parseStarted = Date.now();
        blockComments = [];
        tokens = lexer(textDocument.getText(), blockComments);
        if (cancelToken.isCancellationRequested) return [];
        parserResult = parser(tokens, textDocument.uri);
        perfCount('scan.parseMs', Date.now() - parseStarted);
        // Seed the fs parse cache with this parse, so other scanned files resolving references
        // into this one hit the cache instead of re-reading and re-parsing it from disk.
        await primeParsedFile(uriToFsPath(textDocument.uri), parserResult.value);
        if (isModRules(textDocument.uri)) {
            // mod.rules diagnostics need the manifest's actions registered to validate them, but we do
            // not invalidate the live mod context for an unopened file (the open buffer owns that).
            ModRulesRegistrar.instance.registerManifest(parserResult.value);
        }
    }
    if (cancelToken.isCancellationRequested) return [];
    if (settings.trace.server === 'verbose') {
        console.dir(parserResult);
    }
    let problems = 0;
    const diagnostics: Diagnostic[] = [];

    for (const error of parserResult.parserErrors) {
        problems++;
        if (problems > settings.maxNumberOfProblems) break;
        const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
                start: textDocument.positionAt(error.token.start),
                end: textDocument.positionAt(error.token.end ?? error.token.start),
            },
            message: error.message,
            source: 'cosmoteer-language-server',
            // Every finding names the check behind it, so a report can group by rule and a reader
            // can filter one off. A parse error belongs to no switchable pass, so its id is fixed.
            code: 'parse-error',
        };
        if (hasDiagnosticRelatedInformationCapability && error.additionalInfo) {
            for (const info of error.additionalInfo) {
                diagnostic.relatedInformation = [
                    {
                        location: {
                            uri: textDocument.uri,
                            range: Object.assign({}, diagnostic.range),
                        },
                        message: info.message,
                    },
                ];
            }
        }
        diagnostics.push(diagnostic);
    }

    let validationErrors: ValidationError[] = [];
    const validateStarted = Date.now();
    // Wall time of one validation pass, accumulated into a perf counter for the scan bench's
    // per-pass breakdown. Only the bulk scan records (persist=false), the open-file flow doesn't.
    const timedPass = async <T>(counter: string, run: () => Promise<T> | T): Promise<T> => {
        if (persist) return await run();
        const started = Date.now();
        const result = await run();
        perfCount(counter, Date.now() - started);
        return result;
    };
    try {
        validationErrors = await timedPass('scan.vElementsMs', async () => {
            const passes = parserResult.value.elements.map((node) => Validator.instance.validate(node, cancelToken));
            return tagged((await Promise.all(passes).catch(() => [])).flat(), 'syntax-and-references');
        });
        // Top-level duplicate keys span sibling elements (each validated independently above), and
        // inheritance cycles span multiple nodes/files, and both need a whole-document view, so they run
        // as separate passes over the root, like the mod-action pass below.
        const documentDuplicate = await ValidationForDocumentDuplicates.callback(parserResult.value, cancelToken).catch(
            () => undefined
        );
        if (documentDuplicate) {
            documentDuplicate.code = 'document-duplicate';
            validationErrors.push(documentDuplicate);
        }
        const inheritanceCycleErrors = await timedPass('scan.vCyclesMs', () =>
            validateInheritanceCycles(parserResult.value, cancelToken).catch(() => [])
        );
        validationErrors = validationErrors.concat(tagged(inheritanceCycleErrors, 'inheritance-cycle'));
        // Separate pass: `{`/`[` blocks that open with no name in front of them outside a list, which
        // the game refuses to load. Needs the sibling view of a whole scope, like the duplicate pass.
        const anonymousBlockErrors = await validateAnonymousBlocks(parserResult.value, cancelToken).catch(() => []);
        validationErrors = validationErrors.concat(tagged(anonymousBlockErrors, 'anonymous-block'));
        // Separate pass: schema-driven checks (currently invalid enum values), like the duplicate /
        // inheritance-cycle passes above. Self-gates to non-mod `.rules` files.
        const schemaErrors = await timedPass('scan.vSchemaMs', () =>
            validateSchema(parserResult.value, cancelToken).catch(() => [])
        );
        validationErrors = validationErrors.concat(tagged(schemaErrors, 'schema'));
        // Separate pass: schema `ID<…>` component references that name no component in the part.
        // On by default, but only once the game `Data` tree is indexed: the part-wide id union folds
        // in inherited vanilla bases, which cannot resolve without the install.
        if (settings.diagnostics?.validateComponentReferences && gameIndexAvailable()) {
            const siblingRefErrors = await timedPass('scan.vSiblingMs', () =>
                validateSchemaSiblingReferences(parserResult.value, cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(siblingRefErrors, 'validateComponentReferences'));
        }
        // Separate pass: cross-file `ID<…>` references (GUI toggle/color/targeter/trigger ids) whose
        // id names no declaration in the project. On by default, but only once the game `Data` tree is
        // indexed: without it, a reference to a vanilla-declared id would be a false positive.
        if (settings.diagnostics?.validateCrossFileReferences && gameIndexAvailable()) {
            const idRefErrors = await timedPass('scan.vCrossFileMs', async () =>
                validateCrossFileIdReferences(parserResult.value, await searchFolderUris(), cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(idRefErrors, 'validateCrossFileReferences'));
        }
        // Separate pass: groups missing a schema-required field, checked through the inheritance chain.
        // On by default. Optional-field detection (constructor defaults, nullable types, collections)
        // closed the false positives, and the pass skips any group whose chain does not fully resolve,
        // so an unindexed vanilla base cannot produce a finding. The engine-injected fields that have
        // no static trace are named in the validator's `RUNTIME_REQUIRED_ALLOWLIST`.
        if (settings.diagnostics?.validateRequiredFields) {
            const requiredFieldErrors = await timedPass('scan.vRequiredMs', async () => {
                // The project-wide set of inheritance-base names lets the check skip cross-file
                // templates (a `BASE_*` group inherited by other files) that a single-file scan
                // would false-positive.
                const workspaceBaseNames = await TemplateBaseIndex.instance
                    .baseNames(await searchFolderUris(), cancelToken)
                    .catch(() => undefined);
                return validateRequiredFields(parserResult.value, cancelToken, workspaceBaseNames).catch(() => []);
            });
            validationErrors = validationErrors.concat(tagged(requiredFieldErrors, 'validateRequiredFields'));
        }
        // Separate pass: inline `_`-prefixed shader constants a material sets, checked against the
        // uniforms its `.shader` declares. On by default. The game itself ships a few constant keys its
        // shaders never read, so those are suppressed by name in the validator's `VANILLA_DEAD_KEYS`.
        if (settings.diagnostics?.validateShaderConstants) {
            const shaderConstantErrors = await validateShaderConstants(parserResult.value, cancelToken).catch(() => []);
            validationErrors = validationErrors.concat(tagged(shaderConstantErrors, 'validateShaderConstants'));
        }
        // Separate pass: literal localization keys (`NameKey = "Parts/Foo"`) that no strings file
        // declares. On by default, but only once the game `Data` tree is indexed: a mod referencing a
        // vanilla key would false-positive against the mod's own strings alone.
        if (settings.diagnostics?.validateLocalizationKeys && gameIndexAvailable()) {
            const localizationErrors = await timedPass('scan.vLocalizationMs', async () =>
                validateLocalizationKeys(parserResult.value, await searchFolderUris(), cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(localizationErrors, 'validateLocalizationKeys'));
        }

        // Separate pass: a path shaped field whose file or folder is not on disk. The asset check
        // finds a path by its extension, so a music track, a markov name file and the folder fields
        // a texture set or a ship library is read from go unchecked, even though the game resolves
        // every one of them while it loads. Ungated by the game index, since a relative path is read
        // against the folder of the file it is written in, which needs no game tree.
        if (settings.diagnostics?.validatePaths) {
            const pathErrors = await timedPass('scan.vPathMs', async () =>
                validatePathValues(parserResult.value, cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(pathErrors, 'validatePaths'));
        }
        // Separate pass: `,`/`;` separators that a line break already makes redundant. A token-level
        // scan, since separators never become AST nodes. Hint severity keeps the finding out of the
        // Problems panel (vanilla itself ships hundreds of trailing separators).
        if (settings.diagnostics?.validateRedundantSeparators) {
            validationErrors = validationErrors.concat(tagged(validateRedundantSeparators(tokens), 'validateRedundantSeparators'));
        }
        // Separate pass: a second member started on a line the member before it already owns, a second
        // reference hung on a field by a `,`, and a `*/` that closes no comment. All three are hard
        // load failures the parser cannot see, since the first two fold into a value and the third
        // lexes as an operator pair. Ungated, like the parser errors they belong with.
        validationErrors = validationErrors.concat(tagged(validateMissingSeparators(tokens), 'missing-separator'));
        validationErrors = validationErrors.concat(tagged(validateUnbracketedValueList(tokens), 'unbracketed-value-list'));
        validationErrors = validationErrors.concat(tagged(validateOrphanCommentTerminators(tokens), 'orphan-comment-terminator'));
        // Separate pass: block comments the game's scanner never closes (an even run of `*` before the
        // closing `/`), which swallow every rule between them and the next `*/`. Comments produce no
        // tokens, so it reads the spans the lexer collected alongside them.
        if (settings.diagnostics?.validateUnclosedComments) {
            validationErrors = validationErrors.concat(
                tagged(validateUnclosedComments(textDocument.getText(), blockComments), 'validateUnclosedComments')
            );
        }
        // Separate pass: a `/*` that no `*/` ever ends, which takes the rest of the file down with it.
        // Ungated: the file does not load at all, so it is a hard error rather than a lint.
        validationErrors = validationErrors.concat(
            tagged(validateUnterminatedComments(textDocument.getText(), blockComments), 'unterminated-comment')
        );
        // Separate pass: fields the game provably ignores (not a member of the resolved schema class
        // and never referenced in the file). Hint severity with a remove quick fix.
        if (settings.diagnostics?.validateIgnoredFields) {
            const ignoredFieldErrors = await validateIgnoredFields(parserResult.value, cancelToken).catch(() => []);
            validationErrors = validationErrors.concat(tagged(ignoredFieldErrors, 'validateIgnoredFields'));
        }
        // Separate pass: fields that restate the game's default, faded as dead weight with a remove
        // quick fix. Judged only inside groups that do not inherit, so an explicit default overriding
        // a base's value is never flagged.
        if (settings.diagnostics?.validateDefaultValues) {
            const defaultValueErrors = await timedPass('scan.vDefaultValueMs', () =>
                validateDefaultValuedFields(parserResult.value, cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(defaultValueErrors, 'validateDefaultValues'));
        }
        // Separate pass: SCREAMING_CASE constants no reference reads, chains of them included. Needs
        // the project's mention index to prove the name is spelled nowhere else, so it runs with the
        // same folder set the cross-file checks use.
        if (settings.diagnostics?.validateUnusedConstants) {
            const unusedConstantErrors = await timedPass('scan.vUnusedConstantMs', async () =>
                validateUnusedConstants(parserResult.value, await searchFolderUris(), cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(unusedConstantErrors, 'validateUnusedConstants'));
        }
        // Separate pass: field sets several files of the mod repeat verbatim, which could live in one
        // shared base file instead. Compares the file against the files it would share that base with,
        // so it runs with the same folder set the other cross-file checks use.
        if (settings.diagnostics?.validateDuplicateFields) {
            const duplicateFieldErrors = await timedPass('scan.vDuplicateFieldsMs', async () =>
                validateDuplicateFields(
                    parserResult.value,
                    textDocument.getText(),
                    await searchFolderUris(),
                    cancelToken,
                    await reachableFileFilter(cancelToken)
                ).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(duplicateFieldErrors, 'validateDuplicateFields'));
        }
        // Separate pass: the inverse question, a field whose value the group already inherits. Reads
        // the base files the document points at rather than the mod around it.
        if (settings.diagnostics?.validateRedundantOverrides) {
            const redundantOverrideErrors = await timedPass('scan.vRedundantOverrideMs', async () =>
                validateRedundantOverrides(parserResult.value, textDocument.getText(), cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(redundantOverrideErrors, 'validateRedundantOverrides'));
        }
        // Separate pass: part-grid values the part's own size puts out of the game's reach (a door
        // location off the perimeter ring, a blocked cell or a per-cell map key outside the part),
        // plus a `PhysicalRect` leaving the part, which the game throws on while reading it.
        if (settings.diagnostics?.validatePartGeometry) {
            const partGeometryErrors = await timedPass('scan.vPartGeometryMs', async () =>
                validatePartGeometry(parserResult.value, cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(partGeometryErrors, 'validatePartGeometry'));
        }

        // Separate pass: a sprite of a sprite list whose art the game stretches differently from the
        // way it stretches the rest of the list, which draws that one entry squashed or on its side.
        // No game index gate, since the pass reads the document it is given plus the art beside it.
        if (settings.diagnostics?.validateSpriteGeometry) {
            const spriteGeometryErrors = await timedPass('scan.vSpriteGeometryMs', async () =>
                validateSpriteGeometry(parserResult.value, cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(spriteGeometryErrors, 'validateSpriteGeometry'));
        }
        // Separate pass: a sprite naming a render layer the ship that draws it does not declare,
        // which the game throws on the first time it draws the part. Needs the game index: the ship
        // registry the scope is built from lives in the install's own root file.
        if (settings.diagnostics?.validateRenderLayers && gameIndexAvailable()) {
            const renderLayerErrors = await timedPass('scan.vRenderLayerMs', async () =>
                validateRenderLayers(parserResult.value, await shipLayerContext(), cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(renderLayerErrors, 'validateRenderLayers'));
        }
        // Separate pass: a particle data channel a file computes that nothing in the effect reads.
        // Needs the game index: a mod's effect usually takes its body from a vanilla `Def`, and
        // without that file every channel it writes would read as dropped.
        if (settings.diagnostics?.validateUnusedParticleChannels && gameIndexAvailable()) {
            const particleChannelErrors = await timedPass('scan.vParticleChannelMs', async () =>
                validateUnusedParticleChannels(parserResult.value, cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(
                tagged(particleChannelErrors, 'validateUnusedParticleChannels')
            );
        }
        // Separate pass: an id two files of this mod both register for one game collection, which
        // the game resolves by keeping one entry and dropping the rest. Needs the game index, like
        // the sibling cross-file checks, because the registration gate reads the rooting indexes.
        if (settings.diagnostics?.validateDuplicateIds && gameIndexAvailable()) {
            const duplicateIdErrors = await timedPass('scan.vDuplicateIdMs', async () =>
                validateDuplicateModIds(parserResult.value, await searchFolderPaths(), cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(duplicateIdErrors, 'validateDuplicateIds'));
        }
        // Separate pass: a buff modifier, clamp or toggle naming a buff its own part never receives.
        // Needs the game index: the part's receivable set is folded through an inheritance chain that
        // almost always runs into a vanilla base, and an unread chain makes the pass answer nothing.
        if (settings.diagnostics?.validateUnreceivableBuffs && gameIndexAvailable()) {
            const buffErrors = await timedPass('scan.vUnreceivableBuffMs', async () =>
                validateUnreceivableBuffs(parserResult.value, cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(buffErrors, 'validateUnreceivableBuffs'));
        }
        // Separate pass: a field a sibling switches off, faded with a remove fix. Reads the group
        // it is written in and nothing else, so it needs neither the game index nor the project.
        if (settings.diagnostics?.validateInertFields) {
            const inertFieldErrors = await timedPass('scan.vInertFieldMs', () =>
                validateInertFields(parserResult.value, cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(inertFieldErrors, 'validateInertFields'));
        }
        // Separate pass: one language strings file of the mod against the languages beside it.
        // Ungated by the game index: the comparison is between the mod's own files, and the
        // languages the base game ships are not complete either.
        if (settings.diagnostics?.validateLocalizationCoverage) {
            const coverageErrors = await timedPass('scan.vLocalizationCoverageMs', async () =>
                validateLocalizationCoverage(parserResult.value, await searchFolderPaths(), cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(coverageErrors, 'validateLocalizationCoverage'));
        }
        // Separate pass: a usage-defined category name that reads as a misspelling of one the
        // project writes everywhere. Needs the game index: the vocabulary a name is judged against
        // is mostly the game's own, and without it every vanilla category would look invented.
        if (settings.diagnostics?.validateMarkerVocabulary && gameIndexAvailable()) {
            const markerErrors = await timedPass('scan.vMarkerVocabularyMs', async () =>
                validateMarkerVocabulary(parserResult.value, await searchFolderPaths(), cancelToken).catch(() => [])
            );
            validationErrors = validationErrors.concat(tagged(markerErrors, 'validateMarkerVocabulary'));
        }
        // Separate pass: the media-effect bucket registry, whose duplicates and per-list caps the
        // engine throws on while it reads the file. Ungated by the game index: a repeated name and
        // an over-long list are both decided inside the document, and the one check that needs the
        // file to be the whole registry asks the rooting indexes itself.
        if (settings.diagnostics?.validateEffectBuckets) {
            const effectBucketErrors = await validateEffectBuckets(parserResult.value, cancelToken).catch(() => []);
            validationErrors = validationErrors.concat(tagged(effectBucketErrors, 'validateEffectBuckets'));
        }
        if (isModRules(textDocument.uri)) {
            // Separate pass: validate the manifest's action verbs/targets against the
            // effective game tree (the AstType-keyed Validator allows only one pass per type).
            const modActionErrors = await validateModActions(
                ModRulesRegistrar.instance.getActions(textDocument.uri),
                cancelToken
            ).catch(() => []);
            validationErrors = validationErrors.concat(tagged(modActionErrors, 'mod-action'));
            // Separate pass: a version-split `mod_*.rules` without `CompatibleGameVersions` is
            // never selected by the game when the mod has other manifest files.
            const manifestVersionErrors = await validateManifestVersion(parserResult.value, cancelToken).catch(
                () => []
            );
            validationErrors = validationErrors.concat(tagged(manifestVersionErrors, 'manifest-version'));
            // Separate pass: an action aiming at a node an installed mod already takes for
            // itself, which the game resolves by applying whichever mod's id sorts last.
            if (settings.diagnostics?.validateModConflicts) {
                const conflictErrors = await validateModConflicts(
                    ModRulesRegistrar.instance.getActions(textDocument.uri),
                    textDocument.uri,
                    cancelToken
                ).catch(() => []);
                validationErrors = validationErrors.concat(tagged(conflictErrors, 'validateModConflicts'));
            }
            // Separate pass: the manifest own metadata against what `Cosmoteer.Mods.ModInfo`
            // reads (a missing or malformed `ID`/`Name`, a field name that is a near miss of a
            // real one, a declared folder or logo that is not on disk).
            if (settings.diagnostics?.validateModManifest) {
                const modManifestErrors = await validateModManifest(parserResult.value, cancelToken).catch(() => []);
                validationErrors = validationErrors.concat(tagged(modManifestErrors, 'validateModManifest'));
            }
        } else if (gameIndexAvailable() && isActionFragmentDocument(parserResult.value)) {
            // An included action fragment (launcher.rules, register.rules) holds a literal `Actions`
            // list that a manifest concatenates via `Actions: &<file>/Actions`. Validate its actions
            // the same way (verbs, required fields, and targets resolved against the game root), so
            // its `AddTo`/`OverrideIn` paths are checked instead of misread as unresolved mod-relative
            // references. Gated on the game index being ready, since target resolution needs the game
            // tree (an unready tree would flag every real vanilla target as missing).
            const modActionErrors = await validateModActions(parseModActions(parserResult.value), cancelToken).catch(
                () => []
            );
            validationErrors = validationErrors.concat(tagged(modActionErrors, 'mod-action'));
        }
    } catch (e) {
        traceFailure(e);
    }
    if (!persist) perfCount('scan.validateMs', Date.now() - validateStarted);

    for (const error of validationErrors) {
        // A finding the pass could not place is dropped rather than published at the top of the
        // file. Reading a missing span as offset zero would put an underline on a line that has
        // nothing to do with it, and dereferencing one used to end the whole workspace pass.
        const span = findingSpanOf(error);
        if (!span) continue;
        problems++;
        if (problems > settings.maxNumberOfProblems) break;
        const diagnostic: Diagnostic = {
            severity: VALIDATION_SEVERITY[error.severity ?? 'error'],
            range: {
                start: textDocument.positionAt(span.start),
                end: textDocument.positionAt(span.end),
            },
            message: error.message,
            source: 'cosmoteer-language-server',
        };
        if (error.unnecessary) diagnostic.tags = [DiagnosticTag.Unnecessary];
        // Round-trip quick-fix data (e.g. "did you mean") to the code-action handler.
        if (error.data) diagnostic.data = error.data;
        // The rule the finding belongs to, which the lint reports group by and both editors show
        // beside the message so a reader can filter on it.
        if (error.code) diagnostic.code = error.code;
        if (hasDiagnosticRelatedInformationCapability && error.additionalInfo) {
            diagnostic.relatedInformation = [
                {
                    location: {
                        uri: textDocument.uri,
                        range: Object.assign({}, diagnostic.range),
                    },
                    message: error.additionalInfo,
                },
            ];
        }
        diagnostics.push(diagnostic);
    }
    if (cancelToken.isCancellationRequested) return [];
    return diagnostics;
}
