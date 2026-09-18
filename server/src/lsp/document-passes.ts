// The whole-document validator passes, as a table rather than as forty hand-copied call sites.
//
// Every pass used to be written out in validate-document.ts as its own four-line block, each one
// independently deciding whether to add a settings gate, a game-index gate, a perf counter and a
// `.catch`. Forty copies of a shape drift: two of them had ended up with another pass's comment
// above them. Here the gates and the counter are fields, the runner applies them once, and adding
// a pass is one row.
//
// ORDER IS BEHAVIOUR. Findings are published in the order the passes produce them and truncated at
// `maxNumberOfProblems`, so moving a row changes which findings a reader sees on a file that hits
// the cap. The rows are in the order the hand-written blocks ran in.

import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../core/ast/ast';
import { Token } from '../core/lexer/lexer';
import { BlockCommentSpan } from '../core/lexer/lexer';
import { CosmoteerSettings } from '../settings';
import type { RuleId } from '../features/diagnostics/rule-ids';
import { ValidationError } from '../features/diagnostics/validator';
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
import {
    validateChainedBuffReceivable,
    validateUnreceivableBuffs,
} from '../features/diagnostics/validator.unreceivable-buff';
import { validateEffectBuckets } from '../features/diagnostics/validator.effect-bucket';
import { validateUnderlyingParts } from '../features/diagnostics/validator.underlying-part';
import { validateBulletComponents } from '../features/diagnostics/validator.bullet-components';
import { validateValueRanges } from '../features/diagnostics/validator.value-range';
import { validateDivisionByZero } from '../features/diagnostics/validator.division-by-zero';
import { validateColorValues } from '../features/color/validator.color-value';
import { validateTextMarkup } from '../features/diagnostics/validator.text-markup';
import { validateChainedToCycles } from '../features/diagnostics/validator.chained-to-cycle';
import { validateGalaxyGenerators } from '../features/diagnostics/validator.galaxy-generator';
import { validateStorageCycles } from '../features/diagnostics/validator.storage-cycle';
import { validateNumericDomains } from '../features/diagnostics/validator.numeric-domain';
import { validateResourcePickups } from '../features/diagnostics/validator.resource-pickup';
import { validateMishandledFields } from '../features/diagnostics/validator.mishandled-field';
import { validateRefusedEnumValues } from '../features/diagnostics/validator.refused-enum-value';
import { validateBlendSpriteCodes } from '../features/diagnostics/validator.blend-sprite';
import { validateIndicatorIndexes } from '../features/diagnostics/validator.indicator-index';
import { validateMarkerVocabulary } from '../features/diagnostics/validator.marker-vocabulary';
import { validateLocalizationCoverage } from '../features/diagnostics/validator.localization-coverage';
import { validateInertFields } from '../features/diagnostics/validator.inert-field';
import { validateModConflicts } from '../features/diagnostics/validator.mod-conflict';
import { validateActionEntries, validateModActions } from '../features/diagnostics/validator.mod-action';
import { validateManifestVersion } from '../features/diagnostics/validator.manifest-version';
import { validateModManifest } from '../features/diagnostics/validator.mod-manifest';
import { TemplateBaseIndex } from '../workspace/template-base.index';
import { ModRulesRegistrar } from '../mod/mod-rules.registrar';
import { findActionsList, parseModActions } from '../mod/action-parser';

/** The diagnostics settings that switch a pass on, which is every boolean key but the two scope ones. */
export type DiagnosticSettingKey = {
    [Key in keyof CosmoteerSettings['diagnostics']]: CosmoteerSettings['diagnostics'][Key] extends boolean
        ? Key
        : never;
}[keyof CosmoteerSettings['diagnostics']];

/**
 * Which documents a pass is written for. Most read any `.rules` file; the manifest ones only run on
 * a `mod.rules`, and the action pass also covers an included fragment that holds a literal `Actions`
 * list a manifest concatenates.
 */
