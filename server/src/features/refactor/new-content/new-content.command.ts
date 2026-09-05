import { constants, existsSync, statSync } from 'fs';
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, relative } from 'path';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNodeDocument } from '../../../core/ast/ast';
import { identityOfMod, ModIdentity } from '../../../mod/mod-dependencies';
import { findModRoot } from '../../../mod/mod-root';
import { parseText } from '../../../utils/ast.utils';
import { isUnder } from '../../../utils/relative-path';
import { CosmoteerWorkspaceData } from '../../../workspace/cosmoteer-workspace.service';
import { insertEditForFile, modStringsFiles } from '../../diagnostics/localization-key-insert';
import { filePathToUri } from '../../navigation/navigation-strategy';
import { normalizeUri } from '../../navigation/reference-location';
import { uriToFsPath } from '../../navigation/workspace-files';
import { actionEntryText } from '../../ships/builtin-ships.emitter';
import { LineEnding } from '../../ships/builtin-ships.types';
import { documentFor, lineEndingOf, openBuffers } from '../command-host';
import { relativeRulesReference } from '../shared-base/base-file.emitter';
import { dirOf, readRulesFile } from '../shared-base/base-index';
import { editableModRootOf } from '../shared-base/shared-base.analysis-entry';
import {
    addManyActionText,
    manifestActionInsert,
    overridesActionText,
} from '../register-part/manifest-action.emitter';
import { registerPartInShip } from '../register-part/register-part.command';
import { RegisterPartHost } from '../register-part/register-part.types';
import { ShipClassEntry, shipClassesFor, shipPartsListOf } from '../register-part/ship-registry';
import {
    authorPrefixOf,
    contentFileNameOf,
    contentIdFor,
    declaredIdsIn,
    ID_CLASS_OF_KIND,
} from './content-id';
import {
    CONTENT_FOLDERS,
    contentFilePathOf,
    contentFolderPathOf,
    emitContent,
    LocalizationEntry,
    pointedAtByFor,
    STAT_MEMBER,
    TOGGLE_MEMBER,
} from './content-templates';
import {
    BUFF_REGISTRY,
    EDITOR_GROUP_REGISTRY,
    PART_STAT_REGISTRY,
    PART_TOGGLE_REGISTRY,
    registeredIds,
    RegistrySpec,
} from './registry-ids';
import {
    gameRootListTarget,
    gameRootMemberTarget,
    manifestAlreadyAdds,
    manifestAlreadyOverridesWith,
    manifestAlreadyReplacesWith,
    manifestForRegistration,
    ManifestReplaceAction,
    manifestReplaceActionFor,
} from './registration.emitter';
import {
    CONTENT_KINDS,
    ContentKind,
    ContentKindInfo,
    NewContentApplyResult,
    NewContentArgs,
    NewContentFailure,
    NewContentResult,
    NewContentScanResult,
    NewContentShip,
    RegistrationFailure,
    RegistrationRoute,
} from './new-content.types';

/**
 * The `workspace/executeCommand` id that creates a new content file. Both clients invoke it twice:
 * without a name it reports what can be created in the mod the given file belongs to, and with one
 * it writes the file, registers it and adds its localization keys.
 *
 * Creating and registering are one exchange rather than two commands, because a content file that
 * nothing registers is invisible: a part is typed only through whatever registers it, and the
 * whole-workspace pass skips a file the mod does not reach, so an unregistered part would read as
 * "the editor does not know this file" for every symptom the author sees.
 */
export const NEW_CONTENT_COMMAND = 'cosmoteer.newContent';

/** How many ships the scan reports, so a workspace full of ship mods still answers readably. */
const MAX_REPORTED_SHIPS = 40;

/** The game root member holding the resource registry, which the resource route registers into. */
const RESOURCES_MEMBER = 'Resources';

/** The game root member naming the menu rules, and the value inside them the title screen flies in. */
const MENUS_MEMBER = 'Menus';
const LOGO_SHIP_MEMBER = 'LogoShip';

/** Where the menu rules live below the data root, for a game root that does not name them. */
const MENUS_FILE = 'gui/menus.rules';

/** The extension a saved ship carries, which is the only file a logo ship can be copied from. */
const SAVED_SHIP_EXTENSION = '.ship.png';

/**
 * The game's decal file and the list inside it a decal group is added to. The game root never names
 * this file, the paint tool reads it directly, so the target is spelled out rather than derived.
 */
const DECAL_GROUPS_FILE = 'roof_decals/roof_decals.rules';
const DECAL_GROUPS_MEMBER = 'Groups';

/** The group a created decal file declares, which the registration and the reference both name. */
const DECAL_GROUP_MEMBER = 'Group';

/** The game root member naming the buff map, which the buff route merges into. */
const BUFFS_MEMBER = 'Buffs';

/**
 * The game's tutorial pages and the list inside them a codex page is appended to. The game root
 * names `codex/codex.rules`, whose own `CodexPages` is the concatenation of the tutorial, lore and
 * tip lists, so the tutorial list is the one to append to, which is what the mods that add pages
 * do. Like the decal file it is named outright rather than derived.
 */
const CODEX_TUTORIALS_FILE = 'codex/tutorials/tutorials.rules';
const CODEX_PAGES_MEMBER = 'CodexPages';

/**
 * The gui registry each of the three registry kinds is added to. The game root reaches these files
 * only through nested references (`Game/GameGui`, then the gui's own `Build`, then its
 * `EditorGroups`), which the root walk does not follow, so like the decal file each is named
 * outright and its presence on disk is the proof that the install is really there. The buff map is
 * here for its id check alone, since a new buff named like a vanilla one would replace it.
 */
