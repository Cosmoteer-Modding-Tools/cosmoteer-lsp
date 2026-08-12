import { AbstractNode, IdentifierNode, isAssignmentNode, isGroupNode, isListNode } from '../core/ast/ast';

/**
 * Model of the metadata a `mod.rules` manifest declares, read from `Cosmoteer.Mods.ModInfo`
 * (Cosmoteer.dll, game 0.30.4c). The class is `[ReflectiveSerialization(Explicit = true)]`, so its
 * `[Serialize]` members are the whole set the deserializer binds, and a member whose attribute does
 * not set `Optional = true` makes the read throw when the manifest leaves it out.
 *
 * Two names the class does not declare belong here anyway, or every mod that uses them would be
 * reported: the constructor reads `Actions` itself through `TryReadFromPath`, and `GetModInfoPath`
 * reads `UseThisFileIfNoVersionMatch` off the file while it picks between version-split manifests.
 *
 * The manifest is deliberately not part of the generated schema. Schemagen roots at
 * `Cosmoteer.Data.Rules` and never reaches `Cosmoteer.Mods`, and a manifest document is not rooted
 * through the schema engine either, so this table is what stands in for it.
 */
export interface ManifestMember {
    name: string;
    /** True when the deserializer throws on the member being absent, so the mod does not load. */
    required?: boolean;
    /** Further spellings the game binds to the same member (`[Serialize(AlternateAliases = …)]`). */
    aliases?: string[];
    /**
     * Set when the value is a filesystem path. The game resolves a relative one against the folder
     * the manifest itself is in (`Halfling.IO.FilePath`'s ObjectText constructor combines it with
     * `node.FileRoot.FilePath.Directory`), while a rooted value or one starting with `./` goes to
     * `Path.GetFullPath`, which reads it against the working directory, the install root.
     */
    path?: 'file' | 'folder';
}

/** The top-level members of a manifest, in the order `ModInfo` declares them. */
export const MANIFEST_MEMBERS: ManifestMember[] = [
    { name: 'ID', required: true },
    { name: 'Name', required: true },
    { name: 'Version' },
    { name: 'CompatibleGameVersions' },
    { name: 'ModifiesGameplay', aliases: ['ModifiesMultiplayer'] },
    { name: 'Author' },
    { name: 'Description' },
    { name: 'Logo', path: 'file' },
    { name: 'StringsFolder', path: 'folder' },
    { name: 'ShipLibraries' },
    { name: 'Actions' },
    { name: 'UseThisFileIfNoVersionMatch' },
];

/** The members of one `ShipLibraries` entry (`ModInfo.ModShipLibrary`). */
export const SHIP_LIBRARY_MEMBERS: ManifestMember[] = [
    { name: 'Folder', required: true, path: 'folder' },
    { name: 'NameKey', required: true },
    { name: 'TooltipKey' },
];

/** Every spelling accepted at the top level of a manifest, aliases included. */
export const MANIFEST_MEMBER_NAMES: string[] = MANIFEST_MEMBERS.flatMap((member) => [
    member.name,
    ...(member.aliases ?? []),
]);

/** Every spelling accepted inside a `ShipLibraries` entry. */
export const SHIP_LIBRARY_MEMBER_NAMES: string[] = SHIP_LIBRARY_MEMBERS.flatMap((member) => [
    member.name,
    ...(member.aliases ?? []),
]);

const manifestKeys = new Set(MANIFEST_MEMBER_NAMES.map((name) => name.toLowerCase()));
const shipLibraryKeys = new Set(SHIP_LIBRARY_MEMBER_NAMES.map((name) => name.toLowerCase()));

/**
 * The model entry a written name binds to, aliases and letter case folded the way the game folds
 * them (`OTGroupNode._childrenByName` is InvariantCultureIgnoreCase, so `ModifiesGamePlay` binds
 * exactly like the declared `ModifiesGameplay`).
 *
 * @param name the written member name.
 * @param members the model to look the name up in.
 * @returns the model entry, or undefined when the game binds nothing by that name.
 */
export const manifestMemberFor = (name: string, members: ManifestMember[]): ManifestMember | undefined => {
    const wanted = name.toLowerCase();
    return members.find((member) =>
        [member.name, ...(member.aliases ?? [])].some((spelling) => spelling.toLowerCase() === wanted)
    );
};

/**
 * Whether a written name is a top-level manifest member.
 *
 * @param name the written member name.
 * @returns true when the game binds the name.
 */
export const isManifestMember = (name: string): boolean => manifestKeys.has(name.toLowerCase());

/**
 * Whether a written name is a member of a `ShipLibraries` entry.
 *
 * @param name the written member name.
 * @returns true when the game binds the name.
 */
export const isShipLibraryMember = (name: string): boolean => shipLibraryKeys.has(name.toLowerCase());

/**
 * Whether a written mod id has the shape the game demands. `ModInfo`'s constructor takes the first
 * `.` and throws unless a character stands on each side of it, so `mine.parts` passes while `mod`,
 * `.mod` and `mod.` do not.
 *
 * @param id the written id value.
 * @returns true when the id is in the `author_name.mod_name` form.
 */
export const isValidModId = (id: string): boolean => {
    const dot = id.indexOf('.');
    return dot >= 1 && dot < id.length - 1;
};

/** A named member of a manifest container, with the identifier a diagnostic anchors on. */
export interface ManifestEntry {
    name: string;
    identifier: IdentifierNode;
    element: AbstractNode;
    /** True for a bare named group (`DeveloperMode { … }`), a shape the unknown-member check skips. */
    bareGroup: boolean;
}

/**
 * The named members of a manifest container, in written order. An anonymous element and a bare
 * `&…` include member carry no name of their own and are left out.
 *
 * @param container the document or group whose members are listed.
 * @returns one entry per named member.
 */
export const manifestEntries = (container: { elements: AbstractNode[] }): ManifestEntry[] => {
    const entries: ManifestEntry[] = [];
    for (const element of container.elements) {
        if (isAssignmentNode(element)) {
            entries.push({ name: element.left.name, identifier: element.left, element, bareGroup: false });
        } else if ((isGroupNode(element) || isListNode(element)) && element.identifier) {
            entries.push({
                name: element.identifier.name,
                identifier: element.identifier,
                element,
                bareGroup: isGroupNode(element),
            });
        }
    }
    return entries;
};
