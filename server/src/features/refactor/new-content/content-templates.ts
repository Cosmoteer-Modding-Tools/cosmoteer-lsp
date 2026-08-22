import * as l10n from '@vscode/l10n';
import { displayNameOf, localizationLabelOf } from './content-id';
import { gameRootPathOf, gameRootReferenceOf } from './game-root-reference';
import { ContentKind } from './new-content.types';

/**
 * The file a new piece of content starts as, one hand-written template per kind.
 *
 * Hand-written rather than generated from the schema, for two reasons the schema itself shows.
 * `PartRules` declares 112 fields and inherits nothing, twenty-eight of which throw when absent, so
 * a generated file would either be enormous or silently incomplete; and the fields that matter most
 * are the ones a value generator cannot fill, since `EditorIcon`, `Resources` and `EditorGroup` are
 * a group, a list of tuples and a reference. What makes the part template short is the base it
 * inherits: `Data/ships/base_part.rules` already supplies twenty-three of those twenty-eight fields,
 * so the template only writes the five it does not (`ID`, `NameKey`, `Size`, `MaxHealth` and
 * `EditorIcon`) plus `Resources`, which no base in the chain declares.
 *
 * Every template also has to be a file our own editor types, which is a stricter test than the
 * game's. A shot only becomes a `BulletRules` because it sits under a `shots/` folder, a resource
 * only becomes a `ResourceRules` because it sits under `resources/` and declares a top-level `ID`,
 * and a media effect only becomes anything at all through its top-level `Type`. The folder each kind
 * is created in is therefore part of the template, not a matter of taste.
 */

/** One localization key a template writes, with the placeholder text the language files get. */
export interface LocalizationEntry {
    /** The key path as the file writes it, `Parts/SuperArmor`. */
    readonly key: string;
    /** The value written into every language file, quotes included. */
    readonly value: string;
}

/** A template, emitted for one name. */
export interface EmittedTemplate {
    /** The whole file, newline terminated. */
    readonly text: string;
    /** The localization keys the file names, in the order they appear. */
    readonly localization: LocalizationEntry[];
    /** The install assets the template points at, which the author is expected to replace. */
    readonly placeholderAssets: string[];
    /** What has to point at the file, for a kind nothing registers. */
    readonly pointedAtBy?: string;
}

/** The indentation the game's own `.rules` files use, which every template matches. */
const INDENT = '\t';

/**
 * The base a new part inherits. Every terran part in the game inherits it, and through it the
 * twenty-three otherwise mandatory fields a part would have to spell out itself.
 */
const PART_BASE = 'ships/terran/base_part_terran.rules';

/**
 * The install assets the templates point at so a created file loads and shows something at once.
 *
 * A part whose `EditorIcon` names a file that does not exist is a part the game refuses, and a
 * scaffolder cannot draw an icon, so each template points at a vanilla asset by its install-root
 * path. The author replaces the path with their own artwork; until then the file is complete and
 * loadable rather than half written.
 */
const PLACEHOLDER_PART_ICON = 'ships/terran/corridor/icon.png';
const PLACEHOLDER_RESOURCE_ICON = 'resources/steel/icon.png';
const PLACEHOLDER_BULLET_SPRITE = 'shots/bullet_med/bullet_med.png';
const PLACEHOLDER_SOUND = 'common_effects/sounds/small_part_destroyed.wav';

/** The folder inside the mod each kind is created in, relative to the mod root. */
export const CONTENT_FOLDERS: Readonly<Record<ContentKind, string>> = {
    // A part is typed through whatever registers it rather than through its folder, so this one is
    // convention only.
    part: 'parts',
    // The other three are not free: `resources/` and `shots/` are what make the file a resource and
    // a shot, and a media effect names its own class in its `Type`, so its folder is free again.
    resource: 'resources',
    bullet: 'shots',
    mediaEffect: 'effects',
};

/**
 * Whether a kind gets a folder of its own inside the kind folder. A part, a resource and a shot each
 * own their sprites and sounds, which the game reads from the directory the file is written in, so
 * they get a folder to put them in. A media effect from these templates owns no asset of its own.
 */
const HAS_OWN_FOLDER: Readonly<Record<ContentKind, boolean>> = {
    part: true,
    resource: true,
    bullet: true,
    mediaEffect: false,
};

/**
 * Where a created file goes.
 *
 * @param modRoot the mod's root directory.
 * @param kind the content kind.
 * @param fileName the normalized file name.
 * @returns the file's on-disk path, forward slashes.
 */
export const contentFilePathOf = (modRoot: string, kind: ContentKind, fileName: string): string => {
    const root = modRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const folder = CONTENT_FOLDERS[kind];
    return HAS_OWN_FOLDER[kind]
        ? `${root}/${folder}/${fileName}/${fileName}.rules`
        : `${root}/${folder}/${fileName}.rules`;
};

