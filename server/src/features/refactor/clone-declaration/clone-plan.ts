import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { relative } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isValueNode, ValueNode } from '../../../core/ast/ast';
import { hasId, sameId } from '../../../document/schema/entity-schema';
import { findModRoot } from '../../../mod/mod-root';
import { parseText } from '../../../utils/ast.utils';
import { foldPathCase } from '../../../workspace/fs-cache';
import { LocalizationText } from '../../completion/localization-key.index';
import { modStringsFiles } from '../../diagnostics/localization-key-insert';
import { filePathToUri } from '../../navigation/navigation-strategy';
import { definitionLocationOf } from '../../navigation/reference-location';
import { idReferenceSites, IdSymbol } from '../../navigation/schema-id-symbol';
import { editableModRootOf } from '../shared-base/shared-base.analysis-entry';
import {
    CloneKey,
    deriveCloneKey,
    localizationKeyFieldsOf,
    StringsFileInsert,
    stringsInsertsFor,
} from './clone-localization';
import { CloneTarget, CloneTargetRefusal, CloneUnit, dirOfPath, filesUnder, removableMemberSpan } from './clone-target';
import { rebaseUnitFile, UnitRebaseContext } from './unit-rebase';

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

/**
 * What an id may be spelled with. The same set the rename refactoring enforces, because a clone
 * declares an id exactly the way a rename rewrites one.
 */
export const VALID_ID = /^[A-Za-z0-9_.]+$/;

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

/** What the caller asks a plan for. */
export interface CloneRequest {
    /** The id the copy declares. */
    readonly newId: string;
    /** The directory the copy lands in, absent for the default beside or below the source. */
    readonly destinationDir?: string;
}

/** The value text of an id, keeping the quoting the source used. */
const idText = (quoted: boolean | undefined, id: string): string => (quoted ? `"${id}"` : id);

/** The entity name of an id, which is what a file or directory the clone creates is named after. */
export const idLeafOf = (id: string): string => id.slice(id.lastIndexOf('.') + 1) || id;

/** A path with forward slashes, so every comparison and every written path reads the same. */
const slashed = (path: string): string => path.replace(/\\/g, '/');

/** Whether a path sits inside a directory, folding case the way the filesystem matches it. */
const isUnder = (path: string, root: string): boolean => {
    const folded = foldPathCase(slashed(path));
    const prefix = foldPathCase(slashed(root).replace(/\/+$/, ''));
    return folded === prefix || folded.startsWith(`${prefix}/`);
};

/**
 * The directory the copy lands in when the caller named none.
 *
 * A source the user may already edit is cloned beside itself, which is the case that needs no path
 * rewriting at all: every `<../base_…>` reference and every `../` asset path of the game's own parts
 * still names the same file from a sibling directory. A source in the game's install or in somebody
 * else's workshop mod is cloned into the one mod of the workspace, under the same subpath it holds in
 * the tree it came from, so a part of `ships/terran` arrives in the mod's own `ships/terran`.
 *
 * @param target the declaration being cloned.
 * @param newId the id the copy declares.
 * @param sourceEditable the root of the tree the source may be edited in, absent when it may not.
 * @param candidates the mod roots that could take the copy.
 * @param dataRoot the game's `Data` directory.
 * @returns the directory, or the reason one cannot be picked.
 */
export const defaultDestinationDir = (
    target: CloneTarget,
    newId: string,
    sourceEditable: string | undefined,
    candidates: readonly string[],
    dataRoot: string | undefined
): { dir: string } | { failure: CloneFailure; detail?: string[] } => {
    const sourceDir = dirOfPath(target.fsPath);
    if (target.unit === 'listElement') return { dir: sourceDir };
    if (sourceEditable) {
        return { dir: target.unit === 'directory' ? `${dirOfPath(sourceDir)}/${idLeafOf(newId)}` : sourceDir };
    }
    // A copy of somebody else's file has to be told which project it joins, and only one candidate
    // answers that on its own.
    if (candidates.length !== 1) return { failure: 'ambiguousDestination', detail: [...candidates] };
    const modRoot = candidates[0];
    const sourceRoot = findModRoot(target.fsPath) ?? dataRoot;
    const anchor = target.unit === 'directory' ? dirOfPath(sourceDir) : sourceDir;
    const inside = sourceRoot ? slashed(relative(sourceRoot, anchor)) : '';
    const subPath = inside === '' || inside.startsWith('..') ? '' : `/${inside}`;
    return { dir: target.unit === 'directory' ? `${modRoot}${subPath}/${idLeafOf(newId)}` : `${modRoot}${subPath}` };
};

