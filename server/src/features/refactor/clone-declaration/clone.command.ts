import { existsSync } from 'fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNodeDocument } from '../../../core/ast/ast';
import { hasId } from '../../../document/schema/entity-schema';
import { parseText } from '../../../utils/ast.utils';
import { unifiedDiff } from '../../../utils/unified-diff';
import { workspaceRelativePath } from '../../../utils/relative-path';
import { LocalizationText } from '../../completion/localization-key.index';
import { filePathToUri } from '../../navigation/navigation-strategy';
import { normalizeUri } from '../../navigation/reference-location';
import { uriToFsPath } from '../../navigation/workspace-files';
import { openBuffers } from '../command-host';
import { modRootsUnder } from '../register-part/ship-registry';
import { editableModRootOf } from '../shared-base/shared-base.analysis-entry';
import { buildClonePlan, ClonePlan, CloneFailure, idLeafOf } from './clone-plan';
import { CloneTarget, CloneUnit, dirOfPath, filesUnder, locateCloneTarget } from './clone-target';

/**
 * The `workspace/executeCommand` id of the clone. Both clients invoke it in three rounds: without an
 * id it reports what cloning this declaration would take, with an id and `preview` it answers with the
 * whole rewrite as a diff, and with an id alone it writes the copy.
 */
export const CLONE_DECLARATION_COMMAND = 'cosmoteer.cloneDeclaration';

/**
 * The command the lightbulb's refactoring carries, deliberately absent from the server's
 * `executeCommandProvider` so that it is never executed here.
 *
 * The new id is a name only the author can choose, and the copy writes files that have to be read
 * before they are written. A client resolves a command against its own handlers only when the server
 * does not claim it, so leaving this one unclaimed is what hands the exchange to the client. Both
 * clients implement it: they run the report round, ask for the id, show the diff, then invoke
 * {@link CLONE_DECLARATION_COMMAND} with the answer.
 */
export const CLONE_DECLARATION_ACTION_COMMAND = 'cosmoteer.cloneDeclarationFromAction';

/** What the client sends. */
export interface CloneDeclarationArgs {
    /** The file the declaration is written in. */
    uri: string;
    /** The byte offset the offer was made at. */
    offset: number;
    /** The id the copy declares. Absent means "report what this would take". */
    newId?: string;
    /** The directory the copy lands in, absent for the default beside or below the source. */
    destinationDir?: string;
    /** Work the copy out and answer with a diff, without writing anything. */
    preview?: boolean;
}

/** What cloning this declaration would take. */
export interface CloneScanResult {
    kind: 'scan';
    /** The id the source declares. */
    id: string;
    /** The identity field's name as the source spells it. */
    identityKey: string;
    /** How much of the source the copy carries. */
    unit: CloneUnit;
    /** How many files the copy would write, the language files aside. */
    files: number;
    /** An id to start from, which the author is expected to rewrite. */
    proposedId: string;
    /** Where the copy would land with that id, empty when the destination is not decided. */
    destinationDir: string;
    /** The mods the copy could go into, for a client that has to ask. */
    modRoots: string[];
    /** Why nothing could be reported, absent on success. */
    failure?: CloneFailure;
}

/** One file the clone writes, with the text it would hold. */
interface ClonePreviewFile {
    fsPath: string;
    /** The file's contents afterwards, for a side-by-side view against what is on disk. */
    after: string;
    /** True when the file does not exist yet, so there is nothing to compare against. */
    created: boolean;
}

/** What a clone would do, in the formats an editor can render. */
export interface ClonePreviewResult {
    kind: 'preview';
    /** Every rewritten file as one unified diff, for a client without a diff view. */
    diff: string;
    /** The written files with their contents, for a client that has a real diff view. Capped. */
    changed: ClonePreviewFile[];
    /** How many written files did not fit in {@link changed}. */
    omitted: number;
    /** Every path the clone writes, uncapped, so nothing is written that was not shown. */
    writes: string[];
    /** The files carried over byte for byte, which have no text to diff. */
    copied: string[];
    /** The destination mod's language files the keys are declared in. */
    stringsFiles: string[];
    destinationDir: string;
    newId: string;
    unit: CloneUnit;
    /** The `OtherIDs` aliases the copy leaves behind, as written. */
    droppedOtherIds: string[];
    /** The localization keys the copy declares in place of the source's. */
    keys: Array<{ from: string; to: string }>;
    /** Why the preview could not be built, absent on success. */
    failure?: CloneFailure;
    /** What the failure is about: a path, a file, or the mods to choose between. */
    detail?: string[];
}