const REGISTRY_OF_KIND: Readonly<Partial<Record<ContentKind, RegistrySpec>>> = {
    editorGroup: EDITOR_GROUP_REGISTRY,
    partStat: PART_STAT_REGISTRY,
    partToggle: PART_TOGGLE_REGISTRY,
    buff: BUFF_REGISTRY,
};

/** How each kind is wired into the game, decided by the kind alone. */
const REGISTRATION_ROUTE_OF_KIND: Readonly<Record<ContentKind, RegistrationRoute>> = {
    part: 'ship',
    resource: 'manifest',
    bullet: 'none',
    mediaEffect: 'none',
    logoShip: 'manifest',
    decalFolder: 'manifest',
    editorGroup: 'manifest',
    partStat: 'manifest',
    partToggle: 'manifest',
    buff: 'manifest',
    codexPage: 'manifest',
};

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface NewContentHost extends RegisterPartHost {
    /**
     * Every id the project already declares for a schema class, so a derived id that would collide
     * with one is refused before anything is written.
     *
     * Optional because the command has an answer without it. A host that can reach the project's id
     * index supplies the wider set, which also catches a collision with the game's own content; with
     * no host answer the mod's own files are swept instead, which is the collision that would make
     * the duplicate-id check fire on the file the moment it is created.
     *
     * @param cls the schema class whose ids are wanted.
     * @param cancellationToken cancels the lookup.
     * @returns the declared ids, in whatever case they are written.
     */
    existingIds?(cls: string, cancellationToken: CancellationToken): Promise<ReadonlySet<string>>;
}

/** Where the created file sits and what it is called. */
interface Target {
    /** The mod the file is created in. */
    modRoot: string;
    /** The normalized file name. */
    fileName: string;
    /** The file's on-disk path. */
    fsPath: string;
    /** The folder created for the file, absent for a kind that gets no folder of its own. */
    folder?: string;
    /** The id the file declares, empty for a kind that declares none. */
    id: string;
}

/**
 * The name a folder stands in as a file under. Nothing is ever written to it: the gates all read a
 * file path and walk up from its directory, so a folder only needs a name below it to be judged the
 * same way a file in it would be.
 */
const FOLDER_ANCHOR = 'anchor.rules';

/** Where the command was invoked, as both a file path to judge and a directory to write from. */
interface Anchor {
    /** A file path inside the anchor directory, which the mod gate is asked about. */
    fsPath: string;
    /** The directory the created file's reference is expressed relative to. */
    dir: string;
}

/**
 * What the client pointed at, which is a rules file when one is open and a folder when none is.
 *
 * The command has to be reachable with nothing open, so both clients may hand over a workspace
 * folder. Every gate below reads a file path and walks up from its directory, so a folder is judged
 * as a file inside itself rather than as a file beside itself, which is what reading it as a plain
 * path would do.
 *
 * @param uri the uri the client sent.
 * @returns the path the gates are asked about and the directory to write from.
 */
const anchorOf = (uri: string): Anchor => {
    const fsPath = uriToFsPath(uri).replace(/\\/g, '/').replace(/\/+$/, '');
    let isDirectory: boolean;
    try {
        isDirectory = statSync(fsPath).isDirectory();
    } catch {
        isDirectory = false;
    }
    return isDirectory ? { fsPath: `${fsPath}/${FOLDER_ANCHOR}`, dir: fsPath } : { fsPath, dir: dirOf(fsPath) };
};

/** A scan result carrying nothing but the reason there is nothing to report. */
const scanFailed = (failure: NewContentFailure): NewContentScanResult => ({
    kind: 'scan',
    modRoot: '',
    modId: '',
    idPrefix: '',
    kinds: [],
    ships: [],
    failure,
});

/** An apply result carrying nothing but the reason nothing was created. */
const applyFailed = (kind: ContentKind, failure: NewContentFailure): NewContentApplyResult => ({
    kind: 'apply',
    created: '',
    contentKind: kind,
    id: '',
    route: 'none',
    registeredIn: '',
    changedFiles: [],
    localizationKeys: [],
    localizationFiles: [],
    reference: '',
    placeholderAssets: [],
    failure,
});

/**
 * The mod a file belongs to, or why the command may not create anything beside it.
 *
 * The gate is `editableModRootOf`, the one guard every refactoring reads. It keeps the command out
 * of the game's own `Data` tree unless the vanilla-editing switch says the game data is what is being
 * worked on, and out of an installed workshop mod whatever that switch says, since that mod is
 * somebody else's.
 *
 * @param fsPath the file the command was invoked on.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the mod root, or the refusal.
 */
const modRootFor = (
    fsPath: string,
    dataRoot: string | undefined
): { readonly modRoot: string } | { readonly failure: NewContentFailure } => {
    const modRoot = editableModRootOf(fsPath);
    if (modRoot) return { modRoot: modRoot.replace(/\\/g, '/') };
    // A file that does sit in a mod, or in the game's own tree, was refused by the gate rather than
    // simply not found, and saying which of the two happened is the whole difference between "open a
    // mod first" and "this is not yours to edit".
    const refused = findModRoot(fsPath) !== null || isUnder(fsPath, dataRoot);
    return { failure: refused ? 'notEditable' : 'noModRoot' };
};

/**
 * The ships a new part of this mod could be registered in, each with what stands in the way.
 *
 * The part does not exist yet, so only what the ship and the mod decide is reported. Whether the
 * part is already listed is not a question that can be asked before it has been created, and the
 * register-part command re-asks every one of these against the files as they stand when the
 * registration is actually written.
 *
 * @param entries the ship classes the registry holds.
 * @param modRoot the mod the part would be created in.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the candidates, capped so a workspace full of ship mods still answers readably.
 */
