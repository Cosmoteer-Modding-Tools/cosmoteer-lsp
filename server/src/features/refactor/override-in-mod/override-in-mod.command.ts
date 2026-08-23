import { mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNode, isValueNode } from '../../../core/ast/ast';
import { basenameOf, isModRules } from '../../../document/document-kind';
import { ActionSource } from '../../../mod/action';
import { findModRoot } from '../../../mod/mod-root';
import { isStringsFile } from '../../../mod/strings-folder';
import { memberNameOf, stepIntoNode } from '../../../semantics/reference-resolver';
import { parseText } from '../../../utils/ast.utils';
import { isUnder } from '../../../utils/relative-path';
import { foldPathCase } from '../../../workspace/fs-cache';
import { uriToFsPath } from '../../navigation/workspace-files';
import { documentFor, lineEndingOf, openBuffers } from '../command-host';
import { manifestActionMatches, manifestToWrite } from '../new-content/registration.emitter';
import { manifestActionInsert } from '../register-part/manifest-action.emitter';
import { manifestsIn, modRootsUnder } from '../register-part/ship-registry';
import { relativeRulesReference } from '../shared-base/base-file.emitter';
import { readRulesFile } from '../shared-base/base-index';
import { editableModRootOf } from '../shared-base/shared-base.analysis-entry';
import { OverrideMember, OverrideRefusal, overrideGroupName, overrideMemberAt } from './override-member';
import { overridesActionText, sparseOverrideFileText } from './overrides-action.emitter';

/**
 * The `workspace/executeCommand` id that writes an `Overrides` action for the value the caret sits
 * on. Both clients invoke it twice: without a mod it reports the mods the override could go into and
 * what would be written, and with one it writes the action.
 */
export const OVERRIDE_IN_MOD_COMMAND = 'cosmoteer.overrideInMod';

/**
 * The command the lightbulb's refactoring carries, deliberately absent from the server's
 * `executeCommandProvider` so that it is never executed here.
 *
 * Which mod the override belongs in, and whether it is written into the manifest or into a file of
 * its own, are choices only the author can make, and a code action has no way to ask for one. A
 * client resolves a command against its own handlers only when the server does not claim it, so
 * leaving this one unclaimed is what hands the exchange to the client. Both clients implement it:
 * they run the scan round, ask, then invoke {@link OVERRIDE_IN_MOD_COMMAND} with the answer.
 */
export const OVERRIDE_IN_MOD_ACTION_COMMAND = 'cosmoteer.overrideInModFromAction';

/** What the client sends: the value, and on the second round the mod it picked. */
export interface OverrideInModArgs {
    /** The file of the game install the value is written in. */
    uri: string;
    /** The byte offset of the caret in that file. */
    offset: number;
    /** The {@link OverrideModCandidate.key} of the chosen mod. Absent means "report the candidates". */
    mod?: string;
    /** Whether the map is written into the manifest or into a file of the mod. Defaults to inline. */
    shape?: 'inline' | 'file';
}

/** Why an override cannot be written, whatever else is true of it. */
export type OverrideInModFailure =
    | OverrideRefusal
    /** The file is not one of the game install, so it is edited directly instead of overridden. */
    | 'notVanilla'
    /** Language string files are the one thing actions cannot touch. */
    | 'stringsFile'
    /** The game folder is not configured, so no target path can be expressed. */
    | 'noGamePath'
    /** The workspace holds no mod the override could go into. */
    | 'noModRoot'
    /** The mod the client picked is no longer among the candidates. */
    | 'unknownMod'
    /** The mod ships several manifests and only its author knows which get the override. */
    | 'ambiguousManifest'
    /** The manifest cannot take another action entry. */
    | 'notEditable'
    /** An action of that mod already overrides this member. */
    | 'alreadyOverridden'
    /** The client turned the edit down. */
    | 'editRejected'
    /** The fragment file could not be written. */
    | 'writeFailed';