/**
 * The folder created for the file, which has to be free as well as the file itself: a folder that is
 * already there belongs to something, and writing into it would mix two pieces of content's assets.
 *
 * @param modRoot the mod's root directory.
 * @param kind the content kind.
 * @param fileName the normalized file name.
 * @returns the folder's on-disk path, or undefined for a kind that gets no folder of its own.
 */
export const contentFolderPathOf = (modRoot: string, kind: ContentKind, fileName: string): string | undefined => {
    if (!HAS_OWN_FOLDER[kind]) return undefined;
    const root = modRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    return `${root}/${CONTENT_FOLDERS[kind]}/${fileName}`;
};

/**
 * What has to point at a created file, for a kind nothing registers.
 *
 * The game reaches a shot through a weapon part's `BulletEmitter` and a media effect through a
 * `MediaEffects` entry, and neither is a registration a mod can write from its manifest. Saying so
 * plainly is the whole answer for those two kinds, because a file nothing reaches is a file the game
 * never loads and the editor never types.
 *
 * @param kind the content kind.
 * @returns the sentence, or undefined for a kind that has a registration route.
 */
export const pointedAtByFor = (kind: ContentKind): string | undefined => {
    switch (kind) {
        case 'bullet':
            return l10n.t(
                'Nothing reaches this shot yet. Point a weapon part at it by setting the Bullet field of its BulletEmitter component to this reference.'
            );
        case 'mediaEffect':
            return l10n.t(
                'Nothing reaches this effect yet. Add this reference to a MediaEffects list on a part, a shot or a hit effect.'
            );
        default:
            return undefined;
    }
};

/**
 * The part template: the five mandatory fields its base does not supply, the resource cost no base
 * declares, and the two localization keys the build menu reads.
 *
 * @param id the part's id.
 * @param label the localization label derived from the file name.
 * @returns the file's lines, with no line endings.
 */
const partLines = (id: string, label: string): string[] => [
    `Part : ${gameRootReferenceOf(PART_BASE, 'Part')}`,
    '{',
    `${INDENT}ID = ${id}`,
    `${INDENT}NameKey = "Parts/${label}"`,
    `${INDENT}DescriptionKey = "Parts/${label}Desc"`,
    `${INDENT}EditorGroup = "Structure"`,
    `${INDENT}Size = [1, 1]`,
    `${INDENT}MaxHealth = 1000`,
    `${INDENT}Resources`,
    `${INDENT}[`,
    `${INDENT}${INDENT}[steel, 4]`,
    `${INDENT}]`,
    `${INDENT}EditorIcon`,
    `${INDENT}{`,
    `${INDENT}${INDENT}Texture`,
    `${INDENT}${INDENT}{`,
    `${INDENT}${INDENT}${INDENT}File = "${gameRootPathOf(PLACEHOLDER_PART_ICON)}"`,
    `${INDENT}${INDENT}${INDENT}SampleMode = Linear`,
    `${INDENT}${INDENT}}`,
    `${INDENT}${INDENT}Size = [32, 32]`,
    `${INDENT}}`,
    '}',
];

/**
 * The resource template. `ID` is both the resource's name everywhere a part asks for it and the
 * field the editor needs to see at the top level before it reads the file as a resource at all.
 *
 * @param id the resource's id.
 * @param label the localization label derived from the file name.
 * @returns the file's lines, with no line endings.
 */
const resourceLines = (id: string, label: string): string[] => [
    `ID = ${id}`,
    `NameKey = "Resource/${label}"`,
    `PluralNameKey = "Resource/${label}Plural"`,
    `DescriptionKey = "Resource/${label}Desc"`,
    'BuyPrice = 25',
    'MaxStackSize = 40',
    'Icon',
    '{',
    `${INDENT}Texture`,
    `${INDENT}{`,
    `${INDENT}${INDENT}File = "${gameRootPathOf(PLACEHOLDER_RESOURCE_ICON)}"`,
    `${INDENT}${INDENT}MipLevels = max`,
    `${INDENT}}`,
    `${INDENT}Size = [64, 64]`,
    '}',
];

/**
 * The shot template: the two values every shot needs, and the four components without which the game
 * has nothing to simulate, draw or hit anything with. The lifetime is left out on purpose, because
 * the game works it out from the range and the speed.
 *
 * @param id the shot's id.
 * @returns the file's lines, with no line endings.
 */