/** One edit inside a copied file, in that file's own offsets. */
interface SourceEdit {
    readonly start: number;
    readonly end: number;
    readonly newText: string;
}

/** A file's text with a set of disjoint edits applied, replayed from the back so no offset shifts. */
const applyEdits = (text: string, edits: readonly SourceEdit[]): string => {
    let out = text;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
    }
    return out;
};

/** Whether a list of edits reads any run of source twice, which would mean two rewrites disagreeing. */
const overlapping = (edits: readonly SourceEdit[]): boolean => {
    const sorted = [...edits].sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index++) {
        if (sorted[index].start < sorted[index - 1].end) return true;
    }
    return false;
};

/**
 * The id rewrites one document needs, restricted to a span when only part of the file is being copied.
 *
 * The id is never rewritten by searching the text for it. 193 of the game's 732 distinct part ids are
 * a strict prefix of another (`crew` of `crew2`, `io` of `ion_beams`), and 74 of the files declaring
 * an own id write that same text again in a slot that is not an id at all, such as `bg_blue.rules`
 * pairing `ID = bg_blue` with `StaticBackgroundTexture = &<textures/tex_bg_blue.rules>`. Only the
 * nodes the schema says are id slots are touched, so that texture reference, and the comment the
 * game's own `ID` lines trail, both come through untouched.
 *
 * @param document the parsed copy source.
 * @param symbol the id the copy renames.
 * @param newId the id the copy declares.
 * @param identity the identity slot itself, which is rewritten whether or not the sweep sees it.
 * @param span the offsets being copied, absent when the whole file is.
 * @returns the rewrites.
 */
const idEditsOf = (
    document: AbstractNodeDocument,
    symbol: IdSymbol,
    newId: string,
    identity: ValueNode | undefined,
    span?: { start: number; end: number }
): SourceEdit[] => {
    const edits: SourceEdit[] = [];
    const seen = new Set<number>();
    const add = (node: AbstractNode, quoted: boolean | undefined): void => {
        if (span && (node.position.start < span.start || node.position.end > span.end)) return;
        if (seen.has(node.position.start)) return;
        seen.add(node.position.start);
        edits.push({ start: node.position.start, end: node.position.end, newText: idText(quoted, newId) });
    };
    // The identity slot itself is written first and never left to the reference sweep. Not every class
    // types its identity as a reference to itself, so a whole-file root such as a codex page carries an
    // `ID` the sweep does not see, and a copy of one would arrive still answering to the source's name.
    if (identity) add(identity, identity.quoted);
    for (const site of idReferenceSites(document, symbol)) add(site, isValueNode(site) ? site.quoted : false);
    return edits;
};

/** The localization repointing edits, restricted to a span the same way. */
const keyEditsOf = (keys: readonly CloneKey[], span?: { start: number; end: number }): SourceEdit[] =>
    keys
        .filter((key) => !span || (key.node.position.start >= span.start && key.node.position.end <= span.end))
        .map((key) => ({
            start: key.node.position.start,
            end: key.node.position.end,
            newText: idText(key.node.quoted, key.newKey),
        }));

/**
 * The edit that leaves the `OtherIDs` aliases behind, and the aliases it drops.
 *
 * The game resolves an alias exactly like a primary id, so carrying one into the copy would hand the
 * copy a second name the original already answers to, and the game would keep one of the two and drop
 * the other. A copy is a new thing with a new name, so the legacy aliases stay with the original. This
 * is a stated rule rather than a judgement call: 51 of the game's own part files and 418 of the
 * installed workshop mods' carry `OtherIDs`, and every one of them means "this used to be called that".
 *
 * @param container the cloned group or document.
 * @param text the declaring file's source.
 * @param span the offsets being copied, absent when the whole file is.
 * @returns the edit and the dropped aliases, empty when the container declares none.
 */