/** One mod the override could be written into. */
export interface OverrideModCandidate {
    /** The identity the client sends back to pick this mod. */
    key: string;
    /** The mod folder's name, which is what the user recognizes it by. */
    name: string;
    /** The mod's root directory, with forward slashes. */
    modRoot: string;
    /** The manifests it ships, by base name. */
    manifests: string[];
    /** True when one of its actions already overrides this member. */
    alreadyOverridden: boolean;
    /** Why this mod cannot take the override, absent when it can. */
    blocked?: 'ambiguousManifest' | 'notEditable';
}

/** The mods the override could be written into, and what would be written. */
export interface OverrideInModScanResult {
    kind: 'scan';
    /** The name of the member being overridden, empty when there is none. */
    memberName: string;
    /** The `OverrideIn` path the action would carry. */
    target: string;
    /** The `Overrides` body that would be written, one member deep. */
    body: string;
    /** True when the member is a group or a list, so the override replaces the whole of it. */
    replacesContainer: boolean;
    /** The candidates, in the order the folders were walked. */
    candidates: OverrideModCandidate[];
    /** Why nothing could be worked out, absent on success. */
    failure?: OverrideInModFailure;
}

/** What writing the override did, or why it did nothing. */
export interface OverrideInModApplyResult {
    kind: 'apply';
    /** The mod the override went into, empty when nothing was written. */
    modRoot: string;
    /** The manifest the action was written into, empty when nothing was written. */
    manifestFsPath: string;
    /** The fragment file that was created, empty for the inline shape. */
    createdFsPath: string;
    /** Every file the command changed, so the client can save and tidy them. */
    changedFiles: string[];
    /** The `OverrideIn` path that was written. */
    target: string;
    /** The name of the member that was overridden. */
    memberName: string;
    /** True when the override replaces a whole group or list rather than a single value. */
    replacesContainer: boolean;
    /** Why nothing was written, absent on success. */
    failure?: OverrideInModFailure;
    /** The manifest names to choose between, only set for `ambiguousManifest`. */
    manifests?: string[];
}

/** The server-side facilities the command needs, injected so the module stays testable. */
export interface OverrideInModHost {
    /** The workspace folders whose mods could take the override, as on-disk paths. */
    folderPaths(): Promise<string[]>;
    /** The editor's open buffers, whose unsaved text wins over disk. */
    openDocuments(): readonly TextDocument[];
    /** The game's `Data` directory, which the target path is expressed against. */
    dataRoot(): string | undefined;
    /** Hands the client the edit. */
    applyEdit(changes: Record<string, TextEdit[]>): Promise<boolean>;
    /** Announces the files the command wrote, so the indexes pick them up without waiting for a watcher. */
    filesChanged(paths: readonly string[]): void;
}

/** The folder a generated fragment file goes in, below the mod's root. */
const FRAGMENT_DIR = 'overrides';

/** How many mods a scan reports, so a workspace full of mods still answers with a readable list. */
const MAX_REPORTED_MODS = 40;

/**
 * The member names an `Overrides` source supplies, folded to lower case the way the game's own child
 * lookup matches them.
 *
 * A source written as a reference is followed into the file it names, so a mod keeping its overrides
 * in a fragment is recognized as well. A reference that cannot be followed answers with nothing,
 * which reports the member as not yet overridden: a second entry for the same name is applied after
 * the first and simply wins, while wrongly claiming the member is taken would refuse an override the
 * author is entitled to.
 *
 * @param source the action's `Overrides` value.
 * @param declaringDir the directory of the file the action is written in.
 * @returns the member names the source supplies.
 */
const overriddenNamesOf = async (source: ActionSource, declaringDir: string): Promise<Set<string>> => {
    const names = new Set<string>();
    let group: AbstractNode | null | undefined = source;
    if (isValueNode(source)) {
        const match = /^\s*&?\s*<([^<>]+)>(.*)$/.exec(String(source.valueType.value));
        if (!match) return names;
        const file = await readRulesFile(resolve(declaringDir, match[1].trim()).replace(/\\/g, '/'));
        if (!file) return names;
        group = file.document;
        for (const segment of match[2].split('/').map((part) => part.trim()).filter((part) => part.length > 0)) {
            if (!group) return names;
            group = stepIntoNode(group, segment);
        }
    }
    if (!group || !('elements' in group)) return names;
    for (const element of (group as { elements: AbstractNode[] }).elements) {
        const name = memberNameOf(element);
        if (name !== undefined) names.add(name.toLowerCase());
    }
    return names;
};

