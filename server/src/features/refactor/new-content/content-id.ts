import { readFile } from 'fs/promises';
import { Dirent, readdirSync } from 'fs';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { isRulesFileName } from '../../../document/document-kind';
import { modIdDeclarationsOf } from '../../diagnostics/validator.duplicate-id';
import { parseText } from '../../../utils/ast.utils';
import { ContentKind } from './new-content.types';

/**
 * Names and ids for created content.
 *
 * The id shape is the game's, read off the install rather than invented: a part, a shot and a status
 * carry a dotted `author.thing` id (`cosmoteer.cannon_med`, `"cosmoteer.bullet_med"`), while a
 * resource carries a bare one (`ID = steel`). The author segment comes from the mod's own manifest
 * id, which is where every workshop mod in the corpus takes it from as well (manifest
 * `evans.tritsteel_armor` writes parts as `evans.tri_armor…`).
 *
 * The manifest's own id rule is deliberately not applied here. `isValidModId` demands the dotted
 * form because the game matches mods by it, and content ids in the installed corpus are frequently
 * dotless (`faction1`, `apbullet`), so a mod whose manifest declares no dotted id still gets usable
 * content ids rather than a refusal.
 */

/** Directories the mod walk never enters, none of which holds content the game loads. */
const SKIPPED_DIRS = new Set(['.git', '.hg', '.svn', '.vscode', '.idea', 'node_modules', 'out', 'dist', 'bin', 'obj']);

/** How deep below the mod root the id sweep looks, deep enough for every layout in the corpus. */
const MAX_SWEEP_DEPTH = 8;

/** The schema class whose ids a kind's own id must not collide with, absent when it declares none. */
export const ID_CLASS_OF_KIND: Readonly<Partial<Record<ContentKind, string>>> = {
    part: 'Cosmoteer.Ships.Parts.PartRules',
    resource: 'Cosmoteer.Resources.ResourceRules',
    bullet: 'Cosmoteer.Bullets.BulletRules',
};

/**
 * The file and folder name derived from what the author typed: lower case, words joined by
 * underscores, and nothing outside the characters a `.rules` identifier and a folder name can both
 * hold.
 *
 * @param raw the name as the author typed it.
 * @returns the normalized name, or undefined when nothing usable is left of it.
 */
export const contentFileNameOf = (raw: string): string | undefined => {
    const name = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    // A name that begins with a digit would read as a positional index rather than as a member name
    // wherever the game looks a group up by name, so it is refused rather than quietly prefixed.
    if (name.length === 0 || /^[0-9]/.test(name)) return undefined;
    return name;
};

/** The words of a normalized name, each capitalized, ready for whichever separator a name needs. */
const capitalizedWords = (fileName: string): string[] =>
    fileName
        .split('_')
        .filter((word) => word.length > 0)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

/**
 * The label a localization key is built from: the normalized name in Pascal case, which is how the
 * game's own keys are written (`Parts/SuperArmor`, `Resource/Steel`).
 *
 * @param fileName the normalized file name.
 * @returns the key label.
 */
export const localizationLabelOf = (fileName: string): string => capitalizedWords(fileName).join('');

/**
 * The readable name written into the language files as the placeholder translation, so the author
 * sees something rather than an empty string in game before translating it.
 *
 * @param fileName the normalized file name.
 * @returns the display name.
 */
export const displayNameOf = (fileName: string): string => capitalizedWords(fileName).join(' ');

/**
 * The author segment of a manifest id, which every id the mod declares is prefixed with.
 *
 * @param manifestId the mod's manifest `ID`, already unquoted.
 * @returns the segment before the first dot, or undefined when the manifest declares no dotted id.
 */
export const authorPrefixOf = (manifestId: string | undefined): string | undefined => {
    if (!manifestId) return undefined;
    const prefix = manifestId.split('.')[0].trim();
    return prefix.length > 0 && prefix.length < manifestId.trim().length ? prefix : undefined;
};

/**
 * The id a created file declares.
 *
 * @param kind the content kind, which decides whether the id is dotted.
 * @param prefix the mod's author segment, absent when the manifest declares no dotted id.
 * @param fileName the normalized file name.
 * @returns the id, or the empty string for a kind that declares none.
 */
export const contentIdFor = (kind: ContentKind, prefix: string | undefined, fileName: string): string => {
    if (!ID_CLASS_OF_KIND[kind]) return '';
    // A resource is named by a bare word everywhere the game reads one, `Resources [ [steel, 24] ]`
    // included, so prefixing it would name a resource that no part can ask for.
    if (kind === 'resource') return fileName;
    return prefix ? `${prefix}.${fileName}` : fileName;
};

/**
 * Every rules file below a directory, in a deterministic order. The extension the game's loader
 * accepts is the one `isRulesFileName` names, `.txt` included, because mods really do declare whole
 * parts in a `.txt` file and an id declared there takes its slot like any other. The readme and
 * changelog that filter drops are prose a modder wrote for the reader, which declares nothing.
 */
const rulesFilesUnder = (root: string): string[] => {
    const files: string[] = [];
    const walk = (dir: string, depth: number): void => {
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory()) {
                if (depth >= MAX_SWEEP_DEPTH || SKIPPED_DIRS.has(entry.name.toLowerCase())) continue;
                walk(join(dir, entry.name), depth + 1);
            } else if (isRulesFileName(entry.name)) {
                files.push(join(dir, entry.name).replace(/\\/g, '/'));
            }
        }
    };
    walk(root, 0);
    return files;
};

/**
 * Every id a mod's own files declare for a schema class, so a derived id that would collide with one
 * is refused before anything is written.
 *
 * This is the mod-local half of the answer and always available. A caller that can reach the whole
 * project's id index supplies the wider set instead, which also catches a collision with the game's
 * own content.
 *
 * @param modRoot the mod to sweep.
 * @param cls the schema class whose ids are wanted.
 * @param cancellationToken cancels the sweep.
 * @returns the declared ids, folded to lower case the way the game matches them.
 */
export const declaredIdsIn = async (
    modRoot: string,
    cls: string,
    cancellationToken: CancellationToken
): Promise<Set<string>> => {
    const ids = new Set<string>();
    for (const fsPath of rulesFilesUnder(modRoot)) {
        if (cancellationToken.isCancellationRequested) break;
        const text = await readFile(fsPath, 'utf8').catch(() => null);
        if (text === null) continue;
        let document;
        try {
            document = parseText(text, fsPath);
        } catch {
            continue;
        }
        for (const declaration of modIdDeclarationsOf(document)) {
            if (declaration.cls === cls) ids.add(declaration.id.toLowerCase());
        }
    }
    return ids;
};