export type PassScope = 'anyDocument' | 'modRules' | 'modRulesOrActionFragment';

/** Everything a pass may need, built once per document and shared by all of them. */
export interface PassContext {
    readonly document: AbstractNodeDocument;
    readonly uri: string;
    /** The document's full text, for the passes that judge characters rather than nodes. */
    readonly text: string;
    /** The lexed tokens, for the separator passes: separators never become AST nodes. */
    readonly tokens: Token[];
    /** The comment spans the lexer collected, which produce no tokens either. */
    readonly blockComments: BlockCommentSpan[];
    readonly cancelToken: CancellationToken;
    /** True for the open-document flow, false for the bulk pass over unopened files. */
    readonly persist: boolean;
    /** True for a `mod.rules`, false for an included action fragment that holds an `Actions` list. */
    readonly isManifest: boolean;
    folderUris(): Promise<string[]>;
    folderPaths(): Promise<string[]>;
    shipLayers(): Promise<Parameters<typeof validateRenderLayers>[1]>;
    reachableFiles(): Promise<((fsPath: string) => boolean) | undefined>;
    /** Republishes this document's diagnostics once a pass's cross-file work lands. */
    refreshOpenDocument(): (() => void) | undefined;
}

/** One whole-document validator pass, with the gates the runner applies to it. */
export interface DocumentPass {
    /** The rule id every finding of this pass is stamped with, from features/diagnostics/rule-ids.ts. */
    readonly code: RuleId;
    /** The setting that switches it off, absent for a pass that always runs. */
    readonly setting?: DiagnosticSettingKey;
    /** True when the pass would false-positive without the game's own `Data` tree indexed. */
    readonly needsGameIndex?: boolean;
    /** The perf counter the bulk scan accumulates this pass's wall time into. */
    readonly counter?: string;
    /** Which documents it is written for. Defaults to any `.rules` file. */
    readonly scope?: PassScope;
    run(context: PassContext): ValidationError[] | Promise<ValidationError[]>;
}

/**
 * The actions of a manifest or of an included fragment, whichever this document is. A manifest's
 * actions are registered while it is read; a fragment's are parsed from its own `Actions` list.
 *
 * @param context the pass context.
 * @returns the actions to validate.
 */
const actionsOf = (context: PassContext) =>
    context.isManifest ? ModRulesRegistrar.instance.getActions(context.uri) : parseModActions(context.document);

