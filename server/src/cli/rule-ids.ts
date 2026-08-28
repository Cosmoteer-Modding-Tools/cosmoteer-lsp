import type { CosmoteerSettings } from '../settings';

// The rule identities the lint reports carry. A rule id is a public contract the moment a SARIF
// file reaches a code scanning service: the service keys an alert on it, so renaming one closes
// every alert of the old name and opens a fresh one for each finding. Ids are therefore added, and
// never renamed. Where a pass has a setting that switches it off, the setting key is the id, so a
// reader can turn a reported rule off without a lookup table.

/** The severities a finding can carry, most severe first. Mirrors the four the editor shows. */
export type LintSeverity = 'error' | 'warning' | 'info' | 'hint';

/** Severities in ranking order, so a threshold can be compared by index. */
export const SEVERITY_ORDER: readonly LintSeverity[] = ['error', 'warning', 'info', 'hint'];

/**
 * Whether a severity is at least as severe as a threshold.
 *
 * @param severity the finding's severity.
 * @param threshold the threshold to compare against.
 * @returns true when the finding is at or above the threshold.
 */
export const atLeastAsSevere = (severity: LintSeverity, threshold: LintSeverity): boolean =>
    SEVERITY_ORDER.indexOf(severity) <= SEVERITY_ORDER.indexOf(threshold);

/** The keys of `diagnostics` that switch a validation pass on or off. */
type PassSettingKey = Exclude<
    {
        [K in keyof CosmoteerSettings['diagnostics']]: CosmoteerSettings['diagnostics'][K] extends boolean ? K : never;
    }[keyof CosmoteerSettings['diagnostics']],
    'validateWholeWorkspace'
>;

/** One reportable rule: what it checks, how severe its findings usually are, and what gates it. */
interface LintRule {
    /** The stable identity that appears in every report. */
    id: string;
    /** A short name for a report header, in the wording the settings use. */
    title: string;
    /** One sentence saying what the pass reports, for readers who never opened the editor. */
    description: string;
    /** The severity most of the pass's findings carry, used as the SARIF default configuration. */
    defaultLevel: LintSeverity;
    /** The setting that switches the pass off, when it has one. */
    setting?: PassSettingKey;
    /** Whether the pass only runs once the game `Data` tree is indexed. */
    needsGameData: boolean;
}

/**
 * The rule a finding falls back to when the server did not name one. Older server builds do not
 * tag their findings, and a report that silently dropped those findings would be worse than one
 * that groups them, so they are collected here and the text report says how many there were.
 */
export const UNTAGGED_RULE_ID = 'unnamed-check';

