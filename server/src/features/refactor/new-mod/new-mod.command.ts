import { existsSync, readdirSync, statSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { identityOfMod, manifestPathsIn, readManifest, scalarMember } from '../../../mod/mod-dependencies';
import { isValidModId } from '../../../mod/mod-manifest';
import { foldPathCase } from '../../../workspace/fs-cache';
import { localModDirs, workshopContentDir } from '../../../workspace/workshop-dir';
import { gameVersionsInsertLiteral } from '../../diagnostics/validator.manifest-version';
import { contentFileNameOf } from '../new-content/content-id';
import { NewModApplyResult, NewModArgs, NewModDestination, NewModResult, NewModScanResult } from './new-mod.types';

/**
 * The `workspace/executeCommand` id that creates a new mod. Both clients invoke it twice: without a
 * name it reports where a mod can be created and what the manifest would say about the installed
 * game, and with one it writes the mod folder.
 *
 * What is written is the smallest mod the game loads and the editor understands: a manifest that
 * names the mod and the game versions it is known to work with, and a language file for the names
 * the author's own content will need. No art and no text is copied out of the game's own
 * `Standard Mods`, whose example mod is somebody's published work down to the author field and the
 * logo, so a scaffold copied from it would ship their identity inside a new mod.
 *
 * The manifest is written with an empty `Actions` list rather than with none. A mod loads nothing
 * until an action names a target, which the overview's health table says outright, and an empty
 * list is the place that action is written in.
 */
export const NEW_MOD_COMMAND = 'cosmoteer.newMod';

/** How many author names the scan offers back, enough to recognize one's own among a mod library. */
const MAX_KNOWN_AUTHORS = 12;

/** The language file every new mod ships, which is the one the game falls back to. */
const DEFAULT_LANGUAGE_FILE = 'en.rules';

/** The folder the manifest points its `StringsFolder` at. */
const STRINGS_FOLDER = 'strings';

/** A scan answer for a machine the command could not read a game install from. */
const emptyScan = (): NewModScanResult => ({ kind: 'scan', destinations: [], gameVersions: '', knownAuthors: [] });

/**
 * An apply answer that created nothing.
 *
 * @param failure why nothing was created.
 * @returns the result to send back.
 */
const applyFailed = (failure: NewModApplyResult['failure']): NewModApplyResult => ({
    kind: 'apply',
    modRoot: '',
    manifest: '',
    id: '',
    createdFiles: [],
    loadedByGame: false,
    failure,
});

/** The mod folders on this machine, which are the roots a new mod would be created beside. */
const installedModRoots = (): string[] => {
    const roots: string[] = [];
    for (const parent of [workshopContentDir(), ...localModDirs()]) {
        if (!parent) continue;
        let entries: string[];
        try {
            entries = readdirSync(parent);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const root = join(parent, entry);
            try {
                if (statSync(root).isDirectory()) roots.push(root);
            } catch {
                /* a folder that vanished between the listing and the probe */
            }
        }
    }
    return roots;
};

/**
 * The manifest ids already taken on this machine, folded to lower case. The game matches mods by
 * this id, so a second mod carrying one is a mod the player cannot have both of.
 *
 * @returns the taken ids.
 */
const takenModIds = async (): Promise<Set<string>> => {
    const taken = new Set<string>();
    for (const root of installedModRoots()) {
        const identity = await identityOfMod(root).catch(() => undefined);
        if (identity?.manifestId) taken.add(identity.manifestId.toLowerCase());
    }
    return taken;
};

/**
 * The author names the mods in the user's own `Mods` folders are written under, so their own name is
 * offered back rather than retyped. The subscribed workshop tree is left out, since a suggestion
 * list of a few hundred other people's names is no suggestion at all. A mod somebody else wrote can
 * still sit in a local folder, so what this offers is a shortlist rather than a claim of authorship.
 *
 * @returns the distinct author names.
 */
const knownAuthors = async (): Promise<string[]> => {
    const authors: string[] = [];
    const seen = new Set<string>();
    for (const parent of localModDirs()) {
        let entries: string[];
        try {
            entries = readdirSync(parent);
        } catch {
            continue;
        }
        for (const entry of entries) {
            for (const path of manifestPathsIn(join(parent, entry))) {
                const manifest = await readManifest(path);
                const author = manifest ? scalarMember(manifest, 'Author') : undefined;
                if (!author || seen.has(author.toLowerCase())) continue;
                seen.add(author.toLowerCase());
                authors.push(author);
                if (authors.length >= MAX_KNOWN_AUTHORS) return authors;
            }
        }
    }
    return authors;
};

/**
 * Reports where a mod can be created and what the manifest would carry.
 *
 * @returns the scan answer.
 */
const scanRound = async (): Promise<NewModScanResult> => {
    const destinations: NewModDestination[] = localModDirs().map((path) => ({ path, loadedByGame: true }));
    return {
        kind: 'scan',
        destinations,
        gameVersions: (await gameVersionsInsertLiteral().catch(() => undefined)) ?? '',
        knownAuthors: await knownAuthors().catch(() => []),
    };
};

/**
 * Escapes a value for the quoted string form: the game's own reader takes `\"` and `\\` inside a
 * quoted value, and nothing else has to be spelled differently on one line.
 *
 * @param raw the text as the author typed it.
 * @returns the text as it is written between quotes.
 */
const quoted = (raw: string): string => `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The manifest text of a new mod.
 *
 * @param id the mod id.
 * @param name the mod's display name.
 * @param author the author's name.
 * @param versions the `CompatibleGameVersions` literal, empty when the install could not say.
 * @returns the file's text.
 */
const manifestText = (id: string, name: string, author: string, versions: string): string => {
    const lines = [
        '// The id the game matches this mod by. It has to carry a dot, and the part in front of it',
        '// is yours rather than the mod\'s, so two mods of your own never collide.',
        `ID = ${id}`,
        '',
        '// What the game shows this mod as.',
        `Name = ${quoted(name)}`,
        '',
        'Version = 1.0.0',
    ];
    if (versions) {
        lines.push(
            '',
            '// The game versions this mod is known to work with. A player running another one is',
            '// warned, and an update the mod does not name turns it off rather than breaking a save.',
            `CompatibleGameVersions = ${versions}`
        );
    }
    lines.push(
        '',
        '// Whether this mod changes how the game plays, which decides who can play with whom.',
        'ModifiesGameplay = true',
        ''
    );
    if (author) lines.push(`Author = ${quoted(author)}`, '');
    lines.push(
        '// The folder holding one file per language, each naming what this mod adds.',
        `StringsFolder = ${quoted(STRINGS_FOLDER)}`,
        '',
        '// What the game does with this mod. Until an action names a target, the game loads nothing',
        '// from here: the Cosmoteer: New Content File command writes both the content and its action.',
        'Actions',
        '[',
        ']',
        ''
    );
    return lines.join('\n');
};

/**
 * The text of the new mod's language file. The game reads the keys a mod's own content asks for out
 * of this file, and the new-content command writes each one in as it creates the content, so the
 * file starts as the comment saying what belongs in it.
 *
 * @param name the mod's display name.
 * @returns the file's text.
 */
const stringsText = (name: string): string =>
    [
        `// The English names and descriptions ${name} adds.`,
        '// A key written here overrides the game\'s own of the same name, and the',
        '// Cosmoteer: New Content File command adds the keys of everything it creates.',
        '',
    ].join('\n');

