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
 * is created in is therefore part of the template, not a matter of taste. A decal group goes one step
 * further: the folder is the content, since the game reads every PNG in it as a decal.
 */

/** One localization key a template writes, with the placeholder text the language files get. */
export interface LocalizationEntry {
    /** The key path as the file writes it, `Parts/SuperArmor`. */
    readonly key: string;
    /** The value written into every language file, quotes included. */
    readonly value: string;
}

/** A template, emitted for one name. */
interface EmittedTemplate {
    /** The whole file, newline terminated. */
    readonly text: string;
    /** The localization keys the file names, in the order they appear. */
    readonly localization: LocalizationEntry[];
    /** The install assets the template points at, which the author is expected to replace. */
    readonly placeholderAssets: string[];
    /** What has to point at the file, for a kind nothing registers. */
    readonly pointedAtBy?: string;
    /** How a part uses the entry, for a kind whose registration alone shows nothing. */
    readonly usage?: string;
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
const PLACEHOLDER_DECAL_ICON = 'roof_decals/shapes.png';
const PLACEHOLDER_GROUP_ICON = 'gui/game/designer/group_utilities.png';
const PLACEHOLDER_TOGGLE_OFF = 'gui/game/parts/toggle_power_off.png';
const PLACEHOLDER_TOGGLE_ON = 'gui/game/parts/toggle_power_on.png';

/**
 * Where a new toolbar category sorts among the game's own. The game's categories run from 0 to
 * 1000 in steps of a hundred, Utilities at 900 and Structure at 1000, and a category with no sort
 * order goes last. Between those two is where a mod's category reads as one more of the game's
 * rather than as an afterthought.
 */
const EDITOR_GROUP_SORT_ORDER = 950;

/** The members the stat and toggle files declare, which the registration and the reference both name. */
export const STAT_MEMBER = 'Stat';
export const TOGGLE_MEMBER = 'Toggle';

/**
 * The tab a new codex page sits under, the game's own tutorials tab. The codex dialog opens one tab
 * per distinct key, so a mod wanting a tab of its own only has to write another key here.
 */
const TUTORIALS_TAB_KEY = 'Codex/Tutorials';

/** What the language files say in a codex page's paragraphs until the author writes them. */
const CODEX_PARAGRAPH_PLACEHOLDER = '"Write this part of the help here."';

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
    // The game keeps its own logo ship and decal groups under these two names, and a mod that
    // mirrors them is a mod whose layout a reader of the vanilla tree already knows.
    logoShip: 'gui',
    decalFolder: 'roof_decals',
    // The three gui registry entries sit under `gui/` as the game's own do, one folder per registry,
    // so a mod that adds several of each keeps them apart the way the game's tree does.
    editorGroup: 'gui/editor_groups',
    partStat: 'gui/stats',
    partToggle: 'gui/toggles',
    // The game keeps its buffs and its codex pages under these two names, and the mods that add
    // either mirror them.
    buff: 'buffs',
    codexPage: 'codex',
};

/**
 * Whether a kind gets a folder of its own inside the kind folder. A part, a resource and a shot each
 * own their sprites and sounds, which the game reads from the directory the file is written in, so
 * they get a folder to put them in. A media effect from these templates owns no asset of its own,
 * and a logo ship is a single image. A decal folder is nothing but its folder: every PNG dropped
 * beside the group file becomes a decal, which is the whole point of creating one.
 */
const HAS_OWN_FOLDER: Readonly<Record<ContentKind, boolean>> = {
    part: true,
    resource: true,
    bullet: true,
    mediaEffect: false,
    logoShip: false,
    decalFolder: true,
    // A registry entry points at the game's own icons until the author draws one, so it owns no
    // asset and needs no folder.
    editorGroup: false,
    partStat: false,
    partToggle: false,
    // A buff has no asset at all. A codex page reads its entry images from the directory it is
    // written in, so it gets a folder for them like a part does.
    buff: false,
    codexPage: true,
};

/**
 * The name of the file itself, inside whatever folder the kind gets.
 *
 * A logo ship is the copied `.ship.png` rather than a rules file, and a decal group file carries a
 * prefix so the folder it sits in can hold a decal image of the same name without a clash.
 *
 * @param kind the content kind.
 * @param fileName the normalized file name.
 * @returns the file's base name, extension included.
 */