const otherIdsRemoval = (
    container: GroupNode | AbstractNodeDocument,
    text: string,
    span?: { start: number; end: number }
): { edits: SourceEdit[]; dropped: string[] } => {
    const found = removableMemberSpan(container, text, 'OtherIDs');
    if (!found) return { edits: [], dropped: [] };
    if (span && (found.start < span.start || found.end > span.end)) return { edits: [], dropped: [] };
    const written = text.slice(found.value.position.start, found.value.position.end).trim();
    return { edits: [{ start: found.start, end: found.end, newText: '' }], dropped: [written] };
};

/** The indentation of the line an offset sits on, so a duplicated list element lines up with its peers. */
const lineIndentOf = (text: string, offset: number): string => {
    let start = offset;
    while (start > 0 && text[start - 1] !== '\n') start--;
    let end = start;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    return text.slice(start, end);
};

/**
 * The file's text with the cloned list element written again below itself, carrying the new id.
 *
 * A collection element is not a file, so there is nothing to copy anywhere: the duplicate belongs in
 * the very same list, since that list is what the game reads the collection from. Every path in it
 * therefore still resolves against the same directory, and none of them is rewritten.
 *
 * @param document the parsed declaring file.
 * @param text the declaring file's source.
 * @param target the element being cloned.
 * @param symbol the id the copy renames.
 * @param newId the id the copy declares.
 * @param keys the localization keys the copy repoints.
 * @returns the whole file's new text and the aliases dropped, or the reason there is none.
 */
const duplicateListElement = (
    document: AbstractNodeDocument,
    text: string,
    target: CloneTarget,
    symbol: IdSymbol,
    newId: string,
    keys: readonly CloneKey[]
): { text: string; dropped: string[] } | { failure: CloneFailure } => {
    const container = target.container;
    if (!isGroupNode(container)) return { failure: 'noDeclaration' };
    // An element may name its bases before its brace, and those belong to the copy as much as its
    // body does, so the span starts at the earliest thing the element writes.
    const start = Math.min(container.position.start, ...(container.inheritance ?? []).map((base) => base.position.start));
    const end = container.position.end;
    if (!(start >= 0 && end > start && end <= text.length)) return { failure: 'stale' };
    const span = { start, end };

    const removal = otherIdsRemoval(container, text, span);
    const edits = [...idEditsOf(document, symbol, newId, target.node, span), ...keyEditsOf(keys, span), ...removal.edits];
    if (overlapping(edits)) return { failure: 'stale' };
    const copy = applyEdits(text.slice(start, end), edits.map((edit) => ({ ...edit, start: edit.start - start, end: edit.end - start })));
    const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
    const insert = `${lineEnding}${lineIndentOf(text, start)}${copy}`;
    return { text: `${text.slice(0, end)}${insert}${text.slice(end)}`, dropped: removal.dropped };
};

/**
 * Rewrite one copied rules file: every id the copy renames, the aliases it drops, the localization
 * keys it repoints and every path it has to re-express.
 *
 * @param source the file's on-disk path.
 * @param text the file's source.
 * @param document the parsed source.
 * @param symbol the id the copy renames.
 * @param newId the id the copy declares.
 * @param keys the localization keys the copy repoints, empty for a file that is not the declaring one.
 * @param rebaseContext where the file is copied from and to.
 * @param container the cloned container, only for the declaring file, whose aliases are dropped.
 * @param identity the identity slot, only for the declaring file, which is always rewritten.
 * @returns the rewritten text and the aliases dropped, or the path that stopped the copy.
 */
