import { readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNode, GroupNode, isListNode, isValueNode } from '../../../core/ast/ast';
import { basenameOf } from '../../../document/document-kind';
import { parseModActions } from '../../../mod/action-parser';
import { normalizeTargetPath } from '../../../mod/action-target-resolver';
import { findModRoot } from '../../../mod/mod-root';
import { findMemberThroughInheritance, ResolveReferenceFn } from '../../../semantics/inheritance-resolver';
import { globalSettings } from '../../../settings';
import { namedMembersOf, parseText } from '../../../utils/ast.utils';
import { FileWithPath, CosmoteerWorkspaceData } from '../../../workspace/cosmoteer-workspace.service';
import { foldPathCase } from '../../../workspace/fs-cache';
import { FullNavigationStrategy } from '../../navigation/full.navigation-strategy';
import { filePathToUri } from '../../navigation/navigation-strategy';
import { normalizeUri } from '../../navigation/reference-location';
import { uriToFsPath } from '../../navigation/workspace-files';
import { appendElementEdit, isError } from '../../part-editor/grid-edit.service';
import { locatePartGroup } from '../../part-editor/part-grid-data.service';
import { relativeRulesReference } from '../shared-base/base-file.emitter';
import { dirOf, readRulesFile } from '../shared-base/base-index';
import { editableModRootOf } from '../shared-base/shared-base.analysis-entry';
import { addManyActionText, manifestActionInsert, shipPartsTargetPath } from './manifest-action.emitter';
import {
    collectShipClasses,
    manifestsIn,
    modRootsUnder,
    partsListRegisters,
    ShipClassEntry,
    ShipParts,
    shipPartsIn,
    shipPartsListOf,
} from './ship-registry';

/**
 * The `workspace/executeCommand` id that registers a part in a ship class. Both clients invoke it
 * twice: without a ship it reports the ship classes the part could be registered in, and with one it
 * writes the registration, either into that ship's own `Parts` list or into the mod's manifest.
 */
export const REGISTER_PART_IN_SHIP_COMMAND = 'cosmoteer.registerPartInShip';

/**
 * The command the lightbulb's refactoring carries, deliberately absent from the server's
 * `executeCommandProvider` so that it is never executed here.
 *
 * Which ship class the part belongs in is a choice only the author can make, and a code action has no
 * way to ask for one. A client resolves a command against its own handlers only when the server does
 * not claim it, so leaving this one unclaimed is what hands the exchange to the client. Both clients
 * implement it: they run the scan round, ask, then invoke {@link REGISTER_PART_IN_SHIP_COMMAND} with
 * the answer.
 */
export const REGISTER_PART_IN_SHIP_ACTION_COMMAND = 'cosmoteer.registerPartInShipFromAction';

/** What the client sends: the part, and on the second round the ship it picked. */
export interface RegisterPartArgs {
    /** The file the part group lives in. */
    uri: string;
    /** The byte offset of the part group's name in that file. */
    offset: number;
    /** The {@link ShipCandidate.key} of the chosen ship. Absent means "report the candidates". */
    ship?: string;
}

/** Why a ship cannot take the part, whatever else is true of it. */
export type ShipBlocker = 'partsInherited' | 'noPartsList' | 'notEditable' | 'noModRoot' | 'unreadable';

/** Why a registration did nothing. */
export type RegisterPartFailure =
    | 'stale'
    | 'noShipClasses'
    | 'unknownShip'
    | 'alreadyRegistered'
    | 'partsInherited'
    | 'noPartsList'
    | 'noModRoot'
    | 'ambiguousManifest'
    | 'notEditable'
    | 'editRejected';

/** Something worth saying that did not stop the registration. */
export type RegisterPartWarning = 'noPartId';