const shipCandidates = async (
    entries: readonly ShipClassEntry[],
    modRoot: string,
    dataRoot: string | undefined
): Promise<NewContentShip[]> => {
    const candidates: NewContentShip[] = [];
    for (const entry of entries.slice(0, MAX_REPORTED_SHIPS)) {
        const vanilla = isUnder(entry.fsPath, dataRoot);
        const ship = await shipPartsListOf(entry.fsPath, entry.groupName);
        // A ship of the game install is patched from the mod's manifest, a ship the workspace owns is
        // edited in place, and a ship of somebody else's installed mod is neither.
        const editable = vanilla || !!editableModRootOf(entry.fsPath);
        const blocked = !editable
            ? ('notEditable' as const)
            : !ship
              ? ('unreadable' as const)
              : ship.partsList
                ? undefined
                : // A `Parts` that only comes from a base may well be replaced rather than extended by
                  // a local re-declaration, and nothing in the tree proves which, so it is refused.
                  ship.inherits
                  ? ('partsInherited' as const)
                  : ('noPartsList' as const);
        candidates.push({
            key: entry.key,
            groupName: entry.groupName,
            id: ship?.id,
            fsPath: entry.fsPath,
            target: vanilla ? 'vanilla' : 'workspace',
            via: vanilla ? 'modAction' : 'shipFile',
            blocked,
        });
    }
    return candidates;
};

/** The game root document and its path, absent when the game path is unset or unreadable. */
const gameRootOf = async (
    host: NewContentHost
): Promise<{ document: AbstractNodeDocument; fsPath: string } | undefined> => {
    const root = await host.gameRoot().catch(() => undefined);
    const document = (root?.content as CosmoteerWorkspaceData | undefined)?.parsedDocument;
    return document && root?.path ? { document, fsPath: root.path } : undefined;
};

/**
 * Whether the manifest route can be taken in this mod at all, checked before anything is written so
 * the client can say so while it still has the author's attention.
 *
 * @param modRoot the mod the file would be created in.
 * @returns the reason the route is closed, absent when it is open.
 */
const manifestRouteBlocker = (modRoot: string): RegistrationFailure | undefined => {
    const choice = manifestForRegistration(modRoot);
    if (choice.kind === 'none') return 'noModRoot';
    if (choice.kind === 'ambiguous') return 'ambiguousManifest';
    return undefined;
};

/**
 * What each content kind would do in this mod.
 *
 * @param modRoot the mod the file would be created in.
 * @param hasShips whether the registry answered with any ship at all.
 * @param pointedAtBy the sentence each unregistered kind carries.
 * @returns one entry per kind, in the order the client offers them.
 */
const kindInfos = (
    modRoot: string,
    hasShips: boolean,
    pointedAtBy: (kind: ContentKind) => string | undefined
): ContentKindInfo[] =>
    CONTENT_KINDS.map((kind) => {
        const registration = REGISTRATION_ROUTE_OF_KIND[kind];
        let blocked: RegistrationFailure | undefined;
        if (registration === 'ship') blocked = hasShips ? undefined : 'noShipClasses';
        else if (registration === 'manifest') blocked = manifestRouteBlocker(modRoot);
        return { kind, folder: CONTENT_FOLDERS[kind], registration, pointedAtBy: pointedAtBy(kind), blocked };
    });

/**
 * Report what can be created in the mod the given file belongs to.
 *
 * @param modRoot the mod the file would be created in.
 * @param host the server facilities.
 * @param cancellationToken cancels the manifest reads.
 * @returns the kinds, the ships and the id prefix the client needs to ask its questions.
 */