const rewriteCopiedFile = (
    source: string,
    text: string,
    document: AbstractNodeDocument,
    symbol: IdSymbol,
    newId: string,
    keys: readonly CloneKey[],
    rebaseContext: UnitRebaseContext,
    container: GroupNode | AbstractNodeDocument | undefined,
    identity: ValueNode | undefined
): { text: string; dropped: string[] } | { failure: CloneFailure; detail: string[] } => {
    const removal = container ? otherIdsRemoval(container, text) : { edits: [], dropped: [] };
    const edits: SourceEdit[] = [...idEditsOf(document, symbol, newId, identity), ...keyEditsOf(keys), ...removal.edits];
    const rebased = rebaseUnitFile(text, rebaseContext);
    if ('refusal' in rebased) return { failure: rebased.refusal, detail: [rebased.path, source] };
    for (const rebase of rebased.rebases) edits.push(rebase);
    // Two rewrites over one run of source would mean the file was read two different ways, so the copy
    // is refused rather than written half one way and half the other.
    if (overlapping(edits)) return { failure: 'stale', detail: [source] };
    return { text: applyEdits(text, edits), dropped: removal.dropped };
};

/**
 * Work out everything a clone would write, without writing any of it.
 *
 * @param target the declaration being cloned.
 * @param text the declaring file's source, the very text the target was located in.
 * @param document the parsed declaring file, the very parse the target was located in.
 * @param request the id the copy declares and where it goes.
 * @param context the project facts the plan needs.
 * @param cancellationToken cancels the reads and the schema resolution.
 * @returns the plan, or the reason there is none.
 */