/** One ship class the part could be registered in, and what registering would take. */
export interface ShipCandidate {
    /** The identity the client sends back to pick this ship. */
    key: string;
    /** The ship group's name in its own file. */
    groupName: string;
    /** The ship's written `ID`, absent when it declares none. */
    id?: string;
    /** The ship file's on-disk path. */
    fsPath: string;
    /** Whether the ship belongs to the workspace or to the game's own install. */
    target: 'workspace' | 'vanilla';
    /** Whether registering writes into the ship's own file or into the mod's manifest. */
    via: 'shipFile' | 'modAction';
    /** True when the part is already in that ship's parts, so registering would duplicate it. */
    alreadyRegistered: boolean;
    /** Why this ship cannot take the part, absent when it can. */
    blocked?: ShipBlocker;
}

/** The ship classes the part could be registered in. */
export interface RegisterPartScanResult {
    kind: 'scan';
    /** The part's own id, read locally or through its bases, absent when it declares none anywhere. */
    partId?: string;
    /** The part group's name, which is what a registration reference names. */
    partGroupName: string;
    /** The candidates in registry order, mod-added ships last. */
    candidates: ShipCandidate[];
    /** Why the candidates could not be worked out, absent on success. */
    failure?: RegisterPartFailure;
}

/** What a registration did, or why it did nothing. */
export interface RegisterPartApplyResult {
    kind: 'apply';
    /** The ship file the part was registered in, empty when nothing was written. */
    shipFsPath: string;
    /** Whether the registration went into the ship's own file or into the mod's manifest. */
    via: 'shipFile' | 'modAction';
    /** Every file the edit changed, so the client can save and tidy them. */
    changedFiles: string[];
    /** The reference that was written, sigil included, empty when nothing was written. */
    reference: string;
    /** Something worth saying that did not stop the registration. */
    warning?: RegisterPartWarning;
    /** Why nothing was written, absent on success. */
    failure?: RegisterPartFailure;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
}

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface RegisterPartHost {
    /** The workspace folders whose mods may declare ships, as on-disk paths. */
    folderPaths(): Promise<string[]>;
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** The game's own root `cosmoteer.rules`, which holds the ship registry. */
    gameRoot(): Promise<FileWithPath | undefined>;
    /** The game's `Data` directory, which decides whether a ship is the install's or the mod's. */
    dataRoot(): string | undefined;
    /** Hands the client the edit. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Announces the files the command wrote, so the indexes pick them up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}

/** How many ships a scan reports, so a workspace full of ship mods still answers with a readable list. */
const MAX_REPORTED_SHIPS = 40;

const navigation = new FullNavigationStrategy();

/** Adapts the shared navigation strategy to the inheritance resolver's reference-resolution shape. */
const resolveReference: ResolveReferenceFn = (path, startNode, currentLocation, token, inheritanceVisited) =>
    navigation.navigate(path, startNode, currentLocation, token, new Set(), inheritanceVisited) as ReturnType<
        ResolveReferenceFn
    >;

/** The part the offer was made on, resolved against what its file says right now. */
interface ResolvedPart {
    /** The file's uri in the spelling an edit has to name it by. */
    uri: string;
    /** The file's on-disk path, with forward slashes. */
    fsPath: string;
    /** The part group's name. */
    groupName: string;
    /** The part's id, read locally or through its bases. */
    id?: string;
    /** The group itself, for the inheritance read. */
    group: GroupNode;
}

/** The open buffers keyed by normalized uri, so a file open in the editor is read and edited live. */
const openBuffers = (host: RegisterPartHost): Map<string, TextDocument> => {
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

/** Whether a path sits inside a directory, folding case the way the filesystem matches it. */
const isUnder = (fsPath: string, root: string | undefined): boolean => {
    if (!root) return false;
    const key = foldPathCase(resolve(fsPath).replace(/\\/g, '/'));
    const prefix = foldPathCase(resolve(root).replace(/\\/g, '/').replace(/\/+$/, ''));
    return key === prefix || key.startsWith(`${prefix}/`);
};

/** The line ending a file already uses, so anything written into it keeps it. */
const lineEndingOf = (text: string): '\n' | '\r\n' => (text.includes('\r\n') ? '\r\n' : '\n');

/**
 * The part's id, read from its own group and then through its bases. It is only ever reported, never
 * required: a part is registered by the reference path to its group, not by its id.
 *
 * @param group the part group.
 * @param cancellationToken cancels the inheritance walk.
 * @returns the id, or undefined when neither the group nor any base declares one.
 */
const partIdOf = async (group: GroupNode, cancellationToken: CancellationToken): Promise<string | undefined> => {
    for (const [name, node] of namedMembersOf(group)) {
        if (name.toLowerCase() === 'id' && isValueNode(node)) return String(node.valueType.value);
    }
    const inherited = await findMemberThroughInheritance(group, 'ID', resolveReference, cancellationToken).catch(
        () => null
    );
    return isValueNode(inherited) ? String(inherited.valueType.value) : undefined;
};

/**
 * The part the arguments point at, read from the editor's buffer so an unsaved edit is what is
 * registered.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the inheritance walk the id read makes.
 * @returns the part, or undefined when the offset no longer sits in a part group.
 */
const resolvePart = async (
    args: RegisterPartArgs,
    host: RegisterPartHost,
    cancellationToken: CancellationToken
): Promise<ResolvedPart | undefined> => {
    const fsPath = uriToFsPath(args.uri).replace(/\\/g, '/');
    const document = await documentFor(fsPath, openBuffers(host));
    if (!document) return undefined;
    const text = document.getText();
    const parsed = parseText(text, fsPath);
    const group = locatePartGroup(parsed, args.offset);
    if (!group?.identifier) return undefined;
    // The offer anchors on the group's own name. An edit that moved the group out from under the
    // offset makes the offer stale rather than registering whatever now sits there, and the
    // container-position invariant leaves an unclosed group's end at zero, which reads as open-ended.
    const end = group.position.end > group.position.start ? group.position.end : Number.MAX_SAFE_INTEGER;
    if (args.offset < group.identifier.position.start || args.offset >= end) return undefined;
    return {
        uri: document.uri,
        fsPath,
        groupName: group.identifier.name,
        id: await partIdOf(group, cancellationToken),
        group,
    };
};

/**
 * The ship classes the game loads, from the game's own registry and from the workspace mods' manifests.
 *
 * @param host the server facilities.
 * @param cancellationToken cancels the manifest reads.
 * @returns the ship classes, empty when the game path is unset and no mod adds one.
 */
const shipEntries = async (
    host: RegisterPartHost,
    cancellationToken: CancellationToken
): Promise<ShipClassEntry[]> => {
    const root = await host.gameRoot().catch(() => undefined);
    const rootDocument = (root?.content as CosmoteerWorkspaceData | undefined)?.parsedDocument;
    const folders = await host.folderPaths().catch(() => []);
    const modRoots = new Set<string>();
    for (const folder of folders) for (const modRoot of modRootsUnder(folder)) modRoots.add(modRoot);
    return await collectShipClasses(rootDocument, root?.path, [...modRoots], cancellationToken);
};

/** How a registration would be written, and what stands in the way of it. */
interface Route {
    via: 'shipFile' | 'modAction';
    /** The mod root whose manifest takes the action, only for the `modAction` route. */
    modRoot?: string;
    /** Why the registration cannot happen at all, absent when it can. */
    blocked?: ShipBlocker;
}

/**
 * Which of the four cases a ship and a part fall into: a ship the workspace owns is edited directly,
 * a ship of the game install is patched from the mod's manifest, and a part outside any mod may only
 * touch the install when the vanilla-editing switch says so.
 *
 * @param shipFsPath the ship file's on-disk path.
 * @param partFsPath the part file's on-disk path.
 * @param dataRoot the game's `Data` directory, absent when the game path is unset.
 * @returns the route, carrying a blocker when there is none.
 */
const routeFor = (shipFsPath: string, partFsPath: string, dataRoot: string | undefined): Route => {
    if (!isUnder(shipFsPath, dataRoot)) {
        // A ship of somebody else's installed workshop mod is refused here, which has no switch.
        return editableModRootOf(shipFsPath) ? { via: 'shipFile' } : { via: 'shipFile', blocked: 'notEditable' };
    }
    const partModRoot = editableModRootOf(partFsPath) ? findModRoot(partFsPath) : null;
    if (partModRoot) return { via: 'modAction', modRoot: partModRoot };
    if (globalSettings.allowEditingVanillaFiles) return { via: 'shipFile' };
    return { via: 'modAction', blocked: 'noModRoot' };
};

/** The blocker a ship's own file carries, absent when its `Parts` list can be appended to. */
const partsBlockerOf = (ship: ShipParts | undefined): ShipBlocker | undefined => {
    if (!ship) return 'unreadable';
    if (ship.partsList) return undefined;
    // A `Parts` that only comes from a base may well be replaced rather than extended by a local
    // re-declaration, and nothing in the tree proves which. Refusing is the only safe answer.
    return ship.inherits ? 'partsInherited' : 'noPartsList';
};

/**
 * Whether one of a mod's manifests already adds the part to a ship's `Parts` list.
 *
 * @param modRoot the mod whose manifests are read.
 * @param target the ship's `Parts` list as an action target names it.
 * @param partFsPath the part file's on-disk path.
 * @param partGroupName the part group's name.
 * @returns true when an action already carries that reference.
 */
const manifestAlreadyRegisters = async (
    modRoot: string,
    target: string,
    partFsPath: string,
    partGroupName: string
): Promise<boolean> => {
    const wanted = normalizeTargetPath(target).toLowerCase();
    for (const manifestFsPath of manifestsIn(modRoot)) {
        const file = await readRulesFile(manifestFsPath);
        if (!file) continue;
        const declaringDir = dirOf(manifestFsPath);
        for (const action of parseModActions(file.document)) {
            const hits = action.targets.some(
                (node) => normalizeTargetPath(String(node.valueType.value)).toLowerCase() === wanted
            );
            if (!hits) continue;
            for (const source of action.sources) {
                const elements: readonly AbstractNode[] = isListNode(source) ? source.elements : [source];
                if (partsListRegisters(elements, declaringDir, partFsPath, partGroupName)) return true;
            }
        }
    }
    return false;
};

/**
 * Report the ship classes the part could be registered in, each with what registering it would take.
 *
 * @param part the part the offer was made on.
 * @param entries the ship classes the registry holds.
 * @param host the server facilities.
 * @returns the candidates, capped so a workspace full of ship mods still answers with a readable list.
 */
const scanRound = async (
    part: ResolvedPart,
    entries: readonly ShipClassEntry[],
    host: RegisterPartHost
): Promise<RegisterPartScanResult> => {
    const dataRoot = host.dataRoot();
    const candidates: ShipCandidate[] = [];
    for (const entry of entries.slice(0, MAX_REPORTED_SHIPS)) {
        const ship = await shipPartsListOf(entry.fsPath, entry.groupName);
        const route = routeFor(entry.fsPath, part.fsPath, dataRoot);
        const partsBlocker = partsBlockerOf(ship);
        let alreadyRegistered = !!(
            ship?.partsList &&
            partsListRegisters(ship.partsList.elements, dirOf(entry.fsPath), part.fsPath, part.groupName)
        );
        if (!alreadyRegistered && route.via === 'modAction' && route.modRoot && dataRoot) {
            alreadyRegistered = await manifestAlreadyRegisters(
                route.modRoot,
                shipPartsTargetPath(dataRoot, entry.fsPath, entry.groupName),
                part.fsPath,
                part.groupName
            );
        }
        candidates.push({
            key: entry.key,
            groupName: entry.groupName,
            id: ship?.id,
            fsPath: entry.fsPath,
            target: isUnder(entry.fsPath, dataRoot) ? 'vanilla' : 'workspace',
            via: route.via,
            alreadyRegistered,
            blocked: route.blocked ?? partsBlocker,
        });
    }
    return {
        kind: 'scan',
        partId: part.id,
        partGroupName: part.groupName,
        candidates,
        failure: entries.length === 0 ? 'noShipClasses' : undefined,
    };
};

/** An apply result carrying nothing but the reason nothing happened. */
const applyFailed = (
    failure: RegisterPartFailure,
    via: 'shipFile' | 'modAction' = 'shipFile',
    shipFsPath = '',
    manifests?: string[]
): RegisterPartApplyResult => ({
    kind: 'apply',
    shipFsPath,
    via,
    changedFiles: [],
    reference: '',
    failure,
    manifests,
});

/**
 * Append the part to a ship's own `Parts [ … ]`, against the buffer the edit will be applied to so an
 * unsaved change cannot shift the insertion offset.
 *
 * @param part the part being registered.
 * @param entry the ship it goes into.
 * @param host the server facilities.
 * @returns what was written, or the reason nothing was.
 */
const applyToShipFile = async (
    part: ResolvedPart,
    entry: ShipClassEntry,
    host: RegisterPartHost
): Promise<RegisterPartApplyResult> => {
    const document = await documentFor(entry.fsPath, openBuffers(host));
    if (!document) return applyFailed('notEditable', 'shipFile', entry.fsPath);
    const text = document.getText();
    const ship = shipPartsIn(text, parseText(text, entry.fsPath), entry.groupName);
    const blocker = partsBlockerOf(ship);
    if (blocker || !ship?.partsList) {
        return applyFailed(blocker === 'partsInherited' ? 'partsInherited' : 'noPartsList', 'shipFile', entry.fsPath);
    }
    const declaringDir = dirOf(entry.fsPath);
    if (partsListRegisters(ship.partsList.elements, declaringDir, part.fsPath, part.groupName)) {
        return applyFailed('alreadyRegistered', 'shipFile', entry.fsPath);
    }
    // `relativeRulesReference` was written for inheritance references and emits no sigil, which a
    // `Parts` element needs.
    const reference = `&${relativeRulesReference(declaringDir, part.fsPath, part.groupName)}`;
    const outcome = appendElementEdit(text, ship.partsList, reference);
    if (isError(outcome)) return applyFailed('notEditable', 'shipFile', entry.fsPath);

    const applied = await host.applyEdit({ [document.uri]: outcome }).catch(() => false);
    if (!applied) return applyFailed('editRejected', 'shipFile', entry.fsPath);
    host.filesChanged([entry.fsPath]);
    return {
        kind: 'apply',
        shipFsPath: entry.fsPath,
        via: 'shipFile',
        changedFiles: [entry.fsPath],
        reference,
        warning: part.id ? undefined : 'noPartId',
    };
};

/**
 * Write an `AddMany` action into the mod's manifest, which is how a mod adds a part to a ship the
 * game install owns and the mod may not edit.
 *
 * @param part the part being registered.
 * @param entry the ship it goes into.
 * @param modRoot the mod whose manifest takes the action.
 * @param dataRoot the game's `Data` directory, which the action's target is expressed against.
 * @param host the server facilities.
 * @returns what was written, or the reason nothing was.
 */
const applyToManifest = async (
    part: ResolvedPart,
    entry: ShipClassEntry,
    modRoot: string,
    dataRoot: string,
    host: RegisterPartHost
): Promise<RegisterPartApplyResult> => {
    const manifests = manifestsIn(modRoot);
    if (manifests.length === 0) return applyFailed('noModRoot', 'modAction', entry.fsPath);
    // A version-split mod (`mod_0.30.rules` beside `mod_0.29.rules`) needs the author to say which
    // variants get the part, so it is refused rather than guessed at.
    const named = manifests.find((path) => basenameOf(path).toLowerCase() === 'mod.rules');
    const manifestFsPath = named ?? (manifests.length === 1 ? manifests[0] : undefined);
    if (!manifestFsPath) {
        return applyFailed('ambiguousManifest', 'modAction', entry.fsPath, manifests.map(basenameOf));
    }

    const target = shipPartsTargetPath(dataRoot, entry.fsPath, entry.groupName);
    if (await manifestAlreadyRegisters(modRoot, target, part.fsPath, part.groupName)) {
        return applyFailed('alreadyRegistered', 'modAction', entry.fsPath);
    }
    const ship = await shipPartsListOf(entry.fsPath, entry.groupName);
    const blocker = partsBlockerOf(ship);
    if (blocker) {
        return applyFailed(blocker === 'partsInherited' ? 'partsInherited' : 'noPartsList', 'modAction', entry.fsPath);
    }
    if (
        ship?.partsList &&
        partsListRegisters(ship.partsList.elements, dirOf(entry.fsPath), part.fsPath, part.groupName)
    ) {
        return applyFailed('alreadyRegistered', 'modAction', entry.fsPath);
    }

    const document = await documentFor(manifestFsPath, openBuffers(host));
    if (!document) return applyFailed('notEditable', 'modAction', entry.fsPath);
    const text = document.getText();
    const lineEnding = lineEndingOf(text);
    const insert = manifestActionInsert(text, parseText(text, manifestFsPath), lineEnding);
    if (insert.kind === 'unusable') return applyFailed('notEditable', 'modAction', entry.fsPath);

    // A mod action's source references resolve against the file the action is written in, never
    // against the game root its target names.
    const reference = `&${relativeRulesReference(dirname(manifestFsPath), part.fsPath, part.groupName)}`;
    const entryText = addManyActionText(target, reference, insert.indent, lineEnding);
    const at = document.positionAt(insert.offset);
    const edits: TextEdit[] = [
        { range: { start: at, end: at }, newText: `${insert.before}${entryText}${insert.after}` },
    ];

    const applied = await host.applyEdit({ [document.uri]: edits }).catch(() => false);
    if (!applied) return applyFailed('editRejected', 'modAction', entry.fsPath);
    host.filesChanged([manifestFsPath]);
    return {
        kind: 'apply',
        shipFsPath: entry.fsPath,
        via: 'modAction',
        changedFiles: [manifestFsPath],
        reference,
        warning: part.id ? undefined : 'noPartId',
    };
};

/**
 * The command entry point: report the ship classes when the client sent no ship, and register the
 * part in the chosen one otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the manifest reads and the inheritance walk.
 * @returns the candidates, or what the registration did.
 */
export const registerPartInShip = async (
    args: RegisterPartArgs,
    host: RegisterPartHost,
    cancellationToken: CancellationToken
): Promise<RegisterPartScanResult | RegisterPartApplyResult> => {
    const part = await resolvePart(args, host, cancellationToken);
    if (!part) {
        return args.ship
            ? applyFailed('stale')
            : { kind: 'scan', partGroupName: '', candidates: [], failure: 'stale' };
    }
    const entries = await shipEntries(host, cancellationToken);
    if (!args.ship) return await scanRound(part, entries, host);

    // The registry is rebuilt rather than trusted from the scan: the files it was read from may have
    // been edited since, and a ship that has moved must not be written to at a remembered offset.
    const entry = entries.find((candidate) => candidate.key === args.ship);
    if (!entry) return applyFailed('unknownShip');
    const dataRoot = host.dataRoot();
    const route = routeFor(entry.fsPath, part.fsPath, dataRoot);
    if (route.blocked) {
        return applyFailed(route.blocked === 'notEditable' ? 'notEditable' : 'noModRoot', route.via, entry.fsPath);
    }
    if (route.via === 'modAction') {
        if (!route.modRoot || !dataRoot) return applyFailed('noModRoot', 'modAction', entry.fsPath);
        return await applyToManifest(part, entry, route.modRoot, dataRoot, host);
    }
    return await applyToShipFile(part, entry, host);
};