/** What a clone did, or why it did nothing. */
export interface CloneApplyResult {
    kind: 'apply';
    /** The copy's own file, the one worth opening afterwards, empty when nothing was written. */
    created: string;
    /** Every path the clone created. */
    createdPaths: string[];
    /** The already-open files the clone changed through the editor, so the client can save them. */
    changedFiles: string[];
    /** The language files the keys were declared in. */
    stringsFiles: string[];
    /** The `OtherIDs` aliases the copy left behind, as written. */
    droppedOtherIds: string[];
    /** How many localization keys the copy declares. */
    keys: number;
    newId: string;
    unit: CloneUnit;
    /** Why nothing was written, absent on success. */
    failure?: CloneFailure;
    /** What the failure is about: a path, a file, or the mods to choose between. */
    detail?: string[];
}

type CloneDeclarationSummary = CloneScanResult | ClonePreviewResult | CloneApplyResult;

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface CloneHost {
    /** The workspace folders, as on-disk paths. */
    folderPaths(): Promise<string[]>;
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** Hands the client the edit for the files it already has open. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** The ids already declared for a class, so a clone never takes one that is in use. */
    declaredIds(cls: string, cancellationToken: CancellationToken): Promise<ReadonlySet<string>>;
    /** Every localization key the project declares, lower-cased. */
    declaredKeys(cancellationToken: CancellationToken): Promise<ReadonlySet<string>>;
    /** The source key's text in every language the project has. */
    localizationTexts(key: string, cancellationToken: CancellationToken): Promise<readonly LocalizationText[]>;
    /** The game's `Data` directory, which decides whether a path becomes `./Data/…`. */
    dataRoot(): string | undefined;
    /** Announces the files the command wrote, so the indexes pick them up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}

/**
 * How many written files a preview carries in full. A part directory holds a hundred sprites, and the
 * unified diff plus {@link ClonePreviewResult.writes} already name every one of them, so the
 * side-by-side view opens on the files that actually changed.
 */
const MAX_PREVIEW_FILES = 40;

/** The author prefix the game's own files tell mod authors never to use for their own content. */
const RESERVED_AUTHOR = 'cosmoteer';

/** The unsaved text of an open file, or undefined when the editor does not hold it. */
const openTextOf = (open: ReadonlyMap<string, TextDocument>) => (fsPath: string): string | undefined =>
    open.get(normalizeUri(filePathToUri(fsPath)))?.getText();

/**
 * An id to start the author off with: the source's entity name with `_copy` on the end, and a counting
 * suffix while that is taken.
 *
 * The game's own author prefix is dropped rather than carried over. `cannon_med.rules` says so in a
 * comment on the very line the clone copies: part ids are written `author_name.part_name`, and a mod
 * must not use `cosmoteer` as its author name because a future part of the game may take that name.
 *
 * @param id the id the source declares.
 * @param taken the ids already declared for the class.
 * @returns the proposed id.
 */
export const proposeCloneId = (id: string, taken: ReadonlySet<string>): string => {
    const cut = id.lastIndexOf('.');
    const author = cut > 0 ? id.slice(0, cut) : '';
    const leaf = idLeafOf(id);
    const base = author === '' || author.toLowerCase() === RESERVED_AUTHOR ? leaf : `${author}.${leaf}`;
    let proposed = `${base}_copy`;
    for (let index = 2; hasId(taken, proposed); index++) proposed = `${base}_copy${index}`;
    return proposed;
};

/** The document the command works against: the open buffer, else the file on disk. */
const documentFor = async (
    uri: string,
    open: ReadonlyMap<string, TextDocument>
): Promise<{ text: string; document: AbstractNodeDocument; fsPath: string } | undefined> => {
    const fsPath = uriToFsPath(uri).replace(/\\/g, '/');
    const buffer = open.get(normalizeUri(uri));
    const text = buffer?.getText() ?? (await readFile(fsPath, { encoding: 'utf-8' }).catch(() => undefined));
    if (text === undefined) return undefined;
    try {
        return { text, document: parseText(text, fsPath), fsPath };
    } catch {
        return undefined;
    }
};

/** The plan context the command runs plans against. */
const planContext = (host: CloneHost, folders: string[], open: ReadonlyMap<string, TextDocument>) => ({
    folderPaths: folders,
    dataRoot: host.dataRoot(),
    declaredIds: (cls: string, token: CancellationToken) => host.declaredIds(cls, token),
    declaredKeys: (token: CancellationToken) => host.declaredKeys(token),
    localizationTexts: (key: string, token: CancellationToken) => host.localizationTexts(key, token),
    modRootsUnder,
    openText: openTextOf(open),
});

/**
 * Report what cloning the declaration under the caret would take, so the client can ask for an id
 * knowing how much is about to be copied and where it would land.
 *
 * @param target the declaration being cloned.
 * @param host the server facilities.
 * @param cancellationToken cancels the id read.
 * @returns the report.
 */
const scanRound = async (
    target: CloneTarget,
    host: CloneHost,
    cancellationToken: CancellationToken
): Promise<CloneScanResult> => {
    const declared = await host.declaredIds(target.cls, cancellationToken).catch(() => new Set<string>());
    const proposedId = proposeCloneId(target.id, declared);
    const folders = await host.folderPaths();
    const roots = new Set<string>();
    for (const folder of folders) for (const root of modRootsUnder(folder)) roots.add(root.replace(/\\/g, '/'));
    const sourceDir = dirOfPath(target.fsPath);
    const sourceEditable = editableModRootOf(target.fsPath);
    const files = target.unit === 'directory' ? filesUnder(sourceDir).length : 1;
    const destination =
        target.unit === 'listElement'
            ? sourceDir
            : sourceEditable
              ? target.unit === 'directory'
                  ? `${dirOfPath(sourceDir)}/${idLeafOf(proposedId)}`
                  : sourceDir
              : roots.size === 1
                ? [...roots][0]
                : '';
    return {
        kind: 'scan',
        id: target.id,
        identityKey: target.identityKey,
        unit: target.unit,
        files,
        proposedId,
        destinationDir: destination,
        modRoots: [...roots],
    };
};

/** A failed scan, so the client always gets an answer of the shape it asked for. */
const scanFailed = (failure: CloneFailure): CloneScanResult => ({
    kind: 'scan',
    id: '',
    identityKey: '',
    unit: 'file',
    files: 0,
    proposedId: '',
    destinationDir: '',
    modRoots: [],
    failure,
});

/** A failed preview. */
const previewFailed = (failure: CloneFailure, detail?: string[]): ClonePreviewResult => ({
    kind: 'preview',
    diff: '',
    changed: [],
    omitted: 0,
    writes: [],
    copied: [],
    stringsFiles: [],
    destinationDir: '',
    newId: '',
    unit: 'file',
    droppedOtherIds: [],
    keys: [],
    failure,
    detail,
});

/** A failed apply. */
const applyFailed = (failure: CloneFailure, detail?: string[]): CloneApplyResult => ({
    kind: 'apply',
    created: '',
    createdPaths: [],
    changedFiles: [],
    stringsFiles: [],
    droppedOtherIds: [],
    keys: 0,
    newId: '',
    unit: 'file',
    failure,
    detail,
});

/** A file's text with a set of edits applied, replayed from the back so no offset has to be shifted. */
const applyEditsToText = (text: string, edits: readonly TextEdit[], document: TextDocument): string => {
    const spans = edits
        .map((edit) => ({
            start: document.offsetAt(edit.range.start),
            end: document.offsetAt(edit.range.end),
            newText: edit.newText,
        }))
        .sort((a, b) => b.start - a.start);
    let out = text;
    for (const span of spans) out = out.slice(0, span.start) + span.newText + out.slice(span.end);
    return out;
};

/** A strings file's text after its inserts, measured against the very text the edits were built on. */
const stringsFileAfter = (fsPath: string, text: string, edits: readonly TextEdit[]): string =>
    applyEditsToText(text, edits, TextDocument.create(filePathToUri(fsPath), 'rules', 0, text));

/**
 * Everything the clone would write, as a diff and as the finished files, so the whole copy can be read
 * before any of it happens.
 *
 * Every path the clone touches is named, the sprites carried over byte for byte included, because a
 * refactoring that writes into the user's project must never write a file the user was not shown.
 *
 * @param plan the plan to render.
 * @param folders the workspace folders, which the file names are shown relative to.
 * @returns the preview.
 */
const previewClone = (plan: ClonePlan, folders: string[]): ClonePreviewResult => {
    const sections: string[] = [];
    const changed: ClonePreviewFile[] = [];
    const writes: string[] = [];
    const copied: string[] = [];
    for (const file of plan.files) {
        writes.push(file.destination);
        if (file.text === undefined) {
            copied.push(file.destination);
            continue;
        }
        const before = file.created ? '' : (file.before ?? '');
        sections.push(unifiedDiff(before, file.text, workspaceRelativePath(file.destination, folders)));
        if (changed.length < MAX_PREVIEW_FILES) {
            changed.push({ fsPath: file.destination, after: file.text, created: file.created });
        }
    }
    for (const strings of plan.stringsFiles) {
        const after = stringsFileAfter(strings.fsPath, strings.text, strings.edits);
        writes.push(strings.fsPath);
        sections.push(unifiedDiff(strings.text, after, workspaceRelativePath(strings.fsPath, folders)));
        if (changed.length < MAX_PREVIEW_FILES) {
            changed.push({ fsPath: strings.fsPath, after, created: false });
        }
    }
    return {
        kind: 'preview',
        diff: sections.filter((section) => section.length > 0).join('\n'),
        changed,
        omitted: Math.max(0, plan.files.filter((file) => file.text !== undefined).length + plan.stringsFiles.length - changed.length),
        writes,
        copied,
        stringsFiles: plan.stringsFiles.map((strings) => strings.fsPath),
        destinationDir: plan.destinationDir,
        newId: plan.newId,
        unit: plan.unit,
        droppedOtherIds: plan.droppedOtherIds,
        keys: plan.keys.map((key) => ({ from: key.sourceKey, to: key.newKey })),
    };
};

/**
 * Write the copy.
 *
 * Files that are not open in the editor are written straight to disk, and only the ones the user
 * already has open go through the editor, so their buffers stay in step with disk and the change lands
 * in the undo history where the user can reach it. That split is the same one the shared-base
 * extraction makes, and for the same reason: a copy carrying a hundred sprites must not open a hundred
 * tabs.
 *
 * Everything the clone creates is taken away again when any part of the write fails, so a half-copied
 * part never survives as content the game would try to load.
 *
 * @param plan the plan to apply.
 * @param host the server facilities.
 * @returns what was done, or the reason nothing was.
 */
const applyClone = async (plan: ClonePlan, host: CloneHost): Promise<CloneApplyResult> => {
    const open = openBuffers(host);
    const createdPaths: string[] = [];
    const changes: Record<string, TextEdit[]> = {};
    // Only a folder this run really creates may be taken away again. If something appeared there
    // between the preview and now, it belongs to whoever put it there.
    const removableDir = plan.createdDir && !existsSync(plan.createdDir) ? plan.createdDir : undefined;
    // The copy's own new files go down first and the file the copy is written back into goes last, so
    // a failure anywhere never leaves a file that was already there half rewritten.
    const fresh = plan.files.filter((file) => file.destination !== file.source);
    const inPlace = plan.files.filter((file) => file.destination === file.source && file.text !== undefined);

    const rollback = async (): Promise<void> => {
        if (removableDir) {
            await rm(removableDir, { recursive: true, force: true }).catch(() => undefined);
            return;
        }
        // A single-file copy leaves the folders it had to make behind, which hold nothing the game
        // reads, rather than removing a folder somebody else may have started using.
        for (const path of createdPaths) await rm(path, { force: true }).catch(() => undefined);
    };

    try {
        for (const file of fresh) {
            await mkdir(dirOfPath(file.destination), { recursive: true });
            if (file.text === undefined) await copyFile(file.source, file.destination);
            else await writeFile(file.destination, file.text, { encoding: 'utf-8' });
            createdPaths.push(file.destination);
        }
        for (const strings of plan.stringsFiles) {
            const buffer = open.get(normalizeUri(filePathToUri(strings.fsPath)));
            if (buffer) {
                changes[buffer.uri] = [...(changes[buffer.uri] ?? []), ...strings.edits];
                continue;
            }
            await writeFile(strings.fsPath, stringsFileAfter(strings.fsPath, strings.text, strings.edits), {
                encoding: 'utf-8',
            });
        }
        for (const file of inPlace) {
            // A list-element clone rewrites the file the element is already in, which may well be open.
            const buffer = open.get(normalizeUri(filePathToUri(file.destination)));
            if (buffer) {
                changes[buffer.uri] = [
                    {
                        range: { start: buffer.positionAt(0), end: buffer.positionAt(buffer.getText().length) },
                        newText: file.text!,
                    },
                ];
                continue;
            }
            await writeFile(file.destination, file.text!, { encoding: 'utf-8' });
        }
    } catch {
        await rollback();
        host.filesChanged(createdPaths);
        return applyFailed('writeFailed', [plan.destinationDir]);
    }

    const written = [
        ...plan.files.map((file) => file.destination),
        ...plan.stringsFiles.map((strings) => strings.fsPath),
    ];
    host.filesChanged(written);

    const throughEditor = Object.keys(changes);
    if (throughEditor.length > 0) {
        const applied = await host.applyEdit(changes).catch(() => false);
        if (!applied) {
            return {
                ...applyFailed('editRejected'),
                created: plan.files[0]?.destination ?? '',
                createdPaths,
                newId: plan.newId,
                unit: plan.unit,
            };
        }
    }
    return {
        kind: 'apply',
        created: plan.files.find((file) => file.text !== undefined)?.destination ?? plan.destinationDir,
        createdPaths,
        changedFiles: throughEditor.map((uri) => uriToFsPath(uri).replace(/\\/g, '/')),
        stringsFiles: plan.stringsFiles.map((strings) => strings.fsPath),
        droppedOtherIds: plan.droppedOtherIds,
        keys: plan.keys.length,
        newId: plan.newId,
        unit: plan.unit,
    };
};

/**
 * The command entry point: report what a clone would take when the client sent no id, show the whole
 * rewrite when it asked for a preview, and write the copy otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the reads and the cross-file walks.
 * @returns the report, the preview, or what the copy did.
 */
export const cloneDeclaration = async (
    args: CloneDeclarationArgs,
    host: CloneHost,
    cancellationToken: CancellationToken
): Promise<CloneDeclarationSummary> => {
    const open = openBuffers(host);
    const source = await documentFor(args.uri, open);
    if (!source) return args.newId ? applyFailed('stale') : scanFailed('stale');
    const located = await locateCloneTarget(source.document, args.offset, source.fsPath, args.uri, cancellationToken);
    if ('refusal' in located) {
        return args.newId ? applyFailed(located.refusal) : scanFailed(located.refusal);
    }
    if (!args.newId) return await scanRound(located.target, host, cancellationToken);

    const folders = await host.folderPaths();
    const built = await buildClonePlan(
        located.target,
        source.text,
        source.document,
        { newId: args.newId, destinationDir: args.destinationDir },
        planContext(host, folders, open),
        cancellationToken
    );
    if ('failure' in built) {
        return args.preview ? previewFailed(built.failure, built.detail) : applyFailed(built.failure, built.detail);
    }
    return args.preview ? previewClone(built.plan, folders) : await applyClone(built.plan, host);
};