export const buildClonePlan = async (
    target: CloneTarget,
    text: string,
    document: AbstractNodeDocument,
    request: CloneRequest,
    context: ClonePlanContext,
    cancellationToken: CancellationToken
): Promise<ClonePlanResult> => {
    const newId = request.newId.trim();
    if (!VALID_ID.test(newId)) return { failure: 'invalidId' };
    if (sameId(newId, target.id)) return { failure: 'idUnchanged' };
    const declared = await context.declaredIds(target.cls, cancellationToken).catch(() => new Set<string>());
    if (hasId(declared, newId)) return { failure: 'idTaken' };

    const sourceDir = dirOfPath(target.fsPath);
    const sourceEditable = editableModRootOf(target.fsPath);
    const candidates = new Set<string>();
    for (const folder of context.folderPaths) for (const root of context.modRootsUnder(folder)) candidates.add(slashed(root));
    // A collection element is copied into the very list it is already in, so it has no destination to
    // choose and the caller cannot name one. That also means the file it is written back into has to
    // be one the user may edit, which is the one case where the source is gated as well.
    const destination =
        target.unit === 'listElement'
            ? { dir: sourceDir }
            : request.destinationDir
              ? { dir: slashed(request.destinationDir) }
              : defaultDestinationDir(target, newId, sourceEditable, [...candidates], context.dataRoot);
    if ('failure' in destination) return destination;
    const destinationDir = destination.dir.replace(/\/+$/, '');
    // The source may be the game's own file, which is the whole point of the feature. The destination
    // never may: a copy is only worth making somewhere the user can keep working on it.
    const destinationRoot =
        target.unit === 'listElement' ? sourceEditable : editableModRootOf(`${destinationDir}/placeholder.rules`);
    if (!destinationRoot) return { failure: 'notEditable' };

    // Which files the copy carries, and where each of them lands.
    const sources = target.unit === 'directory' ? filesUnder(sourceDir) : target.unit === 'file' ? [slashed(target.fsPath)] : [];
    const destinationOf = new Map<string, string>();
    if (target.unit === 'directory') {
        // Copying a directory into itself would read the copy as part of the source, so it is refused
        // along with a destination that is already there.
        if (existsSync(destinationDir) || isUnder(destinationDir, sourceDir)) {
            return { failure: 'destinationExists', detail: [destinationDir] };
        }
        for (const file of sources) {
            // The declaring file is renamed with the folder. The game's own parts name the folder and
            // the file after the part, and a folder called `big_cannon` holding `cannon.rules` is
            // exactly the half-renamed state this refactoring exists to avoid. Every reference inside
            // the copy follows, because the unit map is what the rebaser reads.
            const inside =
                foldPathCase(file) === foldPathCase(slashed(target.fsPath))
                    ? `${idLeafOf(newId)}.rules`
                    : slashed(relative(sourceDir, file));
            destinationOf.set(file, `${destinationDir}/${inside}`);
        }
    } else if (target.unit === 'file') {
        destinationOf.set(slashed(target.fsPath), `${destinationDir}/${idLeafOf(newId)}.rules`);
    }
    const claimedPaths = new Set<string>();
    for (const path of destinationOf.values()) {
        if (existsSync(path) || claimedPaths.has(foldPathCase(path))) {
            return { failure: 'destinationExists', detail: [path] };
        }
        claimedPaths.add(foldPathCase(path));
    }
    const unitMap = new Map<string, string>();
    for (const [from, to] of destinationOf) unitMap.set(foldPathCase(from), to);

    // The localization keys the copy declares in place of the source's.
    const takenKeys = await context.declaredKeys(cancellationToken).catch(() => new Set<string>());
    const keyFields = await localizationKeyFieldsOf(target.container, cancellationToken).catch(() => []);
    const claimed = new Set<string>(takenKeys);
    const keys: CloneKey[] = [];
    for (const field of keyFields) {
        const newKey = deriveCloneKey(field.sourceKey, target.id, newId, claimed);
        // A key that names no entity of its own is shared text the copy keeps pointing at.
        if (newKey === undefined) continue;
        claimed.add(newKey.toLowerCase());
        keys.push({ ...field, newKey });
    }

    const symbol: IdSymbol = { id: target.id, rootClass: target.cls, location: definitionLocationOf(target.node) };
    const declaringPath = slashed(target.fsPath);
    const files: ClonePlanFile[] = [];
    let droppedOtherIds: string[] = [];

    if (target.unit === 'listElement') {
        const duplicate = duplicateListElement(document, text, target, symbol, newId, keys);
        if ('failure' in duplicate) return duplicate;
        droppedOtherIds = duplicate.dropped;
        files.push({ source: declaringPath, destination: declaringPath, text: duplicate.text, before: text, created: false });
    } else {
        for (const source of sources) {
            if (cancellationToken.isCancellationRequested) return { failure: 'stale' };
            const to = destinationOf.get(source)!;
            if (!source.toLowerCase().endsWith('.rules')) {
                files.push({ source, destination: to, created: true });
                continue;
            }
            const declaring = foldPathCase(source) === foldPathCase(declaringPath);
            const fileText = declaring
                ? text
                : (context.openText?.(source) ?? (await readFile(source, { encoding: 'utf-8' }).catch(() => undefined)));
            if (fileText === undefined) return { failure: 'stale', detail: [source] };
            let parsed: AbstractNodeDocument;
            try {
                parsed = declaring ? document : parseText(fileText, source);
            } catch {
                return { failure: 'stale', detail: [source] };
            }
            const rebaseContext: UnitRebaseContext = {
                sourceDir: dirOfPath(source),
                destinationDir: dirOfPath(to),
                unit: unitMap,
                dataRoot: context.dataRoot,
                destinationRoot,
            };
            const rewritten = rewriteCopiedFile(
                source,
                fileText,
                parsed,
                symbol,
                newId,
                declaring ? keys : [],
                rebaseContext,
                declaring ? target.container : undefined,
                declaring ? target.node : undefined
            );
            if ('failure' in rewritten) return rewritten;
            if (declaring) droppedOtherIds = rewritten.dropped;
            files.push({ source, destination: to, text: rewritten.text, before: fileText, created: true });
        }
    }

    // The keys go into the destination mod's own language files, never the source's, so cloning a part
    // out of the game's install never writes into the install.
    const texts = await Promise.all(
        keys.map(async (key) => ({
            newKey: key.newKey,
            texts: await context.localizationTexts(key.sourceKey, cancellationToken).catch(() => []),
        }))
    );
    const stringsPaths = await modStringsFiles(filePathToUri(`${destinationDir}/placeholder.rules`), cancellationToken).catch(
        () => []
    );
    const stringsFiles = await stringsInsertsFor(stringsPaths.map(slashed), texts, context.openText);

    return {
        plan: {
            target,
            unit: target.unit,
            id: target.id,
            newId,
            identityKey: target.identityKey,
            destinationDir,
            createdDir: target.unit === 'directory' ? destinationDir : undefined,
            files,
            stringsFiles,
            keys,
            droppedOtherIds,
        },
    };
};