/**
 * Whether one of a mod's manifests already overrides that member in that group.
 *
 * @param modRoot the mod whose manifests are read.
 * @param target the group as an action target names it.
 * @param memberName the member the override would change.
 * @returns true when an action already supplies that member there.
 */
const modAlreadyOverrides = (modRoot: string, target: string, memberName: string): Promise<boolean> => {
    const key = memberName.toLowerCase();
    return manifestActionMatches(
        modRoot,
        target,
        async (source, declaringDir) => (await overriddenNamesOf(source, declaringDir)).has(key),
        'Overrides'
    );
};

/** The value the offer was made on, resolved against what its file says right now. */
interface ResolvedValue {
    /** The file's uri in the spelling an edit has to name it by. */
    uri: string;
    /** The file's on-disk path, with forward slashes. */
    fsPath: string;
    /** The override that would be written. */
    member: OverrideMember;
}

/**
 * The value the arguments point at, read from the editor's buffer so an unsaved edit is what is
 * copied.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the strings-folder read.
 * @returns the value, or the reason there is none.
 */
const resolveValue = async (
    args: OverrideInModArgs,
    host: OverrideInModHost,
    cancellationToken: CancellationToken
): Promise<ResolvedValue | { failure: OverrideInModFailure }> => {
    const dataRoot = host.dataRoot();
    if (!dataRoot) return { failure: 'noGamePath' };
    const fsPath = uriToFsPath(args.uri).replace(/\\/g, '/');
    // Only the game's own files are overridden. A file of the user's own mod is edited directly, and
    // a file of somebody else's installed mod needs a cross-mod load order this feature does not
    // model, so both are turned down rather than half handled.
    if (!isUnder(fsPath, dataRoot) || findModRoot(fsPath) || isModRules(fsPath)) return { failure: 'notVanilla' };
    // The game's own example mod states it plainly: a language strings file cannot be modified by an
    // action at all, so an override written against one is a silently dead entry.
    if (await isStringsFile(args.uri, cancellationToken).catch(() => false)) return { failure: 'stringsFile' };

    const document = await documentFor(fsPath, openBuffers(host));
    if (!document) return { failure: 'stale' };
    const text = document.getText();
    const result = overrideMemberAt(parseText(text, fsPath), text, args.offset, fsPath, dataRoot);
    if ('refusal' in result) return { failure: result.refusal };
    return { uri: document.uri, fsPath, member: result.member };
};

/**
 * The mods of the workspace the override could be written into.
 *
 * @param host the server facilities.
 * @returns the mod roots, in the order the folders were walked, without duplicates.
 */
const candidateModRoots = async (host: OverrideInModHost): Promise<string[]> => {
    const folders = await host.folderPaths().catch(() => []);
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const folder of folders) {
        for (const modRoot of modRootsUnder(folder)) {
            const key = foldPathCase(modRoot);
            if (seen.has(key)) continue;
            // A mod of the installed workshop tree belongs to somebody else, whatever folder it was
            // reached through.
            if (!editableModRootOf(`${modRoot}/mod.rules`)) continue;
            seen.add(key);
            roots.push(modRoot);
        }
    }
    return roots;
};

/**
 * Report the mods the override could go into, each with what stands in the way of it.
 *
 * @param value the value the offer was made on.
 * @param host the server facilities.
 * @returns the candidates, capped so a workspace full of mods still answers with a readable list.
 */
