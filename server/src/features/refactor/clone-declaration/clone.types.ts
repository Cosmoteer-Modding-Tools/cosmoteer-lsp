/**
 * The plan the clone builder hands the command, and the facilities the command is given. Kept apart
 * from the command and the plan builder so a test can name a plan without pulling the file writing in
 * with it. The shapes the command speaks to a client in are shared with the clients, in
 * shared/clone-declaration.types.ts.
 */

import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CloneFailure, CloneUnit } from '../../../../../shared/clone-declaration.types';
import { LocalizationText } from '../../completion/localization-key.index';
import { CloneKey, StringsFileInsert } from './clone-localization';
import { CloneTarget } from './clone-target';

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