export const RULES: readonly LintRule[] = [
    {
        id: 'parse-error',
        title: 'Parse error',
        description: 'The file does not parse, so the game refuses to load it.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'syntax-and-references',
        title: 'Values and references',
        description:
            'The checks that run over every element of a file: references that resolve to nothing, asset paths that are not on disk or are written unquoted, math expressions and function calls, assignment shape, and a key written twice in one group.',
        defaultLevel: 'warning',
        needsGameData: false,
    },
    {
        id: 'document-duplicate',
        title: 'Duplicate top-level key',
        description: 'A key written twice at the top level of a file, where only the last one takes effect.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'inheritance-cycle',
        title: 'Circular inheritance',
        description: 'A chain of bases that leads back to where it started, which the game cannot resolve.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'reference-cycle',
        title: 'Circular reference',
        description: 'A reference whose chain leads back to itself, so the value it stands for can never be computed.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'anonymous-block',
        title: 'Block without a name',
        description: 'A `{` or `[` block opened with no name in front of it outside a list.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'schema',
        title: 'Schema',
        description: 'A value the game reads into a typed field that cannot hold it, such as an unknown enum name.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'missing-separator',
        title: 'Missing separator',
        description: 'A second member started on a line the member before it already owns, which folds into a value.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'unbracketed-value-list',
        title: 'Unbracketed value list',
        description: 'A second reference hung on a field by a comma, which the game reads as one value.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'orphan-comment-terminator',
        title: 'Stray comment terminator',
        description: 'A `*/` that closes no comment.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'unterminated-comment',
        title: 'Unterminated comment',
        description: 'A `/*` that no `*/` ever ends, which takes the rest of the file down with it.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'mod-action',
        title: 'Mod action',
        description:
            'A manifest action, or an action list a manifest includes: an unknown verb, a missing required field, a target that resolves to nothing, and a source or target of the wrong shape.',
        defaultLevel: 'error',
        needsGameData: false,
    },
    {
        id: 'manifest-version',
        title: 'Manifest game version',
        description:
            'A version-split `mod_*.rules` without `CompatibleGameVersions`, which the game never selects when the mod ships other manifests.',
        defaultLevel: 'warning',
        needsGameData: false,
    },
    {
        id: 'validateComponentReferences',
        title: 'Component references',
        description: 'A component `ID<…>` reference naming no component in the part or in a base it inherits.',
        defaultLevel: 'warning',
        setting: 'validateComponentReferences',
        needsGameData: true,
    },
    {
        id: 'validateCrossFileReferences',
        title: 'Cross-file ids',
        description: 'A toggle, colour, targeter or trigger id that no file in the project declares.',
        defaultLevel: 'warning',
        setting: 'validateCrossFileReferences',
        needsGameData: true,
    },
    {
        id: 'validateUndeclaredDependencies',
        title: 'Undeclared dependencies',
        description:
            'An id this project only resolves because another installed mod declares it, while the manifest does not list that mod under Dependencies.',
        defaultLevel: 'info',
        setting: 'validateUndeclaredDependencies',
        needsGameData: true,
    },
    {
        id: 'validateRequiredFields',
        title: 'Required fields',
        description: 'A group missing a field the game requires, checked through its whole inheritance chain.',
        defaultLevel: 'error',
        setting: 'validateRequiredFields',
        needsGameData: false,
    },
    {
        id: 'validateShaderConstants',
        title: 'Shader constants',
        description: 'An inline `_`-prefixed constant a material sets that its `.shader` declares no uniform for.',
        defaultLevel: 'warning',
        setting: 'validateShaderConstants',
        needsGameData: false,
    },
    {
        id: 'validateShaderCode',
        title: 'Shader code',
        description: 'An `#include` that is not on disk, an undeclared uniform read, or a call to no known function.',
        defaultLevel: 'warning',
        setting: 'validateShaderCode',
        needsGameData: false,
    },
    {
        id: 'validateLocalizationKeys',
        title: 'Localization keys',
        description: 'A localization key that no language strings file in the project declares.',
        defaultLevel: 'warning',
        setting: 'validateLocalizationKeys',
        needsGameData: true,
    },
    {
        id: 'validatePaths',
        title: 'Paths',
        description:
            'A path-shaped field whose file or folder is not on disk, covering the paths the asset check cannot recognise by extension.',
        defaultLevel: 'warning',
        setting: 'validatePaths',
        needsGameData: false,
    },
    {
        id: 'validateRedundantSeparators',
        title: 'Redundant separators',
        description: 'A `,` or `;` that a line break already makes unnecessary.',
        defaultLevel: 'hint',
        setting: 'validateRedundantSeparators',
        needsGameData: false,
    },
    {
        id: 'validateUnclosedComments',
        title: 'Unclosed block comments',
        description:
            'A block comment the game leaves open, because it closes one only on an odd run of `*` before the `/`.',
        defaultLevel: 'warning',
        setting: 'validateUnclosedComments',
        needsGameData: false,
    },
    {
        id: 'validateIgnoredFields',
        title: 'Ignored fields',
        description: 'A field the game provably never reads, and that no reference in the file reads either.',
        defaultLevel: 'hint',
        setting: 'validateIgnoredFields',
        needsGameData: false,
    },
    {
        id: 'validateDefaultValues',
        title: 'Default values',
        description: 'A field that restates the game default, so deleting it changes nothing.',
        defaultLevel: 'hint',
        setting: 'validateDefaultValues',
        needsGameData: false,
    },
    {
        id: 'validateUnusedConstants',
        title: 'Unused constants',
        description: 'A SCREAMING_CASE constant that nothing in the project reads, chains of them included.',
        defaultLevel: 'hint',
        setting: 'validateUnusedConstants',
        needsGameData: false,
    },
    {
        id: 'validateDuplicateFields',
        title: 'Duplicated field sets',
        description: 'A group whose fields several other files of the mod write word for word.',
        defaultLevel: 'hint',
        setting: 'validateDuplicateFields',
        needsGameData: false,
    },
    {
        id: 'validateRedundantOverrides',
        title: 'Redundant overrides',
        description: 'A field whose value the group already inherits.',
        defaultLevel: 'hint',
        setting: 'validateRedundantOverrides',
        needsGameData: false,
    },
    {
        id: 'validatePartGeometry',
        title: 'Part geometry',
        description:
            'A part-grid value the part own size puts out of reach, such as a door location that is not a cell beside the part, or a door presence toggle whose cell is inside the part.',
        defaultLevel: 'hint',
        setting: 'validatePartGeometry',
        needsGameData: false,
    },
    {
        id: 'validateSpriteGeometry',
        title: 'Sprite geometry',
        description: 'A damage level whose art is stretched differently from the other levels of its own list.',
        defaultLevel: 'hint',
        setting: 'validateSpriteGeometry',
        needsGameData: false,
    },
    {
        id: 'validateRenderLayers',
        title: 'Render layers',
        description:
            'A sprite naming a render layer the ship that draws it does not declare, which the game throws on the first time the part is drawn.',
        defaultLevel: 'warning',
        setting: 'validateRenderLayers',
        needsGameData: true,
    },
    {
        id: 'validateUnusedParticleChannels',
        title: 'Unused particle channels',
        description:
            'A particle data channel a file computes that nothing in the effect ever reads, which is what a channel name misspelled on one side of the pair leaves behind.',
        defaultLevel: 'hint',
        setting: 'validateUnusedParticleChannels',
        needsGameData: true,
    },
    {
        id: 'validateModConflicts',
        title: 'Mod conflicts',
        description:
            'A manifest action aiming at a node an installed mod already replaces, removes or writes, where the game applies only the last of the two.',
        defaultLevel: 'info',
        setting: 'validateModConflicts',
        needsGameData: false,
    },
    {
        id: 'validateInertFields',
        title: 'Fields a sibling switches off',
        description:
            'A field the game stops reading because of what a sibling in the same group says, such as a converter quantity written beside the list form rather than beside the storage shorthand.',
        defaultLevel: 'hint',
        setting: 'validateInertFields',
        needsGameData: false,
    },
    {
        id: 'validateLocalizationCoverage',
        title: 'Localization coverage',
        description:
            'A language of the mod that declares fewer keys than the languages beside it, and a translation whose placeholder slots do not match the English text.',
        defaultLevel: 'hint',
        setting: 'validateLocalizationCoverage',
        needsGameData: false,
    },
    {
        id: 'validateMarkerVocabulary',
        title: 'Marker vocabulary',
        description:
            'A usage-defined name (a part category, a part feature, a ship tag) written once in the project that is one typing slip from a name several files write.',
        defaultLevel: 'hint',
        setting: 'validateMarkerVocabulary',
        needsGameData: true,
    },
    {
        id: 'validateEffectBuckets',
        title: 'Effect buckets',
        description:
            'A media-effect bucket declared twice, a bucket list longer than the band the engine reads out of it, and a registry with no `default_bullet` bucket for bullet sprites to fall back to.',
        defaultLevel: 'error',
        setting: 'validateEffectBuckets',
        needsGameData: false,
    },
    {
        id: 'validateIndicatorIndexes',
        title: 'Indicator indexes',
        description:
            'An indicator sprite component hiding its own index, which the game refuses to load, or an index its list does not have, which fails the load with an index error the game cannot name.',
        defaultLevel: 'error',
        setting: 'validateIndicatorIndexes',
        needsGameData: false,
    },
    {
        id: 'validateBlendSpriteCodes',
        title: 'Blend sprite codes',
        description:
            'A blend sprite situation code carrying a character the engine cannot expand, which throws the first time the sprite is drawn, or a code whose length its slot does not allow.',
        defaultLevel: 'error',
        setting: 'validateBlendSpriteCodes',
        needsGameData: false,
    },
    {
        id: 'validateRefusedEnumValues',
        title: 'Refused enum values',
        description:
            'An enum member the field type allows and the class reading it refuses, such as a fixed weapon auto-targeting anything but ship parts.',
        defaultLevel: 'warning',
        setting: 'validateRefusedEnumValues',
        needsGameData: false,
    },
    {
        id: 'validateMishandledFields',
        title: 'Mishandled fields',
        description:
            'A field the game reads and then acts on wrongly, such as an `ExcludeID` the engine adds to the list of parts a criteria matches rather than the one it excludes.',
        defaultLevel: 'warning',
        setting: 'validateMishandledFields',
        needsGameData: false,
    },
    {
        id: 'validateChainedToCycles',
        title: 'Circular component chain',
        description:
            'A part component chain that leads back to itself, which takes the process down the moment the part is created.',
        defaultLevel: 'error',
        setting: 'validateChainedToCycles',
        needsGameData: false,
    },
    {
        id: 'validateTextMarkup',
        title: 'Text markup',
        description:
            'A localization string whose markup the game cannot read, which it answers by drawing the string with its tags visible as plain text.',
        defaultLevel: 'warning',
        setting: 'validateTextMarkup',
        needsGameData: false,
    },
    {
        id: 'validateValueRanges',
        title: 'Value ranges',
        description:
            'A range written the wrong way round where its consumer cares, such as one the game rolls a whole number out of, which throws on a high end below its low one.',
        defaultLevel: 'error',
        setting: 'validateValueRanges',
        needsGameData: false,
    },
    {
        id: 'validateChainedBuffReceivable',
        title: 'Chained buff not receivable',
        description:
            'A buff provider chaining from a buff its own part cannot receive, which the game refuses to load the data tree over.',
        defaultLevel: 'error',
        setting: 'validateChainedBuffReceivable',
        needsGameData: false,
    },
    {
        id: 'validateBulletComponents',
        title: 'Bullet components',
        description:
            'A bullet with two physics components, with none at all, or with a hit written above its physics component, which reads a physics body that does not exist yet.',
        defaultLevel: 'error',
        setting: 'validateBulletComponents',
        needsGameData: false,
    },
    {
        id: 'validateUnderlyingParts',
        title: 'Underlying parts',
        description:
            'A part naming itself as the part it leaves behind when destroyed, which the engine walks with no guard against a loop.',
        defaultLevel: 'error',
        setting: 'validateUnderlyingParts',
        needsGameData: false,
    },
    {
        id: 'validateModManifest',
        title: 'Mod manifest',
        description:
            'The manifest metadata the game reads: a missing or malformed `ID` or `Name`, a near miss of a real field name, and a declared folder or logo that is not on disk.',
        defaultLevel: 'error',
        setting: 'validateModManifest',
        needsGameData: false,
    },
    {
        id: 'validateDuplicateIds',
        title: 'Duplicate ids',
        description: 'An id two files of one mod both register for the same game collection.',
        defaultLevel: 'warning',
        setting: 'validateDuplicateIds',
        needsGameData: true,
    },
    {
        id: 'validateUnreceivableBuffs',
        title: 'Unreceivable buffs',
        description: 'A buff modifier, clamp or toggle naming a buff its own part never receives.',
        defaultLevel: 'warning',
        setting: 'validateUnreceivableBuffs',
        needsGameData: true,
    },
    {
        id: UNTAGGED_RULE_ID,
        title: 'Unnamed check',
        description:
            'A finding from a server build that does not say which check produced it. Build the server from this version to have every finding named.',
        defaultLevel: 'warning',
        needsGameData: false,
    },
];

const RULES_BY_ID: ReadonlyMap<string, LintRule> = new Map(RULES.map((rule) => [rule.id, rule]));

/**
 * Look a rule up by the identity a diagnostic carried.
 *
 * @param code the `code` field of the diagnostic, in whatever form it arrived.
 * @returns the rule, or undefined when the code names none.
 */
export const ruleById = (code: unknown): LintRule | undefined =>
    typeof code === 'string' ? RULES_BY_ID.get(code) : undefined;

/**
 * The rule id a finding is reported under.
 *
 * @param code the `code` field of the diagnostic, in whatever form it arrived.
 * @returns the rule id, falling back to {@link UNTAGGED_RULE_ID}.
 */
export const ruleIdFor = (code: unknown): string => ruleById(code)?.id ?? UNTAGGED_RULE_ID;

/** The rules that only run once the game `Data` tree is indexed, in report order. */
export const GAME_DATA_RULES: readonly LintRule[] = RULES.filter((rule) => rule.needsGameData);