export const DOCUMENT_PASSES: readonly DocumentPass[] = [
    // Top-level duplicate keys span sibling elements (each validated on its own by the node-level
    // registry), so this one needs the whole-document view.
    {
        code: 'document-duplicate',
        run: async ({ document, cancelToken }) => {
            const found = await ValidationForDocumentDuplicates.callback(document, cancelToken);
            return found ? [found] : [];
        },
    },
    // Inheritance cycles span multiple nodes and files.
    {
        code: 'inheritance-cycle',
        counter: 'scan.vCyclesMs',
        run: ({ document, cancelToken }) => validateInheritanceCycles(document, cancelToken),
    },
    // `{`/`[` blocks that open with no name in front of them outside a list, which the game refuses
    // to load. Needs the sibling view of a whole scope, like the duplicate pass.
    {
        code: 'anonymous-block',
        run: ({ document, cancelToken }) => validateAnonymousBlocks(document, cancelToken),
    },
    // Schema-driven checks (currently invalid enum values). Self-gates to non-mod `.rules` files.
    {
        code: 'schema',
        counter: 'scan.vSchemaMs',
        run: ({ document, cancelToken }) => validateSchema(document, cancelToken),
    },
    // Schema `ID<…>` component references that name no component in the part. On by default, but
    // only once the game `Data` tree is indexed: the part-wide id union folds in inherited vanilla
    // bases, which cannot resolve without the install.
    {
        code: 'validateComponentReferences',
        setting: 'validateComponentReferences',
        needsGameIndex: true,
        counter: 'scan.vSiblingMs',
        run: ({ document, cancelToken }) => validateSchemaSiblingReferences(document, cancelToken),
    },
    // Cross-file `ID<…>` references (GUI toggle/color/targeter/trigger ids) whose id names no
    // declaration in the project. Needs the game index: without it, a reference to a
    // vanilla-declared id would be a false positive.
    {
        code: 'validateCrossFileReferences',
        setting: 'validateCrossFileReferences',
        needsGameIndex: true,
        counter: 'scan.vCrossFileMs',
        run: async (context) =>
            validateCrossFileIdReferences(context.document, await context.folderUris(), context.cancelToken),
    },
    // Groups missing a schema-required field, checked through the inheritance chain. Optional-field
    // detection (constructor defaults, nullable types, collections) closed the false positives, and
    // the pass skips any group whose chain does not fully resolve, so an unindexed vanilla base
    // cannot produce a finding. The engine-injected fields that have no static trace are named in
    // the validator's `RUNTIME_REQUIRED_ALLOWLIST`.
    {
        code: 'validateRequiredFields',
        setting: 'validateRequiredFields',
        counter: 'scan.vRequiredMs',
        run: async (context) => {
            // The project-wide set of inheritance-base names lets the check skip cross-file
            // templates (a `BASE_*` group inherited by other files) that a single-file scan would
            // false-positive.
            const workspaceBaseNames = await TemplateBaseIndex.instance
                .baseNames(await context.folderUris(), context.cancelToken)
                .catch(() => undefined);
            return validateRequiredFields(context.document, context.cancelToken, workspaceBaseNames);
        },
    },
    // Inline `_`-prefixed shader constants a material sets, checked against the uniforms its
    // `.shader` declares. The game itself ships a few constant keys its shaders never read, so those
    // are suppressed by name in the validator's `VANILLA_DEAD_KEYS`.
    {
        code: 'validateShaderConstants',
        setting: 'validateShaderConstants',
        run: ({ document, cancelToken }) => validateShaderConstants(document, cancelToken),
    },
    // Literal localization keys (`NameKey = "Parts/Foo"`) that no strings file declares. Needs the
    // game index: a mod referencing a vanilla key would false-positive against the mod's own
    // strings alone.
    {
        code: 'validateLocalizationKeys',
        setting: 'validateLocalizationKeys',
        needsGameIndex: true,
        counter: 'scan.vLocalizationMs',
        run: async (context) =>
            validateLocalizationKeys(context.document, await context.folderUris(), context.cancelToken),
    },
    // A path shaped field whose file or folder is not on disk. The asset check finds a path by its
    // extension, so a music track, a markov name file and the folder fields a texture set or a ship
    // library is read from go unchecked, even though the game resolves every one of them while it
    // loads. Ungated by the game index, since a relative path is read against the folder of the file
    // it is written in, which needs no game tree.
    {
        code: 'validatePaths',
        setting: 'validatePaths',
        counter: 'scan.vPathMs',
        run: ({ document, cancelToken }) => validatePathValues(document, cancelToken),
    },
    // `,`/`;` separators that a line break already makes redundant. A token-level scan, since
    // separators never become AST nodes. Hint severity keeps the finding out of the Problems panel
    // (vanilla itself ships hundreds of trailing separators).
    {
        code: 'validateRedundantSeparators',
        setting: 'validateRedundantSeparators',
        run: ({ tokens }) => validateRedundantSeparators(tokens),
    },
    // A second member started on a line the member before it already owns, a second reference hung
    // on a field by a `,`, and a `*/` that closes no comment. All three are hard load failures the
    // parser cannot see, since the first two fold into a value and the third lexes as an operator
    // pair. Ungated, like the parser errors they belong with.
    { code: 'missing-separator', run: ({ tokens }) => validateMissingSeparators(tokens) },
    { code: 'unbracketed-value-list', run: ({ tokens }) => validateUnbracketedValueList(tokens) },
    { code: 'orphan-comment-terminator', run: ({ tokens }) => validateOrphanCommentTerminators(tokens) },
    // Block comments the game's scanner never closes (an even run of `*` before the closing `/`),
    // which swallow every rule between them and the next `*/`. Comments produce no tokens, so it
    // reads the spans the lexer collected alongside them.
    {
        code: 'validateUnclosedComments',
        setting: 'validateUnclosedComments',
        run: ({ text, blockComments }) => validateUnclosedComments(text, blockComments),
    },
    // A `/*` that no `*/` ever ends, which takes the rest of the file down with it. Ungated: the
    // file does not load at all, so it is a hard error rather than a lint.
    {
        code: 'unterminated-comment',
        run: ({ text, blockComments }) => validateUnterminatedComments(text, blockComments),
    },
    // Fields the game provably ignores (not a member of the resolved schema class and never
    // referenced in the file). Hint severity with a remove quick fix.
    {
        code: 'validateIgnoredFields',
        setting: 'validateIgnoredFields',
        run: ({ document, cancelToken }) => validateIgnoredFields(document, cancelToken),
    },
    // Fields that restate the game's default, faded as dead weight with a remove quick fix. Judged
    // only inside groups that do not inherit, so an explicit default overriding a base's value is
    // never flagged.
    {
        code: 'validateDefaultValues',
        setting: 'validateDefaultValues',
        counter: 'scan.vDefaultValueMs',
        run: ({ document, cancelToken }) => validateDefaultValuedFields(document, cancelToken),
    },
    // SCREAMING_CASE constants no reference reads, chains of them included. Needs the project's
    // mention index to prove the name is spelled nowhere else, so it runs with the same folder set
    // the cross-file checks use.
    {
        code: 'validateUnusedConstants',
        setting: 'validateUnusedConstants',
        counter: 'scan.vUnusedConstantMs',
        run: async (context) =>
            validateUnusedConstants(context.document, await context.folderUris(), context.cancelToken),
    },
    // Field sets several files of the mod repeat verbatim, which could live in one shared base file
    // instead. Compares the file against the files it would share that base with, so it runs with
    // the same folder set the other cross-file checks use.
    {
        code: 'validateDuplicateFields',
        setting: 'validateDuplicateFields',
        counter: 'scan.vDuplicateFieldsMs',
        run: async (context) =>
            validateDuplicateFields(
                context.document,
                context.text,
                await context.folderUris(),
                context.cancelToken,
                await context.reachableFiles(),
                context.refreshOpenDocument()
            ),
    },
    // The inverse question, a field whose value the group already inherits. Reads the base files the
    // document points at rather than the mod around it.
    {
        code: 'validateRedundantOverrides',
        setting: 'validateRedundantOverrides',
        counter: 'scan.vRedundantOverrideMs',
        run: ({ document, text, cancelToken }) => validateRedundantOverrides(document, text, cancelToken),
    },
    // Part-grid values the part's own size puts out of the game's reach (a door location off the
    // perimeter ring, a blocked cell or a per-cell map key outside the part), plus a `PhysicalRect`
    // leaving the part, which the game throws on while reading it.
    {
        code: 'validatePartGeometry',
        setting: 'validatePartGeometry',
        counter: 'scan.vPartGeometryMs',
        run: ({ document, cancelToken }) => validatePartGeometry(document, cancelToken),
    },
    // A sprite of a sprite list whose art the game stretches differently from the way it stretches
    // the rest of the list, which draws that one entry squashed or on its side. No game index gate,
    // since the pass reads the document it is given plus the art beside it.
    {
        code: 'validateSpriteGeometry',
        setting: 'validateSpriteGeometry',
        counter: 'scan.vSpriteGeometryMs',
        run: ({ document, cancelToken }) => validateSpriteGeometry(document, cancelToken),
    },
    // A sprite naming a render layer the ship that draws it does not declare, which the game throws
    // on the first time it draws the part. Needs the game index: the ship registry the scope is
    // built from lives in the install's own root file.
    {
        code: 'validateRenderLayers',
        setting: 'validateRenderLayers',
        needsGameIndex: true,
        counter: 'scan.vRenderLayerMs',
        run: async (context) => validateRenderLayers(context.document, await context.shipLayers(), context.cancelToken),
    },
    // A particle data channel a file computes that nothing in the effect reads. Needs the game
    // index: a mod's effect usually takes its body from a vanilla `Def`, and without that file every
    // channel it writes would read as dropped.
    {
        code: 'validateUnusedParticleChannels',
        setting: 'validateUnusedParticleChannels',
        needsGameIndex: true,
        counter: 'scan.vParticleChannelMs',
        run: ({ document, cancelToken }) => validateUnusedParticleChannels(document, cancelToken),
    },
    // An id two files of this mod both register for one game collection, which the game resolves by
    // keeping one entry and dropping the rest. Needs the game index, like the sibling cross-file
    // checks, because the registration gate reads the rooting indexes.
    {
        code: 'validateDuplicateIds',
        setting: 'validateDuplicateIds',
        needsGameIndex: true,
        counter: 'scan.vDuplicateIdMs',
        run: async (context) =>
            validateDuplicateModIds(context.document, await context.folderPaths(), context.cancelToken),
    },
    // A buff modifier, clamp or toggle naming a buff its own part never receives. Needs the game
    // index: the part's receivable set is folded through an inheritance chain that almost always
    // runs into a vanilla base, and an unread chain makes the pass answer nothing.
    {
        code: 'validateUnreceivableBuffs',
        setting: 'validateUnreceivableBuffs',
        needsGameIndex: true,
        counter: 'scan.vUnreceivableBuffMs',
        run: ({ document, cancelToken }) => validateUnreceivableBuffs(document, cancelToken),
    },
    // A field a sibling switches off, faded with a remove fix. Reads the group it is written in and
    // nothing else, so it needs neither the game index nor the project.
    {
        code: 'validateInertFields',
        setting: 'validateInertFields',
        counter: 'scan.vInertFieldMs',
        run: ({ document, cancelToken }) => validateInertFields(document, cancelToken),
    },
    // One language strings file of the mod against the languages beside it. Ungated by the game
    // index: the comparison is between the mod's own files, and the languages the base game ships
    // are not complete either.
    {
        code: 'validateLocalizationCoverage',
        setting: 'validateLocalizationCoverage',
        counter: 'scan.vLocalizationCoverageMs',
        run: async (context) =>
            validateLocalizationCoverage(context.document, await context.folderPaths(), context.cancelToken),
    },
    // A usage-defined category name that reads as a misspelling of one the project writes
    // everywhere. Needs the game index: the vocabulary a name is judged against is mostly the
    // game's own, and without it every vanilla category would look invented.
    {
        code: 'validateMarkerVocabulary',
        setting: 'validateMarkerVocabulary',
        needsGameIndex: true,
        counter: 'scan.vMarkerVocabularyMs',
        run: async (context) =>
            validateMarkerVocabulary(context.document, await context.folderPaths(), context.cancelToken),
    },
    // An indicator hiding an index its own list does not have, which the game answers at load time
    // with a message that names no indicator, or with no message at all. Decided inside the
    // document, so it needs neither the game index nor the rooting indexes.
    {
        code: 'validateIndicatorIndexes',
        setting: 'validateIndicatorIndexes',
        run: ({ document, cancelToken }) => validateIndicatorIndexes(document, cancelToken),
    },
    // A situation code the blend sprite expander refuses. The character rule needs only the text, so
    // it covers the template groups the codes are shared through, and the length rule asks the
    // schema for the list it is written in.
    {
        code: 'validateBlendSpriteCodes',
        setting: 'validateBlendSpriteCodes',
        run: ({ document, cancelToken }) => validateBlendSpriteCodes(document, cancelToken),
    },
    // An enum member the consuming class refuses, which the schema cannot express since it types the
    // field by its enum. Decided from the group class and the written member, so it needs nothing
    // outside the document.
    {
        code: 'validateRefusedEnumValues',
        setting: 'validateRefusedEnumValues',
        run: ({ document, cancelToken }) => validateRefusedEnumValues(document, cancelToken),
    },
    // A field the reader takes and acts on wrongly, which loads without a word and leaves the game
    // doing something other than what the file says. Keyed by the exact class, since each of these
    // fields has a sibling class that reads it correctly.
    {
        code: 'validateMishandledFields',
        setting: 'validateMishandledFields',
        run: ({ document, cancelToken }) => validateMishandledFields(document, cancelToken),
    },
    // A component chain that closes, read off the part component dictionary the engine resolves a
    // chain against. Folds the group through its bases, so it stays silent on a part whose
    // components it could not read in full.
    {
        code: 'validateChainedToCycles',
        setting: 'validateChainedToCycles',
        run: ({ document, cancelToken }) => validateChainedToCycles(document, cancelToken),
    },
    // A pickup size above the stack of the resource it hands out. Reads the stack out of the
    // resource file the id names, so it needs the game index and the project folders.
    {
        code: 'validateResourcePickups',
        setting: 'validateResourcePickups',
        needsGameIndex: true,
        run: async (context) =>
            validateResourcePickups(context.document, await context.folderPaths(), context.cancelToken),
    },
    // A number the reading class refuses, from a table keyed by the exact class. Folds each group
    // it judges, so a value supplied by a base counts and an unreadable chain says nothing.
    {
        code: 'validateNumericDomains',
        setting: 'validateNumericDomains',
        run: ({ document, cancelToken }) => validateNumericDomains(document, cancelToken),
    },
    // A storage composed out of itself, read off the same part component dictionary the chain
    // check walks. Folds the group through its bases, so it stays silent on a part whose
    // components it could not read in full.
    {
        code: 'validateStorageCycles',
        setting: 'validateStorageCycles',
        run: ({ document, cancelToken }) => validateStorageCycles(document, cancelToken),
    },
    // A galaxy generator that loads and then builds a map the game cannot use. Resolves every
    // element of the `Spawners` list, including the ones written as a reference into another file,
    // and says nothing at all about a list it could not read in full.
    {
        code: 'validateGalaxyGenerators',
        setting: 'validateGalaxyGenerators',
        run: ({ document, cancelToken }) => validateGalaxyGenerators(document, cancelToken),
    },
    // A colour written as one word that names no colour the engine knows. Its reader answers that
    // with an exception that takes the whole data tree down, so the game does not start at all.
    {
        code: 'validateColorValues',
        setting: 'validateColorValues',
        run: ({ document }) => validateColorValues(document),
    },
    // A language file string the markup reader refuses, which the game answers silently by drawing
    // the tags themselves. Judged on a mod's own language files only, since the game's translations
    // are not the author's to correct.
    {
        code: 'validateTextMarkup',
        setting: 'validateTextMarkup',
        run: async (context) => validateTextMarkup(context.document, await context.folderUris(), context.cancelToken),
    },
    // A range whose direction its consumer refuses. Kept out of the schema pass, which sees the
    // field but not the class reading it, and ordering is only a mistake where the consumer rolls or
    // compares rather than interpolates.
    {
        code: 'validateValueRanges',
        setting: 'validateValueRanges',
        run: ({ document, cancelToken }) => validateValueRanges(document, cancelToken),
    },
    // A numeric value that divides by zero. Needs the field's type to say whether the game stores
    // the NaN or refuses the file over it, and resolves only the values that divide at all.
    {
        code: 'validateDivisionByZero',
        setting: 'validateDivisionByZero',
        run: ({ document, cancelToken }) => validateDivisionByZero(document, cancelToken),
    },
    // A provider chaining from a buff the part cannot receive, which the game answers by refusing
    // the whole data tree. Kept apart from the buff hints above, which are lint-level, so a reader
    // turning those down does not lose a load failure.
    {
        code: 'validateChainedBuffReceivable',
        setting: 'validateChainedBuffReceivable',
        run: ({ document, cancelToken }) => validateChainedBuffReceivable(document, cancelToken),
    },
    // A bullet component set the game cannot build. Judged on the merged order, since a base
    // contributes its members first and a derived file re-declaring the physics component moves it
    // behind everything written above it.
    {
        code: 'validateBulletComponents',
        setting: 'validateBulletComponents',
        run: ({ document, cancelToken }) => validateBulletComponents(document, cancelToken),
    },
    // A part naming itself as its own underlying replacement. Only the self-naming shape is judged,
    // since the part table the game walks is built per ship and joining two parts by name alone
    // could invent an edge between ships that never share one.
    {
        code: 'validateUnderlyingParts',
        setting: 'validateUnderlyingParts',
        run: ({ document, cancelToken }) => validateUnderlyingParts(document, cancelToken),
    },
    // The media-effect bucket registry, whose duplicates and per-list caps the engine throws on
    // while it reads the file. Ungated by the game index: a repeated name and an over-long list are
    // both decided inside the document, and the one check that needs the file to be the whole
    // registry asks the rooting indexes itself.
    {
        code: 'validateEffectBuckets',
        setting: 'validateEffectBuckets',
        run: ({ document, cancelToken }) => validateEffectBuckets(document, cancelToken),
    },
    // The action verbs and targets against the effective game tree, plus an entry of the `Actions`
    // list that is not a `{ }` group, which the manifest reader cannot read as an action. The entry
    // check runs off the list itself, since such an entry never reaches the parsed actions.
    //
    // An included action fragment (launcher.rules, register.rules) holds a literal `Actions` list
    // that a manifest concatenates via `Actions: &<file>/Actions`. It is validated the same way, so
    // its `AddTo`/`OverrideIn` paths are checked instead of misread as unresolved mod-relative
    // references. The fragment case needs the game index, since target resolution needs the game
    // tree; an unready tree would flag every real vanilla target as missing.
    {
        code: 'mod-action',
        scope: 'modRulesOrActionFragment',
        run: async (context) => {
            const actionErrors = await validateModActions(actionsOf(context), context.cancelToken, context.text).catch(
                (): ValidationError[] => []
            );
            return actionErrors.concat(validateActionEntries(findActionsList(context.document)));
        },
    },
    // A version-split `mod_*.rules` without `CompatibleGameVersions` is never selected by the game
    // when the mod has other manifest files.
    {
        code: 'manifest-version',
        scope: 'modRules',
        run: ({ document, cancelToken }) => validateManifestVersion(document, cancelToken),
    },
    // An action aiming at a node an installed mod already takes for itself, which the game resolves
    // by applying whichever mod's id sorts last.
    {
        code: 'validateModConflicts',
        setting: 'validateModConflicts',
        scope: 'modRules',
        run: (context) =>
            validateModConflicts(ModRulesRegistrar.instance.getActions(context.uri), context.uri, context.cancelToken),
    },
    // The manifest's own metadata against what `Cosmoteer.Mods.ModInfo` reads (a missing or
    // malformed `ID`/`Name`, a field name that is a near miss of a real one, a declared folder or
    // logo that is not on disk).
    {
        code: 'validateModManifest',
        setting: 'validateModManifest',
        scope: 'modRules',
        run: ({ document, cancelToken }) => validateModManifest(document, cancelToken),
    },
];