const baseNameOf = (kind: ContentKind, fileName: string): string => {
    switch (kind) {
        case 'logoShip':
            return `${fileName}.ship.png`;
        case 'decalFolder':
            return `decal_group_${fileName}.rules`;
        case 'part':
        case 'resource':
        case 'bullet':
        case 'mediaEffect':
        case 'editorGroup':
        case 'partStat':
        case 'partToggle':
        case 'buff':
        case 'codexPage':
            return `${fileName}.rules`;
    }
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
    const baseName = baseNameOf(kind, fileName);
    return HAS_OWN_FOLDER[kind] ? `${root}/${folder}/${fileName}/${baseName}` : `${root}/${folder}/${baseName}`;
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
 * The decal-group template, in the shape `roof_decals/roof_decals.rules` writes each of its `Groups`
 * entries in. `Folders` is read relative to the file that declares it, so `"."` names the folder the
 * file was created in, and every PNG the author drops there becomes a decal of this group.
 *
 * @param label the localization label derived from the file name.
 * @returns the file's lines, with no line endings.
 */
const decalGroupLines = (label: string): string[] => [
    '// Every PNG in the folder beside this file becomes a roof decal under this group in the paint',
    "// tool. The icon is the game's own until you draw one.",
    'Group',
    '{',
    `${INDENT}Folders = ["."]`,
    `${INDENT}NameKey = "DecalGroups/${label}"`,
    `${INDENT}Icon`,
    `${INDENT}{`,
    `${INDENT}${INDENT}Texture`,
    `${INDENT}${INDENT}{`,
    `${INDENT}${INDENT}${INDENT}File = "${gameRootPathOf(PLACEHOLDER_DECAL_ICON)}"`,
    `${INDENT}${INDENT}${INDENT}MipLevels = 2`,
    `${INDENT}${INDENT}${INDENT}SampleMode = Linear`,
    `${INDENT}${INDENT}}`,
    `${INDENT}}`,
    '}',
];

/**
 * The toolbar category template, in the shape `gui/game/designer/editor_groups.rules` writes each
 * of its members in. The member name is the id a part writes as its `EditorGroup`, which is why it
 * is the label rather than a field inside the group.
 *
 * @param label the group's id, which the localization key is named after as well.
 * @returns the file's lines, with no line endings.
 */
const editorGroupLines = (label: string): string[] => [
    `// The member name, ${label}, is the id a part writes as its EditorGroup to show up in this`,
    '// category of the build toolbar. The sort order puts it between Utilities and Structure.',
    label,
    '{',
    `${INDENT}NameKey = "EditorGroups/${label}"`,
    `${INDENT}Icon`,
    `${INDENT}{`,
    `${INDENT}${INDENT}Texture`,
    `${INDENT}${INDENT}{`,
    `${INDENT}${INDENT}${INDENT}File = "${gameRootPathOf(PLACEHOLDER_GROUP_ICON)}"`,
    `${INDENT}${INDENT}${INDENT}MipLevels = 2`,
    `${INDENT}${INDENT}${INDENT}SampleMode = Linear`,
    `${INDENT}${INDENT}}`,
    `${INDENT}}`,
    `${INDENT}SortOrder = ${EDITOR_GROUP_SORT_ORDER}`,
    '}',
];

/**
 * The stat line template: the two fields a `PartStats` entry has. The tooltip prints the line for
 * every part whose `Stats` names the id, formatted through the key.
 *
 * @param label the stat's id, which the format key is named after as well.
 * @returns the file's lines, with no line endings.
 */
const partStatLines = (label: string): string[] => [
    `// A part shows this line in its tooltip once its Stats group writes a value under ${label}.`,
    STAT_MEMBER,
    '{',
    `${INDENT}ID = ${label}`,
    `${INDENT}FormatKey = "Stats/${label}Fmt"`,
    '}',
];

/**
 * The part toggle template: a two-position switch, shown in the ship editor as well as in the
 * command card, with the game's own power button sprites until the author draws their own. The
 * toggle id and both choice ids carry the author segment because every mod's toggles and choices
 * share one table and one hotkey list, and a duplicate throws at game start.
 *
 * @param toggleId the toggle's id, which the choice ids are built from.
 * @param label the localization label the tooltip keys are named after.
 * @returns the file's lines, with no line endings.
 */
const partToggleLines = (toggleId: string, label: string): string[] => {
    const choice = (suffix: 'off' | 'on', keySuffix: 'Off' | 'On', sprite: string): string[] => [
        `${INDENT}${INDENT}{`,
        `${INDENT}${INDENT}${INDENT}ChoiceID = "${toggleId}_${suffix}"`,
        `${INDENT}${INDENT}${INDENT}ButtonToolTipKey = "PartToggles/${label}_${keySuffix}"`,
        `${INDENT}${INDENT}${INDENT}ButtonSprite`,
        `${INDENT}${INDENT}${INDENT}{`,
        `${INDENT}${INDENT}${INDENT}${INDENT}Texture`,
        `${INDENT}${INDENT}${INDENT}${INDENT}{`,
        `${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}File = "${gameRootPathOf(sprite)}"`,
        `${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}MipLevels = 2`,
        `${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}SampleMode = Linear`,
        `${INDENT}${INDENT}${INDENT}${INDENT}}`,
        `${INDENT}${INDENT}${INDENT}}`,
        `${INDENT}${INDENT}}`,
    ];
    return [
        `// A part carries this toggle through a UIToggle component naming "${toggleId}", and another`,
        '// component of the part has to reference that component to be switched by it.',
        TOGGLE_MEMBER,
        '{',
        `${INDENT}ToggleID = "${toggleId}"`,
        `${INDENT}Style = Switch`,
        `${INDENT}ShowInEditor = true`,
        `${INDENT}Choices`,
        `${INDENT}[`,
        ...choice('off', 'Off', PLACEHOLDER_TOGGLE_OFF),
        ...choice('on', 'On', PLACEHOLDER_TOGGLE_ON),
        `${INDENT}]`,
        '}',
    ];
};

/**
 * The tooltip a toggle choice shows, in the game's own spelling: the name in bold with the state
 * coloured, and the hotkey the game binds to the choice on a second line.
 *
 * @param display the readable name of the toggle.
 * @param state the state the choice puts the part in.
 * @param choiceId the choice the hotkey is bound to.
 * @returns the value, quotes included.
 */
const toggleToolTip = (display: string, state: 'Off' | 'On', choiceId: string): string => {
    const coloured = state === 'Off' ? '<bad>Off</bad>' : '<good>On</good>';
    return `"<b>${display}: ${coloured}</b>\\n\\nHotkey: <btn id='PartToggles.${choiceId}'/>"`;
};

/**
 * The buff template: a map with one member, the buff id, in the shape `buffs/buffs.rules` writes the
 * game's own. The member name is the id because the game reads the buff map keyed by member, and a
 * file holding one member is what a manifest merges in whole, so one file per buff and a file of
 * many take the same action.
 *
 * The body is a percentage-style buff, the shape the game's `Engine` buff has: providers add up,
 * the combined value sits on a base of a hundred percent and the build-mode overlay prints it as a
 * signed percentage. Every field of a buff is optional, so an author who wants a raw sum instead
 * deletes the lines rather than adding any.
 *
 * @param id the buff's id, which is the member name.
 * @returns the file's lines, with no line endings.
 */
const buffLines = (id: string): string[] => [
    '// A buff other parts can provide and receive. Parts name it in ReceivableBuffs, provide it with a',
    `// *BuffProvider component and read it with a { Type = Buff; BuffType = ${id} } modifier.`,
    id,
    '{',
    `${INDENT}CombineMode = Add`,
    `${INDENT}BaseValue = 100%`,
    `${INDENT}IconTextFormatKey = "BuildBox/BuffPercentageFmt"`,
    `${INDENT}IconTextMultiply = 100`,
    `${INDENT}IconTextAdd = -100`,
    `${INDENT}ShowIconTextForZeroValue = false`,
    `${INDENT}RectBorderColor = [10, 212, 98, 160]`,
    `${INDENT}RectFillColor = [10, 212, 98, 64]`,
    '}',
];

/**
 * The codex page template, in the shape the game's own tutorial pages take: the four fields every
 * page needs and two text-only paragraphs. The show conditions are left to the comment rather than
 * written, because a page with one the HUD offers the moment the condition holds, and which
 * condition fits is the author's call. Without one the page is still listed in the codex.
 *
 * @param id the page's id, the key of its seen-state in the player's settings.
 * @param label the localization label the title and the paragraphs are declared under.
 * @returns the file's lines, with no line endings.
 */
const codexPageLines = (id: string, label: string): string[] => [
    '// A help page for the mod, listed under the Tutorials tab of the codex. The texts are keys in the',
    '// language files. Give it a ShowCondition or TempShowCondition to have the HUD offer it, such as',
    `// TempShowCondition = "? game.HasPartCategoryInHand('<category>')"`,
    `ID = ${id}`,
    `TitleKey = "Tutorials/${label}/Title"`,
    `TabNameKey = "${TUTORIALS_TAB_KEY}"`,
    'Entries',
    '[',
    `${INDENT}{ TextKey = "Tutorials/${label}/Text1" }`,
    `${INDENT}{ TextKey = "Tutorials/${label}/Text2" }`,
    ']',
];

/**
 * How a part uses a created registry entry, for the kinds whose registration alone shows nothing.
 * Said plainly rather than left to the summary, because a category with no part in it, a stat no
 * part writes, a toggle no component carries, a buff no part provides and a page no condition
 * offers each look like a creation that did nothing.
 *
 * @param kind the content kind.
 * @param id the id the created file declares.
 * @returns the sentence, or undefined for a kind that needs no such note.
 */
export const usageFor = (kind: ContentKind, id: string): string | undefined => {
    switch (kind) {
        case 'editorGroup':
            return `Write EditorGroup = "${id}" in a part to put it in this group.`;
        case 'partStat':
            return `Write ${id} = <value> inside a part's Stats group, or inside a StatsByCategory entry, and the line appears in its tooltip.`;
        case 'partToggle':
            return `Add a component { Type = UIToggle  ToggleID = "${id}"  Default = 1  RequiresCommand = false } to a part's Components, and have another component of that part name it as its OperationalToggle, since the toggle switches nothing on its own.`;
        case 'buff':
            return `Name it in a part's ReceivableBuffs, provide it with a *BuffProvider component (BuffType = ${id}) and read it through a { Type = Buff; BuffType = ${id} } modifier.`;
        case 'codexPage':
            return `Give it a ShowCondition or TempShowCondition, such as "? game.HasPartCategoryInHand('<category>')", to have the HUD offer it, since without one it is listed in the codex only.`;
        default:
            return undefined;
    }
};

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
        case 'decalFolder':
            lines = decalGroupLines(label);
            localization = [{ key: `DecalGroups/${label}`, value: `"${display}"` }];
            placeholderAssets = [gameRootPathOf(PLACEHOLDER_DECAL_ICON)];
            break;
        case 'logoShip':
            // A logo ship is a saved ship the command copies, so there is no text to emit for it and
            // the answer is deliberately empty rather than a template that pretends otherwise.
            lines = [];
            break;
        case 'editorGroup':
            lines = editorGroupLines(id);
            localization = [{ key: `EditorGroups/${id}`, value: `"${display}"` }];
            placeholderAssets = [gameRootPathOf(PLACEHOLDER_GROUP_ICON)];
            break;
        case 'partStat':
            lines = partStatLines(id);
            localization = [{ key: `Stats/${id}Fmt`, value: `"<white>${display}:</white> <good>{0:0.##}</good>"` }];
            break;
        case 'partToggle':
            lines = partToggleLines(id, label);
            localization = [
                { key: `PartToggles/${label}_Off`, value: toggleToolTip(display, 'Off', `${id}_off`) },
                { key: `PartToggles/${label}_On`, value: toggleToolTip(display, 'On', `${id}_on`) },
            ];
            placeholderAssets = [gameRootPathOf(PLACEHOLDER_TOGGLE_OFF), gameRootPathOf(PLACEHOLDER_TOGGLE_ON)];
            break;
        case 'buff':
            // A buff has no name the game shows, its only text being the shared percentage format
            // the template names, so it declares no key.
            lines = buffLines(id);
            break;
        case 'codexPage':
            lines = codexPageLines(id, label);
            localization = [
                { key: `Tutorials/${label}/Title`, value: `"${display}"` },
                { key: `Tutorials/${label}/Text1`, value: CODEX_PARAGRAPH_PLACEHOLDER },
                { key: `Tutorials/${label}/Text2`, value: CODEX_PARAGRAPH_PLACEHOLDER },
            ];
            break;
    }
    const pointedAtBy = pointedAtByFor(kind);
    const usage = usageFor(kind, id);

    return {
        text: [...lines, ''].join('\n').split('\n').join(lineEnding),
        localization,
        placeholderAssets,
        pointedAtBy,
        usage,
    };
};