const scanRound = async (
    modRoot: string,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<NewContentScanResult> => {
    const identity = await identityOfMod(modRoot).catch((): ModIdentity => ({ root: modRoot }));
    const entries = await shipClassesFor(host, cancellationToken);
    const ships = await shipCandidates(entries, modRoot, host.dataRoot());
    return {
        kind: 'scan',
        modRoot,
        modId: identity.manifestId ?? '',
        idPrefix: authorPrefixOf(identity.manifestId) ?? '',
        kinds: kindInfos(modRoot, ships.some((ship) => !ship.blocked), pointedAtByFor),
        ships,
    };
};

/**
 * The ids the created file's own id must not collide with.
 *
 * @param cls the schema class the id belongs to.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the lookup.
 * @returns the ids, folded to lower case the way the game matches them.
 */
const takenIds = async (
    cls: string,
    modRoot: string,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<Set<string>> => {
    const wide = host.existingIds
        ? await host.existingIds(cls, cancellationToken).catch(() => undefined)
        : undefined;
    if (wide) return new Set([...wide].map((id) => id.toLowerCase()));
    return await declaredIdsIn(modRoot, cls, cancellationToken);
};

/**
 * Whether a path names a saved ship on disk. The extension is the game's own for a ship image, and
 * a folder or a missing file is refused rather than copied into an empty logo.
 *
 * @param fsPath the path the client sent, absent when it sent none.
 * @returns true when there is a saved ship to copy.
 */
const isSavedShip = (fsPath: string | undefined): boolean => {
    if (!fsPath || !fsPath.toLowerCase().endsWith(SAVED_SHIP_EXTENSION)) return false;
    try {
        return statSync(fsPath).isFile();
    } catch {
        return false;
    }
};

/**
 * Work out the target of an apply round, refusing rather than writing when the name, the path or the
 * id is not free.
 *
 * Every one of these is re-asked here rather than trusted from the scan round: the client's picker
 * can sit open while the disk moves on, so the answers it was given are hints and nothing more.
 *
 * @param args the client's arguments.
 * @param kind the content kind being created.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the id lookup.
 * @returns the target, or the refusal.
 */
const targetFor = async (
    args: NewContentArgs,
    kind: ContentKind,
    modRoot: string,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<Target | NewContentFailure> => {
    const fileName = contentFileNameOf(args.name ?? '');
    if (!fileName) return 'invalidName';
    // A logo ship is copied rather than written, so the ship to copy has to be there before the
    // target is worth working out.
    if (kind === 'logoShip' && !isSavedShip(args.source)) return 'noSource';
    const fsPath = contentFilePathOf(modRoot, kind, fileName);
    const folder = contentFolderPathOf(modRoot, kind, fileName);
    if (existsSync(fsPath) || (folder && existsSync(folder))) return 'pathTaken';

    const identity = await identityOfMod(modRoot).catch((): ModIdentity => ({ root: modRoot }));
    const id = contentIdFor(kind, authorPrefixOf(identity.manifestId), fileName);
    const cls = ID_CLASS_OF_KIND[kind];
    if (id && cls) {
        const taken = await takenIds(cls, modRoot, host, cancellationToken);
        if (taken.has(id.toLowerCase())) return 'idTaken';
    }
    // A registry entry's id is matched against the game's own file and the mod's manifests rather
    // than against the schema id index, which never sees these registries. The game compares the
    // ids ignoring case, and a duplicate throws the moment it loads.
    const registry = REGISTRY_OF_KIND[kind];
    if (id && registry) {
        const taken = await registeredIds(registry, modRoot, host.dataRoot());
        if (taken.has(id.toLowerCase())) return 'idTaken';
    }
    return { modRoot, fileName, fsPath, folder, id };
};

/** What a localization insert did to one language file. */
interface StringsFileEdit {
    fsPath: string;
    /** The file's text with every missing key added. */
    text: string;
    /** The keys that were actually added, empty when the file already declared all of them. */
    added: string[];
}

/**
 * Add the template's localization keys to one language file, one after another, so the second key's
 * insertion point is measured against the text the first one produced.
 *
 * @param fsPath the language file.
 * @param source that file's current text.
 * @param entries the keys and their placeholder values.
 * @returns the file's new text and the keys that were added.
 */
const insertKeysInto = (fsPath: string, source: string, entries: readonly LocalizationEntry[]): StringsFileEdit => {
    const lineEnding = lineEndingOf(source);
    let text = source;
    const added: string[] = [];
    for (const entry of entries) {
        let document: AbstractNodeDocument;
        try {
            document = parseText(text, fsPath);
        } catch {
            break;
        }
        const edit = insertEditForFile(document, text, entry.key, entry.value);
        if (!edit) continue;
        const positions = TextDocument.create(filePathToUri(fsPath), 'rules', 0, text);
        const start = positions.offsetAt(edit.range.start);
        const end = positions.offsetAt(edit.range.end);
        // The insert is written with plain newlines, so a language file written with `\r\n` keeps its
        // own ending rather than gaining a second one halfway down.
        const inserted = lineEnding === '\n' ? edit.newText : edit.newText.split('\n').join(lineEnding);
        text = text.slice(0, start) + inserted + text.slice(end);
        added.push(entry.key);
    }
    return { fsPath, text, added };
};

/**
 * Write the template's localization keys into every language file the mod ships.
 *
 * A file the author has open goes through the editor, so the change lands in the undo history where
 * they can reach it, and the rest are written straight to disk, which is what keeps a mod with a
 * dozen languages from filling the workspace with unsaved buffers.
 *
 * Shared with the faction command, which declares a faction's name the same way.
 *
 * @param createdUri the created file's uri, which the mod's strings folders are resolved from.
 * @param entries the keys and their placeholder values.
 * @param host the server facilities.
 * @param cancellationToken cancels the folder resolution.
 * @returns the keys that were added and the files they were added to.
 */
export const writeLocalizationKeys = async (
    createdUri: string,
    entries: readonly LocalizationEntry[],
    host: Pick<NewContentHost, 'openDocuments' | 'applyEdit' | 'filesChanged'>,
    cancellationToken: CancellationToken
): Promise<{ keys: string[]; files: string[] }> => {
    if (entries.length === 0) return { keys: [], files: [] };
    const files = await modStringsFiles(createdUri, cancellationToken).catch(() => []);
    if (files.length === 0) return { keys: [], files: [] };

    const open = openBuffers(host);
    const changes: Record<string, TextEdit[]> = {};
    const touched: string[] = [];
    const added = new Set<string>();
    for (const file of files) {
        const fsPath = file.replace(/\\/g, '/');
        const buffer = open.get(normalizeUri(filePathToUri(fsPath)));
        const source = buffer?.getText() ?? (await readFile(fsPath, 'utf-8').catch(() => undefined));
        if (source === undefined) continue;
        const result = insertKeysInto(fsPath, source, entries);
        if (result.added.length === 0) continue;
        for (const key of result.added) added.add(key);
        touched.push(fsPath);
        if (buffer) {
            // One replacement of the whole buffer, since the keys were inserted one after another
            // and their offsets only make sense against the text each one produced.
            const end = buffer.positionAt(source.length);
            changes[buffer.uri] = [{ range: { start: { line: 0, character: 0 }, end }, newText: result.text }];
        } else {
            await writeFile(fsPath, result.text, { encoding: 'utf-8' }).catch(() => undefined);
        }
    }
    if (Object.keys(changes).length > 0) await host.applyEdit(changes).catch(() => false);
    if (touched.length > 0) host.filesChanged(touched);
    return { keys: [...added], files: touched };
};

/** What a registration did. */
interface RegistrationOutcome {
    route: RegistrationRoute;
    registeredIn: string;
    changedFiles: string[];
    failure?: RegistrationFailure;
    manifests?: string[];
    /** The path a `Replace` already named before it was re-pointed at the created file. */
    previousLogo?: string;
}

/**
 * Register a created part in the chosen ship, by handing the whole job to the shipped register-part
 * command, which already knows every case: a ship the mod owns takes the part in its own `Parts`
 * list, a ship of the game install is patched from the manifest, and an inherited `Parts`, an
 * ambiguous manifest or a part already listed are each refused rather than written.
 *
 * @param target the created part.
 * @param ship the ship key the client picked, absent when it picked none.
 * @param host the server facilities.
 * @param cancellationToken cancels the registry reads.
 * @returns what the registration did.
 */
const registerPart = async (
    target: Target,
    ship: string | undefined,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<RegistrationOutcome> => {
    if (!ship) return { route: 'ship', registeredIn: '', changedFiles: [], failure: 'noShipChosen' };
    const result = await registerPartInShip(
        // The template writes the part group first, so its name begins the file.
        { uri: filePathToUri(target.fsPath), offset: 0, ship },
        host,
        cancellationToken
    );
    if (result.kind !== 'apply') {
        return { route: 'ship', registeredIn: '', changedFiles: [], failure: result.failure ?? 'stale' };
    }
    // The manifest route changes the manifest, the ship route changes the ship's own file, so what
    // "registered in" names is whichever of the two was actually written.
    const registeredIn = result.via === 'modAction' ? (result.changedFiles[0] ?? '') : result.shipFsPath;
    return {
        route: 'ship',
        registeredIn: result.failure ? '' : registeredIn,
        changedFiles: result.changedFiles,
        failure: result.failure,
        manifests: result.manifests,
    };
};

/** A manifest route that wrote nothing, and why. */
const manifestFailed = (failure: RegistrationFailure, manifests?: string[]): RegistrationOutcome => ({
    route: 'manifest',
    registeredIn: '',
    changedFiles: [],
    failure,
    manifests,
});

/**
 * Write one action entry into the mod's manifest, which is how every manifest route ends: the
 * manifest is chosen, an entry that is already there is refused, and the new one is appended where
 * the manifest's own `Actions` list ends.
 *
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param alreadyThere whether one of the mod's manifests already carries the entry.
 * @param entryTextOf the entry's text, built once the manifest's directory, indentation and line
 * ending are known, since its source paths resolve against that directory.
 * @returns what the registration did.
 */
const writeManifestAction = async (
    modRoot: string,
    host: NewContentHost,
    alreadyThere: () => Promise<boolean>,
    entryTextOf: (manifestDir: string, indent: string, lineEnding: LineEnding) => string
): Promise<RegistrationOutcome> => {
    const choice = manifestForRegistration(modRoot);
    if (choice.kind === 'none') return manifestFailed('noModRoot');
    if (choice.kind === 'ambiguous') return manifestFailed('ambiguousManifest', choice.manifests);
    const manifestFsPath = choice.fsPath;
    if (await alreadyThere()) return manifestFailed('alreadyRegistered');

    const document = await documentFor(manifestFsPath, openBuffers(host));
    if (!document) return manifestFailed('notEditable');
    const text = document.getText();
    const lineEnding = lineEndingOf(text);
    const insert = manifestActionInsert(text, parseText(text, manifestFsPath), lineEnding);
    if (insert.kind === 'unusable') return manifestFailed('manifestUnusable');

    const entryText = entryTextOf(dirOf(manifestFsPath), insert.indent, lineEnding);
    const at = document.positionAt(insert.offset);
    const edits: TextEdit[] = [
        { range: { start: at, end: at }, newText: `${insert.before}${entryText}${insert.after}` },
    ];
    const applied = await host.applyEdit({ [document.uri]: edits }).catch(() => false);
    if (!applied) return manifestFailed('editRejected');
    host.filesChanged([manifestFsPath]);
    return { route: 'manifest', registeredIn: manifestFsPath, changedFiles: [manifestFsPath] };
};

/**
 * Register a created file in one of the game root's own lists, with an `AddMany` action in the mod's
 * manifest. That is the only way a mod reaches a registry the game owns, since the file holding it
 * belongs to the install and the mod may not edit it.
 *
 * @param target the created file.
 * @param member the game root member holding the list.
 * @param host the server facilities.
 * @returns what the registration did.
 */
const registerInGameRootList = async (
    target: Target,
    member: string,
    host: NewContentHost
): Promise<RegistrationOutcome> => {
    const dataRoot = host.dataRoot();
    const root = await gameRootOf(host);
    if (!dataRoot || !root) return manifestFailed('noGameRoot');
    const registryTarget = gameRootListTarget(root.document, root.fsPath, dataRoot, member);
    if (!registryTarget) return manifestFailed('noGameRoot');
    return await writeManifestAction(
        target.modRoot,
        host,
        () => manifestAlreadyAdds(target.modRoot, registryTarget, target.fsPath),
        // A mod action's source references resolve against the file the action is written in, never
        // against the game root its target names. The entry is memberless because a registry of
        // whole files is what the game root's own list holds.
        (manifestDir, indent, lineEnding) =>
            addManyActionText(registryTarget, `&${relativeRulesReference(manifestDir, target.fsPath)}`, indent, lineEnding)
    );
};

/**
 * Register a created decal group in the game's own `Groups` list, with an `AddMany` naming the group
 * inside the created file, since that list holds groups and the file merely carries one.
 *
 * @param target the created decal group file.
 * @param host the server facilities.
 * @returns what the registration did.
 */
const registerDecalGroup = async (target: Target, host: NewContentHost): Promise<RegistrationOutcome> => {
    const dataRoot = host.dataRoot();
    // The decal file is the proof that the install is really there, in place of the game root the
    // other routes read, because nothing in the game root points at it.
    if (!dataRoot || !existsSync(join(dataRoot, DECAL_GROUPS_FILE))) return manifestFailed('noGameRoot');
    const registryTarget = `<${DECAL_GROUPS_FILE}>/${DECAL_GROUPS_MEMBER}`;
    return await writeManifestAction(
        target.modRoot,
        host,
        () => manifestAlreadyAdds(target.modRoot, registryTarget, target.fsPath),
        (manifestDir, indent, lineEnding) =>
            addManyActionText(
                registryTarget,
                `&${relativeRulesReference(manifestDir, target.fsPath, DECAL_GROUP_MEMBER)}`,
                indent,
                lineEnding
            )
    );
};

/**
 * The action target of a gui registry, once the file holding it is really there. The game root does
 * not name these files, so the file is the proof of the install, as it is for the decal groups.
 *
 * @param registry the registry.
 * @param host the server facilities.
 * @returns the target, or undefined when the game path is unset or the file is missing.
 */
const guiRegistryTarget = (registry: RegistrySpec, host: NewContentHost): string | undefined => {
    const dataRoot = host.dataRoot();
    if (!dataRoot || !existsSync(join(dataRoot, registry.vanillaFile))) return undefined;
    return registry.targets[0];
};

/**
 * Register a created toolbar category as a named member of the game's editor groups. The category
 * is a member of a group rather than an entry of a list, so it takes an `Add` with a `Name`, the
 * one verb that can add a named member, and the name is the id a part writes.
 *
 * @param target the created category file.
 * @param host the server facilities.
 * @returns what the registration did.
 */
const registerEditorGroup = async (target: Target, host: NewContentHost): Promise<RegistrationOutcome> => {
    const registryTarget = guiRegistryTarget(EDITOR_GROUP_REGISTRY, host);
    if (!registryTarget) return manifestFailed('noGameRoot');
    return await writeManifestAction(
        target.modRoot,
        host,
        () => manifestAlreadyAdds(target.modRoot, registryTarget, target.fsPath),
        (manifestDir, indent, lineEnding) =>
            actionEntryText(
                [
                    'Action = Add',
                    `AddTo = "${registryTarget}"`,
                    `Name = "${target.id}"`,
                    `ToAdd = &${relativeRulesReference(manifestDir, target.fsPath, target.id)}`,
                ],
                indent,
                lineEnding
            )
    );
};

/**
 * Register a created stat line or toggle in the game's own list of them, with an `AddMany` naming
 * the entry inside the created file, since the list holds entries and the file merely carries one.
 *
 * @param target the created file.
 * @param registry the registry the entry goes into.
 * @param member the member of the created file holding the entry.
 * @param host the server facilities.
 * @returns what the registration did.
 */
const registerInGuiRegistry = async (
    target: Target,
    registry: RegistrySpec,
    member: string,
    host: NewContentHost
): Promise<RegistrationOutcome> => {
    const registryTarget = guiRegistryTarget(registry, host);
    if (!registryTarget) return manifestFailed('noGameRoot');
    return await writeManifestAction(
        target.modRoot,
        host,
        () => manifestAlreadyAdds(target.modRoot, registryTarget, target.fsPath),
        (manifestDir, indent, lineEnding) =>
            addManyActionText(
                registryTarget,
                `&${relativeRulesReference(manifestDir, target.fsPath, member)}`,
                indent,
                lineEnding
            )
    );
};

/**
 * Register a created buff by merging its file into the game's buff map with an `Overrides`. The map
 * is a group rather than a list, so the list verbs throw on it, and the merge is by member name,
 * which is why the file holds the buff as its one member. The target is the reference the game root
 * writes for its `Buffs`, and the literal path stands in for a root that does not name it, as long
 * as the file is really there.
 *
 * @param target the created buff file.
 * @param host the server facilities.
 * @returns what the registration did.
 */
const registerBuff = async (target: Target, host: NewContentHost): Promise<RegistrationOutcome> => {
    const dataRoot = host.dataRoot();
    if (!dataRoot) return manifestFailed('noGameRoot');
    const root = await gameRootOf(host);
    const derived = root ? gameRootListTarget(root.document, root.fsPath, dataRoot, BUFFS_MEMBER) : undefined;
    const fallback = existsSync(join(dataRoot, BUFF_REGISTRY.vanillaFile)) ? BUFF_REGISTRY.targets[0] : undefined;
    const registryTarget = derived ?? fallback;
    if (!registryTarget) return manifestFailed('noGameRoot');
    return await writeManifestAction(
        target.modRoot,
        host,
        () => manifestAlreadyOverridesWith(target.modRoot, registryTarget, target.fsPath),
        (manifestDir, indent, lineEnding) =>
            overridesActionText(registryTarget, `&${relativeRulesReference(manifestDir, target.fsPath)}`, indent, lineEnding)
    );
};

/**
 * Register a created codex page in the game's tutorial pages, with an `AddMany` naming the whole
 * file, since the list holds pages and the file is one.
 *
 * @param target the created page file.
 * @param host the server facilities.
 * @returns what the registration did.
 */
const registerCodexPage = async (target: Target, host: NewContentHost): Promise<RegistrationOutcome> => {
    const dataRoot = host.dataRoot();
    // The tutorial file is the proof that the install is really there, as the decal file is for a
    // decal group, because the game root reaches it only through the codex file's own list.
    if (!dataRoot || !existsSync(join(dataRoot, CODEX_TUTORIALS_FILE))) return manifestFailed('noGameRoot');
    const registryTarget = `<${CODEX_TUTORIALS_FILE}>/${CODEX_PAGES_MEMBER}`;
    return await writeManifestAction(
        target.modRoot,
        host,
        () => manifestAlreadyAdds(target.modRoot, registryTarget, target.fsPath),
        (manifestDir, indent, lineEnding) =>
            addManyActionText(registryTarget, `&${relativeRulesReference(manifestDir, target.fsPath)}`, indent, lineEnding)
    );
};

/**
 * Point an existing `Replace` action's `With` at another file, keeping everything else about the
 * action as the author wrote it. The old path is reported so the author knows which file the
 * manifest no longer names, since that file is left where it is.
 *
 * @param existing the action to re-point.
 * @param fsPath the file the value is replaced with from now on.
 * @param host the server facilities.
 * @returns what the registration did.
 */
const repointReplace = async (
    existing: ManifestReplaceAction,
    fsPath: string,
    host: NewContentHost
): Promise<RegistrationOutcome> => {
    const document = await documentFor(existing.manifestFsPath, openBuffers(host));
    if (!document) return manifestFailed('notEditable');
    const previous = String(existing.source.valueType.value);
    const path = manifestRelativePath(dirOf(existing.manifestFsPath), fsPath);
    const { line, characterStart, characterEnd } = existing.source.position;
    // The value's range is replaced as it was written, quotes and all when it had them.
    const written = document.getText({ start: { line, character: characterStart }, end: { line, character: characterEnd } });
    const quoted = written.startsWith('"') || written.startsWith("'");
    const edits: TextEdit[] = [
        {
            range: { start: { line, character: characterStart }, end: { line, character: characterEnd } },
            newText: quoted ? `${written[0]}${path}${written[0]}` : path,
        },
    ];
    const applied = await host.applyEdit({ [document.uri]: edits }).catch(() => false);
    if (!applied) return manifestFailed('editRejected');
    host.filesChanged([existing.manifestFsPath]);
    return {
        route: 'manifest',
        registeredIn: existing.manifestFsPath,
        changedFiles: [existing.manifestFsPath],
        previousLogo: previous,
    };
};

/**
 * The path of a file the way a manifest names it, relative to the manifest's own directory.
 *
 * @param manifestDir the manifest's directory.
 * @param fsPath the file being named.
 * @returns the relative path, forward slashes on every platform.
 */
const manifestRelativePath = (manifestDir: string, fsPath: string): string =>
    relative(manifestDir, fsPath).replace(/\\/g, '/');

/**
 * Point the title screen at a copied logo ship, with a `Replace` action on the menu rules' `LogoShip`
 * value. The value is a single path rather than a list, so it is replaced rather than added to, and
 * the path is written relative to the manifest, which is how the game reads a `With`.
 *
 * @param target the copied ship image.
 * @param host the server facilities.
 * @returns what the registration did.
 */
const registerLogoShip = async (target: Target, host: NewContentHost): Promise<RegistrationOutcome> => {
    const dataRoot = host.dataRoot();
    if (!dataRoot) return manifestFailed('noGameRoot');
    const root = await gameRootOf(host);
    const derived = root ? gameRootMemberTarget(root.document, MENUS_MEMBER, LOGO_SHIP_MEMBER) : undefined;
    // A game root that does not name its menus is still a game whose menus are where they always
    // are, so the literal path stands in when the file is really there.
    const fallback = existsSync(join(dataRoot, MENUS_FILE)) ? `<${MENUS_FILE}>/${LOGO_SHIP_MEMBER}` : undefined;
    const logoTarget = derived ?? fallback;
    if (!logoTarget) return manifestFailed('noGameRoot');
    if (await manifestAlreadyReplacesWith(target.modRoot, logoTarget, target.fsPath)) {
        return manifestFailed('alreadyRegistered');
    }
    // The title screen shows one ship, so a mod that already replaces it gets that action pointed
    // at the new copy rather than a second action saying something else about the same value.
    const existing = await manifestReplaceActionFor(target.modRoot, logoTarget);
    if (existing) return await repointReplace(existing, target.fsPath, host);
    return await writeManifestAction(
        target.modRoot,
        host,
        async () => false,
        (manifestDir, indent, lineEnding) =>
            actionEntryText(
                [
                    'Action = Replace',
                    `Replace = "${logoTarget}"`,
                    `With = "${manifestRelativePath(manifestDir, target.fsPath)}"`,
                ],
                indent,
                lineEnding
            )
    );
};

/**
 * Take whichever registration route the kind has.
 *
 * @param kind the content kind that was created.
 * @param target the created file.
 * @param args the client's arguments, which carry the ship a part goes in.
 * @param host the server facilities.
 * @param cancellationToken cancels the registry reads.
 * @returns what the registration did, or that the kind has no route.
 */
const register = async (
    kind: ContentKind,
    target: Target,
    args: NewContentArgs,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<RegistrationOutcome> => {
    switch (kind) {
        case 'part':
            return await registerPart(target, args.ship, host, cancellationToken);
        case 'resource':
            return await registerInGameRootList(target, RESOURCES_MEMBER, host);
        case 'logoShip':
            return await registerLogoShip(target, host);
        case 'decalFolder':
            return await registerDecalGroup(target, host);
        case 'editorGroup':
            return await registerEditorGroup(target, host);
        case 'partStat':
            return await registerInGuiRegistry(target, PART_STAT_REGISTRY, STAT_MEMBER, host);
        case 'partToggle':
            return await registerInGuiRegistry(target, PART_TOGGLE_REGISTRY, TOGGLE_MEMBER, host);
        case 'buff':
            return await registerBuff(target, host);
        case 'codexPage':
            return await registerCodexPage(target, host);
        case 'bullet':
        case 'mediaEffect':
            return { route: 'none', registeredIn: '', changedFiles: [] };
    }
};

/**
 * The reference that reaches a created file, written from the directory of the file the command was
 * invoked on, which is the file the author is looking at and the one they will paste it into.
 *
 * @param kind the content kind that was created.
 * @param anchor where the command was invoked.
 * @param target the created file.
 * @returns the reference, sigil included, or the manifest-relative path for a logo ship, which no
 * reference can name.
 */
const referenceTo = (kind: ContentKind, anchor: Anchor, target: Target): string => {
    switch (kind) {
        case 'logoShip':
            // The manifest sits at the mod root, so the path is the one the Replace action wrote.
            return manifestRelativePath(target.modRoot, target.fsPath);
        case 'part':
            return `&${relativeRulesReference(anchor.dir, target.fsPath, 'Part')}`;
        case 'decalFolder':
            return `&${relativeRulesReference(anchor.dir, target.fsPath, DECAL_GROUP_MEMBER)}`;
        case 'editorGroup':
        case 'partStat':
        case 'partToggle':
        case 'buff':
            // A part never references the entry's file. It writes the id, as its `EditorGroup`, as
            // a name inside its `Stats`, as a component's `ToggleID` or as a `BuffType`, so the id
            // is the reference.
            return target.id;
        case 'resource':
        case 'bullet':
        case 'mediaEffect':
        case 'codexPage':
            return `&${relativeRulesReference(anchor.dir, target.fsPath)}`;
    }
};

/**
 * Write a created file, exclusively, so a file that appeared between the check and the write is
 * never overwritten.
 *
 * @param fsPath the file to write.
 * @param text its content.
 * @returns why nothing was written, absent on success.
 */
const writeCreated = async (fsPath: string, text: string): Promise<NewContentFailure | undefined> => {
    try {
        await mkdir(dirname(fsPath), { recursive: true });
        await writeFile(fsPath, text, { encoding: 'utf-8', flag: 'wx' });
        return undefined;
    } catch {
        return existsSync(fsPath) ? 'pathTaken' : 'writeFailed';
    }
};

/**
 * Copy the saved ship a logo ship is made from, with the same refusal to overwrite.
 *
 * @param source the saved ship the client named.
 * @param fsPath where the copy goes.
 * @returns why nothing was copied, absent on success.
 */
const copySavedShip = async (source: string, fsPath: string): Promise<NewContentFailure | undefined> => {
    try {
        await mkdir(dirname(fsPath), { recursive: true });
        await copyFile(source, fsPath, constants.COPYFILE_EXCL);
        return undefined;
    } catch {
        return existsSync(fsPath) ? 'pathTaken' : 'writeFailed';
    }
};

/**
 * The line ending the mod's own files use, taken from its manifest so a created file matches what is
 * already there rather than whatever the platform would have written.
 *
 * @param modRoot the mod being written to.
 * @returns the ending, defaulting to `\n` when the manifest cannot be read.
 */
const modLineEnding = async (modRoot: string): Promise<'\n' | '\r\n'> => {
    const choice = manifestForRegistration(modRoot);
    if (choice.kind !== 'manifest') return '\n';
    const file = await readRulesFile(choice.fsPath);
    return file ? lineEndingOf(file.text) : '\n';
};

/**
 * Create the file, register it and add its localization keys.
 *
 * @param args the client's arguments.
 * @param kind the content kind being created.
 * @param modRoot the mod being written to.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads.
 * @returns what was created, or the reason nothing was.
 */
const applyRound = async (
    args: NewContentArgs,
    kind: ContentKind,
    modRoot: string,
    anchor: Anchor,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<NewContentApplyResult> => {
    const target = await targetFor(args, kind, modRoot, host, cancellationToken);
    if (typeof target === 'string') return applyFailed(kind, target);

    const emitted = emitContent(kind, target.fileName, target.id, await modLineEnding(modRoot));
    // A logo ship is the author's own saved ship rather than a template, so it is copied in whole.
    const failure =
        kind === 'logoShip'
            ? await copySavedShip(args.source ?? '', target.fsPath)
            : await writeCreated(target.fsPath, emitted.text);
    if (failure) return applyFailed(kind, failure);
    host.filesChanged([target.fsPath]);

    const localization = await writeLocalizationKeys(
        filePathToUri(target.fsPath),
        emitted.localization,
        host,
        cancellationToken
    ).catch(() => ({ keys: [], files: [] }));

    const registration: RegistrationOutcome = args.skipRegistration
        ? { route: 'none', registeredIn: '', changedFiles: [] }
        : await register(kind, target, args, host, cancellationToken);

    return {
        kind: 'apply',
        created: target.fsPath,
        contentKind: kind,
        id: target.id,
        route: registration.route,
        registeredIn: registration.registeredIn,
        registrationFailure: registration.failure,
        manifests: registration.manifests,
        changedFiles: [...new Set([...registration.changedFiles, ...localization.files])],
        localizationKeys: emitted.localization.map((entry) => entry.key),
        localizationFiles: localization.files,
        reference: referenceTo(kind, anchor, target),
        pointedAtBy: emitted.pointedAtBy,
        usage: emitted.usage,
        placeholderAssets: emitted.placeholderAssets,
        ...(registration.previousLogo !== undefined ? { previousLogo: registration.previousLogo } : {}),
    };
};

/**
 * The command entry point: report what can be created when the client sent no name, and create it
 * otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the registry and manifest reads.
 * @returns what can be created, or what was.
 */
export const newContent = async (
    args: NewContentArgs,
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<NewContentResult> => {
    const kind = args.kind;
    const scanning = !args.name;
    if (!scanning && (!kind || !CONTENT_KINDS.includes(kind))) {
        return applyFailed(kind ?? 'part', 'unknownKind');
    }
    const anchor = anchorOf(args.uri);
    const located = modRootFor(anchor.fsPath, host.dataRoot());
    if ('failure' in located) {
        return scanning ? scanFailed(located.failure) : applyFailed(kind ?? 'part', located.failure);
    }
    if (scanning) return await scanRound(located.modRoot, host, cancellationToken);
    return await applyRound(args, kind as ContentKind, located.modRoot, anchor, host, cancellationToken);
};