const bulletLines = (id: string): string[] => [
    `ID = "${id}"`,
    'Range = 190',
    'Speed = 240',
    '',
    'Components',
    '{',
    `${INDENT}Physics`,
    `${INDENT}{`,
    `${INDENT}${INDENT}Type = CirclePhysics`,
    `${INDENT}${INDENT}Radius = 0.15`,
    `${INDENT}${INDENT}Density = 0.0001`,
    `${INDENT}}`,
    '',
    `${INDENT}Death`,
    `${INDENT}{`,
    `${INDENT}${INDENT}Type = DeathByLifetime`,
    `${INDENT}}`,
    '',
    `${INDENT}Hit`,
    `${INDENT}{`,
    `${INDENT}${INDENT}Type = PenetratingHit`,
    `${INDENT}${INDENT}Penetration = 1`,
    `${INDENT}${INDENT}PenetrationSpeed = 25`,
    '',
    `${INDENT}${INDENT}HitOperational`,
    `${INDENT}${INDENT}{`,
    `${INDENT}${INDENT}${INDENT}HitEffects`,
    `${INDENT}${INDENT}${INDENT}[`,
    `${INDENT}${INDENT}${INDENT}${INDENT}{`,
    `${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}Type = Damage`,
    `${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}Damage = { BaseValue = 100; EffectScaleExponent = 1 }`,
    `${INDENT}${INDENT}${INDENT}${INDENT}}`,
    `${INDENT}${INDENT}${INDENT}]`,
    `${INDENT}${INDENT}}`,
    `${INDENT}${INDENT}HitStructural = &HitOperational`,
    `${INDENT}${INDENT}HitShield = &HitOperational`,
    `${INDENT}${INDENT}PenetratingOperational = &HitOperational`,
    `${INDENT}${INDENT}PenetratingStructural = &HitOperational`,
    `${INDENT}${INDENT}FinishedPenetratingOperational = &HitOperational`,
    `${INDENT}${INDENT}FinishedPenetratingStructural = &HitOperational`,
    `${INDENT}}`,
    '',
    `${INDENT}Sprite`,
    `${INDENT}{`,
    `${INDENT}${INDENT}Type = Sprite`,
    `${INDENT}${INDENT}Sprite`,
    `${INDENT}${INDENT}{`,
    `${INDENT}${INDENT}${INDENT}Texture`,
    `${INDENT}${INDENT}${INDENT}{`,
    `${INDENT}${INDENT}${INDENT}${INDENT}File = "${gameRootPathOf(PLACEHOLDER_BULLET_SPRITE)}"`,
    `${INDENT}${INDENT}${INDENT}${INDENT}SampleMode = Linear`,
    `${INDENT}${INDENT}${INDENT}${INDENT}MipLevels = max`,
    `${INDENT}${INDENT}${INDENT}}`,
    `${INDENT}${INDENT}${INDENT}Size = [0.35, 0.35]`,
    `${INDENT}${INDENT}}`,
    `${INDENT}}`,
    '}',
];

/**
 * The media-effect template, as a sound.
 *
 * Of the nine effect kinds the game's registry holds, this is the one a template can finish. A
 * particle effect needs a `Def` and an `EmitterDef` and a beam needs a sprite, none of which exists
 * before the author has authored it, whereas an `Audio` effect declares no field the game throws
 * over and is what a mod most often adds first.
 *
 * @returns the file's lines, with no line endings.
 */
const mediaEffectLines = (): string[] => [
    'Type = Audio',
    `Sound = "${gameRootPathOf(PLACEHOLDER_SOUND)}"`,
    'Volume = 1',
    'SpeedVariation = 0.1',
];

/**
 * Emit the template for one kind.
 *
 * @param kind the content kind to write.
 * @param fileName the normalized file name, which the localization label is derived from.
 * @param id the id the file declares, empty for a kind that declares none.
 * @param lineEnding the ending the mod's own files use, so the new file matches them.
 * @returns the file's text, the localization keys it names and the placeholder assets it points at.
 */
export const emitContent = (
    kind: ContentKind,
    fileName: string,
    id: string,
    lineEnding: '\n' | '\r\n' = '\n'
): EmittedTemplate => {
    const label = localizationLabelOf(fileName);
    const display = displayNameOf(fileName);
    let lines: string[];
    let localization: LocalizationEntry[] = [];
    let placeholderAssets: string[] = [];


    switch (kind) {
        case 'part':
            lines = partLines(id, label);
            localization = [
                { key: `Parts/${label}`, value: `"${display}"` },
                { key: `Parts/${label}Desc`, value: '""' },
            ];
            placeholderAssets = [gameRootPathOf(PLACEHOLDER_PART_ICON)];
            break;
        case 'resource':
            lines = resourceLines(id, label);
            localization = [
                { key: `Resource/${label}`, value: `"${display}"` },
                { key: `Resource/${label}Plural`, value: `"${display}"` },
                { key: `Resource/${label}Desc`, value: '""' },
            ];
            placeholderAssets = [gameRootPathOf(PLACEHOLDER_RESOURCE_ICON)];
            break;
        case 'bullet':
            lines = bulletLines(id);
            placeholderAssets = [gameRootPathOf(PLACEHOLDER_BULLET_SPRITE)];
            break;
        case 'mediaEffect':
            lines = mediaEffectLines();
            placeholderAssets = [gameRootPathOf(PLACEHOLDER_SOUND)];
            break;
    }
    const pointedAtBy = pointedAtByFor(kind);

    return {
        text: [...lines, ''].join('\n').split('\n').join(lineEnding),
        localization,
        placeholderAssets,
        pointedAtBy,
    };
};