const scanRound = async (value: ResolvedValue, host: OverrideInModHost): Promise<OverrideInModScanResult> => {
    const roots = (await candidateModRoots(host)).slice(0, MAX_REPORTED_MODS);
    const candidates: OverrideModCandidate[] = [];
    for (const modRoot of roots) {
        const manifests = manifestsIn(modRoot);
        candidates.push({
            key: foldPathCase(modRoot),
            name: modRoot.split('/').filter(Boolean).pop() ?? modRoot,
            modRoot,
            manifests: manifests.map(basenameOf),
            alreadyOverridden: await modAlreadyOverrides(modRoot, value.member.target, value.member.name),
            blocked: manifests.length === 0 ? 'notEditable' : manifestToWrite(manifests) ? undefined : 'ambiguousManifest',
        });
    }
    return {
        kind: 'scan',
        memberName: value.member.name,
        target: value.member.target,
        body: value.member.body,
        replacesContainer: value.member.replacesContainer,
        candidates,
        failure: candidates.length === 0 ? 'noModRoot' : undefined,
    };
};

/** A scan result carrying nothing but the reason nothing could be worked out. */
const scanFailed = (failure: OverrideInModFailure): OverrideInModScanResult => ({
    kind: 'scan',
    memberName: '',
    target: '',
    body: '',
    replacesContainer: false,
    candidates: [],
    failure,
});

/** An apply result carrying nothing but the reason nothing happened. */
const applyFailed = (
    failure: OverrideInModFailure,
    value?: ResolvedValue,
    modRoot = '',
    manifests?: string[]
): OverrideInModApplyResult => ({
    kind: 'apply',
    modRoot,
    manifestFsPath: '',
    createdFsPath: '',
    changedFiles: [],
    target: value?.member.target ?? '',
    memberName: value?.member.name ?? '',
    replacesContainer: value?.member.replacesContainer ?? false,
    failure,
    manifests,
});

/**
 * A path for the fragment file that is not taken yet, so a second override of the same group never
 * writes over the first.
 *
 * @param modRoot the mod the file goes in.
 * @param fsPath the on-disk path of the file being overridden.
 * @param groupName the group the override targets.
 * @returns the file's on-disk path, with forward slashes.
 */
