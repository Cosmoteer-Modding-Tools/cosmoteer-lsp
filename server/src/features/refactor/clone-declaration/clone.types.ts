/**
 * The shapes the clone command speaks in: the plan the builder hands the command, what a client sends,
 * what each of the command's three rounds answers with, and the facilities the command is given. Kept
 * apart from the command and the plan builder so a client and a test can name a result without pulling
 * the file writing in with it.
 */

import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LocalizationText } from '../../completion/localization-key.index';
import { CloneKey, StringsFileInsert } from './clone-localization';
import { CloneTarget, CloneTargetRefusal, CloneUnit } from './clone-target';

/** Why a clone did not happen. Every one of them is a state the copy would have been wrong in. */
export type CloneFailure =
    | CloneTargetRefusal
    | 'stale'
    | 'invalidId'
    | 'idUnchanged'
    | 'idTaken'
    | 'notEditable'
    | 'ambiguousDestination'
    | 'destinationExists'
    | 'unresolvablePath'
    | 'escapingPath'
    | 'writeFailed'
    | 'editRejected';

/** One file the clone writes. */
export interface ClonePlanFile {
    /** The file it is copied from. */
    readonly source: string;
    /** Where the copy goes. */
    readonly destination: string;
    /** The copy's text, absent for a file carried over byte for byte. */
    readonly text?: string;
    /** The source's own text, so the copy can be read against it, absent for a byte-for-byte copy. */
    readonly before?: string;
    /** True when nothing is at the destination yet. */
    readonly created: boolean;
}

/** Everything a clone would write, worked out but not yet written. */
export interface ClonePlan {
    readonly target: CloneTarget;
    readonly unit: CloneUnit;
    /** The id the source declares. */
    readonly id: string;
    /** The id the copy declares. */
    readonly newId: string;
    /** The identity field's name as the source spells it. */
    readonly identityKey: string;
    /** The directory the copy lands in. */
    readonly destinationDir: string;
    /** The directory the clone creates, so a failed write can take it away again. */
    readonly createdDir?: string;
    /** Every file the clone writes, rewritten or carried over. */
    readonly files: ClonePlanFile[];
    /** The destination mod's language files and what the clone adds to each of them. */
    readonly stringsFiles: StringsFileInsert[];
    /** The localization keys the copy declares in place of the source's. */
    readonly keys: CloneKey[];
    /** The `OtherIDs` aliases the copy does not carry over, as written. */
    readonly droppedOtherIds: string[];
}

/** What the plan builder came to. */
export type ClonePlanResult = { plan: ClonePlan } | { failure: CloneFailure; detail?: string[] };

/** The facts about the project a plan needs, injected so the module stays testable. */
export interface ClonePlanContext {
    /** The workspace folders, as on-disk paths. */
    readonly folderPaths: readonly string[];
    /** The game's `Data` directory, which decides whether a path becomes `./Data/…`. */
    readonly dataRoot?: string;
    /** The ids already declared for a class, so a clone never takes one that is in use. */
    declaredIds(cls: string, cancellationToken: CancellationToken): Promise<ReadonlySet<string>>;
    /** Every localization key the project declares, lower-cased, so a derived key is never taken. */
    declaredKeys(cancellationToken: CancellationToken): Promise<ReadonlySet<string>>;
    /** The source key's text in every language the project has. */
    localizationTexts(key: string, cancellationToken: CancellationToken): Promise<readonly LocalizationText[]>;
    /** The mod roots below a workspace folder, which is where a copy of a game file can go. */
    modRootsUnder(folder: string): string[];
    /** The unsaved text of an open file, which wins over what is on disk. */
    openText?(fsPath: string): string | undefined;
}

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
export interface ClonePreviewFile {
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
