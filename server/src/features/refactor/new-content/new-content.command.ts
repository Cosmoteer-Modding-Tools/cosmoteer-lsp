import { existsSync, statSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNodeDocument } from '../../../core/ast/ast';
import { identityOfMod, ModIdentity } from '../../../mod/mod-dependencies';
import { findModRoot } from '../../../mod/mod-root';
import { parseText } from '../../../utils/ast.utils';
import { CosmoteerWorkspaceData, FileWithPath } from '../../../workspace/cosmoteer-workspace.service';
import { foldPathCase } from '../../../workspace/fs-cache';
import { insertEditForFile, modStringsFiles } from '../../diagnostics/localization-key-insert';
import { filePathToUri } from '../../navigation/navigation-strategy';
import { normalizeUri } from '../../navigation/reference-location';
import { uriToFsPath } from '../../navigation/workspace-files';
import { relativeRulesReference } from '../shared-base/base-file.emitter';
import { dirOf, readRulesFile } from '../shared-base/base-index';
import { editableModRootOf } from '../shared-base/shared-base.analysis-entry';
import { addManyActionText, manifestActionInsert } from '../register-part/manifest-action.emitter';
import { RegisterPartHost, registerPartInShip } from '../register-part/register-part.command';
import {
    collectShipClasses,
    modRootsUnder,
    ShipClassEntry,
    shipPartsListOf,
} from '../register-part/ship-registry';
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
} from './content-templates';
import {
    gameRootListTarget,
    manifestAlreadyAdds,
    manifestForRegistration,
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

/** The line ending a file already uses, so anything written beside it keeps it. */
const lineEndingOf = (text: string): '\n' | '\r\n' => (text.includes('\r\n') ? '\r\n' : '\n');

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

/** Whether a path sits inside a directory, folding case the way the filesystem matches it. */
const isUnder = (fsPath: string, root: string | undefined): boolean => {
    if (!root) return false;
    const key = foldPathCase(resolve(fsPath).replace(/\\/g, '/'));
    const prefix = foldPathCase(resolve(root).replace(/\\/g, '/').replace(/\/+$/, ''));
    return key === prefix || key.startsWith(`${prefix}/`);
};

/** The open buffers keyed by normalized uri, so a file open in the editor is read and edited live. */
const openBuffers = (host: NewContentHost): Map<string, TextDocument> => {
    const map = new Map<string, TextDocument>();
    for (const document of host.openDocuments()) map.set(normalizeUri(document.uri), document);
    return map;
};

/** The open buffer for a path, or a document built from its disk content. */
const documentFor = async (
    fsPath: string,
    open: ReadonlyMap<string, TextDocument>
): Promise<TextDocument | undefined> => {
    const canonical = filePathToUri(fsPath);
    const buffer = open.get(normalizeUri(canonical));
    if (buffer) return buffer;
    try {
        return TextDocument.create(canonical, 'rules', 0, await readFile(fsPath, { encoding: 'utf-8' }));
    } catch {
        return undefined;
    }
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
 * The ship classes the game loads, from its own registry and from the workspace mods' manifests.
 *
 * @param host the server facilities.
 * @param cancellationToken cancels the manifest reads.
 * @returns the ship classes, empty when the game path is unset and no mod adds one.
 */
const shipEntries = async (
    host: NewContentHost,
    cancellationToken: CancellationToken
): Promise<ShipClassEntry[]> => {
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as CosmoteerWorkspaceData | undefined)?.parsedDocument;
    const folders = await host.folderPaths().catch(() => []);
    const modRoots = new Set<string>();
    for (const folder of folders) for (const modRoot of modRootsUnder(folder)) modRoots.add(modRoot);
    return await collectShipClasses(rootDocument, root?.path, [...modRoots], cancellationToken);
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
        const registration: RegistrationRoute =
            kind === 'part' ? 'ship' : kind === 'resource' ? 'manifest' : 'none';
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
    const entries = await shipEntries(host, cancellationToken);
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
 * @param createdUri the created file's uri, which the mod's strings folders are resolved from.
 * @param entries the keys and their placeholder values.
 * @param host the server facilities.
 * @param cancellationToken cancels the folder resolution.
 * @returns the keys that were added and the files they were added to.
 */
const writeLocalizationKeys = async (
    createdUri: string,
    entries: readonly LocalizationEntry[],
    host: NewContentHost,
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
    const failed = (failure: RegistrationFailure, manifests?: string[]): RegistrationOutcome => ({
        route: 'manifest',
        registeredIn: '',
        changedFiles: [],
        failure,
        manifests,
    });
    const dataRoot = host.dataRoot();
    const root = await gameRootOf(host);
    if (!dataRoot || !root) return failed('noGameRoot');
    const registryTarget = gameRootListTarget(root.document, root.fsPath, dataRoot, member);
    if (!registryTarget) return failed('noGameRoot');

    const choice = manifestForRegistration(target.modRoot);
    if (choice.kind === 'none') return failed('noModRoot');
    if (choice.kind === 'ambiguous') return failed('ambiguousManifest', choice.manifests);
    const manifestFsPath = choice.fsPath;
    if (await manifestAlreadyAdds(target.modRoot, registryTarget, target.fsPath)) {
        return failed('alreadyRegistered');
    }

    const document = await documentFor(manifestFsPath, openBuffers(host));
    if (!document) return failed('notEditable');
    const text = document.getText();
    const lineEnding = lineEndingOf(text);
    const insert = manifestActionInsert(text, parseText(text, manifestFsPath), lineEnding);
    if (insert.kind === 'unusable') return failed('manifestUnusable');

    // A mod action's source references resolve against the file the action is written in, never
    // against the game root its target names. The entry is memberless because a registry of whole
    // files is what the game root's own list holds.
    const reference = `&${relativeRulesReference(dirOf(manifestFsPath), target.fsPath)}`;
    const entryText = addManyActionText(registryTarget, reference, insert.indent, lineEnding);
    const at = document.positionAt(insert.offset);
    const edits: TextEdit[] = [
        { range: { start: at, end: at }, newText: `${insert.before}${entryText}${insert.after}` },
    ];
    const applied = await host.applyEdit({ [document.uri]: edits }).catch(() => false);
    if (!applied) return failed('editRejected');
    host.filesChanged([manifestFsPath]);
    return { route: 'manifest', registeredIn: manifestFsPath, changedFiles: [manifestFsPath] };
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
    try {
        await mkdir(dirname(target.fsPath), { recursive: true });
        // Exclusive, so a file that appeared between the check and the write is never overwritten.
        await writeFile(target.fsPath, emitted.text, { encoding: 'utf-8', flag: 'wx' });
    } catch {
        return applyFailed(kind, existsSync(target.fsPath) ? 'pathTaken' : 'writeFailed');
    }
    host.filesChanged([target.fsPath]);

    const localization = await writeLocalizationKeys(
        filePathToUri(target.fsPath),
        emitted.localization,
        host,
        cancellationToken
    ).catch(() => ({ keys: [], files: [] }));

    let registration: RegistrationOutcome = { route: 'none', registeredIn: '', changedFiles: [] };
    if (!args.skipRegistration) {
        if (kind === 'part') registration = await registerPart(target, args.ship, host, cancellationToken);
        else if (kind === 'resource') registration = await registerInGameRootList(target, RESOURCES_MEMBER, host);
    }

    // The reference is written from the directory of the file the command was invoked on, which is
    // the file the author is looking at and the one they will paste it into.
    const anchorDir = dirOf(uriToFsPath(args.uri).replace(/\\/g, '/'));
    const member = kind === 'part' ? 'Part' : undefined;
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
        reference: `&${relativeRulesReference(anchor.dir, target.fsPath, member)}`,
        pointedAtBy: emitted.pointedAtBy,
        placeholderAssets: emitted.placeholderAssets,
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