const fragmentFsPath = (modRoot: string, fsPath: string, groupName: string): string => {
    const stem = (fsPath.split('/').pop() ?? 'overrides').replace(/\.[^.]*$/, '');
    const base = `${stem}_${groupName}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    for (let attempt = 0; ; attempt++) {
        const name = attempt === 0 ? `${base}.rules` : `${base}_${attempt + 1}.rules`;
        const candidate = join(modRoot, FRAGMENT_DIR, name).replace(/\\/g, '/');
        if (!existsSync(candidate)) return candidate;
    }
};

/**
 * Where the action entry goes in a manifest and what is written around it.
 *
 * @param text the manifest's source text.
 * @param manifestFsPath the manifest's on-disk path.
 * @param lineEnding the ending the manifest already uses.
 * @returns the insertion, or undefined when the manifest cannot take another entry.
 */
const insertionFor = (
    text: string,
    manifestFsPath: string,
    lineEnding: '\n' | '\r\n'
): { offset: number; before: string; after: string; indent: string } | undefined => {
    const insert = manifestActionInsert(text, parseText(text, manifestFsPath), lineEnding);
    return insert.kind === 'unusable' ? undefined : insert;
};

/**
 * Write the `Overrides` action into the chosen mod's manifest, and the fragment file beside it when
 * the map is not written inline.
 *
 * @param value the value being overridden.
 * @param modRoot the mod the override goes into.
 * @param shape whether the map is written into the manifest or into a file of the mod.
 * @param host the server facilities.
 * @returns what was written, or the reason nothing was.
 */
const applyRound = async (
    value: ResolvedValue,
    modRoot: string,
    shape: 'inline' | 'file',
    host: OverrideInModHost
): Promise<OverrideInModApplyResult> => {
    const manifests = manifestsIn(modRoot);
    if (manifests.length === 0) return applyFailed('notEditable', value, modRoot);
    const manifestFsPath = manifestToWrite(manifests);
    if (!manifestFsPath) return applyFailed('ambiguousManifest', value, modRoot, manifests.map(basenameOf));
    if (await modAlreadyOverrides(modRoot, value.member.target, value.member.name)) {
        return applyFailed('alreadyOverridden', value, modRoot);
    }

    const document = await documentFor(manifestFsPath, openBuffers(host));
    if (!document) return applyFailed('notEditable', value, modRoot);
    const text = document.getText();
    const lineEnding = lineEndingOf(text);
    const insert = insertionFor(text, manifestFsPath, lineEnding);
    if (!insert) return applyFailed('notEditable', value, modRoot);

    const groupName = overrideGroupName(value.member.targetPath, value.fsPath);
    let createdFsPath = '';
    let source: Parameters<typeof overridesActionText>[1] = { kind: 'inline', body: value.member.body };
    if (shape === 'file') {
        createdFsPath = fragmentFsPath(modRoot, value.fsPath, groupName);
        // The fragment is written before the action, so the manifest never points at a file that is
        // not there yet, which the editor would report as a broken reference.
        try {
            await mkdir(dirname(createdFsPath), { recursive: true });
            await writeFile(createdFsPath, sparseOverrideFileText(groupName, value.member.body, lineEnding), {
                encoding: 'utf-8',
            });
        } catch {
            return applyFailed('writeFailed', value, modRoot);
        }
        // A mod action's source references resolve against the file the action is written in, never
        // against the game root its target names.
        source = {
            kind: 'reference',
            reference: `&${relativeRulesReference(dirname(manifestFsPath), createdFsPath, groupName)}`,
        };
    }

    const entryText = overridesActionText(value.member.target, source, insert.indent, lineEnding);
    const at = document.positionAt(insert.offset);
    const edits: TextEdit[] = [
        { range: { start: at, end: at }, newText: `${insert.before}${entryText}${insert.after}` },
    ];
    const applied = await host.applyEdit({ [document.uri]: edits }).catch(() => false);
    if (!applied) {
        // The fragment is only ever pointed at by the entry that was turned down, so it goes with it
        // rather than being left behind for the next attempt to number around.
        if (createdFsPath) {
            await rm(createdFsPath, { force: true }).catch(() => undefined);
            host.filesChanged([createdFsPath]);
        }
        return applyFailed('editRejected', value, modRoot);
    }
    host.filesChanged(createdFsPath ? [createdFsPath, manifestFsPath] : [manifestFsPath]);
    return {
        kind: 'apply',
        modRoot,
        manifestFsPath,
        createdFsPath,
        changedFiles: createdFsPath ? [createdFsPath, manifestFsPath] : [manifestFsPath],
        target: value.member.target,
        memberName: value.member.name,
        replacesContainer: value.member.replacesContainer,
    };
};

/**
 * The command entry point: report the mods the override could go into when the client sent no mod,
 * and write the action into the chosen one otherwise.
 *
 * @param args the client's arguments.
 * @param host the server facilities.
 * @param cancellationToken cancels the manifest reads.
 * @returns the candidates, or what the write did.
 */
export const overrideInMod = async (
    args: OverrideInModArgs,
    host: OverrideInModHost,
    cancellationToken: CancellationToken
): Promise<OverrideInModScanResult | OverrideInModApplyResult> => {
    const value = await resolveValue(args, host, cancellationToken);
    if ('failure' in value) return args.mod ? applyFailed(value.failure) : scanFailed(value.failure);
    if (!args.mod) return await scanRound(value, host);

    // The mods are walked again rather than trusted from the scan: a manifest may have been created
    // or deleted since, and a mod that is no longer there must not be written to at a remembered path.
    const roots = await candidateModRoots(host);
    const modRoot = roots.find((root) => foldPathCase(root) === args.mod);
    if (!modRoot) return applyFailed(roots.length === 0 ? 'noModRoot' : 'unknownMod', value);
    return await applyRound(value, modRoot, args.shape === 'file' ? 'file' : 'inline', host);
};