/**
 * Creates the mod folder and writes what it holds.
 *
 * @param args the client's arguments.
 * @returns what was created, or why nothing was.
 */
const applyRound = async (args: NewModArgs): Promise<NewModApplyResult> => {
    const destination = (args.destination ?? '').trim();
    if (!destination || !existsSync(destination)) return applyFailed('noDestination');
    const name = (args.name ?? '').trim();
    const modSegment = contentFileNameOf(args.folderName?.trim() || name);
    if (!name || !modSegment) return applyFailed('invalidName');
    const author = (args.author ?? '').trim();
    const authorSegment = contentFileNameOf(author);
    if (!authorSegment) return applyFailed('invalidAuthor');

    const id = `${authorSegment}.${modSegment}`;
    // The command derives both halves, so an id it cannot form at all is a name the author has to
    // change rather than something to write and let the manifest check report afterwards.
    if (!isValidModId(id)) return applyFailed('invalidName');
    if ((await takenModIds().catch(() => new Set<string>())).has(id.toLowerCase())) return applyFailed('idTaken');

    const modRoot = join(destination, modSegment);
    if (existsSync(modRoot)) return applyFailed('pathTaken');

    const manifest = join(modRoot, 'mod.rules');
    const strings = join(modRoot, STRINGS_FOLDER, DEFAULT_LANGUAGE_FILE);
    try {
        await mkdir(join(modRoot, STRINGS_FOLDER), { recursive: true });
        const versions = (await gameVersionsInsertLiteral().catch(() => undefined)) ?? '';
        await writeFile(manifest, manifestText(id, name, author, versions), 'utf8');
        await writeFile(strings, stringsText(name), 'utf8');
    } catch {
        return applyFailed('writeFailed');
    }
    const loaded = localModDirs().some((dir) => foldPathCase(dir) === foldPathCase(destination));
    return {
        kind: 'apply',
        modRoot,
        manifest,
        id,
        createdFiles: [manifest, strings],
        loadedByGame: loaded,
    };
};

/**
 * Reports where a mod could be created, or creates one.
 *
 * @param args the client's arguments.
 * @param cancellationToken cancels nothing yet, kept so the command reads like its siblings.
 * @returns the scan report, or what was created.
 */
export const newMod = async (args: NewModArgs, cancellationToken: CancellationToken): Promise<NewModResult> => {
    if (cancellationToken.isCancellationRequested) return emptyScan();
    return args.name ? await applyRound(args) : await scanRound();
};
