/**
 * The Steam Workshop page a code mod's assembly belongs to.
 *
 * A schema hover ends with a link to the most relevant modding-wiki page, which is the right thing
 * for a game class and the wrong thing for a mod's own class: the wiki documents the game's content
 * and says nothing about a modded component or its fields. A subscribed mod does have a page that
 * documents it though, and its id is sitting in the install path Steam unpacked it to:
 *
 *     …/steamapps/workshop/content/799600/3768401176/CosmoteerDrone.dll
 *                                        ^^^^^^^^^^ the published file id
 *
 * so the hover can point at the mod's own page instead. A mod being developed locally has no
 * published id and gets no link, which is correct: there is nothing to link to yet.
 */
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { COSMOTEER_APP_ID } from '../../workspace/workshop-dir';

/** Where a code mod is published, for the hover footer. */
export interface WorkshopLink {
    /** The mod's Steam Workshop page. */
    url: string;
    /** The mod's display name from its manifest, absent when the manifest could not be read. */
    name?: string;
}

/** The unpacked path of a subscribed mod, whose last segment is the published file id. */
const WORKSHOP_PATH = new RegExp(`/workshop/content/${COSMOTEER_APP_ID}/(\\d+)(?:/|$)`, 'i');

/** `Name = "…"` in a mod manifest, the mod's display name. */
const MANIFEST_NAME = /^\s*Name\s*=\s*"((?:[^"\\]|\\.)*)"/m;

/**
 * The published file id of the mod an assembly belongs to, and the folder it was unpacked into.
 *
 * @param assemblyPath the assembly's path.
 * @returns the id and the mod's root folder, or undefined when the path is not inside the workshop
 *          tree (a mod being developed locally, or one installed some other way).
 */
export const workshopModOf = (assemblyPath: string): { id: string; root: string } | undefined => {
    const normalized = assemblyPath.replace(/\\/g, '/');
    const match = WORKSHOP_PATH.exec(normalized);
    if (!match) return undefined;
    const id = match[1];
    // Rebuilt from the prefix rather than sliced out of the match, so an id that repeats the app id
    // cannot make the root end in the wrong place.
    return { id, root: `${normalized.slice(0, match.index)}/workshop/content/${COSMOTEER_APP_ID}/${id}` };
};

/**
 * The manifest name of a mod, read from the `mod.rules` at its root.
 *
 * Deliberately a regex over the raw text rather than a parse: this runs during the schema build,
 * before the document machinery is usable, and one quoted field is all it needs.
 *
 * @param root the mod's root folder.
 * @returns the declared name, or undefined when there is no readable manifest with one.
 */
const manifestName = async (root: string): Promise<string | undefined> => {
    try {
        const text = await readFile(join(root, 'mod.rules'), 'utf8');
        const match = MANIFEST_NAME.exec(text);
        return match ? match[1].replace(/\\(.)/g, '$1') : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Resolve the workshop page of the mod an assembly belongs to.
 *
 * @param assemblyPath the assembly's path.
 * @returns the link, or undefined for an assembly outside the workshop tree.
 */
export const workshopLinkFor = async (assemblyPath: string): Promise<WorkshopLink | undefined> => {
    const workshop = workshopModOf(assemblyPath);
    if (!workshop) return undefined;
    const name = await manifestName(workshop.root);
    const link: WorkshopLink = { url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshop.id}` };
    if (name) link.name = name;
    return link;
};
