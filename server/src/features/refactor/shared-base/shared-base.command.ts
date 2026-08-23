import { mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseText } from '../../../utils/ast.utils';
import { unifiedDiff } from '../../../utils/unified-diff';
import { workspaceRelativePath } from '../../../utils/relative-path';
import { foldPathCase } from '../../../workspace/fs-cache';
import { normalizeUri } from '../../navigation/reference-location';
import { documentFor, openBuffers } from '../command-host';
import { baseTargetFrom, BaseTarget } from './base-index';
import { buildBaseFileText, buildBaseInsertText, relativeRulesReference } from './base-file.emitter';
import { buildConsumerEdits, mergeFileEdits } from './consumer-rewrite';
import {
    baseFileNameFor,
    baseIdentityOf,
    Candidate,
    candidatesInFile,
    MIN_FIELDS,
    rebaseInheritance,
} from './duplicate-field.analysis';
import { judgeExistingBase } from './existing-base';
import { fileFactsForPath, modFacts, modPlans, rulesFilesUnder } from './mod-scan';
import { editableModRootOf } from './shared-base.analysis-entry';
import { ExtractionPlan, ExtractionTier, Participant, SerializedPlan, serializePlan } from './plan.types';

/**
 * The `workspace/executeCommand` id of the shared-base extraction. Both clients invoke it: without a
 * plan it sweeps the whole mod and answers with the extractions worth making, and with one it
 * creates or extends the base file and rewrites every file that will inherit it.
 */
export const EXTRACT_SHARED_BASE_COMMAND = 'cosmoteer.extractSharedBase';

/**
 * The command the lightbulb's refactoring carries, deliberately absent from the server's
 * `executeCommandProvider` so that it is never executed here.
 *
 * The offer creates a file and rewrites every file that inherits it, which the user has to be able
 * to read before it happens, and only the editor can show a real diff. A client resolves a command
 * against its own handlers only when the server does not claim it, so leaving this one unclaimed is
 * what hands the exchange to the client. Both clients implement it; the code action is the only
 * thing that ever issues it.
 */
export const EXTRACT_SHARED_BASE_ACTION_COMMAND = 'cosmoteer.extractSharedBaseFromAction';

/** What the client asks for: a sweep when no plan is given, and the extraction when one is. */
export interface ExtractSharedBaseArgs {
    /** A plan from a previous sweep. Absent means "sweep and report". */
    plan?: SerializedPlan;
    /** Replaces the generated base file's name, extension included. */
    baseFileName?: string;
    /** Work out what the plan would do and answer with a diff, without changing anything. */
    preview?: boolean;
}

/** The extractions a sweep found. */
export interface SharedBaseScanResult {
    kind: 'scan';
    plans: SerializedPlan[];
    filesScanned: number;
}

/** Why an extraction did not happen. */
export type SharedBaseFailure = 'planStale' | 'baseFileExists' | 'notEditable' | 'editRejected';

/** What an applied extraction did. */
export interface SharedBaseApplyResult {
    kind: 'apply';
    /** The on-disk path of the base file that was created or added to. */
    created: string;
    /**
     * Every file the client-side edit changed. A workspace edit leaves each of them open and unsaved,
     * which for a plan covering hundreds of files is hundreds of dirty buffers, so the client is told
     * exactly which ones to write out and tidy away.
     */
    changedFiles: string[];
    /** Whether that file was written from scratch or already existed. */
    tier: ExtractionTier;
    /** How many files now inherit it. */
    files: number;
    /** How many fields moved out of each of them. */
    fields: number;
    /** Source bytes removed across those files. */
    removedBytes: number;
    /** Why the extraction did not happen, absent on success. */
    failure?: SharedBaseFailure;
}

/** One file the extraction would change, with the text it would end up holding. */
interface SharedBasePreviewFile {
    fsPath: string;
    /** The file's contents after the rewrite, for a side-by-side view against what is on disk. */
    after: string;
    /** True when the file does not exist yet, so there is nothing to compare against. */
    created: boolean;
}

/** What an extraction would do, in the formats an editor can render. */
export interface SharedBasePreviewResult {
    kind: 'preview';
    /** Every file the extraction touches, as one unified diff, for a client without a diff view. */
    diff: string;
    /**
     * The changed files with their rewritten contents, for a client that has a real diff view.
     * Capped, since a plan can cover hundreds of files and this crosses the wire.
     */
    changed: SharedBasePreviewFile[];
    /** How many changed files did not fit in {@link changed}. */
    omitted: number;
    /** The on-disk path of the base file that would be created or added to. */
    baseFsPath: string;
    tier: ExtractionTier;
    files: number;
    fields: number;
    removedBytes: number;
    /** Why the preview could not be built, absent on success. */
    failure?: SharedBaseFailure;
}

/**
 * How many rewritten files a preview carries in full. A plan can cover hundreds, and the unified
 * diff already summarizes all of them, so the side-by-side view opens on the first of them.
 */
const MAX_PREVIEW_FILES = 40;

type ExtractSharedBaseSummary = SharedBaseScanResult | SharedBaseApplyResult | SharedBasePreviewResult;

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface SharedBaseHost {
    /** The workspace folders to sweep, as on-disk paths. */
    folderPaths(): Promise<string[]>;
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** Hands the client the multi-file edit. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Reports sweep progress, from 0 to 100. */
    report?(percent: number, message: string): void;
    /**
     * Whether a file is one the game actually loads. Without it the sweep would offer to rewrite a
     * backup folder or an unused template, and would drag the base file up to a directory the live
     * files do not share.
     */
    inScope?(fsPath: string): boolean;
    /** Announces the files the command wrote, so the indexes pick them up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}

/** How many plans a sweep reports, so a large mod does not answer with a list nobody reads. */
const MAX_REPORTED_PLANS = 40;

/**
 * A one-line description of a plan for the client's picker.
 *
 * @param plan the plan to describe.
 * @returns the label.
 */
const labelFor = (plan: ExtractionPlan): string => {
    const base = plan.baseFsPath.split(/[\\/]/).pop() ?? plan.baseFsPath;
    const verb = plan.tier === 'existingBase' ? 'into' : '->';
    return `${plan.fields.length} fields x ${plan.participants.length} files ${verb} ${base}`;
};

/**
 * Sweep every mod in the workspace and report the extractions worth making, ranked by how much
 * duplicated source each removes.
 *
 * @param host the server facilities.
 * @param cancellationToken cancels the sweep.
 * @returns the ranked plans and how many files were read.
 */
export const scanForSharedBases = async (
    host: SharedBaseHost,
    cancellationToken: CancellationToken
): Promise<SharedBaseScanResult> => {
    const folders = await host.folderPaths();
    const files: string[] = [];
    for (const folder of folders) files.push(...(await rulesFilesUnder(folder, cancellationToken)));

    // The files are read here rather than inside the mod walk so the sweep can report progress over
    // them. Every read is memoized, so the walk that follows finds its work already done.
    const modRoots = new Set<string>();
    let done = 0;
    for (const file of files) {
        if (cancellationToken.isCancellationRequested) break;
        done++;
        if (done % 50 === 0) host.report?.(Math.round((done / files.length) * 90), `${done}/${files.length}`);
        const modRoot = editableModRootOf(file);
        if (!modRoot) continue;
        if (host.inScope && !host.inScope(file)) continue;
        modRoots.add(modRoot);
        await fileFactsForPath(file, modRoot, cancellationToken);
    }

    // Plans are compared within one mod only, and every fingerprint is expressed relative to that
    // mod's root, so the same field written in two directories still compares equal.
    const plans: ExtractionPlan[] = [];
    for (const modRoot of modRoots) {
        if (cancellationToken.isCancellationRequested) break;
        plans.push(...(await modPlans(modRoot, host.inScope, cancellationToken)));
    }
    plans.sort((a, b) => b.savedBytes - a.savedBytes);
    return {
        kind: 'scan',
        plans: plans.slice(0, MAX_REPORTED_PLANS).map((plan) => serializePlan(plan, labelFor(plan))),
        filesScanned: files.length,
    };
};

/**
 * Rebuild a plan against what the files say right now. A plan travels to the client and back, and
 * the files may have been edited in between, so the participants are re-read and the field set is
 * re-agreed rather than trusted.
 *
 * @param serialized the plan the client sent back.
 * @param host the server facilities, for the open buffers.
 * @param cancellationToken cancels the re-reads.
 * @returns the rebuilt plan, or undefined when the files no longer agree.
 */
const rehydrate = async (
    serialized: SerializedPlan,
    host: SharedBaseHost,
    cancellationToken: CancellationToken
): Promise<ExtractionPlan | undefined> => {
    const modRoot = editableModRootOf(serialized.donor.fsPath);
    if (!modRoot) return undefined;
    const open = openBuffers(host);
    const participants: Participant[] = [];
    for (const entry of serialized.participants) {
        if (editableModRootOf(entry.fsPath) !== modRoot) return undefined;
        if (host.inScope && !host.inScope(entry.fsPath)) return undefined;
        const document = await documentFor(entry.fsPath, open);
        if (!document) return undefined;
        const text = document.getText();
        let candidates: Candidate[];
        try {
            candidates = candidatesInFile(
                { document: parseText(text, entry.fsPath), text, fsPath: entry.fsPath, uri: document.uri },
                modRoot,
                MIN_FIELDS
            );
        } catch {
            return undefined;
        }
        const match = candidates.find((candidate) => candidate.participant.nameStart === entry.offset);
        if (!match) return undefined;
        participants.push(match.participant);
    }
    const donor = participants.find(
        (participant) =>
            foldPathCase(participant.fsPath) === foldPathCase(serialized.donor.fsPath) &&
            participant.nameStart === serialized.donor.offset
    );
    if (!donor) return undefined;
    // Every participant must still say exactly the same thing, or the extraction would change what
    // one of them loads.
    for (const key of serialized.fields) {
        const reference = donor.members.get(key);
        if (!reference) return undefined;
        for (const participant of participants) {
            if (participant.members.get(key)?.norm !== reference.norm) return undefined;
        }
    }
    // The bases have to be re-agreed too, not only the fields. The rewrite replaces whatever a
    // participant inherits with the generated file, so a base that appeared since the plan was
    // offered (an unsaved edit, or another hand) would be dropped without the generated file
    // carrying it over. Recomputing the tier from the files as they are now and requiring it to
    // match what the plan was built on is what makes that impossible.
    const identities = new Set(
        participants.map((participant) =>
            participant.inheritanceRef
                ? (baseIdentityOf(participant.inheritanceRef, dirname(participant.fsPath)) ?? 'unresolvable')
                : ''
        )
    );
    if (identities.size !== 1) return undefined;
    if (identities.has('unresolvable')) return undefined;
    const inherits = !identities.has('');
    const expected = serialized.tier === 'cloneFamily' ? !inherits : inherits;
    if (!expected) return undefined;

    const plan: ExtractionPlan = {
        id: serialized.id,
        tier: inherits ? 'sharedBase' : 'cloneFamily',
        className: serialized.className,
        groupName: serialized.groupName,
        fields: [...serialized.fields],
        participants,
        donor,
        baseFsPath: serialized.baseFsPath,
        inheritedRef: undefined,
        baseIdentity: inherits ? [...identities][0] : undefined,
        savedBytes: serialized.savedBytes,
    };
    if (serialized.tier !== 'existingBase') {
        if (plan.tier === 'sharedBase') {
            plan.inheritedRef = rebaseInheritance(
                donor.inheritanceRef ?? '',
                dirname(donor.fsPath),
                dirname(serialized.baseFsPath)
            );
            if (!plan.inheritedRef) return undefined;
        }
        return plan;
    }

    // Adding to a base file that already exists is only safe while nothing else inherits it, which is
    // a fact about the whole mod rather than about the participants, so it is re-proven here.
    const facts = await modFacts(modRoot, host.inScope, cancellationToken);
    const judged = await judgeExistingBase(
        plan,
        modRoot,
        facts.inheritorCounts,
        facts.locations,
        facts.inheritorFiles
    );
    if (typeof judged === 'string') return undefined;
    if (foldPathCase(judged.fsPath) !== foldPathCase(serialized.existingBase?.fsPath ?? '')) return undefined;
    return {
        ...plan,
        tier: 'existingBase',
        baseFsPath: judged.fsPath,
        existingBase: { fsPath: judged.fsPath, groupPath: [...judged.groupPath] },
    };
};

/** One file the rewrite touches, with the text it starts from and the edits that change it. */
interface TouchedFile {
    fsPath: string;
    document: TextDocument;
    edits: TextEdit[];
}

/** Everything an extraction would do, worked out once and then either previewed or committed. */
interface PreparedRewrite {
    plan: ExtractionPlan;
    /** The base file's path, whether it is being created or added to. */
    baseFsPath: string;
    /** The contents of the base file to create, absent when it already exists. */
    newBaseText?: string;
    /** The files that get an edit, base file included when it already exists. */
    touched: TouchedFile[];
    /** How many of the participants' files are rewritten. */
    files: number;
    removedBytes: number;
}

/**
 * Work out every edit an extraction makes, without changing anything.
 *
 * @param serialized the plan to apply.
 * @param baseFileName replaces the generated file name, when the user picked one.
 * @param host the server facilities.
 * @param cancellationToken cancels the re-reads.
 * @returns the prepared rewrite, or the reason it cannot be made.
 */
const prepareSharedBase = async (
    serialized: SerializedPlan,
    baseFileName: string | undefined,
    host: SharedBaseHost,
    cancellationToken: CancellationToken
): Promise<PreparedRewrite | SharedBaseFailure> => {
    const plan = await rehydrate(serialized, host, cancellationToken);
    if (!plan) return 'planStale';
    const open = openBuffers(host);

    let baseFsPath = plan.baseFsPath;
    let newBaseText: string | undefined;
    let baseInsert: { target: BaseTarget; document: TextDocument } | undefined;
    if (plan.tier === 'existingBase') {
        // Never fall through to the create-a-file branch without one: `baseFsPath` names the file
        // that already exists, so the fall-through would write a second copy of it next door.
        if (!plan.existingBase) return 'planStale';
        // The offsets come from the buffer the edit will be applied to, never from the copy on disk,
        // so an unsaved edit to the base file cannot put the insert in the wrong place.
        const document = await documentFor(plan.existingBase.fsPath, open);
        if (!document) return 'planStale';
        const text = document.getText();
        const target = baseTargetFrom(plan.existingBase, text, parseText(text, plan.existingBase.fsPath));
        if (!target) return 'planStale';
        if (plan.fields.some((key) => target.declaredKeys.has(key))) return 'planStale';
        baseInsert = { target, document };
    } else {
        const chosen = baseFileName?.trim();
        const name =
            chosen ||
            baseFileNameFor(
                plan.participants.map((participant) => participant.fsPath),
                plan.groupName,
                plan.className
            );
        const withExtension = name.endsWith('.rules') ? name : `${name}.rules`;
        const baseDir = dirname(plan.baseFsPath).replace(/\\/g, '/');
        baseFsPath = `${baseDir}/${withExtension}`;
        if (existsSync(baseFsPath)) {
            // A name the user typed is theirs, and quietly writing somewhere else would be a surprise.
            // A generated one is not: two families of the same class in one directory derive the same
            // name, so the second gets the next free one instead of refusing.
            if (chosen) return 'baseFileExists';
            const stem = withExtension.replace(/\.rules$/i, '');
            let suffix = 2;
            while (existsSync(`${baseDir}/${stem}_${suffix}.rules`)) suffix++;
            baseFsPath = `${baseDir}/${stem}_${suffix}.rules`;
        }
    }
    const resolved: ExtractionPlan = { ...plan, baseFsPath };

    // Grouped by file, because one file can hold more than one participating container and each of
    // their edit lists has to be merged into the file's single entry rather than replace it.
    const byFile = new Map<string, { fsPath: string; document: TextDocument; participants: Participant[] }>();
    let removedBytes = 0;
    // The base file gets the line ending the files around it use, taken from the donor.
    let lineEnding: '\n' | '\r\n' = '\n';
    for (const participant of resolved.participants) {
        const document = await documentFor(participant.fsPath, open);
        if (!document) return 'planStale';
        if (participant === resolved.donor && document.getText().includes('\r\n')) lineEnding = '\r\n';
        const entry = byFile.get(document.uri);
        if (entry) entry.participants.push(participant);
        else byFile.set(document.uri, { fsPath: participant.fsPath, document, participants: [participant] });
        for (const key of resolved.fields) removedBytes += participant.members.get(key)?.raw.length ?? 0;
    }

    const touched: TouchedFile[] = [];
    for (const entry of byFile.values()) {
        // A container that already inherits the base keeps its inheritance line untouched.
        const reference = baseInsert
            ? undefined
            : relativeRulesReference(dirname(entry.participants[0].fsPath), baseFsPath, resolved.groupName);
        touched.push({
            fsPath: entry.fsPath,
            document: entry.document,
            edits: mergeFileEdits(
                entry.document,
                entry.participants.flatMap((participant) =>
                    buildConsumerEdits(entry.document, participant, resolved, reference)
                )
            ),
        });
    }
    if (baseInsert) {
        const baseLineEnding = baseInsert.document.getText().includes('\r\n') ? '\r\n' : '\n';
        const at = baseInsert.document.positionAt(baseInsert.target.insertOffset);
        touched.push({
            fsPath: baseFsPath,
            document: baseInsert.document,
            edits: [
                {
                    range: { start: at, end: at },
                    newText: buildBaseInsertText(resolved, baseInsert.target, baseLineEnding),
                },
            ],
        });
    } else {
        newBaseText = buildBaseFileText(resolved, lineEnding);
    }
    return { plan: resolved, baseFsPath, newBaseText, touched, files: byFile.size, removedBytes };
};

/**
 * The edits of some of a prepared rewrite's files, in the shape `workspace/applyEdit` takes.
 *
 * Two entries can name one file (the base file being added to is also the file a container is
 * rewritten in), so they are merged rather than assigned, which would drop whichever list arrived
 * first without a word.
 *
 * @param files the touched files to hand over.
 * @returns the edits per file uri, each list ascending and non-overlapping.
 */
const changesOf = (files: readonly TouchedFile[]): Record<string, TextEdit[]> => {
    const changes: Record<string, TextEdit[]> = {};
    for (const file of files) {
        const existing = changes[file.document.uri];
        changes[file.document.uri] = existing
            ? mergeFileEdits(file.document, [...existing, ...file.edits])
            : file.edits;
    }
    return changes;
};

/**
 * Create or extend the base file a plan describes and rewrite every participant, as one client-side
 * edit on top of whatever the base file needed.
 *
 * @param serialized the plan to apply.
 * @param baseFileName replaces the generated file name, when the user picked one.
 * @param host the server facilities.
 * @param cancellationToken cancels the re-reads.
 * @returns what was done, or the reason nothing was.
 */
export const applySharedBase = async (
    serialized: SerializedPlan,
    baseFileName: string | undefined,
    host: SharedBaseHost,
    cancellationToken: CancellationToken
): Promise<SharedBaseApplyResult> => {
    const failed = (failure: SharedBaseFailure): SharedBaseApplyResult => ({
        kind: 'apply',
        created: '',
        changedFiles: [],
        tier: serialized.tier,
        files: 0,
        fields: 0,
        removedBytes: 0,
        failure,
    });
    const prepared = await prepareSharedBase(serialized, baseFileName, host, cancellationToken);
    if (typeof prepared === 'string') return failed(prepared);

    // Only the files the user actually has open go through the editor. A workspace edit over a file
    // that is not open makes the editor load it, hold it dirty and give it a tab, so a plan covering
    // hundreds of files would bury the workspace in unsaved buffers and take far longer than the
    // rewrite itself. Those are written straight to disk instead, which is what the created base file
    // has always done. The open ones keep going through the editor, so their buffers stay in step
    // with disk and the edit lands in the undo history where the user can reach it.
    const open = new Set(host.openDocuments().map((document) => normalizeUri(document.uri)));
    const throughEditor = prepared.touched.filter((file) => open.has(normalizeUri(file.document.uri)));
    const ontoDisk = prepared.touched.filter((file) => !open.has(normalizeUri(file.document.uri)));

    // The base file is written before anything else: a consumer that inherits a file which does not
    // exist yet would be reported as broken for as long as the rest of the rewrite takes.
    const written: string[] = [];
    try {
        if (prepared.newBaseText !== undefined) {
            await mkdir(dirname(prepared.baseFsPath), { recursive: true });
            await writeFile(prepared.baseFsPath, prepared.newBaseText, { encoding: 'utf-8' });
        }
        for (const file of ontoDisk) {
            await writeFile(file.fsPath, applyEditsToText(file.document, file.edits), { encoding: 'utf-8' });
            written.push(file.fsPath);
        }
    } catch {
        // Nothing is rolled back beyond the base file: the files already rewritten are correct, and
        // the ones after the failure are untouched. `changedFiles` says exactly which is which.
        if (prepared.newBaseText !== undefined && written.length === 0) {
            await rm(prepared.baseFsPath, { force: true }).catch(() => undefined);
        }
        host.filesChanged([prepared.baseFsPath, ...written]);
        return { ...failed('notEditable'), created: prepared.baseFsPath, changedFiles: written };
    }
    host.filesChanged([prepared.baseFsPath, ...prepared.touched.map((file) => file.fsPath)]);

    if (throughEditor.length > 0) {
        const applied = await host.applyEdit(changesOf(throughEditor)).catch(() => false);
        if (!applied) return { ...failed('editRejected'), created: prepared.baseFsPath, changedFiles: written };
    }
    return {
        kind: 'apply',
        created: prepared.baseFsPath,
        changedFiles: throughEditor.map((file) => file.fsPath),
        tier: prepared.plan.tier,
        files: prepared.files,
        fields: prepared.plan.fields.length,
        removedBytes: prepared.removedBytes,
    };
};

/**
 * Work out what a plan would do and answer with it as a unified diff, so the whole rewrite can be
 * read before any of it happens.
 *
 * @param serialized the plan to preview.
 * @param baseFileName replaces the generated file name, when the user picked one.
 * @param host the server facilities.
 * @param cancellationToken cancels the re-reads.
 * @returns the diff and the same counts the apply would report.
 */
const previewSharedBase = async (
    serialized: SerializedPlan,
    baseFileName: string | undefined,
    host: SharedBaseHost,
    cancellationToken: CancellationToken
): Promise<SharedBasePreviewResult> => {
    const prepared = await prepareSharedBase(serialized, baseFileName, host, cancellationToken);
    if (typeof prepared === 'string') {
        return {
            kind: 'preview',
            diff: '',
            changed: [],
            omitted: 0,
            baseFsPath: serialized.baseFsPath,
            tier: serialized.tier,
            files: 0,
            fields: 0,
            removedBytes: 0,
            failure: prepared,
        };
    }
    const folders = await host.folderPaths();
    const sections: string[] = [];
    const changed: SharedBasePreviewFile[] = [];
    // The base file leads, since it is the thing being created or added to and the rest of the
    // rewrite only makes sense once it has been read.
    if (prepared.newBaseText !== undefined) {
        sections.push(unifiedDiff('', prepared.newBaseText, workspaceRelativePath(prepared.baseFsPath, folders)));
        changed.push({ fsPath: prepared.baseFsPath, after: prepared.newBaseText, created: true });
    }
    for (const file of prepared.touched) {
        const before = file.document.getText();
        const after = applyEditsToText(file.document, file.edits);
        sections.push(unifiedDiff(before, after, workspaceRelativePath(file.fsPath, folders)));
        if (changed.length < MAX_PREVIEW_FILES) changed.push({ fsPath: file.fsPath, after, created: false });
    }
    return {
        kind: 'preview',
        diff: sections.filter((section) => section.length > 0).join('\n'),
        changed,
        omitted: Math.max(0, prepared.touched.length + (prepared.newBaseText !== undefined ? 1 : 0) - changed.length),
        baseFsPath: prepared.baseFsPath,
        tier: prepared.plan.tier,
        files: prepared.files,
        fields: prepared.plan.fields.length,
        removedBytes: prepared.removedBytes,
    };
};

/**
 * A file's text with a set of edits applied. The edits are already disjoint and ascending, so they
 * are replayed from the back and no offset has to be shifted.
 *
 * @param doc the file the edits were built against.
 * @param edits the edits to replay.
 * @returns the resulting text.
 */
const applyEditsToText = (doc: TextDocument, edits: readonly TextEdit[]): string => {
    const spans = edits
        .map((edit) => ({
            start: doc.offsetAt(edit.range.start),
            end: doc.offsetAt(edit.range.end),
            newText: edit.newText,
        }))
        .sort((a, b) => b.start - a.start);
    let text = doc.getText();
    for (const span of spans) text = text.slice(0, span.start) + span.newText + text.slice(span.end);
    return text;
};

/**
 * The command entry point: sweep when the client sent no plan, preview when it asked for one, and
 * extract otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the sweep and the re-reads.
 * @returns the sweep's plans, the preview's diff, or the extraction's summary.
 */
export const extractSharedBase = async (
    args: ExtractSharedBaseArgs,
    host: SharedBaseHost,
    cancellationToken: CancellationToken
): Promise<ExtractSharedBaseSummary> => {
    if (!args.plan) return await scanForSharedBases(host, cancellationToken);
    return args.preview
        ? await previewSharedBase(args.plan, args.baseFileName, host, cancellationToken)
        : await applySharedBase(args.plan, args.baseFileName, host, cancellationToken);
};
